/* =========================================================================
   LIBRARY LOADER — load Chart.js and SheetJS ourselves and wait for them,
   rather than relying on <script src> parse-order (unreliable in sandboxed
   preview iframes).
   ========================================================================= */
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.onload = ()=>resolve(src);
    s.onerror = ()=>reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
}
const CHART_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://unpkg.com/chart.js@4.4.4/dist/chart.umd.min.js'
];
const XLSX_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
];
async function loadFirstWorking(sources, checkFn){
  for(const src of sources){
    try{ await loadScript(src); if(checkFn()) return true; }catch(e){ /* try next */ }
  }
  return checkFn();
}

/* =========================================================================
   DATA MODEL
   ========================================================================= */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_ALIASES = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function n12(){ return new Array(12).fill(null); }
function uid(){ return 'id'+Math.random().toString(36).slice(2,10); }

// ---- category color palette (used across groups/investment types) ----
const PALETTE = ['#C9A961','#6FA491','#C06A46','#8FC0AC','#D98C64','#7FAE79','#9BB6C9','#B98BC9','#E4CE94','#5F8C7A'];

function buildDefaultData(){
  return {
    2026: { income: [], expenseGroups: [], investments: [], debts: [], savingsAccounts: [], retirementAccounts: [], savingsGoals: [] },
    2025: { income: [], expenseGroups: [], investments: [], debts: [], savingsAccounts: [], retirementAccounts: [], savingsGoals: [] }
  };
}

function buildDefaultPaymentPlan(){
  return { columns: [], rows: [] };
}

/* =========================================================================
   STATE + PERSISTENCE
   ========================================================================= */
let DATA = null;
let state = { year: 2026, month: 'ALL' };
let charts = {};
const STORAGE_KEY = 'ledger:data:v1';

async function loadData(){
  try{
    const res = await window.storage.get(STORAGE_KEY, false);
    if(res && res.value){
      DATA = JSON.parse(res.value);
      // Migrate investments to have holdings arrays
      Object.keys(DATA).filter(k=>/^\d+$/.test(k)).forEach(y=>{
        if(DATA[y].investments){
          DATA[y].investments.forEach(inv=>{
            if(!inv.holdings) inv.holdings = [];
          });
        }
        // Migrate debts to have an explicit currency (defaults to USD so
        // existing data's math/formatting doesn't change).
        if(DATA[y].debts){
          DATA[y].debts.forEach(d=>{
            if(!d.currency) d.currency = 'USD';
          });
        }
        // Older saved data won't have these arrays yet at all.
        if(!DATA[y].savingsAccounts) DATA[y].savingsAccounts = [];
        if(!DATA[y].retirementAccounts) DATA[y].retirementAccounts = [];
        if(!DATA[y].savingsGoals) DATA[y].savingsGoals = [];
      });
      if(!DATA.paymentPlan) DATA.paymentPlan = buildDefaultPaymentPlan();
      if(!DATA.fxRateHistory) DATA.fxRateHistory = {};
      lastSavedSnapshot = JSON.stringify(DATA);
      return;
    }
  }catch(e){ /* not found or storage unavailable */ }
  DATA = buildDefaultData();
  DATA.paymentPlan = buildDefaultPaymentPlan();
  DATA.fxRateHistory = {};
  lastSavedSnapshot = JSON.stringify(DATA);
}

let isDirty = false;
let lastSavedSnapshot = null;
let dirtyTabs = new Set();
let pendingChanges = [];
let storageMode = 'unknown'; // 'connected' | 'unavailable' (API missing entirely) | 'failing' (API present but calls erroring)

function markDirty(tabId, changeDetail){
  isDirty = true;
  if(tabId) dirtyTabs.add(tabId);
  if(changeDetail){
    const last = pendingChanges[pendingChanges.length-1];
    if(!last || last.target !== changeDetail.target || last.tab !== changeDetail.tab || last.field !== changeDetail.field){
      pendingChanges.push(changeDetail);
    } else {
      last.newVal = changeDetail.newVal;
      last.detail = changeDetail.detail || `${last.oldVal} → ${changeDetail.newVal}`;
    }
  }
  updateSaveUI();
}

async function probeStorage(){
  if(typeof window.storage === 'undefined'){
    storageMode = 'unavailable';
    updateSaveUI();
    return;
  }
  try{
    const res = await window.storage.set('ledger:probe', String(Date.now()), false);
    storageMode = res ? 'connected' : 'failing';
  }catch(e){ storageMode = 'failing'; }
  updateSaveUI();
}

