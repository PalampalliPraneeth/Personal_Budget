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
    2026: { income: [], expenseGroups: [], investments: [], debts: [], savingsAccounts: [] },
    2025: { income: [], expenseGroups: [], investments: [], debts: [], savingsAccounts: [] }
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
      });
      if(!DATA.paymentPlan) DATA.paymentPlan = buildDefaultPaymentPlan();
      lastSavedSnapshot = JSON.stringify(DATA);
      return;
    }
  }catch(e){ /* not found or storage unavailable */ }
  DATA = buildDefaultData();
  DATA.paymentPlan = buildDefaultPaymentPlan();
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
function sumArr(arr){ return arr.reduce((a,b)=>a+num(b),0); }
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
  const clearedNative = num(d.cleared) + sumArr(d.m);
  return debtToUsd(clearedNative, d);
}
function debtPendingCalc(d){ return Math.max(debtToUsd(d.total, d) - debtClearedToDate(d), 0); }
function debtOriginalUsd(d){ return debtToUsd(d.total, d); }
function fmt$(v, decimals){
  decimals = decimals===undefined? 0 : decimals;
  const neg = v<0;
  const s = Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:decimals, maximumFractionDigits:decimals});
  return (neg? '-$':'$')+s;
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
    const raw = num(v);
    out[i] += (inv.currency === 'INR') ? inrToUsd(raw) : raw;
  }));
  return out;
}
function sumRange(arr, months){ return months.reduce((a,i)=>a+num(arr[i]),0); }

function findLatestMonthWithData(y){
  const inc = incomeTotals(y), exp = expenseTotalsAllGroups(y);
  const savings = (yearData(y).savingsAccounts || []);
  let last = -1;
  for(let i=0;i<12;i++){
    if(inc[i]>0 || exp[i]>0) last = i;
    if(savings.some(acc => num((acc.m||[])[i]) > 0)) last = i;
  }
  return last >= 0 ? last : 0;
}

/* =========================================================================
   CASH FLOW: income minus categorized spend minus card bill payments minus
   debt payments, carried month to month (and year to year). Every figure
   can be overridden per month directly in the Cash Flow table.
   ========================================================================= */
function debtPaymentTotals(y){
  const out = n12().map(()=>0);
  yearData(y).debts.forEach(d=> d.m.forEach((v,i)=> out[i]+=debtToUsd(v, d)));
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
  let running = getAutoYearStart(y);
  const rows = [];
  for(let i=0;i<12;i++){
    const income = cfOverride(y,i,'income') ?? incBase[i];
    const expenses = cfOverride(y,i,'expenses') ?? expBase[i];
    const card = cfOverride(y,i,'card') ?? cardBase[i];
    const debtPaid = cfOverride(y,i,'debtPaid') ?? debtBase[i];
    const carryInOverride = cfOverride(y,i,'carryIn');
    const carryIn = carryInOverride!==undefined ? carryInOverride : running;
    const netFlow = income - expenses - card - debtPaid;
    const carryOut = carryIn + netFlow;
    rows.push({
      income, expenses, card, debtPaid, netFlow, carryIn, carryOut,
      incomeOverridden: cfOverride(y,i,'income')!==undefined,
      expensesOverridden: cfOverride(y,i,'expenses')!==undefined,
      cardOverridden: cfOverride(y,i,'card')!==undefined,
      debtPaidOverridden: cfOverride(y,i,'debtPaid')!==undefined,
      carryInOverridden: carryInOverride!==undefined
    });
    running = carryOut;
  }
  return rows;
}

/* =========================================================================
   INIT / SHELL
   ========================================================================= */