async function persistData(silent, attempt){
  attempt = attempt || 1;
  if(typeof window.storage === 'undefined'){
    storageMode = 'unavailable';
    updateSaveUI();
    if(!silent) showToast("This page has no connection to Claude's storage right now, so nothing outside this tab will remember your edits. Export data regularly to keep a real backup.");
    return;
  }
  try{
    const res = await window.storage.set(STORAGE_KEY, JSON.stringify(DATA), false);
    if(!res) throw new Error('empty response from storage');
    lastSavedSnapshot = JSON.stringify(DATA);
    isDirty = false;
    dirtyTabs.clear();
    storageMode = 'connected';
    updateSaveUI();
    let summary = 'Saved changes';
    let detailsToSave = [];
    if(pendingChanges.length > 0){
      detailsToSave = pendingChanges.slice();
      const byTab = {};
      pendingChanges.forEach(c => {
        if(!byTab[c.tab]) byTab[c.tab] = {edit:0, add:0, delete:0, items:new Set()};
        byTab[c.tab][c.action] = (byTab[c.tab][c.action] || 0) + 1;
        byTab[c.tab].items.add(c.target);
      });
      const parts = Object.entries(byTab).map(([tab, info]) => {
        const pieces = [];
        if(info.edit) pieces.push(`${info.edit} edit${info.edit>1?'s':''}`);
        if(info.add) pieces.push(`${info.add} added`);
        if(info.delete) pieces.push(`${info.delete} deleted`);
        const itemList = Array.from(info.items).slice(0,2).join(', ') + (info.items.size>2 ? ` +${info.items.size-2} more` : '');
        return `${tab.charAt(0).toUpperCase()+tab.slice(1)}: ${pieces.join(', ')} (${itemList})`;
      });
      summary = parts.join(' | ');
      pendingChanges = [];
    }
    logChange(summary + (silent ? ' (auto)' : ''), detailsToSave);
    if(!silent) showToast('Saved');
  }catch(e){
    if(attempt < 3){
      await new Promise(r=>setTimeout(r, attempt*800));
      return persistData(silent, attempt+1);
    }
    storageMode = 'failing';
    updateSaveUI();
    if(!silent) showToast('Still could not save after a few tries. Your changes are safe in this tab for now — try again shortly, or click Export data to keep a backup you can reload later.');
  }
}

function discardChanges(){
  if(!lastSavedSnapshot) return;
  DATA = JSON.parse(lastSavedSnapshot);
  isDirty = false;
  dirtyTabs.clear();
  updateSaveUI();
  renderActive();
  showToast('Changes discarded');
}

function updateSaveUI(){
  const bar = document.getElementById('saveBar');
  const discardBtn = document.getElementById('saveBarDiscardBtn');
  const saveBtn = document.getElementById('saveBarSaveBtn');
  if(bar){
    const msgEl = bar.querySelector('.save-bar-msg');
    if(storageMode==='unavailable'){
      bar.classList.add('show');
      if(msgEl) msgEl.innerHTML = "No connection to persistent storage in this view — changes stay in this tab only. <b>Export data</b> now and then to keep a real backup.";
      if(discardBtn) discardBtn.style.display='none';
      if(saveBtn) saveBtn.style.display='none';
    } else if(storageMode==='failing'){
      bar.classList.add('show');
      if(msgEl) msgEl.textContent = "Couldn't reach storage on the last attempt — your edits are still here. Try Save again, or Export data as a backup.";
      if(discardBtn) discardBtn.style.display='';
      if(saveBtn) saveBtn.style.display='';
    } else {
      bar.classList.toggle('show', isDirty);
      if(msgEl) msgEl.textContent = 'You have unsaved changes.';
      if(discardBtn) discardBtn.style.display='';
      if(saveBtn) saveBtn.style.display='';
    }
  }
  const headerBtn = document.getElementById('headerSaveBtn');
  if(headerBtn){
    headerBtn.classList.toggle('primary', isDirty && storageMode!=='unavailable');
    if(storageMode==='unavailable'){
      headerBtn.textContent = '⚠ No storage'; headerBtn.title = "This view has no connection to persistent storage — use Export data instead.";
      headerBtn.disabled = true; headerBtn.style.opacity='0.5';
    } else {
      headerBtn.disabled = false; headerBtn.style.opacity='1';
      headerBtn.title = storageMode==='failing' ? 'Last save failed — click to retry' : 'Save all changes now';
      headerBtn.textContent = storageMode==='failing' ? '⚠ Retry save' : (isDirty ? '● Save changes' : 'Save');
    }
  }
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* =========================================================================
   CHANGE / ACCESS LOGS — kept for the last 15 days, shown on the Data tab
   ========================================================================= */
const CHANGELOG_KEY = 'ledger:changelog:v1';
const ACCESSLOG_KEY = 'ledger:accesslog:v1';
let changeLog = [];
let accessLog = [];
function pruneOld(list){
  const cutoff = Date.now() - 15*24*60*60*1000;
  return list.filter(e=>e.ts>=cutoff);
}
async function loadLogs(){
  try{ const r = await window.storage.get(CHANGELOG_KEY, false); changeLog = r&&r.value ? JSON.parse(r.value) : []; }catch(e){ changeLog=[]; }
  try{ const r = await window.storage.get(ACCESSLOG_KEY, false); accessLog = r&&r.value ? JSON.parse(r.value) : []; }catch(e){ accessLog=[]; }
  changeLog = pruneOld(changeLog);
  accessLog = pruneOld(accessLog);
}
async function logChange(summary, details){
  changeLog.unshift({ts:Date.now(), summary, details: details || []});
  changeLog = pruneOld(changeLog).slice(0,200);
  try{ await window.storage.set(CHANGELOG_KEY, JSON.stringify(changeLog), false); }catch(e){}
}
async function logAccess(role){
  let locationText = 'location unavailable';
  // try{
  //   const pos = await new Promise((res,rej)=>{
  //     if(!navigator.geolocation) return rej();
  //     navigator.geolocation.getCurrentPosition(res, rej, {timeout:2500});
  //   });
  //   locationText = pos.coords.latitude.toFixed(2)+', '+pos.coords.longitude.toFixed(2);
  // }catch(e){ /* denied, unavailable, or timed out — logged without location */ }
  accessLog.unshift({ts:Date.now(), role, locationText});
  accessLog = pruneOld(accessLog).slice(0,200);
  try{ await window.storage.set(ACCESSLOG_KEY, JSON.stringify(accessLog), false); }catch(e){}
}

/* =========================================================================
   HELPERS: numbers, sums, formatting
   ========================================================================= */
function num(v){ return (typeof v === 'number' && !isNaN(v)) ? v : 0; }
/* Display-time safety net for binary floating-point artifacts (590+69.82
   style additions can land on 659.8199999999999) — these are always
   currency amounts, so round to the cent before showing raw values in
   editable cells that don't go through fmt$. */
function roundCents(v){
  if(v===null || v===undefined || v==='') return v;
  const n = Number(v);
  return isNaN(n) ? v : Math.round((n + Number.EPSILON) * 100) / 100;
}
function sumArr(arr){ return arr.reduce((a,b)=>a+num(b),0); }

/* =========================================================================
   FX RATE HISTORY — locks each closed calendar month's own USD/INR rate so
   an INR entry doesn't silently reprice in USD every time the live rate
   drifts. No new external API call: this just remembers the rate that
   ensureFxRates() (tab-investments.js) already fetches, whether that
   fetch happened because you opened the app or a background refresh ran.

   Stored at DATA.fxRateHistory["YYYY-MM"] = { start, end, lastUpdatedDay }
   - start: the rate the FIRST time this month was seen.
   - end:   the rate the MOST RECENT time this month was seen — this gets
            overwritten every new day while the month is still open (today
            → tomorrow → the day after, etc.), and simply stops being
            touched once the month has passed, so it freezes into that
            month's real closing sample automatically — no extra step.
   ========================================================================= */
function ensureFxRateHistory(){
  if(DATA && !DATA.fxRateHistory) DATA.fxRateHistory = {};
}
function fxMonthKey(year, monthIdx){
  return year + '-' + String(monthIdx+1).padStart(2,'0');
}
/* ---------- Timezone-safe date helpers (used app-wide) ----------
   new Date("YYYY-MM-DD") parses as UTC midnight; calling .getMonth()/
   .getDate()/.getFullYear() on it then reads it back in the browser's
   LOCAL time. For anyone west of Greenwich that can roll the 1st of the
   month back into the previous month; .toISOString() on a locally-built
   midnight Date has the mirror problem east of Greenwich (e.g. India),
   silently shifting a date back by one day. These avoid any UTC
   conversion at all, so what you typed/see is exactly what gets stored. */
function parseLocalDateParts(dateStr){
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  return { year: yy, monthIdx: mm-1, day: dd };
}
function toLocalISODate(d){
  const yy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return yy+'-'+mm+'-'+dd;
}
function todayDateStr(){
  return toLocalISODate(new Date());
}
/* Call this whenever a fresh LIVE rate comes back from the FX API (not on
   a fallback/failure — we don't want an outage's placeholder rate getting
   written into history as if it were real). */
function recordFxRateSample(rate){
  if(!rate || !isFinite(rate) || !DATA) return;
  ensureFxRateHistory();
  const now = new Date();
  const key = fxMonthKey(now.getFullYear(), now.getMonth());
  const today = todayDateStr();
  const existing = DATA.fxRateHistory[key];
  let changed = false;
  if(!existing){
    DATA.fxRateHistory[key] = { start: rate, end: rate, lastUpdatedDay: today };
    changed = true;
  } else if(existing.lastUpdatedDay !== today){
    existing.end = rate;
    existing.lastUpdatedDay = today;
    changed = true;
  }
  // Same day, already sampled today — leave it alone so the day's locked
  // rate stays stable instead of jittering with every extra refresh.
  if(changed && typeof persistData === 'function'){
    // This is something the APP did, not something YOU did — save it
    // quietly in the background instead of marking the app "dirty" (which
    // would otherwise prompt a save/discard dialog the next time you
    // switch tabs, just for visiting a page that happened to refresh
    // the exchange rate).
    persistData(true).catch(()=>{});
  }
}
/* The rate to use for a specific calendar month's INR entries:
   - the month we're currently in (no "end" sample yet, still moving)
     or a future month → live rate, exactly as before this feature existed
   - a closed past month we have a history record for → midpoint of that
     month's start/end samples
   - a closed past month with NO history record (predates this feature,
     or the app simply wasn't opened that month) → live rate, same
     graceful fallback as today */
function fxRateForMonth(year, monthIdx){
  const liveRate = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : (typeof FX_FALLBACK_INR !== 'undefined' ? FX_FALLBACK_INR : 84.0);
  if(year===undefined || year===null || monthIdx===undefined || monthIdx===null) return liveRate;
  const now = new Date();
  const curKey = fxMonthKey(now.getFullYear(), now.getMonth());
  const key = fxMonthKey(year, monthIdx);
  if(key >= curKey) return liveRate;
  const rec = DATA && DATA.fxRateHistory && DATA.fxRateHistory[key];
  if(!rec) return liveRate;
  return (rec.start + rec.end) / 2;
}
/* Convert one month's native-currency figure to USD, locked to that
   month's own rate instead of today's live rate. Non-INR passes through
   unchanged, same as every other *ToUsd helper in this file. */
/* ---------- Bank / credit-card running balance (carry-forward) ----------
   A bank's monthly array only has an entry in the months you actually typed
   or logged a transaction — every other month is blank by default. Reading
   that cell literally would make a bank's balance look empty/zero in any
   month you didn't touch it, even though the money obviously didn't
   disappear. These walk backward to the last month that actually has a
   value, so "this month's balance" means the real running balance, not
   "whatever happens to be typed in this exact cell." */
/* INTERNAL ONLY — carries a balance forward from the last month that has an
   explicit value. Do NOT use this for anything the user sees: a blank month
   showing an old month's number (with no visible transaction to explain it)
   is exactly the confusing behavior we removed. This is kept only for
   openAddMoneyModal(), and even there it's gated behind
   bankHasTransactionLog() — see that call site for why. */
function bankNativeValueAt(bank, monthIdx){
  const arr = bank && bank.m;
  if(!arr) return null;
  for(let i=monthIdx; i>=0; i--){
    if(arr[i]!==null && arr[i]!==undefined) return arr[i];
  }
  return null;
}
function bankBalanceUsdAt(bank, year, monthIdx){
  const native = bankNativeValueAt(bank, monthIdx);
  if(native===null) return null;
  return nativeMonthToUsd(native, bank.currency, year, monthIdx);
}
/* Used ONLY by openAddMoneyModal() to decide what "already there" means for
   the month being edited. An explicit value already sitting in that exact
   month (e.g. typed straight into the Advanced table) always wins. Only when
   that month is genuinely blank do we consider borrowing an earlier month's
   balance — and only if bankHasTransactionLog() says this account actually
   has real transaction history to justify it; otherwise the month starts
   from $0, matching what's displayed everywhere. */
function bankCarryValueAt(bank, monthIdx){
  const arr = bank && bank.m;
  if(!arr) return 0;
  if(arr[monthIdx]!==null && arr[monthIdx]!==undefined) return arr[monthIdx];
  if(!bankHasTransactionLog(bank)) return 0;
  return bankNativeValueAt(bank, monthIdx) ?? 0;
}
/* Does this account have any logged transaction, ever (any month)? Used to
   decide whether "+ Add money" is allowed to carry forward a real balance,
   or must start from $0 — see openAddMoneyModal(). */
function bankHasTransactionLog(bank){
  return !!(bank && bank.transactions && bank.transactions.length);
}
/* DISPLAY VALUE — what every card, table, modal, and reconciliation row
   should show. A month with nothing explicitly entered carries forward the
   last real balance (same as a bank statement would) IF this account has
   ever had a logged transaction (bankHasTransactionLog) — otherwise it's a
   genuine $0 (a brand-new account with nothing typed in yet has no balance
   to carry). This always returns a number (never null) so callers don't
   need a `|| 0` fallback. Currency-agnostic — applies the same to INR and
   USD accounts alike. */
function bankDisplayValueAt(bank, monthIdx){
  return bankCarryValueAt(bank, monthIdx);
}
function bankDisplayUsdAt(bank, year, monthIdx){
  return nativeMonthToUsd(bankDisplayValueAt(bank, monthIdx), bank.currency, year, monthIdx);
}

/* ---------------------------------------------------------------------
   Cash accounts and credit cards both carry forward for a blank month —
   every shared render path (summary cards, Advanced table, detail modal,
   Add money) should go through THESE dispatchers rather than picking a
   bank-only or credit-only helper directly:
     - Cash (checking/savings/other): a blank month carries the last real
       balance forward, same as a bank statement, as long as the account
       has at least one logged transaction to justify it (bankCarryValueAt);
       a fresh account with nothing entered yet is a genuine $0.
     - Credit card: debt doesn't reset itself. A blank month carries the
       real owed balance forward from the last month you logged a charge
       or payment — exactly like a bank statement would.
   --------------------------------------------------------------------- */
function accountDisplayValueAt(bank, monthIdx){
  if(bank && bank.type==='credit') return bankNativeValueAt(bank, monthIdx) ?? 0;
  return bankDisplayValueAt(bank, monthIdx);
}
function accountDisplayUsdAt(bank, year, monthIdx){
  return nativeMonthToUsd(accountDisplayValueAt(bank, monthIdx), bank.currency, year, monthIdx);
}
function accountCarryValueAt(bank, monthIdx){
  // Add Money / Add Charge base for "what's already there this month".
  // Credit cards always carry the real owed balance in (debt persists
  // regardless of whether it was set via a logged transaction or typed
  // straight into the Advanced table); cash only carries when there's a
  // real transaction log to justify it — see bankCarryValueAt().
  if(bank && bank.type==='credit') return bankNativeValueAt(bank, monthIdx) ?? 0;
  return bankCarryValueAt(bank, monthIdx);
}

function nativeMonthToUsd(v, currency, year, monthIdx){
  const n = num(v);
  if(currency !== 'INR') return n;
  return n / fxRateForMonth(year, monthIdx);
}
/* Same idea for a full 12-slot monthly array — sums each month's own USD
   conversion rather than summing native values first and applying one
   blanket rate to the total. */
function monthlyArrToUsd(arr, currency, year){
  return sumArr((arr||[]).map((v,i)=> nativeMonthToUsd(v, currency, year, i)));
}
/* Shared hover-tooltip text for any monthly INR cell (Savings, Goals,
   Retirement, Debt — Investments has its own richer version in
   tab-investments.js since it also needs to show math breakdowns).
   Returns null for USD/empty cells (nothing worth showing). */
function monthCellFxTip(nativeValue, currency, year, monthIdx){
  if(currency !== 'INR' || nativeValue===null || nativeValue===undefined || nativeValue==='') return null;
  const usd = nativeMonthToUsd(nativeValue, currency, year, monthIdx);
  const rate = fxRateForMonth(year, monthIdx);
  const curKey = fxMonthKey(new Date().getFullYear(), new Date().getMonth());
  const key = fxMonthKey(year, monthIdx);
  const isLocked = key < curKey && DATA && DATA.fxRateHistory && DATA.fxRateHistory[key];
  const rateLabel = isLocked
    ? `at ${MONTHS[monthIdx]} ${year}'s locked rate (₹${rate.toFixed(2)}/$)`
    : `at current rate (₹${rate.toFixed(2)}/$)`;
  return (typeof fmtInr === 'function' ? fmtInr(nativeValue) : ('₹'+nativeValue)) + '\n≈ ' + fmt$(usd,2) + ' ' + rateLabel;
}

/* Debts (like investments) can be entered in native currency (USD/INR).
   d.total / d.cleared / d.emi / d.m[] are always stored in that native
   currency — this converts to USD wherever a figure is combined with USD
   totals (Overview, KPIs, charts), so an INR debt is never added straight
   into a USD sum. */
function debtToUsd(v, d){
  const n = num(v);
  return (d && d.currency === 'INR') ? inrToUsd(n) : n;
}
function debtClearedToDate(d){
  const y = state.year;
  return debtToUsd(num(d.cleared), d) + monthlyArrToUsd(d.m||[], d.currency, y);
}
function debtPendingCalc(d){ return Math.max(debtToUsd(d.total, d) - debtClearedToDate(d), 0); }
function debtOriginalUsd(d){ return debtToUsd(d.total, d); }
function fmt$(v, decimals){
  decimals = decimals===undefined? 0 : decimals;
  const neg = v<0;
  const s = Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:decimals, maximumFractionDigits:decimals});
  return (neg? '-$':'$')+s;
}
/* Format a value in ITS OWN native currency with the correct symbol (₹ for
   INR, $ for everything else) — for anywhere we're showing an account's own
   number (bank balance, credit limit, a logged transaction amount) rather
   than a cross-currency total. Using fmt$() on a native INR figure was
   showing "$1,149.87" for an INR account — right number, wrong symbol,
   and misleading since it looked like (but wasn't) a USD amount. */
function fmtNative(v, currency){
  if(v===null || v===undefined) v = 0;
  if(currency === 'INR'){
    const neg = v<0;
    const s = Math.abs(v).toLocaleString('en-IN',{minimumFractionDigits:2, maximumFractionDigits:2});
    return (neg? '-₹':'₹')+s;
  }
  return fmt$(v, 2);
}
function pct(v){ return (v*100).toFixed(1)+'%'; }
function monthRange(){
  return state.month==='ALL' ? [0,1,2,3,4,5,6,7,8,9,10,11] : [Number(state.month)];
}
function yearData(y){ return DATA[y] || DATA[state.year]; }

function groupTotals(group){ // sum across categories per month -> array[12]
  const out = n12().map(()=>0);
  group.categories.forEach(c=>{ c.m.forEach((v,i)=> out[i]+=num(v)); });
  return out;
}
function incomeTotals(y){
  const out = n12().map(()=>0);
  yearData(y).income.forEach(c=> c.m.forEach((v,i)=> out[i]+=num(v)));
  return out;
}
function expenseTotalsAllGroups(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function expenseTotalsCounted(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    if(g.excludeFromTotal) return;
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function expenseTotalsExcluded(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    if(!g.excludeFromTotal) return;
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function investContribTotals(y){
  const out = n12().map(()=>0);
  yearData(y).investments.forEach(inv=> inv.m.forEach((v,i)=> {
    out[i] += nativeMonthToUsd(v, inv.currency, y, i);
  }));
  return out;
}

/* =========================================================================
   RETIREMENT ACCOUNTS (401k / IRA / etc.) — lives inside the Savings tab.
   Two parallel monthly streams per account: what YOU put in (mSelf) and what
   your employer matched (mEmployer) — kept separate everywhere since the
   employer portion never passed through your income/cash flow, so it must
   never get counted as "your money" in Sankey/cash-flow math, only as an
   asset once it's actually in the account.
   priorSelf/priorEmployer hold everything contributed before you started
   tracking here (same pattern as a debt's `cleared` field), so switching
   years or starting mid-year doesn't lose your real total.
   ========================================================================= */
function ensureRetirementMigration(){
  const y = state.year;
  if(!yearData(y).retirementAccounts) yearData(y).retirementAccounts = [];
  yearData(y).retirementAccounts.forEach(r=>{
    if(!r.mSelf) r.mSelf = n12();
    if(!r.mEmployer) r.mEmployer = n12();
    if(r.priorSelf===undefined || r.priorSelf===null) r.priorSelf = 0;
    if(r.priorEmployer===undefined || r.priorEmployer===null) r.priorEmployer = 0;
    if(!r.currency) r.currency = 'USD';
    if(r.returnRate===undefined || r.returnRate===null) r.returnRate = 0;
  });
}
function retirementToUsd(v, r){
  const n = num(v);
  return (r && r.currency === 'INR') ? inrToUsd(n) : n;
}
/* Simple estimate: this year's expected growth if the current balance
   compounds at the account's stated annual return/interest rate — same
   "estimate off today's balance" approach the Savings tab uses for its
   interest column. */
function retirementProjectedAnnualGrowth(r){
  return retirementAccountTotalBalance(r) * (num(r.returnRate)/100);
}
/* This YEAR's self-contribution only, per month, in USD — used by the
   Overview Sankey ("where money went") and matches how investContribTotals
   already works. Employer match is intentionally excluded here. */
function retirementSelfContribTotals(y){
  const out = n12().map(()=>0);
  (yearData(y).retirementAccounts||[]).forEach(r=> (r.mSelf||[]).forEach((v,i)=> out[i]+=nativeMonthToUsd(v, r.currency, y, i)));
  return out;
}
function retirementAccountTotalSelf(r){
  const y = state.year;
  return retirementToUsd(num(r.priorSelf), r) + monthlyArrToUsd(r.mSelf||[], r.currency, y);
}
function retirementAccountTotalEmployer(r){
  const y = state.year;
  return retirementToUsd(num(r.priorEmployer), r) + monthlyArrToUsd(r.mEmployer||[], r.currency, y);
}
function retirementAccountTotalBalance(r){ return retirementAccountTotalSelf(r) + retirementAccountTotalEmployer(r); }

/* =========================================================================
   SAVINGS GOALS — a goal can either LINK to an existing savings account
   (progress auto-tracks that account's balance) or track contributions on
   its own monthly grid when it isn't tied to one real account.
   ========================================================================= */
function ensureGoalsMigration(){
  const y = state.year;
  if(!yearData(y).savingsGoals) yearData(y).savingsGoals = [];
  yearData(y).savingsGoals.forEach(g=>{
    if(!g.m) g.m = n12();
    if(g.targetAmount===undefined || g.targetAmount===null) g.targetAmount = 0;
    if(!g.currency) g.currency = 'USD';
    if(g.linkedAccountId===undefined) g.linkedAccountId = null;
    if(!g.icon) g.icon = '🎯';
  });
}
function goalLinkedAccount(goal, accounts){
  return goal.linkedAccountId ? (accounts||[]).find(a=>a.id===goal.linkedAccountId) || null : null;
}
// A linked goal is denominated in whatever currency the linked account uses
// (it IS that account's balance) — only an unlinked goal uses its own field.
function goalEffectiveCurrency(goal, accounts){
  const acc = goalLinkedAccount(goal, accounts);
  return acc ? (acc.currency||'USD') : (goal.currency||'USD');
}
function goalTargetUsd(goal, accounts){
  const cur = goalEffectiveCurrency(goal, accounts);
  return cur==='INR' ? inrToUsd(num(goal.targetAmount)) : num(goal.targetAmount);
}
function goalContributedUsd(goal, accounts, monthIdx){
  const cur = goalEffectiveCurrency(goal, accounts);
  const acc = goalLinkedAccount(goal, accounts);
  const y = state.year;
  if(acc){
    const i = monthIdx>=0 ? monthIdx : 0;
    const native = num((acc.m||[])[i]);
    return cur==='INR' ? nativeMonthToUsd(native, cur, y, i) : native;
  }
  return monthlyArrToUsd(goal.m||[], cur, y);
}

function sumRange(arr, months){ return months.reduce((a,i)=>a+num(arr[i]),0); }

function findLatestMonthWithData(y){
  const inc = incomeTotals(y), exp = expenseTotalsAllGroups(y);
  let last = 0;
  for(let i=0;i<12;i++){ if(inc[i]>0 || exp[i]>0) last=i; }
  return last;
}
/* "What month should count as 'right now' for a snapshot figure?" — Cash on
   Hand, Net Worth, latest Savings/Goals balance, etc. all need to answer
   this. For the CURRENT calendar year this is always today's actual
   month — never a future month, even if it already has data entered (e.g.
   pre-filling December while it's still August). For a past year there's
   no "today" inside it, so it falls back to the latest month that
   actually has data. findLatestMonthWithData() itself stays a plain
   data-scanner; this is the "don't jump into the future" wrapper around it.
*/
function currentSnapshotMonth(y){
  const today = new Date();
  if(y === today.getFullYear()) return today.getMonth();
  const latest = findLatestMonthWithData(y);
  return latest>=0 ? latest : today.getMonth();
}

/* =========================================================================
   BUDGET: a target per category, per month — separate from (and never
   overwriting) the actual amounts Income/Expenses already track. Adds
   `budget:[12]` to every income/expense category the first time it's touched,
   and `budgetType` ('fixed'|'flexible'|'nonmonthly') to every expense group
   so the Budget tab can roll spending up the same way Monarch-style budget
   views do. Existing data is never modified beyond adding these new fields.
   ========================================================================= */
function ensureBudgetMigration(y){
  const yd = yearData(y);
  (yd.income||[]).forEach(c=>{ if(!Array.isArray(c.budget)) c.budget = n12(); });
  (yd.expenseGroups||[]).forEach(g=>{
    if(g.budgetType !== 'fixed' && g.budgetType !== 'flexible' && g.budgetType !== 'nonmonthly'){
      g.budgetType = 'flexible';
    }
    (g.categories||[]).forEach(c=>{ if(!Array.isArray(c.budget)) c.budget = n12(); });
  });
}

/* =========================================================================
   CASH FLOW: income minus categorized spend minus card bill payments minus
   debt payments, carried month to month (and year to year). Every figure
   can be overridden per month directly in the Cash Flow table.
   ========================================================================= */
function debtPaymentTotals(y){
  const out = n12().map(()=>0);
  yearData(y).debts.forEach(d=> d.m.forEach((v,i)=> out[i]+=nativeMonthToUsd(v, d.currency, y, i)));
  return out;
}
function cfOverride(y, i, field){
  const yd = yearData(y);
  const o = yd.cashFlowOverrides && yd.cashFlowOverrides[i];
  return (o && o[field]!==undefined && o[field]!==null) ? o[field] : undefined;
}
function setCfOverride(y, i, field, value){
  const yd = yearData(y);
  if(!yd.cashFlowOverrides) yd.cashFlowOverrides = {};
  if(!yd.cashFlowOverrides[i]) yd.cashFlowOverrides[i] = {};
  if(value===null || value===undefined){ delete yd.cashFlowOverrides[i][field]; }
  else { yd.cashFlowOverrides[i][field] = value; }
}
function getAutoYearStart(y){
  const prevY = y-1;
  if(DATA[prevY]) return computeCashFlow(prevY)[11].carryOut;
  return 0;
}
function computeCashFlow(y){
  const incBase = incomeTotals(y), expBase = expenseTotalsCounted(y), cardBase = expenseTotalsExcluded(y), debtBase = debtPaymentTotals(y);
  // Your own retirement contribution already leaves your pocket the moment
  // it's diverted — the Sankey ("Where it went") already treats it as an
  // outflow of your income, so Cash Flow needs to agree, or that same
  // dollar amount silently double-counts into Net Worth (once as if it's
  // still cash, again as your retirement balance). Employer match is
  // deliberately excluded: it never passed through your income, so it
  // can't be a cash outflow of yours.
  const retBase = retirementSelfContribTotals(y);
  let running = getAutoYearStart(y);
  const rows = [];
  for(let i=0;i<12;i++){
    const income = cfOverride(y,i,'income') ?? incBase[i];
    const expenses = cfOverride(y,i,'expenses') ?? expBase[i];
    const card = cfOverride(y,i,'card') ?? cardBase[i];
    const debtPaid = cfOverride(y,i,'debtPaid') ?? debtBase[i];
    const retirement = cfOverride(y,i,'retirement') ?? retBase[i];
    const carryInOverride = cfOverride(y,i,'carryIn');
    const carryIn = carryInOverride!==undefined ? carryInOverride : running;
    const netFlow = income - expenses - card - debtPaid - retirement;
    const carryOut = carryIn + netFlow;
    rows.push({
      income, expenses, card, debtPaid, retirement, netFlow, carryIn, carryOut,
      incomeOverridden: cfOverride(y,i,'income')!==undefined,
      expensesOverridden: cfOverride(y,i,'expenses')!==undefined,
      cardOverridden: cfOverride(y,i,'card')!==undefined,
      debtPaidOverridden: cfOverride(y,i,'debtPaid')!==undefined,
      retirementOverridden: cfOverride(y,i,'retirement')!==undefined,
      carryInOverridden: carryInOverride!==undefined
    });
    running = carryOut;
  }
  return rows;
}

/* =========================================================================
   INIT / SHELL
   ========================================================================= */