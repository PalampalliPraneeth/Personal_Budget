/* =========================================================================
   HOLDINGS TAB — granular stock / MF / ETF / index / crypto tracking
   ========================================================================= */
const HOLDING_TYPES = ['stock','mf','etf','index','crypto','other'];

/* ---------- Recurring buy schedule helpers ---------- */
function _ordinal(n){
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function _clampDayOfMonth(day, year, month){ // month is 0-indexed, may be >11 (Date() normalizes)
  const lastDay = new Date(year, month+1, 0).getDate();
  return Math.min(day, lastDay);
}
function nextRecurringDate(daysOfMonth){
  if(!daysOfMonth || !daysOfMonth.length) return null;
  const sorted = [...daysOfMonth].sort((a,b)=>a-b);
  const today = new Date(); today.setHours(0,0,0,0);
  for(let i=0;i<25;i++){ // scan up to ~2 years ahead as a safety bound
    const y = today.getFullYear(), m = today.getMonth()+i;
    for(const d of sorted){
      const day = _clampDayOfMonth(d, y, m);
      const candidate = new Date(y, m, day);
      candidate.setHours(0,0,0,0);
      if(candidate >= today) return toLocalISODate(candidate);
    }
  }
  return null;
}
const RECUR_FREQ_LABEL = {
  daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks',
  monthly: 'Monthly', quarterly: 'Quarterly', daysOfMonth: null // built from daysOfMonth instead
};
/* Old plans saved before frequency types existed only ever had daysOfMonth —
   treat those as frequencyType 'daysOfMonth' automatically, no migration needed. */
function _normalizedRecurring(r){
  if(!r) return null;
  return { ...r, frequencyType: r.frequencyType || ((r.daysOfMonth && r.daysOfMonth.length) ? 'daysOfMonth' : 'monthly') };
}
function recurringScheduleLabel(r){
  const norm = _normalizedRecurring(r);
  if(!norm) return '—';
  if(norm.frequencyType === 'daysOfMonth') return (norm.daysOfMonth||[]).map(_ordinal).join(', ');
  return RECUR_FREQ_LABEL[norm.frequencyType] || norm.frequencyType;
}
/* Unified "what's the next date this fires" for every frequency type,
   matching what Robinhood (daily/weekly/biweekly/monthly, anchored to a
   start date) and AngelOne (daily/weekly/monthly SIPs) actually offer. */
function nextRecurringDateForPlan(r){
  const norm = _normalizedRecurring(r);
  if(!norm) return null;
  if(norm.frequencyType === 'daysOfMonth') return nextRecurringDate(norm.daysOfMonth);
  if(!norm.startDate) return null;
  const start = new Date(norm.startDate+'T00:00:00'); start.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);
  if(norm.frequencyType === 'monthly' || norm.frequencyType === 'quarterly'){
    const monthStep = norm.frequencyType === 'quarterly' ? 3 : 1;
    const anchorDay = start.getDate();
    for(let k=0; k<1000; k++){
      const y = start.getFullYear(), m = start.getMonth() + k*monthStep;
      const day = _clampDayOfMonth(anchorDay, y, m);
      const candidate = new Date(y, m, day);
      candidate.setHours(0,0,0,0);
      if(candidate >= today) return toLocalISODate(candidate);
    }
    return null;
  }
  const stepDays = norm.frequencyType === 'weekly' ? 7 : norm.frequencyType === 'biweekly' ? 14 : 1; // 'daily' falls through to 1
  if(start >= today) return toLocalISODate(start);
  const diffDays = Math.floor((today - start) / (1000*60*60*24));
  const stepsNeeded = Math.ceil(diffDays / stepDays);
  const next = new Date(start);
  next.setDate(next.getDate() + stepsNeeded*stepDays);
  return toLocalISODate(next);
}
function collectRecurringRows(y, platformId){ // platformId falsy = all platforms
  ensureHoldingsMigration();
  if(typeof ensureBanksMigration === 'function') ensureBanksMigration();
  const investments = yearData(y).investments || [];
  const allBanks = yearData(y).banks || [];
  const fx = _ensureFx().INR || 95.0;
  const out = [];
  investments.forEach(inv => {
    if(platformId && inv.id !== platformId) return;
    const isINR = inv.currency === 'INR';
    (inv.holdings || []).forEach(h => {
      if(!h.recurring || !h.recurring.active) return;
      const norm = _normalizedRecurring(h.recurring);
      const hasSchedule = norm.frequencyType === 'daysOfMonth' ? (norm.daysOfMonth && norm.daysOfMonth.length) : !!norm.startDate;
      if(!hasSchedule) return;
      const nextDate = nextRecurringDateForPlan(norm);
      const amount = num(norm.amount);
      const estShares = num(h.currentPrice) > 0 ? amount / num(h.currentPrice) : 0;
      const alreadyConfirmed = !!(nextDate && norm.lastConfirmedFor === nextDate);
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      const bankAccount = norm.bankAccountId ? allBanks.find(b => b.id === norm.bankAccountId) : null;
      out.push({
        platformId: inv.id, platformName: inv.name, holdingId: h.id,
        symbol: h.symbol, name: h.name,
        amount, dAmount: fmt(amount), tAmount: tip(amount),
        scheduleLabel: recurringScheduleLabel(norm),
        nextDate, estShares, alreadyConfirmed,
        bankAccountId: norm.bankAccountId || null,
        bankAccountName: bankAccount ? bankAccount.name : null
      });
    });
  });
  return out.sort((a,b) => (a.nextDate||'9999') < (b.nextDate||'9999') ? -1 : (a.nextDate||'9999') > (b.nextDate||'9999') ? 1 : 0);
}

/* ---------- Recurring buy modal ---------- */
function openRecurringModal(h, y, onSave, onRemove){
  const old = document.getElementById('recurModalOverlay');
  if(old) old.remove();

  const existing = _normalizedRecurring(h.recurring) || {};
  const selectedDays = new Set(existing.daysOfMonth || []);
  const todayISO = toLocalISODate(new Date());
  const hasExistingPlan = !!(h.recurring && h.recurring.active);

  // Funding account picker — cash accounts only (checking/savings/other), not
  // credit cards, since the point is "is there money sitting here to cover
  // this" (checked against the account's real balance on Overview).
  if(typeof ensureBanksMigration === 'function') ensureBanksMigration();
  const fundingAccounts = (yearData(y).banks || []).filter(b => b.type !== 'credit');
  const bankOptionsHtml = fundingAccounts.map(b =>
    `<option value="${b.id}" ${existing.bankAccountId===b.id?'selected':''}>${b.name}${b.currency && b.currency!=='USD' ? ' ('+b.currency+')' : ''}</option>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.id = 'recurModalOverlay';
  overlay.className = 'modal-overlay';
  const dayGrid = Array.from({length:31}, (_,i)=>i+1).map(d=>
    `<button type="button" class="recur-day-btn ${selectedDays.has(d)?'active':''}" data-day="${d}">${d}</button>`
  ).join('');
  const freqOptions = [
    ['daily','Daily'], ['weekly','Weekly'], ['biweekly','Every 2 weeks (biweekly)'],
    ['monthly','Monthly'], ['quarterly','Quarterly'], ['daysOfMonth','Specific day(s) of month']
  ];
  overlay.innerHTML = `
    <div class="modal-card" style="width:420px;">
      <h3>🔁 Recurring buy — ${h.symbol}</h3>
      <p class="modal-sub">Same frequency options Robinhood and AngelOne offer for scheduled buys/SIPs, plus specific-day(s) for anything more custom. Purely a tracker — nothing places an order automatically.</p>
      <div class="modal-field">
        <label>Amount per buy</label>
        <input type="number" id="recurAmount" value="${existing.amount||''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Frequency</label>
        <select id="recurFreqType" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${freqOptions.map(([v,label])=>`<option value="${v}" ${existing.frequencyType===v?'selected':''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="modal-field" id="recurStartDateWrap" style="display:${existing.frequencyType==='daysOfMonth'?'none':'block'};">
        <label>Start date</label>
        <input type="date" id="recurStartDate" value="${existing.startDate||todayISO}">
      </div>
      <div class="modal-field" id="recurDaysWrap" style="display:${existing.frequencyType==='daysOfMonth'?'block':'none'};">
        <label>Day(s) of month <span class="hint">tap to toggle, pick as many as you need</span></label>
        <div id="recurDayGrid" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">${dayGrid}</div>
      </div>
      <div class="modal-field">
        <label>Pay from account <span class="hint">optional — shown on Overview so you can see if the money's actually there</span></label>
        <select id="recurBankAccount" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;" ${fundingAccounts.length?'':'disabled'}>
          <option value="">— Not linked —</option>
          ${bankOptionsHtml}
        </select>
        ${!fundingAccounts.length ? '<div class="section-sub" style="margin-top:6px;">Add a bank or savings account on Cash Flow first to link one.</div>' : ''}
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        ${hasExistingPlan ? '<button class="btn danger-outline" id="recurRemoveBtn">Remove plan</button>' : '<span></span>'}
        <div style="display:flex; gap:10px;">
          <button class="btn" id="recurCancelBtn">Cancel</button>
          <button class="btn primary" id="recurSaveBtn">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const freqSelect = overlay.querySelector('#recurFreqType');
  const startDateWrap = overlay.querySelector('#recurStartDateWrap');
  const daysWrap = overlay.querySelector('#recurDaysWrap');
  freqSelect.addEventListener('change', ()=>{
    const isDaysOfMonth = freqSelect.value === 'daysOfMonth';
    startDateWrap.style.display = isDaysOfMonth ? 'none' : 'block';
    daysWrap.style.display = isDaysOfMonth ? 'block' : 'none';
  });

  overlay.querySelectorAll('.recur-day-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const d = parseInt(btn.dataset.day);
      if(selectedDays.has(d)){ selectedDays.delete(d); btn.classList.remove('active'); }
      else { selectedDays.add(d); btn.classList.add('active'); }
    });
  });

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#recurCancelBtn').addEventListener('click', close);

  const removeBtn = overlay.querySelector('#recurRemoveBtn');
  if(removeBtn) removeBtn.addEventListener('click', ()=>{ close(); onRemove(); });

  overlay.querySelector('#recurSaveBtn').addEventListener('click', ()=>{
    const amount = parseFloat(document.getElementById('recurAmount').value);
    if(!amount || amount<=0){ document.getElementById('recurAmount').focus(); return; }
    const frequencyType = freqSelect.value;
    const bankAccountId = document.getElementById('recurBankAccount').value || null;
    if(frequencyType === 'daysOfMonth'){
      if(!selectedDays.size){ showToast('Pick at least one day of the month'); return; }
      close();
      onSave({ frequencyType, amount, daysOfMonth: [...selectedDays].sort((a,b)=>a-b), bankAccountId });
    } else {
      const startDate = document.getElementById('recurStartDate').value;
      if(!startDate){ document.getElementById('recurStartDate').focus(); return; }
      close();
      onSave({ frequencyType, amount, startDate, bankAccountId });
    }
  });

  const firstDayBtn = overlay.querySelector('.recur-day-btn');
  if(firstDayBtn && !existing.amount) document.getElementById('recurAmount').focus();
}

/* ---------- Confirm-buy modal (turns a scheduled recurring occurrence into a real lot) ---------- */
function openConfirmBuyModal(h, scheduledDate, onConfirm){
  const old = document.getElementById('confirmBuyOverlay');
  if(old) old.remove();

  const defaultAmount = (h.recurring && h.recurring.amount) || 0;
  const defaultPrice = h.currentPrice || h.avgPrice || 0;

  const overlay = document.createElement('div');
  overlay.id = 'confirmBuyOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>✓ Confirm buy — ${h.symbol}</h3>
      <p class="modal-sub">Scheduled for ${scheduledDate}. Adjust below if the actual fill differed, then confirm to add it to your real position.</p>
      <div class="modal-field">
        <label>Amount</label>
        <input type="number" id="confirmAmount" value="${defaultAmount||''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Price / share</label>
        <input type="number" id="confirmPrice" value="${defaultPrice||''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="confirmDate" value="${scheduledDate}">
      </div>
      <div class="modal-preview">
        <span class="label">≈ Shares this adds</span>
        <span class="value" id="confirmSharesVal">—</span>
      </div>
      <div class="modal-actions">
        <button class="btn" id="confirmCancelBtn">Cancel</button>
        <button class="btn primary" id="confirmSaveBtn">Confirm buy</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const amountEl = overlay.querySelector('#confirmAmount');
  const priceEl = overlay.querySelector('#confirmPrice');
  const dateEl = overlay.querySelector('#confirmDate');
  const sharesEl = overlay.querySelector('#confirmSharesVal');

  function updatePreview(){
    const amt = parseFloat(amountEl.value)||0;
    const price = parseFloat(priceEl.value)||0;
    sharesEl.textContent = price > 0 ? (amt/price).toFixed(4) : '—';
  }
  updatePreview();
  amountEl.addEventListener('input', updatePreview);
  priceEl.addEventListener('input', updatePreview);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#confirmCancelBtn').addEventListener('click', close);

  overlay.querySelector('#confirmSaveBtn').addEventListener('click', ()=>{
    const amount = parseFloat(amountEl.value);
    const price = parseFloat(priceEl.value);
    const date = dateEl.value || scheduledDate;
    if(!amount || amount<=0){ amountEl.focus(); return; }
    if(!price || price<=0){ priceEl.focus(); return; }
    const qty = amount / price;
    close();
    onConfirm(qty, price, date);
  });

  amountEl.focus(); amountEl.select();
}

/* ---------- Quick Buy modal — a one-off purchase directly from the
   holdings row, without setting up a recurring schedule. Creates a proper
   dated lot, same as confirming a scheduled buy does, so XIRR and cost
   basis both stay accurate. ---------- */
function openQuickBuyModal(h, onConfirm){
  const old = document.getElementById('quickBuyOverlay');
  if(old) old.remove();

  const todayStr = toLocalISODate(new Date());
  const defaultPrice = h.currentPrice || h.avgPrice || 0;

  const overlay = document.createElement('div');
  overlay.id = 'quickBuyOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>+ Buy more — ${h.symbol}</h3>
      <p class="modal-sub">Records a new purchase as its own dated lot — this is what keeps XIRR and cost basis accurate, unlike typing directly into the Qty cell.</p>
      <div class="modal-field">
        <label>Quantity (shares)</label>
        <input type="number" id="qbQty" min="0" step="any" placeholder="0">
      </div>
      <div class="modal-field">
        <label>Price / share</label>
        <input type="number" id="qbPrice" value="${defaultPrice||''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="qbDate" value="${todayStr}">
      </div>
      <div class="modal-preview">
        <span class="label">Total cost</span>
        <span class="value" id="qbTotalVal">—</span>
      </div>
      <div class="modal-actions">
        <button class="btn" id="qbCancelBtn">Cancel</button>
        <button class="btn primary" id="qbSaveBtn">Add purchase</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const qtyEl = overlay.querySelector('#qbQty');
  const priceEl = overlay.querySelector('#qbPrice');
  const dateEl = overlay.querySelector('#qbDate');
  const totalEl = overlay.querySelector('#qbTotalVal');

  function updatePreview(){
    const qty = parseFloat(qtyEl.value)||0;
    const price = parseFloat(priceEl.value)||0;
    totalEl.textContent = (qty>0 && price>0) ? fmt$(qty*price,2) : '—';
  }
  updatePreview();
  qtyEl.addEventListener('input', updatePreview);
  priceEl.addEventListener('input', updatePreview);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#qbCancelBtn').addEventListener('click', close);

  overlay.querySelector('#qbSaveBtn').addEventListener('click', ()=>{
    const qty = parseFloat(qtyEl.value);
    const price = parseFloat(priceEl.value);
    const date = dateEl.value || todayStr;
    if(!qty || qty<=0){ qtyEl.focus(); return; }
    if(!price || price<=0){ priceEl.focus(); return; }
    close();
    onConfirm(qty, price, date);
  });

  qtyEl.focus();
}

/* ---------- Edit Lots modal ----------
   Lets you correct any past buy/sell directly — the fix for holdings that
   got their date wrong when first entered (e.g. dated "today" during setup
   even though you'd actually owned them for months). Changing a date/qty/
   price here directly affects cost basis and XIRR the next time they're
   computed, since both read straight from h.lots. ========================================================================= */
function openEditLotsModal(h){
  const old = document.getElementById('editLotsOverlay');
  if(old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'editLotsOverlay';
  overlay.className = 'modal-overlay';

  const lotsSorted = [...(h.lots||[])].sort((a,b)=> (a.date||'').localeCompare(b.date||''));

  const rowsHtml = lotsSorted.map(l => `
    <div class="lot-edit-row" data-lot-id="${l.id}">
      <select data-lot-field="type" data-lot-id="${l.id}">
        <option value="buy" ${l.type==='buy'?'selected':''}>Buy</option>
        <option value="sell" ${l.type==='sell'?'selected':''}>Sell</option>
      </select>
      <input type="number" data-lot-field="qty" data-lot-id="${l.id}" value="${l.qty}" step="any" placeholder="Qty">
      <input type="number" data-lot-field="price" data-lot-id="${l.id}" value="${l.price}" step="any" placeholder="Price">
      <input type="date" data-lot-field="date" data-lot-id="${l.id}" value="${l.date}">
      <span class="row-del" data-lot-delete="${l.id}" title="Remove this lot">✕</span>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div class="modal-card" style="width:540px;">
      <h3>📝 Edit lots — ${h.symbol}</h3>
      <p class="modal-sub">Correct the date, quantity, or price of any past purchase or sale — this is what fixes a holding that got dated "today" when you first entered it, even though you'd actually owned it for a while. Affects cost basis and XIRR immediately.</p>
      <div class="lot-edit-header">
        <span>Type</span><span>Qty</span><span>Price</span><span>Date</span><span></span>
      </div>
      <div style="max-height:300px; overflow-y:auto; margin-bottom:16px;">
        ${rowsHtml || '<div class="section-sub" style="text-align:center; padding:14px 0;">No lots recorded for this holding.</div>'}
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn" id="editLotsCancelBtn">Cancel</button>
        <button class="btn primary" id="editLotsSaveBtn">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#editLotsCancelBtn').addEventListener('click', close);

  // Deletions are staged locally (toggle-able) until Save is clicked, so a
  // misclick doesn't immediately destroy a lot.
  const toDelete = new Set();
  overlay.querySelectorAll('[data-lot-delete]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.lotDelete;
      const row = overlay.querySelector(`.lot-edit-row[data-lot-id="${id}"]`);
      if(toDelete.has(id)){
        toDelete.delete(id);
        row.style.opacity = '1';
        el.textContent = '✕';
      } else {
        toDelete.add(id);
        row.style.opacity = '0.35';
        el.textContent = '↺';
      }
    });
  });

  overlay.querySelector('#editLotsSaveBtn').addEventListener('click', ()=>{
    const updatedLots = [];
    lotsSorted.forEach(l=>{
      if(toDelete.has(l.id)) return;
      const row = overlay.querySelector(`.lot-edit-row[data-lot-id="${l.id}"]`);
      const type = row.querySelector('[data-lot-field="type"]').value;
      const qty = parseFloat(row.querySelector('[data-lot-field="qty"]').value) || 0;
      const price = parseFloat(row.querySelector('[data-lot-field="price"]').value) || 0;
      const date = row.querySelector('[data-lot-field="date"]').value || l.date;
      updatedLots.push({id: l.id, type, qty, price, date});
    });
    h.lots = updatedLots;
    recalcHolding(h);
    markDirty('holdings');
    close();
    renderHoldings();
    showToast(`Updated ${h.symbol} — ${updatedLots.length} lot${updatedLots.length===1?'':'s'}`);
  });
}


function _ensureFx(){
  if(typeof fxRates !== 'undefined' && fxRates && fxRates.INR) return fxRates;
  return { INR: 95.0 };
}

function _isIndianPlatform(inv){
  const n = (inv.name||'').toLowerCase();
  const c = (inv.category||'').toLowerCase();
  return c.includes('indian') || c.includes('angel') ||
         n.includes('zerodha') || n.includes('groww') || 
         n.includes('angel') || n.includes('loan') ||
         n.includes('coin by');
}

/* Auto-derives the "start of year" price for YTD math, instead of a manual
   field: uses the earliest portfolio snapshot recorded this year for that
   symbol (real historical data), falling back to avg cost if you haven't
   snapshotted yet. No UI entry needed — it just works off data you're
   already recording. */
function _ytdStartPriceFor(h){
  const sym = (h.symbol || '').toString().toUpperCase();
  const snaps = getPortfolioSnapshots(state.year);
  if(snaps.length && sym){
    const first = snaps.find(s => s.holdings && s.holdings[sym] && s.holdings[sym].price);
    if(first) return { price: first.holdings[sym].price, date: first.date };
  }
  return { price: h.avgPrice || 0, date: null };
}

function getPortfolioSnapshots(y){
  return yearData(y).portfolioSnapshots || [];
}
function filterSnapshots(snaps, timeframe){
  if(!snaps.length) return [];
  const now = new Date();
  let cutoff = new Date(0);
  switch(timeframe){
    case '1W': cutoff = new Date(now.getTime() - 7*24*60*60*1000); break;
    case '1M': cutoff = new Date(now.getTime() - 30*24*60*60*1000); break;
    case '3M': cutoff = new Date(now.getTime() - 90*24*60*60*1000); break;
    case '6M': cutoff = new Date(now.getTime() - 180*24*60*60*1000); break;
    case '1Y': cutoff = new Date(now.getTime() - 365*24*60*60*1000); break;
    case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
    default: return snaps;
  }
  return snaps.filter(s => new Date(s.date) >= cutoff);
}
function recordPortfolioSnapshot(y, silent){
  ensureHoldingsMigration();
  const snaps = yearData(y).portfolioSnapshots || [];
  const today = toLocalISODate(new Date());
  const all = aggregateAllHoldings(y);
  const totalValue = all.reduce((a,r)=>a+r.currentValue,0);
  const totalInvested = all.reduce((a,r)=>a+r.invested,0);
  const holdings = {};
  all.forEach(h => { holdings[h.symbol] = { value: h.currentValue, invested: h.invested, qty: h.qty, price: h.currentPrice }; });
  // Per-platform breakdown too, so an individual platform pill can show its
  // own history instead of always falling back to the consolidated total.
  const platforms = {};
  (yearData(y).investments || []).forEach(inv => {
    const platRows = platformHoldings(y, inv.id);
    const pValue = platRows.reduce((a,r)=>a+r.currentValueUSD,0);
    const pInvested = platRows.reduce((a,r)=>a+r.investedUSD,0);
    platforms[inv.id] = { totalValue: pValue, totalInvested: pInvested, totalPl: pValue-pInvested };
  });
  const filtered = snaps.filter(s => s.date !== today);
  filtered.push({date: today, totalValue, totalInvested, totalPl: totalValue-totalInvested, holdings, platforms});
  yearData(y).portfolioSnapshots = filtered.slice(-365); // keep last year of daily snaps
  markDirty('holdings');
  if(!silent) showToast('Snapshot recorded: '+today);
}

/* ---------- FX helpers ---------- */
/* Reuse the investments tab's live FX. If it hasn't loaded yet, trigger it. */
async function ensureHoldingsFx(){
  if(typeof ensureFxRates === 'function' && (!fxRates || !fxRates.INR)){
    await ensureFxRates();
  }
}

/* ---------- Last price refresh timestamp ---------- */
/* Written by both the daily server-side refresh (see
   supabase-functions/daily-price-refresh) and by a manual "Fetch live
   prices" click, so the displayed time is accurate either way. */
const PRICE_TIMESTAMP_KEY = 'ledger:pricesUpdatedAt:v1';
let _priceRefreshTimestamp = undefined; // undefined = not loaded yet, null = loaded, none recorded
async function ensurePriceRefreshTimestamp(){
  if(_priceRefreshTimestamp !== undefined) return;
  try{
    const res = await window.storage.get(PRICE_TIMESTAMP_KEY, false);
    _priceRefreshTimestamp = (res && res.value) ? res.value : null;
  }catch(e){ _priceRefreshTimestamp = null; }
}
async function recordPriceRefreshNow(){
  const nowIso = new Date().toISOString();
  try{ await window.storage.set(PRICE_TIMESTAMP_KEY, nowIso, false); }catch(e){}
  _priceRefreshTimestamp = nowIso;
}
function _formatPriceRefreshTimestamp(){
  if(_priceRefreshTimestamp === undefined) return 'checking…';
  if(_priceRefreshTimestamp === null) return 'never';
  try{ return new Date(_priceRefreshTimestamp).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); }
  catch(e){ return 'unknown'; }
}
function _toUsd(val, currency){
  if(currency !== 'INR') return num(val);
  const r = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : 95.0;
  return num(val) / r;
}
/* ---------- Watchlist ---------- */
/* A personal, platform-agnostic list of tickers you don't own (yet) but
   want to track. Lives at DATA.watchlist (global, not per-year — a
   watchlist isn't tied to any one tax/tracking year). */
function ensureWatchlistMigration(){
  if(!DATA.watchlist) DATA.watchlist = [];
  DATA.watchlist.forEach(w=>{
    if(w.region===undefined) w.region = 'US';
    if(w.targetPrice===undefined) w.targetPrice = null;
    if(w.notes===undefined) w.notes = '';
    if(w.currentPrice===undefined) w.currentPrice = null;
    if(w.dayChangePct===undefined) w.dayChangePct = null;
    if(w.fiftyTwoWeekHigh===undefined) w.fiftyTwoWeekHigh = null;
    if(w.fiftyTwoWeekLow===undefined) w.fiftyTwoWeekLow = null;
    if(w.prevClose===undefined) w.prevClose = null;
    if(w.volume===undefined) w.volume = null;
    if(w.lastFetched===undefined) w.lastFetched = null;
    if(w.priceFetchFailed===undefined) w.priceFetchFailed = false;
    if(!w.addedDate) w.addedDate = toLocalISODate(new Date());
  });
}
/* ---------- Live price fetch (best effort) ---------- */
function _extractPriceMeta(meta){
  const price = meta?.regularMarketPrice;
  const prevClose = meta?.previousClose || meta?.chartPreviousClose;
  let changePct = null;
  if(prevClose && prevClose > 0 && typeof price === 'number'){
    changePct = ((price - prevClose) / prevClose) * 100;
  }
  return {
    price, changePct,
    prevClose: prevClose ?? null,
    // Same Yahoo response already carries the 52-week range and day range —
    // no extra API call needed to get these.
    fiftyTwoWeekHigh: (typeof meta?.fiftyTwoWeekHigh === 'number') ? meta.fiftyTwoWeekHigh : null,
    fiftyTwoWeekLow: (typeof meta?.fiftyTwoWeekLow === 'number') ? meta.fiftyTwoWeekLow : null,
    dayHigh: (typeof meta?.regularMarketDayHigh === 'number') ? meta.regularMarketDayHigh : null,
    dayLow: (typeof meta?.regularMarketDayLow === 'number') ? meta.regularMarketDayLow : null,
    volume: (typeof meta?.regularMarketVolume === 'number') ? meta.regularMarketVolume : null,
  };
}
async function fetchLivePrice(symbol, isIndian){
  let yahooSym = symbol.toUpperCase().trim();
  if(isIndian && !yahooSym.endsWith('.NS') && !yahooSym.endsWith('.BO')){
    yahooSym = yahooSym + '.NS';
  }

  // Preferred path: your own serverless function does the Yahoo Finance call
  // server-to-server, so there's no browser CORS involved at all. Set
  // window.PRICE_PROXY_URL (e.g. in storage-bridge.js) to enable this —
  // see supabase-functions/fetch-price/README.md for a deployable example.
  if(typeof window !== 'undefined' && window.PRICE_PROXY_URL){
    try{
      const res = await fetch(`${window.PRICE_PROXY_URL}?symbol=${encodeURIComponent(yahooSym)}`);
      if(res.ok){
        const data = await res.json();
        if(typeof data.price === 'number' && data.price > 0){
          return {
            price: data.price,
            changePct: (typeof data.changePct === 'number') ? data.changePct : null,
            prevClose: (typeof data.prevClose === 'number') ? data.prevClose : null,
            fiftyTwoWeekHigh: (typeof data.fiftyTwoWeekHigh === 'number') ? data.fiftyTwoWeekHigh : null,
            fiftyTwoWeekLow: (typeof data.fiftyTwoWeekLow === 'number') ? data.fiftyTwoWeekLow : null,
            dayHigh: (typeof data.dayHigh === 'number') ? data.dayHigh : null,
            dayLow: (typeof data.dayLow === 'number') ? data.dayLow : null,
            volume: (typeof data.volume === 'number') ? data.volume : null,
          };
        }
      }
    }catch(e){ /* fall through to the public proxies below */ }
  }

  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`;
  const proxies = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?'
  ];
  for(const proxy of proxies){
    try{
      const res = await fetch(proxy + encodeURIComponent(target));
      const data = await res.json();
      const meta = data.chart?.result?.[0]?.meta;
      const out = _extractPriceMeta(meta);
      if(typeof out.price === 'number' && out.price > 0) return out;
    }catch(e){}
  }
  try{
    const res = await fetch(target);
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    const out = _extractPriceMeta(meta);
    if(typeof out.price === 'number' && out.price > 0) return out;
  }catch(e){}
  throw new Error('Could not fetch. Try entering the price manually.');
}

/* ---------- Data migration ---------- */
function ensureHoldingsMigration(){
  const y = state.year;
  if(!yearData(y).portfolioSnapshots) yearData(y).portfolioSnapshots = [];
  if(!yearData(y).investments) return;
  yearData(y).investments.forEach(inv => {
    if(!inv.currency) inv.currency = _isIndianPlatform(inv) ? 'INR' : 'USD';
    if(!inv.holdings) inv.holdings = [];
    inv.holdings.forEach(h => {
      if(!h.lots) h.lots = [];
      if(!h.dividends) h.dividends = [];
      if(!h.type) h.type = 'stock';
      if(!h.currency) h.currency = inv.currency || 'USD';
      h.lots.forEach(l => { if(!l.type) l.type = 'buy'; if(!l.id) l.id = uid(); });
      if(h.lots.length === 0 && (h.qty > 0 || h.avgPrice > 0)){
        h.lots.push({id: uid(), type:'buy', qty: num(h.qty), price: num(h.avgPrice), date: `${y}-01-01`});
      }
      recalcHolding(h);
    });
  });
}

function recalcHolding(h){
  const lots = (h.lots||[]).slice().sort((a,b)=> new Date(a.date||0) - new Date(b.date||0));
  let qty = 0, costBasis = 0, realizedPL = 0, boughtQty = 0, soldQty = 0, proceeds = 0, costBasisSold = 0, lastSellDate = null;
  lots.forEach(l=>{
    const lq = num(l.qty);
    if(l.type === 'sell'){
      const avgCost = qty > 0 ? costBasis/qty : 0;
      const sq = Math.min(lq, qty);
      const saleCost = sq*avgCost;
      realizedPL += sq*num(l.price) - saleCost;
      proceeds += sq*num(l.price);
      costBasisSold += saleCost;
      costBasis -= saleCost;
      qty -= sq;
      soldQty += sq;
      if(!lastSellDate || (l.date && l.date > lastSellDate)) lastSellDate = l.date;
    } else {
      qty += lq;
      costBasis += lq*num(l.price);
      boughtQty += lq;
    }
  });
  h.qty = qty;
  h.avgPrice = qty > 0 ? costBasis/qty : 0;
  h.realizedPL = realizedPL;
  h.totalBoughtQty = boughtQty;
  h.totalSoldQty = soldQty;
  h.avgSellPrice = soldQty > 0 ? proceeds/soldQty : 0;
  h.costBasisSold = costBasisSold;
  h.proceeds = proceeds;
  h.lastSellDate = lastSellDate;
  h.status = (qty > 0.0000001 || soldQty <= 0) ? 'open' : 'closed';
  if(!h.ytdStartPrice) h.ytdStartPrice = h.avgPrice;
}

/* =========================================================================
   XIRR — annualized return across irregular, dated cash flows. Standard
   finance formula: find the rate r that makes the net present value of
   every cash flow (buys = money out, sells/dividends = money in, plus
   today's market value if still holding) equal to zero:
     Σ CF_i / (1+r)^(days_i / 365) = 0
   There's no closed-form solution, so this solves it numerically:
   Newton-Raphson first (fast, usually converges in a handful of steps),
   falling back to bisection (slower, but always finds a root if one
   exists in a sane range) if Newton-Raphson fails to converge or leaves
   the valid domain (rate must stay > -100%).
   ========================================================================= */
function _xirrNpv(flows, rate, t0){
  return flows.reduce((sum, cf) => {
    const days = (cf.date - t0) / 86400000; // ms -> days
    return sum + cf.amount / Math.pow(1 + rate, days / 365);
  }, 0);
}
function _xirrNpvDerivative(flows, rate, t0){
  return flows.reduce((sum, cf) => {
    const t = (cf.date - t0) / 86400000 / 365;
    if(t === 0) return sum;
    return sum - (t * cf.amount) / Math.pow(1 + rate, t + 1);
  }, 0);
}
function calcXirr(cashflows){
  if(!cashflows) return null;
  const flows = cashflows.filter(cf => cf.amount && cf.date instanceof Date && !isNaN(cf.date.getTime()));
  if(flows.length < 2) return null; // not enough data points to have a "return" at all

  const hasPositive = flows.some(cf => cf.amount > 0);
  const hasNegative = flows.some(cf => cf.amount < 0);
  if(!hasPositive || !hasNegative) return null; // need both money-out and money-in to compute a rate

  const t0 = flows.reduce((min, cf) => cf.date < min ? cf.date : min, flows[0].date);
  if(flows.every(cf => cf.date.getTime() === t0.getTime())) return null; // no time elapsed -> "annualized" is meaningless

  // ---- Newton-Raphson ----
  let rate = 0.1, converged = false;
  for(let i=0; i<100; i++){
    const npv = _xirrNpv(flows, rate, t0);
    const dnpv = _xirrNpvDerivative(flows, rate, t0);
    if(Math.abs(dnpv) < 1e-12) break;
    const next = rate - npv / dnpv;
    if(!isFinite(next) || next <= -0.999999) break; // left the valid domain (rate > -100%)
    if(Math.abs(next - rate) < 1e-7){ rate = next; converged = true; break; }
    rate = next;
  }
  if(converged) return rate;

  // ---- Bisection fallback: slower, but guaranteed to converge if a root
  // exists between these bounds (covers cases Newton-Raphson overshoots on,
  // e.g. very short holding periods, extreme multi-baggers, or a near-total
  // loss — that last case needs the lower bound extremely close to -100%,
  // since losing almost everything means the true rate sits right at the
  // edge of the valid domain). ----
  let lo = -0.999999999, hi = 10;
  let npvLo = _xirrNpv(flows, lo, t0), npvHi = _xirrNpv(flows, hi, t0);
  if(!isFinite(npvLo) || !isFinite(npvHi) || (npvLo > 0) === (npvHi > 0)){
    hi = 100; // widen once for extreme gains before giving up
    npvHi = _xirrNpv(flows, hi, t0);
    if(!isFinite(npvHi) || (npvLo > 0) === (npvHi > 0)) return null; // no sign change -> no solution in a sane range
  }
  for(let i=0; i<200; i++){
    const mid = (lo + hi) / 2;
    const npvMid = _xirrNpv(flows, mid, t0);
    if(Math.abs(npvMid) < 1e-6) return mid;
    if((npvMid > 0) === (npvLo > 0)){ lo = mid; npvLo = npvMid; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}
/* Builds the dated USD cash-flow list for one holding: every buy (outflow,
   locked to that month's own FX rate — same historical-accuracy logic as
   the rest of the app) and sell/dividend (inflow, same treatment), plus —
   if any shares are still held — today's market value as a final
   hypothetical "sold today" inflow, using the LIVE rate since that's a
   right-now valuation, not a historical transaction. */
function holdingCashflowsForXirr(lots, dividends, fallbackCurrency, qtyStillHeld, currentValueUsd){
  const flows = [];
  (lots||[]).forEach(l=>{
    if(!l.date) return;
    const {year, monthIdx, day} = parseLocalDateParts(l.date);
    const dt = new Date(year, monthIdx, day);
    if(isNaN(dt.getTime())) return;
    const nativeAmt = num(l.qty) * num(l.price);
    if(nativeAmt === 0) return;
    const usdAmt = nativeMonthToUsd(nativeAmt, l.currency || fallbackCurrency, year, monthIdx);
    flows.push({ date: dt, amount: l.type === 'sell' ? usdAmt : -usdAmt });
  });
  (dividends||[]).forEach(d=>{
    if(!d.date || !num(d.amount)) return;
    const {year, monthIdx, day} = parseLocalDateParts(d.date);
    const dt = new Date(year, monthIdx, day);
    if(isNaN(dt.getTime())) return;
    flows.push({ date: dt, amount: nativeMonthToUsd(num(d.amount), d.currency || fallbackCurrency, year, monthIdx) });
  });
  if(num(qtyStillHeld) > 0.0000001 && num(currentValueUsd) > 0){
    flows.push({ date: new Date(), amount: num(currentValueUsd) });
  }
  return flows;
}
function fmtXirr(rate, tooNew){
  if(tooNew) return 'New';
  if(rate === null || rate === undefined || !isFinite(rate)) return '—';
  const pctVal = rate * 100;
  if(Math.abs(pctVal) >= 1000) return (pctVal>=0?'>':'<') + (pctVal>=0?'+':'-') + '999%'; // extreme short-period annualization — mathematically real, just not a useful display
  return (pctVal>=0?'+':'') + pctVal.toFixed(1) + '%';
}
/* A handful of buys/sells within the last ~30 days can produce an
   annualized return in the thousands of percent — technically correct
   math, but not a meaningful "how well is this doing per year" number
   (the same reason Fidelity/Schwab don't show an annualized return on
   very fresh positions). Below that threshold, XIRR is suppressed and
   flagged tooNew instead of shown as a wild number. */
function xirrWithMinHistory(cashflows, minDays){
  minDays = minDays===undefined ? 30 : minDays;
  if(!cashflows) return {rate:null, tooNew:false};
  const dated = cashflows.filter(cf => cf.date instanceof Date && !isNaN(cf.date.getTime()));
  if(dated.length < 2) return {rate:null, tooNew:false};
  const times = dated.map(cf=>cf.date.getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  if(spanDays < minDays) return {rate:null, tooNew:true};
  return {rate: calcXirr(cashflows), tooNew:false};
}

/* ---------- Aggregation ---------- */
function aggregateAllHoldings(y){
  ensureHoldingsMigration();
  const map = {};
  yearData(y).investments.forEach(inv => {
    const isINR = inv.currency === 'INR';
    (inv.holdings || []).forEach(h => {
      if(h.status === 'closed') return;
      const sym = (h.symbol || 'unknown').toString().toUpperCase();
      if(!map[sym]) map[sym] = {
        symbol: sym, name: h.name || sym, type: h.type || 'stock',
        qty: 0, invested: 0, currentValue: 0, ytdStartValue: 0,
        platforms: [], prices: [], avgPrices: [], ytdPrices: [],
        dayPLUSD: 0, dayPLKnown: false, regions: new Set(),
        _allLots: [], _allDividends: []
      };
      map[sym]._allLots.push(...(h.lots||[]).map(l=>({...l, currency: isINR?'INR':'USD'})));
      map[sym]._allDividends.push(...(h.dividends||[]).map(d=>({...d, currency: isINR?'INR':'USD'})));
      map[sym].regions.add(isINR ? 'IN' : 'US');
      const q = num(h.qty);
      const avgUSD = _toUsd(h.avgPrice, isINR ? 'INR' : 'USD');
      const curUSD = _toUsd(h.currentPrice, isINR ? 'INR' : 'USD');
      const ytdUSD = _toUsd(_ytdStartPriceFor(h).price, isINR ? 'INR' : 'USD');
      map[sym].qty += q;
      map[sym].invested += q * avgUSD;
      map[sym].currentValue += q * curUSD;
      map[sym].ytdStartValue += q * ytdUSD;
      map[sym].platforms.push(inv.name);
      map[sym].prices.push(curUSD);
      map[sym].avgPrices.push(avgUSD);
      map[sym].ytdPrices.push(ytdUSD);
      map[sym].anyPriceOk = map[sym].anyPriceOk || !h.priceFetchFailed;
      if(h.dayChangePct !== null && h.dayChangePct !== undefined && num(h.currentPrice) > 0){
        // Derive $/share change from % + current price, then convert to USD.
        const prevCloseLocal = num(h.currentPrice) / (1 + h.dayChangePct/100);
        const dayChangePerShareUSD = _toUsd(num(h.currentPrice) - prevCloseLocal, isINR ? 'INR' : 'USD');
        map[sym].dayPLUSD += q * dayChangePerShareUSD;
        map[sym].dayPLKnown = true;
      }
    });
  });
  return Object.values(map).map(h => {
    h.avgPrice = h.qty > 0 ? h.invested / h.qty : 0;
    h.currentPrice = h.prices.length ? h.prices.reduce((a,b)=>a+b,0)/h.prices.length : 0;
    h.priceUnknown = !h.anyPriceOk;
    h.ytdStartPrice = h.qty > 0 ? h.ytdStartValue / h.qty : 0;
    h.plNet = h.currentValue - h.invested;
    h.plPct = h.invested > 0 ? h.plNet / h.invested : 0;
    h.ytdPl = h.currentValue - h.ytdStartValue;
    h.ytdPct = h.ytdStartValue > 0 ? h.ytdPl / h.ytdStartValue : 0;
    h.platforms = [...new Set(h.platforms)];
    h.regions = [...h.regions];
    const prevTotalUSD = h.currentValue - h.dayPLUSD;
    h.dayChangePct = (h.dayPLKnown && prevTotalUSD > 0) ? (h.dayPLUSD / prevTotalUSD) * 100 : null;
    h.dayChgPerShareUSD = (h.dayPLKnown && h.qty > 0) ? h.dayPLUSD / h.qty : null;
    return h;
  }).sort((a,b) => b.currentValue - a.currentValue);
}

function platformHoldings(y, platformId){
  ensureHoldingsMigration();
  const inv = yearData(y).investments.find(i => i.id === platformId);
  if(!inv) return [];
  const isINR = inv.currency === 'INR';
  const fx = _ensureFx().INR || 95.0;
  return (inv.holdings || [])
    .filter(h => h.status !== 'closed')
    .map(h => {
      const q = num(h.qty), avg = num(h.avgPrice), cur = num(h.currentPrice);
      const ytdInfo = _ytdStartPriceFor(h);
      const ytd = ytdInfo.price || avg;
      const invested = q * avg, current = q * cur, ytdVal = q * ytd;
      const pl = current - invested, ytdPl = current - ytdVal;
      const investedUSD = isINR ? invested / fx : invested;
      const currentUSD  = isINR ? current / fx : current;
      const ytdUSD      = isINR ? ytdVal / fx : ytdVal;
      const plUSD       = isINR ? pl / fx : pl;
      const ytdPlUSD    = isINR ? ytdPl / fx : ytdPl;
      const dayChg = h.dayChangePct !== null && h.dayChangePct !== undefined ? h.dayChangePct : null;
      const priceFailed = !!h.priceFetchFailed;
      const dayChgStr = priceFailed ? '—' : (dayChg !== null ? (dayChg >= 0 ? '+' : '') + dayChg.toFixed(2) + '%' : '—');
      const dayChgColor = priceFailed ? 'var(--text-dim)' : (dayChg > 0 ? 'var(--good)' : dayChg < 0 ? 'var(--danger)' : 'var(--text-dim)');
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      let dayPLLocal = null, dayPLUSD = null, dayChgPerShareLocal = null;
      if(dayChg !== null && cur > 0){
        const prevClose = cur / (1 + dayChg/100);
        dayChgPerShareLocal = cur - prevClose; // e.g. Yahoo's "+4.97" in "+4.97 (+2.27%)"
        dayPLLocal = q * dayChgPerShareLocal; // total $ made/lost today on this position, in the platform's own currency
        dayPLUSD = isINR ? dayPLLocal / fx : dayPLLocal;
      }
      const ytdBaselineNote = ytdInfo.date
        ? `YTD baseline: ${fmt(ytd)} (from your ${ytdInfo.date} snapshot)`
        : `YTD baseline: ${fmt(ytd)} (no snapshot yet this year — using avg cost)`;
      return {
        ...h, qty: q, avgPrice: avg, currentPrice: cur, ytdStartPrice: ytd,
        invested, currentValue: current, ytdValue: ytdVal,
        investedUSD, currentValueUSD: currentUSD, ytdValueUSD: ytdUSD,
        plNet: pl, plNetUSD: plUSD, plPct: invested > 0 ? pl / invested : 0,
        ytdNet: ytdPl, ytdNetUSD: ytdPlUSD, ytdPct: ytdVal > 0 ? ytdPl / ytdVal : 0, ytdBaselineNote,
        dayChangePct: dayChg, dayChangeStr: dayChgStr, dayChangeColor: dayChgColor,
        dayPLUSD, dDayPl: dayPLLocal !== null ? fmt(dayPLLocal) : '—', tDayPl: dayPLLocal !== null ? tip(dayPLLocal) : null,
        dDayChgAmt: dayChgPerShareLocal !== null ? fmt(dayChgPerShareLocal) : null,
        tDayChgAmt: dayChgPerShareLocal !== null ? tip(dayChgPerShareLocal) : null,
        dAvg: fmt(avg), dCur: priceFailed ? '—' : fmt(cur), dYtd: fmt(ytd),
        dInv: fmt(invested), dVal: fmt(current), dPl: fmt(pl), dYtdPl: fmt(ytdPl),
        tAvg: tip(avg), tCur: priceFailed ? 'Last fetch failed — showing no price rather than a stale one' : tip(cur), tYtd: tip(ytd),
        tInv: tip(invested), tVal: tip(current), tPl: tip(pl), tYtdPl: tip(ytdPl)
      };
    }).sort((a,b) => b.currentValue - a.currentValue);
}

function platformSoldHoldings(y, platformId){
  ensureHoldingsMigration();
  const inv = yearData(y).investments.find(i => i.id === platformId);
  if(!inv) return [];
  const isINR = inv.currency === 'INR';
  const fx = _ensureFx().INR || 95.0;
  return (inv.holdings || [])
    .filter(h => h.status === 'closed')
    .map(h => {
      const costBasisSold = num(h.costBasisSold), proceeds = num(h.proceeds), realized = num(h.realizedPL);
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      return {
        ...h,
        dAvgBuy: fmt(h.avgPrice), dAvgSell: fmt(h.avgSellPrice),
        dCostBasis: fmt(costBasisSold), dProceeds: fmt(proceeds), dRealized: fmt(realized),
        tCostBasis: tip(costBasisSold), tProceeds: tip(proceeds), tRealized: tip(realized),
        realizedUSD: isINR ? realized/fx : realized,
        realizedPct: costBasisSold > 0 ? realized/costBasisSold : 0
      };
    })
    .sort((a,b) => new Date(b.lastSellDate||0) - new Date(a.lastSellDate||0));
}

function allSoldHoldingsByPlatform(y){
  ensureHoldingsMigration();
  const investments = yearData(y).investments || [];
  return investments
    .map(inv => ({ platformId: inv.id, platformName: inv.name, rows: platformSoldHoldings(y, inv.id) }))
    .filter(p => p.rows.length > 0);
}

/* ---------- Sell modal ---------- */
function openSellModal(h, onConfirm){
  const old = document.getElementById('sellModalOverlay');
  if(old) old.remove();

  const maxQty = h.qty;
  const defaultPrice = h.currentPrice || h.avgPrice || 0;
  const today = toLocalISODate(new Date());

  const overlay = document.createElement('div');
  overlay.id = 'sellModalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Sell ${h.symbol}</h3>
      <p class="modal-sub">${h.name && h.name!==h.symbol ? h.name+' · ' : ''}You currently hold ${maxQty} share${maxQty===1?'':'s'}.</p>
      <div class="modal-field">
        <label>Quantity <span class="hint">max ${maxQty}</span></label>
        <input type="number" id="sellQty" value="${maxQty}" min="0" max="${maxQty}" step="any">
      </div>
      <div class="modal-field">
        <label>Sale price / share</label>
        <input type="number" id="sellPrice" value="${defaultPrice || ''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="sellDate" value="${today}" max="${today}">
      </div>
      <div class="modal-preview">
        <span class="label">Estimated realized P&L</span>
        <span class="value" id="sellPreviewVal">—</span>
      </div>
      <div class="modal-actions">
        <button class="btn" id="sellCancelBtn">Cancel</button>
        <button class="btn primary" id="sellConfirmBtn">Confirm sale</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const qtyEl = overlay.querySelector('#sellQty');
  const priceEl = overlay.querySelector('#sellPrice');
  const dateEl = overlay.querySelector('#sellDate');
  const previewEl = overlay.querySelector('#sellPreviewVal');

  function updatePreview(){
    const q = Math.min(Math.max(parseFloat(qtyEl.value)||0, 0), maxQty);
    const p = parseFloat(priceEl.value)||0;
    const est = q*(p - (h.avgPrice||0));
    previewEl.textContent = (est>=0?'+':'') + fmt$(est,2);
    previewEl.style.color = est>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
  }
  updatePreview();
  qtyEl.addEventListener('input', updatePreview);
  priceEl.addEventListener('input', updatePreview);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#sellCancelBtn').addEventListener('click', close);

  overlay.querySelector('#sellConfirmBtn').addEventListener('click', ()=>{
    const qty = parseFloat(qtyEl.value);
    const price = parseFloat(priceEl.value);
    const date = dateEl.value || today;
    if(!qty || qty<=0){ qtyEl.focus(); return; }
    if(qty > maxQty){ qtyEl.value = maxQty; qtyEl.focus(); return; }
    if(isNaN(price) || price<0){ priceEl.focus(); return; }
    close();
    onConfirm(qty, price, date);
  });

  qtyEl.focus(); qtyEl.select();
}

/* ---------- Render ---------- */
function renderHoldings(){
  const y = state.year;
  ensureHoldingsMigration();
  ensureHoldingsFx();
  if(typeof ensureFxRates === 'function' && (!fxRates || !fxRates.INR)){
    ensureFxRates().then(() => { renderHoldings(); });
  }
  if(_priceRefreshTimestamp === undefined){
    ensurePriceRefreshTimestamp().then(() => { renderHoldings(); });
  }
  if(!state.holdingsView) state.holdingsView = 'ALL';
  if(state.holdingsSubView === undefined) state.holdingsSubView = 'open';
  if(state.holdingsTypeFilter === undefined) state.holdingsTypeFilter = null; // null = All types
  if(state.holdingsTypeFilterOpen === undefined) state.holdingsTypeFilterOpen = false;
  if(state.holdingsSort === undefined) state.holdingsSort = 'valueDesc';
  if(state.holdingsFilter === undefined) state.holdingsFilter = '';

  if(!state.holdingsTimeframe) state.holdingsTimeframe = 'ALL';
  const snaps = filterSnapshots(getPortfolioSnapshots(y), state.holdingsTimeframe);

  const investments = yearData(y).investments || [];
  const allRows = aggregateAllHoldings(y);
  const isAll = state.holdingsView === 'ALL';
  let rows = isAll ? allRows : platformHoldings(y, state.holdingsView);
  let soldGroups = isAll ? allSoldHoldingsByPlatform(y) : [{ platformId: state.holdingsView, platformName: (investments.find(i=>i.id===state.holdingsView)||{}).name || '', rows: platformSoldHoldings(y, state.holdingsView) }].filter(g=>g.rows.length>0);
  if(state.holdingsTypeFilter !== null){
    const activeTypes = state.holdingsTypeFilter;
    rows = rows.filter(r => activeTypes.includes(r.type));
    soldGroups = soldGroups.map(g => ({...g, rows: g.rows.filter(r => activeTypes.includes(r.type))})).filter(g => g.rows.length > 0);
  }
  if(state.holdingsRegion === undefined) state.holdingsRegion = 'all';
  if(isAll && state.holdingsRegion !== 'all'){
    rows = rows.filter(r => r.regions && r.regions.includes(state.holdingsRegion));
  }
  ensureWatchlistMigration();
  const showSold = state.holdingsSubView === 'sold';
  const showRecurring = state.holdingsSubView === 'recurring';
  const showWatchlist = state.holdingsSubView === 'watchlist';
  const recurringRows = collectRecurringRows(y, isAll ? null : state.holdingsView);

  const filterText = (state.holdingsFilter || '').toLowerCase().trim();
  let filteredRows = filterText 
    ? rows.filter(r => ((r.name||'')+' '+(r.symbol||'')+' '+(r.type||'')).toLowerCase().includes(filterText))
    : rows;
  
  const sortMode = state.holdingsSort || 'valueDesc';
  filteredRows = [...filteredRows].sort((a,b) => {
    switch(sortMode){
      case 'nameAsc': return (a.name||'').localeCompare(b.name||'');
      case 'nameDesc': return (b.name||'').localeCompare(a.name||'');
      case 'investedDesc': return b.invested - a.invested;
      case 'investedAsc': return a.invested - b.invested;
      case 'plDesc': return b.plNet - a.plNet;
      case 'plAsc': return a.plNet - b.plNet;
      case 'valueAsc': return a.currentValue - b.currentValue;
      case 'type': return (a.type||'').localeCompare(b.type||'') || b.currentValue - a.currentValue;
      case 'dayplDesc': return (b.dayPLUSD||0) - (a.dayPLUSD||0);
      case 'dayplAsc': return (a.dayPLUSD||0) - (b.dayPLUSD||0);
      default: return b.currentValue - a.currentValue;
    }
  });

  /* ---- Pagination (All Platforms table only, 15 per page) ---- */
  const HOLDINGS_PAGE_SIZE = 15;
  let pageRows = filteredRows;
  let holdingsTotalPages = 1;
  if(isAll){
    holdingsTotalPages = Math.max(1, Math.ceil(filteredRows.length / HOLDINGS_PAGE_SIZE));
    if(state.holdingsPage === undefined) state.holdingsPage = 1;
    if(state.holdingsPage > holdingsTotalPages) state.holdingsPage = holdingsTotalPages;
    if(state.holdingsPage < 1) state.holdingsPage = 1;
    const pageStart = (state.holdingsPage-1) * HOLDINGS_PAGE_SIZE;
    pageRows = filteredRows.slice(pageStart, pageStart + HOLDINGS_PAGE_SIZE);
  }
  
  /* ---- KPIs: OPEN vs SOLD vs WATCHLIST view ---- */
  let kpiHtml = '';
  if(showWatchlist){
    // WATCHLIST VIEW: signal metrics, not portfolio metrics — this list is
    // tickers you don't own, so "P&L" doesn't apply here.
    const wl = DATA.watchlist;
    const withPrice = wl.filter(w=>w.currentPrice!==null);
    const gainers = withPrice.filter(w=>(w.dayChangePct||0)>0).length;
    const losers = withPrice.filter(w=>(w.dayChangePct||0)<0).length;
    const nearLow = withPrice.filter(w=>{
      if(!w.fiftyTwoWeekLow || w.fiftyTwoWeekLow<=0) return false;
      return ((w.currentPrice - w.fiftyTwoWeekLow) / w.fiftyTwoWeekLow) * 100 <= 5;
    }).length;
    const nearHigh = withPrice.filter(w=>{
      if(!w.fiftyTwoWeekHigh || w.fiftyTwoWeekHigh<=0) return false;
      return ((w.currentPrice - w.fiftyTwoWeekHigh) / w.fiftyTwoWeekHigh) * 100 >= -5;
    }).length;
    kpiHtml = `
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
        <div class="kpi-card c-gold"><div class="kpi-label">Watching</div><div class="kpi-value">${wl.length}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Today</div><div class="kpi-value" style="font-size:20px;">${gainers}↑ / ${losers}↓</div><div class="kpi-delta flat">${withPrice.length} of ${wl.length} have live prices</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Near 52W Low <span style="opacity:.6;">(≤5%)</span></div><div class="kpi-value">${nearLow}</div><div class="kpi-delta flat">Potential entry points</div></div>
        <div class="kpi-card c-rust"><div class="kpi-label">Near 52W High <span style="opacity:.6;">(≤5%)</span></div><div class="kpi-value">${nearHigh}</div><div class="kpi-delta flat">Momentum / breakout watch</div></div>
      </div>
    `;
  } else if(showSold){
    // SOLD VIEW: Realized metrics
    const allSold = soldGroups.flatMap(g=>g.rows);
    const totalRealized = allSold.reduce((a,r)=>a+(r.realizedUSD||0),0);
    const totalProceeds = allSold.reduce((a,r)=>a+(r.proceeds||0),0);
    const totalCostBasisSold = allSold.reduce((a,r)=>a+(r.costBasisSold||0),0);
    const winners = allSold.filter(r=>(r.realizedUSD||0)>0);
    const losers = allSold.filter(r=>(r.realizedUSD||0)<0);
    const winRate = allSold.length > 0 ? (winners.length / allSold.length) * 100 : 0;
    const avgWin = winners.length > 0 ? winners.reduce((a,r)=>a+(r.realizedUSD||0),0)/winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((a,r)=>a+(r.realizedUSD||0),0)/losers.length : 0;
    const biggestWin = allSold.length ? Math.max(...allSold.map(r=>r.realizedUSD||0)) : 0;
    const biggestLoss = allSold.length ? Math.min(...allSold.map(r=>r.realizedUSD||0)) : 0;
    const totalRealizedPct = totalCostBasisSold > 0 ? totalRealized / totalCostBasisSold : 0;

    kpiHtml = `
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
        <div class="kpi-card ${totalRealized>=0?'c-teal':'c-danger'}"><div class="kpi-label">Total Realized P&L</div><div class="kpi-value">${totalRealized>=0?'+':''}${fmt$(totalRealized)}</div><div class="kpi-delta ${totalRealized>=0?'up':'down'}">${totalRealized>=0?'+':''}${pct(totalRealizedPct)}</div></div>
        <div class="kpi-card c-gold"><div class="kpi-label">Total Proceeds</div><div class="kpi-value">${fmt$(totalProceeds)}</div></div>
        <div class="kpi-card c-rust"><div class="kpi-label">Cost Basis (sold)</div><div class="kpi-value">${fmt$(totalCostBasisSold)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Win Rate</div><div class="kpi-value">${winRate.toFixed(1)}%</div><div class="kpi-delta flat">${winners.length}W / ${losers.length}L of ${allSold.length}</div></div>
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr); margin-top:12px;">
        <div class="kpi-card c-teal"><div class="kpi-label">Avg Winner</div><div class="kpi-value">+${fmt$(avgWin)}</div></div>
        <div class="kpi-card c-danger"><div class="kpi-label">Avg Loser</div><div class="kpi-value">${fmt$(avgLoss)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Biggest Win</div><div class="kpi-value">+${fmt$(biggestWin)}</div></div>
        <div class="kpi-card c-danger"><div class="kpi-label">Biggest Loss</div><div class="kpi-value">${fmt$(biggestLoss)}</div></div>
      </div>
    `;
    } else {
    // OPEN VIEW: Standard portfolio metrics
    const totalInvested = rows.reduce((a,r)=>a+(r.investedUSD!==undefined?r.investedUSD:r.invested),0);
    const totalCurrent  = rows.reduce((a,r)=>a+(r.currentValueUSD!==undefined?r.currentValueUSD:r.currentValue),0);
    const totalYtdStart = rows.reduce((a,r)=>a+((r.ytdValueUSD!==undefined?r.ytdValueUSD:r.ytdValue)||(r.investedUSD!==undefined?r.investedUSD:r.invested)),0);
    const totalPl       = totalCurrent - totalInvested;
    const totalYtdPl    = totalCurrent - totalYtdStart;
    const totalPlPct    = totalInvested > 0 ? totalPl / totalInvested : 0;
    // const totalYtdPlPct = totalYtdStart > 0 ? totalYtdPl / totalYtdStart : 0; // superseded by Day Change P&L below
    const totalDayPl    = rows.reduce((a,r)=>a+(r.dayPLUSD||0),0);
    const totalDayPrevValue = totalCurrent - totalDayPl; // portfolio value as of yesterday's close
    const totalDayPlPct = totalDayPrevValue > 0 ? totalDayPl / totalDayPrevValue : 0;
    const anyDayDataKnown = rows.some(r => r.dayChangePct !== null && r.dayChangePct !== undefined);
    const fxRate = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : null;
    const fxSource = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? 'live' : 'updating...';

    // Portfolio XIRR for exactly what's on screen right now — every row's
    // buys/sells/dividends combined into one set of cash flows (works for
    // both the All-Platforms aggregated view and a single platform, since
    // aggregated rows already carry a currency tag per lot and single-
    // platform rows fall back to that platform's own currency).
    const curInvForXirr = !isAll ? investments.find(i=>i.id===state.holdingsView) : null;
    const portfolioFallbackCurrency = (curInvForXirr && curInvForXirr.currency==='INR') ? 'INR' : 'USD';
    const portfolioFlows = [];
    rows.forEach(r=>{
      const lots = r._allLots || r.lots;
      const divs = r._allDividends || r.dividends;
      const curVal = r.currentValueUSD !== undefined ? r.currentValueUSD : r.currentValue;
      portfolioFlows.push(...holdingCashflowsForXirr(lots, divs, portfolioFallbackCurrency, r.qty, curVal));
    });
    // Fully-sold (closed) positions are excluded from the table above on
    // purpose (so they don't skew current allocation), but their buys and
    // realized sells are real cash flows that happened — leaving them out
    // would silently understate the portfolio's true annualized return.
    if(isAll){
      allSoldHoldingsByPlatform(y).forEach(group=>{
        const groupInv = investments.find(i=>i.id===group.platformId);
        const groupCurrency = (groupInv && groupInv.currency==='INR') ? 'INR' : 'USD';
        group.rows.forEach(r=>{
          portfolioFlows.push(...holdingCashflowsForXirr(r.lots, r.dividends, groupCurrency, 0, 0));
        });
      });
    } else {
      platformSoldHoldings(y, state.holdingsView).forEach(r=>{
        portfolioFlows.push(...holdingCashflowsForXirr(r.lots, r.dividends, portfolioFallbackCurrency, 0, 0));
      });
    }
    const portfolioXirrResult = xirrWithMinHistory(portfolioFlows);
    const portfolioXirr = portfolioXirrResult.rate;

    // KPI cards are always shown in USD; when you're looking at a single INR
    // platform, attach the native-currency figure as a hover tooltip too,
    // same as every row cell already does.
    const curInv = !isAll ? investments.find(i=>i.id===state.holdingsView) : null;
    const isInrPlatform = !!(curInv && curInv.currency === 'INR');
    const fxForTip = fxRate || 95.0;
    const tipAttr = (usdVal) => isInrPlatform ? `data-tip="${fmtInr(usdVal*fxForTip)}"` : '';

    kpiHtml = `
      <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr);">
        <div class="kpi-card c-teal"><div class="kpi-label">Current Value</div><div class="kpi-value" ${tipAttr(totalCurrent)}>${fmt$(totalCurrent)}</div></div>
        <div class="kpi-card c-gold"><div class="kpi-label">Total Invested</div><div class="kpi-value" ${tipAttr(totalInvested)}>${fmt$(totalInvested)}</div></div>
        <div class="kpi-card ${totalPl>=0?'c-teal':'c-danger'}"><div class="kpi-label">Unrealized P&L</div><div class="kpi-value" ${tipAttr(totalPl)}>${totalPl>=0?'+':''}${fmt$(totalPl)}</div><div class="kpi-delta ${totalPl>=0?'up':'down'}">${totalPl>=0?'+':''}${pct(totalPlPct)}</div></div>
        <div class="kpi-card ${portfolioXirr===null?'c-gold':(portfolioXirr>=0?'c-teal':'c-danger')}"><div class="kpi-label" data-tip="Annualized return combining every buy/sell/dividend shown below — not an average of the individual XIRR column, the actual combined cash flows" class="has-tip">${isAll?'Portfolio':'Platform'} XIRR</div><div class="kpi-value">${fmtXirr(portfolioXirr, portfolioXirrResult.tooNew)}</div></div>
        <div class="kpi-card ${!anyDayDataKnown?'':(totalDayPl>=0?'c-teal':'c-danger')}"><div class="kpi-label">Day Change P&L</div><div class="kpi-value" ${anyDayDataKnown?tipAttr(totalDayPl):''}>${anyDayDataKnown ? (totalDayPl>=0?'+':'')+fmt$(totalDayPl) : '—'}</div><div class="kpi-delta ${totalDayPl>=0?'up':'down'}">${anyDayDataKnown ? (totalDayPl>=0?'+':'')+pct(totalDayPlPct) : 'Click Fetch live prices'}</div></div>
      </div>
      <div class="section-sub" style="margin-top:8px; margin-bottom:0; text-align:right;">
        ${fxRate ? `FX rate: <b style="color:var(--gold-soft);">1 USD = ${fxRate.toFixed(2)} INR</b> <span style="color:var(--text-faint);">(${fxSource})</span>` : '<span style="color:var(--text-faint);">Fetching FX rate...</span>'}
      </div>
    `;
  }

  /* ---- Platform pills ---- */
  const pills = [
    {id:'ALL', label:'All Platforms', count: allRows.length},
    ...investments.map(inv => ({id: inv.id, label: inv.name, count: (inv.holdings||[]).filter(h=>h.status!=='closed').length}))
  ];
  const pillHtml = `<div class="pill-row" style="margin-bottom:18px;">${pills.map(p=>`
    <button class="pill ${state.holdingsView===p.id?'active':''}" data-hpill="${p.id}">
      ${p.label} <span style="opacity:.6;font-size:10px;">(${p.count})</span>
    </button>
  `).join('')}</div>`;

  /* ---- Holdings / Recurring / Watchlist / Sold toggle ---- */
  const subToggle = `
    <div class="seg-toggle">
      <button class="seg-btn ${state.holdingsSubView==='open'?'active':''}" data-subview="open">📈 Holdings <span class="seg-count">${rows.length}</span></button>
      <button class="seg-btn ${showRecurring?'active':''}" data-subview="recurring">🔁 Recurring <span class="seg-count">${recurringRows.length}</span></button>
      <button class="seg-btn ${showWatchlist?'active':''}" data-subview="watchlist">👀 Watchlist <span class="seg-count">${DATA.watchlist.length}</span></button>
      <button class="seg-btn ${showSold?'active':''}" data-subview="sold">💰 Sold <span class="seg-count">${soldGroups.reduce((a,g)=>a+g.rows.length,0)}</span></button>
    </div>
  `;

  /* ---- Region toggle (All Platforms view only — a single platform is already one region) ---- */
  const regionToggle = !isAll ? '' : (() => {
    const inCount = allRows.filter(r => r.regions && r.regions.includes('IN')).length;
    const usCount = allRows.filter(r => r.regions && r.regions.includes('US')).length;
    return `
    <div class="seg-toggle">
      <button class="seg-btn ${state.holdingsRegion==='all'?'active':''}" data-region="all">🌍 All</button>
      <button class="seg-btn ${state.holdingsRegion==='IN'?'active':''}" data-region="IN">🇮🇳 India <span class="seg-count">${inCount}</span></button>
      <button class="seg-btn ${state.holdingsRegion==='US'?'active':''}" data-region="US">🇺🇸 USA <span class="seg-count">${usCount}</span></button>
    </div>`;
  })();

  /* ---- Type filter (checkbox dropdown, filters everything on the page) ---- */
  const activeTypesForUI = state.holdingsTypeFilter === null ? HOLDING_TYPES : state.holdingsTypeFilter;
  const typeFilterPanelHtml = `
    <div id="typeFilterPanel" style="display:${state.holdingsTypeFilterOpen?'flex':'none'}; gap:14px; flex-wrap:wrap; align-items:center; background:var(--bg-card); border:1px solid var(--line); border-radius:9px; padding:10px 14px; margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;font-weight:600;">
        <input type="checkbox" id="typeFilterAll" ${activeTypesForUI.length===HOLDING_TYPES.length?'checked':''}> All
      </label>
      ${HOLDING_TYPES.map(t=>`
        <label style="display:flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;">
          <input type="checkbox" class="typeFilterBox" value="${t}" ${activeTypesForUI.includes(t)?'checked':''}> ${t}
        </label>
      `).join('')}
    </div>
  `;

  /* ---- Toolbar ---- */
  const toolbar = (showSold || showRecurring || showWatchlist) ? '' : `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap;">
      <button class="btn small" id="hFetchPrices">🔄 Fetch live prices</button>
      <span class="section-sub" style="margin:0;">Fetching uses Yahoo Finance. Browsers may block it (CORS) — if so, enter prices manually.</span>
    </div>
  `;

  /* ---- Charts (only for open view) ---- */
  const allocRows = rows.filter(r => (r.currentValueUSD !== undefined ? r.currentValueUSD : r.currentValue) > 0.01).slice(0, 12);
  function _shortLabel(r){
    if(r.name){
      const words = r.name.trim().split(/\s+/).slice(0,2).join(' ');
      if(words) return words;
    }
    return r.symbol || '';
  }
  const allocLabels = allocRows.map(_shortLabel);
  const allocVals   = allocRows.map(r => r.currentValueUSD !== undefined ? r.currentValueUSD : r.currentValue);
  const allocTotal = allocVals.reduce((a,b)=>a+b,0);

  const plRows = rows.filter(r => Math.abs(r.plNetUSD !== undefined ? r.plNetUSD : r.plNet) > 0.01)
                     .sort((a,b) => ((b.plNetUSD !== undefined ? b.plNetUSD : b.plNet) || 0) - ((a.plNetUSD !== undefined ? a.plNetUSD : a.plNet) || 0))
                     .slice(0, 15);
  const plLabels = plRows.map(_shortLabel);
  const plVals   = plRows.map(r => r.plNetUSD !== undefined ? r.plNetUSD : r.plNet);
  const plColors = plVals.map(v => v >= 0 ? '#7FAE79' : '#C06A46');

  /* ---- Table headers ----
     All-Platforms table intentionally omits Symbol and YTD P&L (kept below
     in the per-platform table instead) to stay less cluttered, and groups
     Day Chg right next to Unrealized P&L rather than up by LTP. */
  const typeTh = `<th id="typeFilterTh" style="cursor:pointer; white-space:nowrap;" title="Filter by type">Type <span id="typeFilterIcon" style="opacity:.75;">🔽</span></th>`;
  const thead = isAll
    ? `<tr><th class="pin-col-1">Name</th><th>Qty</th><th>Avg Price</th><th data-tip="Last Traded Price" class="has-tip">LTP</th><th>Invested</th><th>Current Value</th><th>Unrealized P&L</th><th style="min-width:70px;">Day Chg</th><th>Day P&L</th>${typeTh}<th>Platforms</th></tr>`
    : `<tr><th class="pin-col-1" style="width:72px;min-width:72px;max-width:72px;">Symbol</th><th class="pin-col-2" style="min-width:140px;">Name</th>${typeTh}<th>Qty</th><th>Avg Price</th><th data-tip="Last Traded Price" class="has-tip">LTP</th><th style="min-width:70px;">Day Chg</th><th>Invested</th><th>Current Value</th><th>Unrealized P&L</th><th>Day P&L</th><th data-tip="Calculated automatically from your earliest snapshot this year — hover a row's value to see the exact baseline" class="has-tip">YTD P&L</th><th></th></tr>`;

  /* ---- OPEN table body ---- */
  const tbody = pageRows.map(r => {
    const plColor = (v) => v>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
    if(isAll){
      const dayColor = r.dayChangePct===null ? 'var(--text-dim)' : (r.dayChangePct>=0 ? 'var(--good)' : 'var(--danger)');
      const dayPlColor = r.dayChangePct===null ? 'var(--text-dim)' : plColor(r.dayPLUSD||0);
      return `<tr>
        <td class="pin-col-1">${r.name}</td>
        <td data-tip="${r.qty}" class="has-tip">${(r.qty||0).toFixed(2)}</td>
        <td>${fmt$(r.avgPrice,2)}</td>
        <td>${r.priceUnknown ? '—' : fmt$(r.currentPrice,2)}</td>
        <td style="font-weight:600;">${fmt$(r.invested,2)}</td>
        <td style="font-weight:600;color:var(--gold-soft);">${fmt$(r.currentValue,2)}</td>
        <td style="font-weight:600;color:${plColor(r.plNet)}">${r.plNet>=0?'+':''}${fmt$(r.plNet,2)} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
        <td style="color:${dayColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;">${r.dayChangePct===null?'—':(r.dayChangePct>=0?'+':'')+fmt$(r.dayChgPerShareUSD,2)+' ('+(r.dayChangePct>=0?'+':'')+r.dayChangePct.toFixed(2)+'%)'}</td>
        <td style="font-weight:600;color:${dayPlColor};">${r.dayChangePct===null?'—':(r.dayPLUSD>=0?'+':'')+fmt$(r.dayPLUSD,2)}</td>
        <!-- Symbol and YTD P&L columns intentionally omitted from All Platforms — see per-platform table below -->
        <td><span class="debt-tag">${r.type}</span></td>
        <td><span class="debt-tag" style="font-size:10px;">${r.platforms.join(', ')}</span></td>
      </tr>`;
    }
    const tip = (t) => t ? `data-tip="${t}" class="has-tip"` : '';
    return `<tr data-hid="${r.id}">
      <td class="pin-col-1 editable" style="font-weight:600; width:72px; min-width:72px; max-width:72px; overflow:hidden; text-overflow:ellipsis;" contenteditable="true" data-f="symbol" data-id="${r.id}">${r.symbol||''}</td>
      <td class="pin-col-2 editable" style="min-width:140px;" contenteditable="true" data-f="name" data-id="${r.id}">${r.name||''}</td>
      <td><select data-htype="${r.id}" style="background:var(--bg-card-hi);color:var(--gold-soft);border:1px solid var(--line);border-radius:5px;font-family:var(--font-mono);font-size:11.5px;padding:3px 4px;">
        ${HOLDING_TYPES.map(t=>`<option value="${t}" ${r.type===t?'selected':''}>${t}</option>`).join('')}
      </select></td>
      <td class="editable has-tip" contenteditable="true" data-f="qty" data-id="${r.id}" data-raw="${r.qty}" data-tip="${r.qty}">${(r.qty||0).toFixed(2)}</td>
      <td class="editable" contenteditable="true" data-f="avgPrice" data-id="${r.id}" ${tip(r.tAvg)} data-raw="${r.avgPrice}">${r.dAvg}</td>
      <td class="editable" contenteditable="true" data-f="currentPrice" data-id="${r.id}" ${tip(r.tCur)} data-raw="${r.currentPrice}">${r.dCur}</td>
      <td style="color:${r.dayChangeColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;" ${r.tDayChgAmt?`data-tip="${r.tDayChgAmt}" class="has-tip"`:''}>${r.dDayChgAmt===null?'—':(r.dayChangePct>=0?'+':'')+r.dDayChgAmt+' ('+r.dayChangeStr+')'}</td>
      <td style="font-weight:600;" ${tip(r.tInv)}>${r.dInv}</td>
      <td style="font-weight:600;color:var(--gold-soft);" ${tip(r.tVal)}>${r.dVal}</td>
      <td style="font-weight:600;color:${plColor(r.plNet)}" ${tip(r.tPl)}>${r.plNet>=0?'+':''}${r.dPl} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
      <td style="font-weight:600;color:${r.dayChangePct===null?'var(--text-dim)':plColor(r.dayPLUSD||0)};" ${tip(r.tDayPl)}>${r.dayChangePct===null?'—':(r.dayPLUSD>=0?'+':'')+r.dDayPl}</td>
      <td style="color:${plColor(r.ytdNet)}" title="${r.ytdBaselineNote}">${r.ytdNet>=0?'+':''}${r.dYtdPl} <span style="font-size:11px;opacity:.75;">(${r.ytdPct>=0?'+':''}${pct(r.ytdPct)})</span></td>
      <td style="white-space:nowrap;"><button class="btn small" data-buyh="${r.id}" title="Record a one-off purchase, dated today (or whichever date you pick)" style="margin-right:4px;">+ Buy</button><button class="btn small sell" data-sellh="${r.id}">Sell</button> <button class="btn small" data-recurh="${r.id}" title="Set up a recurring buy" style="margin-left:4px;">🔁</button> <button class="btn small" data-editlots="${r.id}" title="Edit or correct individual buy/sell lots" style="margin-left:4px;">📝</button> <span class="row-del" data-delh="${r.id}" title="Delete this holding entirely">✕</span></td>
    </tr>`;
  }).join('');

  /* ---- SOLD table ---- */
  const soldTheadCols = isAll
    ? `<th>Platform</th><th>Symbol</th><th>Name</th><th>Type</th><th>Qty Sold</th><th>Avg Buy</th><th>Avg Sell</th><th>Cost Basis</th><th>Proceeds</th><th>Realized P&L</th><th>Sold</th>`
    : `<th>Symbol</th><th>Name</th><th>Type</th><th>Qty Sold</th><th>Avg Buy</th><th>Avg Sell</th><th>Cost Basis</th><th>Proceeds</th><th>Realized P&L</th><th>Sold</th>`;
  function soldRowHtml(r, platformName){
    const plColor = (v) => v>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
    return `<tr>
      ${isAll ? `<td><span class="debt-tag" style="font-size:10px;">${platformName}</span></td>` : ''}
      <td style="font-weight:600;">${r.symbol}</td>
      <td>${r.name||''}</td>
      <td><span class="debt-tag">${r.type}</span></td>
      <td>${r.totalSoldQty}</td>
      <td>${r.dAvgBuy}</td>
      <td>${r.dAvgSell}</td>
      <td ${r.tCostBasis?`data-tip="${r.tCostBasis}" class="has-tip"`:''}>${r.dCostBasis}</td>
      <td ${r.tProceeds?`data-tip="${r.tProceeds}" class="has-tip"`:''}>${r.dProceeds}</td>
      <td style="font-weight:600;color:${plColor(r.realizedPL)}" ${r.tRealized?`data-tip="${r.tRealized}" class="has-tip"`:''}>${r.realizedPL>=0?'+':''}${r.dRealized} <span style="font-size:11px;opacity:.75;">(${r.realizedPct>=0?'+':''}${pct(r.realizedPct)})</span></td>
      <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim); white-space:nowrap;">${r.lastSellDate||'—'}</td>
    </tr>`;
  }
  const soldSection = `
    <div class="card" style="margin-top:20px;">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Sold ${isAll ? '· all platforms' : '· ' + (investments.find(i=>i.id===state.holdingsView)||{}).name}</h3>
      </div>
      <p class="section-sub">Fully or partially exited positions. Kept separate from the totals above so they don't skew your current allocation.</p>
      ${!soldGroups.length ? '<div class="section-sub" style="padding:16px 0; text-align:center;">Nothing sold yet. Switch to Holdings and use the Sell button on a position.</div>' :
        isAll
          ? soldGroups.map(g => `
              <div style="margin-bottom:18px;">
                <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--gold-soft); font-weight:600; margin-bottom:6px;">${g.platformName}</div>
                <div class="table-scroll">
                  <table class="ledger">
                    <thead><tr>${soldTheadCols}</tr></thead>
                    <tbody>${g.rows.map(r=>soldRowHtml(r, g.platformName)).join('')}</tbody>
                  </table>
                </div>
              </div>
            `).join('')
          : `<div class="table-scroll">
              <table class="ledger">
                <thead><tr>${soldTheadCols}</tr></thead>
                <tbody>${soldGroups[0].rows.map(r=>soldRowHtml(r)).join('')}</tbody>
              </table>
            </div>`
      }
    </div>
  `;

  /* ---- Add form ---- */
  const addForm = (isAll || showSold || showRecurring || showWatchlist) ? '' : `
    <div class="addcat-row" style="margin-top:14px;">
      <input type="text" id="hNewSym" placeholder="Symbol" style="min-width:80px;">
      <input type="text" id="hNewName" placeholder="Name" style="min-width:120px;">
      <select id="hNewType" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
        ${HOLDING_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
      <input type="number" id="hNewQty" placeholder="Qty" step="any" style="width:70px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <input type="number" id="hNewAvg" placeholder="Avg price" step="any" style="width:90px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <input type="number" id="hNewCur" placeholder="LTP(Last Trade Price)" step="any" style="width:90px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <input type="date" id="hNewDate" title="When you actually bought this — defaults to today, but backdate it if you're entering a holding you've had for a while, so XIRR reflects your real holding period." style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
      <button class="btn primary small" id="hAddBtn">+ Add</button>
    </div>
  `;

  /* ---- Portfolio history chart ---- */
  const platformSnaps = isAll ? snaps : snaps.filter(s => s.platforms && s.platforms[state.holdingsView]);

  /* ---- Today's Top Gainers / Losers ---- */
  /* ---- Today's Top Gainers / Losers ---- */
  const moversSection = (showSold || showRecurring || showWatchlist) ? '' : (() => {
    const moversRows = rows.filter(r => r.dayChangePct !== null && r.dayChangePct !== undefined);
    const topGainers = [...moversRows].sort((a,b)=>b.dayChangePct-a.dayChangePct).slice(0,5);
    const topLosers = [...moversRows].sort((a,b)=>a.dayChangePct-b.dayChangePct).filter(r=>r.dayChangePct<0).slice(0,5);
    const moversHead = `<thead><tr><th>Symbol</th><th style="text-align:right;">Day Change</th><th style="text-align:right;">Day P&L</th></tr></thead>`;
    const moversRow = (r, positive) => `
      <tr>
        <td style="font-weight:600;">${r.symbol}</td>
        <td style="text-align:right; color:${positive?'var(--good)':'var(--danger)'}; font-family:var(--font-mono); font-weight:600;">${r.dayChangePct>=0?'+':''}${r.dayChangePct.toFixed(2)}%</td>
        <td style="text-align:right; color:${positive?'var(--good)':'var(--danger)'}; font-family:var(--font-mono); font-size:11.5px;">${(r.dayPLUSD||0)>=0?'+':''}${fmt$(r.dayPLUSD||0,2)}</td>
      </tr>`;
    if(!moversRows.length) return '';
    return `
    <div class="grid-2" style="margin-bottom:20px; grid-template-columns:1fr 1fr;">
      <div class="card" style="min-width:0;">
        <div class="card-head"><h3>🚀 Today's Top Gainers</h3></div>
        ${!topGainers.length ? '<div class="section-sub" style="padding:12px 0; text-align:center;">Nothing up today.</div>' : `
        <div class="table-scroll">
          <table class="ledger" style="min-width:0; width:100%;">${moversHead}<tbody>${topGainers.map(r=>moversRow(r,true)).join('')}</tbody></table>
        </div>
        `}
      </div>
      <div class="card" style="min-width:0;">
        <div class="card-head"><h3>📉 Today's Top Losers</h3></div>
        ${!topLosers.length ? '<div class="section-sub" style="padding:12px 0; text-align:center;">Nothing down today.</div>' : `
        <div class="table-scroll">
          <table class="ledger" style="min-width:0; width:100%;">${moversHead}<tbody>${topLosers.map(r=>moversRow(r,false)).join('')}</tbody></table>
        </div>
        `}
      </div>
    </div>`;
  })();

  const chartSection = (showSold || showRecurring || showWatchlist) ? '' : `
    <div class="card" style="margin-bottom:20px;">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Portfolio history${isAll ? '' : ' · ' + ((investments.find(i=>i.id===state.holdingsView)||{}).name || '')}</h3>
        <div class="pill-row" style="margin:0;">
          ${['ALL','YTD','1Y','6M','3M','1M','1W'].map(tf=>`
            <button class="pill ${state.holdingsTimeframe===tf?'active':''}" data-timeframe="${tf}">${tf}</button>
          `).join('')}
        </div>
        <button class="btn small" id="hRecordSnapshot">📸 Record snapshot</button>
      </div>
      <div class="chart-box tall"><canvas id="chartPortfolioHistory"></canvas></div>
      <div class="section-sub" style="margin-top:8px; margin-bottom:0;">
        ${platformSnaps.length ? 'Snapshots: ' + platformSnaps.length + ' · Last: ' + platformSnaps[platformSnaps.length-1].date : (isAll ? 'No snapshots yet. Click 📸 to record today\'s portfolio value.' : 'No snapshots yet for this platform specifically. Click 📸 to record one.')}
      </div>
    </div>
  `;

  /* ---- Allocation + P&L charts (only open view) ---- */
  const openCharts = (showSold || showRecurring || showWatchlist) ? '' : `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Portfolio allocation</h3></div>
        <div class="chart-box"><canvas id="chartHoldingAlloc"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>P&L by holding</h3></div>
        <div class="chart-box"><canvas id="chartHoldingPl"></canvas></div>
      </div>
    </div>
  `;

  /* ---- Recurring buys section ---- */
  const nextUpcoming = recurringRows.filter(r=>r.nextDate).sort((a,b)=> a.nextDate<b.nextDate?-1:1)[0];
  const recurringSection = `
    <div class="card">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Recurring ${isAll ? '· all platforms' : '· ' + (investments.find(i=>i.id===state.holdingsView)||{}).name}</h3>
        ${nextUpcoming ? `<span style="font-family:var(--font-mono); font-size:12px; color:var(--gold-soft); font-weight:600;">Next: ${nextUpcoming.symbol} on ${nextUpcoming.nextDate}</span>` : ''}
      </div>
      <p class="section-sub">Scheduled recurring buys you've set up on individual holdings — a tracker, not an auto-trader. Switch to Holdings and click 🔁 on a position to add one.</p>
      ${!recurringRows.length ? '<div class="section-sub" style="padding:16px 0; text-align:center;">No recurring plans yet.</div>' : `
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr>${isAll?'<th>Platform</th>':''}<th>Holding</th><th>Amount / buy</th><th>Schedule</th><th>Funding account</th><th>Next date</th><th>Est. shares</th><th></th></tr></thead>
          <tbody>${recurringRows.map(r => `
            <tr>
              ${isAll?`<td><span class="debt-tag" style="font-size:10px;">${r.platformName}</span></td>`:''}
              <td style="font-weight:600;">${r.symbol} ${r.name && r.name!==r.symbol ? `<span style="color:var(--text-dim); font-weight:400;">· ${r.name}</span>` : ''}</td>
              <td ${r.tAmount?`data-tip="${r.tAmount}" class="has-tip"`:''}>${r.dAmount}</td>
              <td><span class="debt-tag">${r.scheduleLabel}</span></td>
              <td style="font-size:12px;">${r.bankAccountName ? r.bankAccountName : '<span style="color:var(--text-dim);">— not linked —</span>'}</td>
              <td style="font-family:var(--font-mono); font-size:12px; color:var(--gold-soft); font-weight:600;">${r.nextDate||'—'}</td>
              <td style="font-family:var(--font-mono); font-size:12px;">${r.estShares.toFixed(4)}</td>
              <td style="white-space:nowrap;">${r.alreadyConfirmed
                ? `<span style="color:var(--teal-soft); font-family:var(--font-mono); font-size:11px; margin-right:8px;" title="Already confirmed for ${r.nextDate}">✓ Confirmed</span>`
                : `<span class="row-del" data-confirmbuy="${r.platformId}|${r.holdingId}|${r.nextDate}" title="Confirm this buy happened" style="margin-right:8px; cursor:pointer; color:var(--teal-soft);">✓ Confirm</span>`
              }<span class="row-del" data-editrecur="${r.platformId}|${r.holdingId}" title="Edit" style="margin-right:8px; cursor:pointer;">✏️</span><span class="row-del" data-removerecur="${r.platformId}|${r.holdingId}" title="Remove">✕</span></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
      `}
    </div>
  `;

  /* ---- Watchlist section ---- */
  const wlSortMode = state.watchlistSort || 'dayChgDesc';
  // Wrapper copies (not the real DATA.watchlist objects) so these
  // display-only derived fields never get written back to Supabase.
  let wlItems = DATA.watchlist.map(w=>{
    const pctFromLow = (w.fiftyTwoWeekLow && w.fiftyTwoWeekLow>0 && w.currentPrice!==null) ? ((w.currentPrice - w.fiftyTwoWeekLow)/w.fiftyTwoWeekLow)*100 : null;
    const pctFromHigh = (w.fiftyTwoWeekHigh && w.fiftyTwoWeekHigh>0 && w.currentPrice!==null) ? ((w.currentPrice - w.fiftyTwoWeekHigh)/w.fiftyTwoWeekHigh)*100 : null;
    const rangePos = (w.fiftyTwoWeekHigh && w.fiftyTwoWeekLow && w.fiftyTwoWeekHigh>w.fiftyTwoWeekLow && w.currentPrice!==null)
      ? Math.max(0, Math.min(100, ((w.currentPrice - w.fiftyTwoWeekLow)/(w.fiftyTwoWeekHigh-w.fiftyTwoWeekLow))*100))
      : null;
    return Object.assign({}, w, { _pctFromLow: pctFromLow, _pctFromHigh: pctFromHigh, _rangePos: rangePos });
  });
  wlItems.sort((a,b)=>{
    switch(wlSortMode){
      case 'dayChgAsc': return (a.dayChangePct??999) - (b.dayChangePct??999);
      case 'nameAsc': return (a.symbol||'').localeCompare(b.symbol||'');
      case 'nearLowAsc': return (a._pctFromLow??999) - (b._pctFromLow??999);
      case 'nearHighDesc': return (b._pctFromHigh??-999) - (a._pctFromHigh??-999);
      case 'addedDesc': return (b.addedDate||'').localeCompare(a.addedDate||'');
      default: return (b.dayChangePct??-999) - (a.dayChangePct??-999); // dayChgDesc
    }
  });
  const watchlistSection = `
    <div class="card">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Watchlist</h3>
        <div style="display:flex; gap:8px; align-items:center;">
          <select id="wlSort" style="appearance:none;-webkit-appearance:none;background:var(--bg-card);color:var(--text);border:1px solid var(--line);padding:6px 26px 6px 10px;border-radius:7px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;">
            <option value="dayChgDesc" ${wlSortMode==='dayChgDesc'?'selected':''}>Sort: Day Chg (high→low)</option>
            <option value="dayChgAsc" ${wlSortMode==='dayChgAsc'?'selected':''}>Sort: Day Chg (low→high)</option>
            <option value="nearLowAsc" ${wlSortMode==='nearLowAsc'?'selected':''}>Sort: Nearest 52W Low</option>
            <option value="nearHighDesc" ${wlSortMode==='nearHighDesc'?'selected':''}>Sort: Nearest 52W High</option>
            <option value="nameAsc" ${wlSortMode==='nameAsc'?'selected':''}>Sort: Symbol A→Z</option>
            <option value="addedDesc" ${wlSortMode==='addedDesc'?'selected':''}>Sort: Recently added</option>
          </select>
          <button class="btn small" id="wlFetchPrices">🔄 Fetch live prices</button>
        </div>
      </div>
      <p class="section-sub">Stocks you don't own yet but want to track — separate from your actual holdings, so it never affects your portfolio totals. 52-week high/low come from the same price fetch, no extra lookup needed.</p>
      ${!wlItems.length ? '<div class="section-sub" style="padding:16px 0; text-align:center;">Nothing on your watchlist yet — add a ticker below.</div>' : `
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr>
            <th>Symbol</th><th>Name</th><th>Region</th>
            <th data-tip="Last Traded Price" class="has-tip">LTP</th><th style="min-width:70px;">Day Chg</th>
            <th>52W Low</th><th style="min-width:110px;">52W Range</th><th>52W High</th>
            <th data-tip="How far above the 52-week low — smaller = closer to a potential entry" class="has-tip">vs Low</th>
            <th data-tip="How far below the 52-week high — closer to 0 = near breakout territory" class="has-tip">vs High</th>
            <th>Target</th><th>Notes</th><th></th>
          </tr></thead>
          <tbody id="watchlistBody">${wlItems.map(w=>{
            const dayColor = w.dayChangePct===null||w.dayChangePct===undefined ? 'var(--text-dim)' : (w.dayChangePct>=0?'var(--good)':'var(--danger)');
            const nearLowTag = (w._pctFromLow!==null && w._pctFromLow<=5) ? `<span class="debt-tag" style="background:rgba(127,174,121,.18); color:var(--good); border-color:transparent; margin-left:6px;">near low</span>` : '';
            const nearHighTag = (w._pctFromHigh!==null && w._pctFromHigh>=-5) ? `<span class="debt-tag" style="background:rgba(192,106,70,.18); color:var(--rust-soft); border-color:transparent; margin-left:6px;">near high</span>` : '';
            const atTarget = (w.targetPrice!==null && w.currentPrice!==null && w.currentPrice<=w.targetPrice);
            const rangeBar = w._rangePos===null ? '<span style="color:var(--text-faint); font-size:11px;">—</span>' : `<div class="runway" style="margin:0;"><div class="runway-fill" style="width:${w._rangePos}%; background:linear-gradient(90deg, var(--good), var(--gold));"></div></div>`;
            return `<tr data-wid="${w.id}">
              <td style="font-weight:600;" class="editable" contenteditable="true" data-wf="symbol" data-id="${w.id}">${w.symbol||''}${nearLowTag}${nearHighTag}</td>
              <td class="editable" contenteditable="true" data-wf="name" data-id="${w.id}">${w.name||''}</td>
              <td><select data-wregion="${w.id}" style="background:var(--bg-card-hi);color:var(--gold-soft);border:1px solid var(--line);border-radius:5px;font-family:var(--font-mono);font-size:11.5px;padding:3px 4px;">
                <option value="US" ${w.region==='US'?'selected':''}>🇺🇸 US</option>
                <option value="IN" ${w.region==='IN'?'selected':''}>🇮🇳 IN</option>
              </select></td>
              <td style="${w.priceFetchFailed?'color:var(--danger);':''}">${w.currentPrice===null ? '—' : fmt$(w.currentPrice,2)}</td>
              <td style="color:${dayColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;">${w.dayChangePct===null||w.dayChangePct===undefined?'—':(w.dayChangePct>=0?'+':'')+w.dayChangePct.toFixed(2)+'%'}</td>
              <td style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-dim);">${w.fiftyTwoWeekLow===null?'—':fmt$(w.fiftyTwoWeekLow,2)}</td>
              <td>${rangeBar}</td>
              <td style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-dim);">${w.fiftyTwoWeekHigh===null?'—':fmt$(w.fiftyTwoWeekHigh,2)}</td>
              <td style="color:${w._pctFromLow!==null && w._pctFromLow<=5?'var(--good)':'var(--text-dim)'}; font-family:var(--font-mono); font-size:11.5px;">${w._pctFromLow===null?'—':'+'+w._pctFromLow.toFixed(1)+'%'}</td>
              <td style="color:${w._pctFromHigh!==null && w._pctFromHigh>=-5?'var(--rust-soft)':'var(--text-dim)'}; font-family:var(--font-mono); font-size:11.5px;">${w._pctFromHigh===null?'—':w._pctFromHigh.toFixed(1)+'%'}</td>
              <td class="editable" contenteditable="true" data-wf="targetPrice" data-id="${w.id}" style="${atTarget?'color:var(--good); font-weight:700;':''}">${w.targetPrice===null?'–':fmt$(w.targetPrice,2)}${atTarget?' ✓':''}</td>
              <td class="editable" contenteditable="true" data-wf="notes" data-id="${w.id}" style="max-width:160px; color:var(--text-dim); font-size:11.5px;">${w.notes||''}</td>
              <td style="white-space:nowrap;"><span class="row-del" data-delw="${w.id}" title="Remove from watchlist">✕</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      `}
      <div class="addcat-row" style="margin-top:14px;">
        <input type="text" id="wlNewSym" placeholder="Symbol, e.g. AAPL" style="min-width:90px;">
        <input type="text" id="wlNewName" placeholder="Name (optional)" style="min-width:130px;">
        <select id="wlNewRegion" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="US">🇺🇸 US</option>
          <option value="IN">🇮🇳 India</option>
        </select>
        <input type="number" id="wlNewTarget" placeholder="Target price (optional)" step="any" style="width:150px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <button class="btn primary small" id="wlAddBtn">+ Add to watchlist</button>
      </div>
    </div>
  `;

  const html = `
    <div class="section-title">Holdings · ${y}</div>
    <p class="section-sub">Every stock, mutual fund, ETF, index, and crypto you own. <b>All Platforms</b> shows the consolidated view. Click a platform pill to edit its individual holdings. YTD uses Jan 1 price (defaults to your avg cost if not set).</p>
    <p class="section-sub" style="margin-top:-8px;">🕒 Prices last refreshed: <b style="color:var(--gold-soft);">${_formatPriceRefreshTimestamp()}</b> <span style="color:var(--text-faint);">(auto-refreshes daily on the server, even if you don't have this open)</span></p>

    ${kpiHtml}

    ${moversSection}

    ${chartSection}

    ${showWatchlist ? '' : pillHtml}
    <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
      ${subToggle}
      ${showWatchlist ? '' : regionToggle}
    </div>

    ${showSold ? soldSection : showRecurring ? recurringSection : showWatchlist ? watchlistSection : `
    ${toolbar}

    ${openCharts}

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; flex:1;">
          <input type="text" id="hFilter" placeholder="🔍 Filter by name, symbol, or type…" value="${state.holdingsFilter||''}" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 12px;font-family:var(--font-body);font-size:12.5px;flex:1;min-width:160px;max-width:260px;">
          <select id="hSort" style="appearance:none;-webkit-appearance:none;background:var(--bg-card);color:var(--text);border:1px solid var(--line);padding:7px 28px 7px 10px;border-radius:7px;font-family:var(--font-mono);font-size:12px;cursor:pointer;min-width:170px;">
            <option value="valueDesc" ${sortMode==='valueDesc'?'selected':''}>Sort: Value (high→low)</option>
            <option value="valueAsc" ${sortMode==='valueAsc'?'selected':''}>Sort: Value (low→high)</option>
            <option value="nameAsc" ${sortMode==='nameAsc'?'selected':''}>Sort: Name A→Z</option>
            <option value="nameDesc" ${sortMode==='nameDesc'?'selected':''}>Sort: Name Z→A</option>
            <option value="investedDesc" ${sortMode==='investedDesc'?'selected':''}>Sort: Invested (high→low)</option>
            <option value="investedAsc" ${sortMode==='investedAsc'?'selected':''}>Sort: Invested (low→high)</option>
            <option value="plDesc" ${sortMode==='plDesc'?'selected':''}>Sort: P&L (high→low)</option>
            <option value="plAsc" ${sortMode==='plAsc'?'selected':''}>Sort: P&L (low→high)</option>
            <option value="type" ${sortMode==='type'?'selected':''}>Sort: Type</option>
            <option value="dayplDesc" ${sortMode==='dayplDesc'?'selected':''}>Sort: Day P&L (high→low)</option>
            <option value="dayplAsc" ${sortMode==='dayplAsc'?'selected':''}>Sort: Day P&L (low→high)</option>
          </select>
        </div>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);">${isAll && holdingsTotalPages>1 ? `Showing ${pageRows.length ? (state.holdingsPage-1)*HOLDINGS_PAGE_SIZE+1 : 0}–${(state.holdingsPage-1)*HOLDINGS_PAGE_SIZE+pageRows.length} of ${filteredRows.length}` : `Showing ${filteredRows.length} of ${rows.length}`}</span>
      </div>
      ${typeFilterPanelHtml}
      <div class="table-scroll">
        <table class="ledger">
          <thead>${thead}</thead>
            <tbody id="holdingsBody">${pageRows.length ? tbody : `<tr><td colspan="${isAll?11:13}" style="color:var(--text-faint);text-align:center;padding:20px;">No holdings match your filter.</td></tr>`}</tbody>
        </table>
      </div>
      ${isAll && holdingsTotalPages>1 ? `
      <div style="display:flex; justify-content:center; align-items:center; gap:16px; margin-top:16px; font-family:var(--font-mono); font-size:12.5px;">
        <button class="btn small" id="holdPagePrev" ${state.holdingsPage<=1?'disabled':''}>‹ Prev</button>
        <span style="color:var(--text-dim);">Page <b style="color:var(--gold-soft);">${state.holdingsPage}</b> of ${holdingsTotalPages}</span>
        <button class="btn small" id="holdPageNext" ${state.holdingsPage>=holdingsTotalPages?'disabled':''}>Next ›</button>
      </div>
      ` : ''}
      ${addForm}
    </div>
    `}
  `;
  document.getElementById('panel-holdings').innerHTML = html;

  /* ---- Toggle handler ---- */
  document.querySelectorAll('[data-subview]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsSubView = b.dataset.subview; renderHoldings();
  }));
  document.querySelectorAll('[data-region]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsRegion = b.dataset.region; state.holdingsPage = 1; renderHoldings();
  }));
  const pagePrevBtn = document.getElementById('holdPagePrev');
  if(pagePrevBtn) pagePrevBtn.addEventListener('click', ()=>{ state.holdingsPage = Math.max(1, state.holdingsPage-1); renderHoldings(); });
  const pageNextBtn = document.getElementById('holdPageNext');
  if(pageNextBtn) pageNextBtn.addEventListener('click', ()=>{ state.holdingsPage = state.holdingsPage+1; renderHoldings(); });

  /* ---- Type filter handlers ---- */
  const typeFilterTh = document.getElementById('typeFilterTh');
  if(typeFilterTh) typeFilterTh.addEventListener('click', ()=>{
    state.holdingsTypeFilterOpen = !state.holdingsTypeFilterOpen; renderHoldings();
  });
  const typeFilterAll = document.getElementById('typeFilterAll');
  if(typeFilterAll) typeFilterAll.addEventListener('change', ()=>{
    state.holdingsTypeFilter = typeFilterAll.checked ? null : [];
    state.holdingsPage = 1;
    renderHoldings();
  });
  document.querySelectorAll('.typeFilterBox').forEach(cb => cb.addEventListener('change', ()=>{
    let sel = (state.holdingsTypeFilter === null ? HOLDING_TYPES.slice() : state.holdingsTypeFilter.slice());
    if(cb.checked){ if(!sel.includes(cb.value)) sel.push(cb.value); }
    else { sel = sel.filter(t => t !== cb.value); }
    state.holdingsTypeFilter = sel;
    state.holdingsPage = 1;
    renderHoldings();
  }));

  /* ---- Handlers ---- */
  document.querySelectorAll('[data-hpill]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsView = b.dataset.hpill; renderHoldings();
  }));

  /* Recurring view edit/remove — these can point at a holding on any
     platform (All Platforms view included), so they live outside the
     single-platform guard below. */
  function _findRecurHolding(key){
    const [platformId, holdingId] = key.split('|');
    const inv2 = investments.find(i => i.id === platformId);
    return inv2 ? inv2.holdings.find(x => x.id === holdingId) : null;
  }
  document.querySelectorAll('[data-editrecur]').forEach(el => el.addEventListener('click', ()=>{
    const h = _findRecurHolding(el.dataset.editrecur);
    if(!h) return;
    openRecurringModal(h, y,
      (config) => {
        h.recurring = { active: true, ...config };
        markDirty(); renderHoldings();
        showToast(`Recurring buy updated for ${h.symbol}`);
      },
      () => {
        h.recurring = null;
        markDirty(); renderHoldings();
        showToast(`Recurring buy removed for ${h.symbol}`);
      }
    );
  }));
  document.querySelectorAll('[data-removerecur]').forEach(el => el.addEventListener('click', ()=>{
    const h = _findRecurHolding(el.dataset.removerecur);
    if(!h) return;
    if(confirm(`Remove the recurring plan for ${h.symbol}?`)){
      h.recurring = null; markDirty(); renderHoldings();
    }
  }));
  document.querySelectorAll('[data-confirmbuy]').forEach(el => el.addEventListener('click', ()=>{
    const [platformId, holdingId, scheduledDate] = el.dataset.confirmbuy.split('|');
    const inv2 = investments.find(i => i.id === platformId);
    const h = inv2 && inv2.holdings.find(x => x.id === holdingId);
    if(!h) return;
    openConfirmBuyModal(h, scheduledDate, (qty, price, date) => {
      h.lots.push({id: uid(), type:'buy', qty, price, date});
      recalcHolding(h);
      if(h.recurring) h.recurring.lastConfirmedFor = scheduledDate;
      markDirty('holdings');
      renderHoldings();
      showToast(`Added ${qty.toFixed(4)} ${h.symbol} @ ${fmt$(price,2)} from recurring buy`);
    });
  }));

  if(!isAll && !showSold && !showRecurring){
    const inv = investments.find(i => i.id === state.holdingsView);
    if(inv){
      document.getElementById('holdingsBody').querySelectorAll('td.editable').forEach(td => {
        td.addEventListener('focus', ()=>{
          td.dataset.origRaw = td.textContent;
          const raw = td.dataset.raw;
          if(raw !== undefined && raw !== '') td.textContent = raw;
        });
        td.addEventListener('blur', ()=>{
          if(td.textContent === td.dataset.origRaw) return;
          const id = td.dataset.id, field = td.dataset.f;
          const h = inv.holdings.find(x => x.id === id);
          if(!h) return;
          if(field === 'symbol' || field === 'name'){
            const v = td.textContent.trim();
            if(h[field] !== v){ h[field] = v; markDirty(); renderHoldings(); }
            return;
          }
          const raw = td.textContent.trim().replace(/[$₹,]/g,'').replace(/\s+/g,'');
          let v = raw === '' ? null : parseFloat(raw);
          if(isNaN(v)) v = null;
          if(field === 'qty') v = v !== null ? v : 0;
          if(field === 'qty'){
            // Whatever the difference is between the new total and what we
            // already had, record it as its OWN lot dated TODAY — exactly
            // like clicking "Buy" would. Silently stretching an existing
            // lot's quantity (its old behavior) backdated newly-added
            // shares onto whatever date the original lot happened to be,
            // which corrupts XIRR (and cost basis) for anyone who uses this
            // cell to add to a position instead of the Buy button.
            const currentQty = num(h.qty);
            const delta = (v||0) - currentQty;
            const todayStr = toLocalISODate(new Date());
            if(Math.abs(delta) > 0.0000001){
              if(delta > 0){
                h.lots.push({id: uid(), type:'buy', qty: delta, price: h.currentPrice||h.avgPrice||0, date: todayStr});
              } else {
                h.lots.push({id: uid(), type:'sell', qty: -delta, price: h.currentPrice||h.avgPrice||0, date: todayStr});
              }
            }
            recalcHolding(h);
          } else if(field === 'avgPrice'){
            const buyLots = h.lots.filter(l => l.type !== 'sell');
            const oldTotal = buyLots.reduce((a,l)=>a+num(l.qty)*num(l.price),0);
            const oldQty = buyLots.reduce((a,l)=>a+num(l.qty),0);
            if(oldQty > 0){
              const ratio = (v * oldQty) / oldTotal;
              buyLots.forEach(l => l.price = num(l.price) * ratio);
            }
            recalcHolding(h);
          } else if(field === 'currentPrice'){
            h.currentPrice = v || 0;
            h.priceFetchFailed = false;
          }
          markDirty(); renderHoldings();
        });
        td.addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
      });

      document.querySelectorAll('[data-htype]').forEach(sel => sel.addEventListener('change', ()=>{
        const h = inv.holdings.find(x => x.id === sel.dataset.htype);
        h.type = sel.value; markDirty(); renderHoldings();
      }));

      document.querySelectorAll('[data-delh]').forEach(el => el.addEventListener('click', ()=>{
        const idx = inv.holdings.findIndex(x => x.id === el.dataset.delh);
        if(idx > -1 && confirm('Remove this holding?')){ inv.holdings.splice(idx,1); markDirty(); renderHoldings(); }
      }));

      document.getElementById('hAddBtn').addEventListener('click', ()=>{
        const sym = document.getElementById('hNewSym').value.trim().toUpperCase();
        const name = document.getElementById('hNewName').value.trim();
        const type = document.getElementById('hNewType').value;
        const qty = parseFloat(document.getElementById('hNewQty').value) || 0;
        const avg = parseFloat(document.getElementById('hNewAvg').value) || 0;
        const cur = parseFloat(document.getElementById('hNewCur').value) || 0;
        const dateInp = document.getElementById('hNewDate').value;
        const purchaseDate = dateInp || toLocalISODate(new Date());
        if(!sym){ document.getElementById('hNewSym').focus(); return; }
        const newH = {
          id: uid(), symbol: sym, name: name || sym, type,
          currentPrice: cur, ytdStartPrice: avg,
          lots: [{id: uid(), type:'buy', qty, price: avg, date: purchaseDate}],
          dividends: [], currency: inv.currency || 'USD'
        };
        recalcHolding(newH);
        inv.holdings.push(newH);
        markDirty(); renderHoldings();
      });

      document.querySelectorAll('[data-sellh]').forEach(el => el.addEventListener('click', ()=>{
        const h = inv.holdings.find(x => x.id === el.dataset.sellh);
        if(!h) return;
        if(h.qty <= 0){ showToast('Nothing left to sell on this holding'); return; }
        openSellModal(h, (qty, price, date) => {
          h.lots.push({id: uid(), type:'sell', qty, price, date});
          recalcHolding(h);
          markDirty('holdings');
          renderHoldings();
          showToast(`Sold ${qty} ${h.symbol} @ ${fmt$(price,2)}`);
        });
      }));

      document.querySelectorAll('[data-buyh]').forEach(el => el.addEventListener('click', ()=>{
        const h = inv.holdings.find(x => x.id === el.dataset.buyh);
        if(!h) return;
        openQuickBuyModal(h, (qty, price, date) => {
          h.lots.push({id: uid(), type:'buy', qty, price, date});
          recalcHolding(h);
          markDirty('holdings');
          renderHoldings();
          showToast(`Added ${qty} ${h.symbol} @ ${fmt$(price,2)} on ${date}`);
        });
      }));

      document.querySelectorAll('[data-editlots]').forEach(el => el.addEventListener('click', ()=>{
        const h = inv.holdings.find(x => x.id === el.dataset.editlots);
        if(h) openEditLotsModal(h);
      }));

      document.querySelectorAll('[data-recurh]').forEach(el => el.addEventListener('click', ()=>{
        const h = inv.holdings.find(x => x.id === el.dataset.recurh);
        if(!h) return;
        openRecurringModal(h, y,
          (config) => {
            h.recurring = { active: true, ...config };
            markDirty(); renderHoldings();
            showToast(`Recurring buy saved for ${h.symbol}`);
          },
          () => {
            h.recurring = null;
            markDirty(); renderHoldings();
            showToast(`Recurring buy removed for ${h.symbol}`);
          }
        );
      }));

      
    }
  }

    /* ---- Fetch live prices (All Platforms or single platform) ---- */
  if(!showSold && !showRecurring){
    const fetchBtn = document.getElementById('hFetchPrices');
    if(fetchBtn){
      fetchBtn.addEventListener('click', async ()=>{
        fetchBtn.textContent = '⏳ Fetching...';
        fetchBtn.disabled = true;
        let updated = 0, failed = 0;

        if(isAll){
          for(const inv of investments){
            for(const h of (inv.holdings || [])){
              if(num(h.qty) <= 0) continue;
              try{
                const result = await fetchLivePrice(h.symbol, inv.currency==='INR');
                h.currentPrice = result.price;
                h.dayChangePct = result.changePct;
                h.lastFetched = Date.now();
                h.priceFetchFailed = false;
                updated++;
              }catch(e){ h.priceFetchFailed = true; failed++; }
              await new Promise(r => setTimeout(r, 300));
            }
          }
        } else {
          const inv = investments.find(i => i.id === state.holdingsView);
          if(inv){
            for(const h of inv.holdings){
              if(num(h.qty) <= 0) continue;
              try{
                const result = await fetchLivePrice(h.symbol, inv.currency==='INR');
                h.currentPrice = result.price;
                h.dayChangePct = result.changePct;
                h.lastFetched = Date.now();
                h.priceFetchFailed = false;
                updated++;
              }catch(e){ h.priceFetchFailed = true; failed++; }
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }

        markDirty();
        if(updated > 0){ await recordPriceRefreshNow(); recordPortfolioSnapshot(y, true); }
        renderHoldings();
        showToast(`${updated} prices updated${failed>0 ? ', '+failed+' failed (CORS/manual needed)' : ''}`);
      });
    }
  }

  /* ---- Watchlist handlers ---- */
  if(showWatchlist){
    const wlFetchBtn = document.getElementById('wlFetchPrices');
    if(wlFetchBtn) wlFetchBtn.addEventListener('click', async ()=>{
      wlFetchBtn.textContent = '⏳ Fetching...';
      wlFetchBtn.disabled = true;
      let updated = 0, failed = 0;
      for(const w of DATA.watchlist){
        if(!w.symbol) continue;
        try{
          const result = await fetchLivePrice(w.symbol, w.region==='IN');
          w.currentPrice = result.price;
          w.dayChangePct = result.changePct;
          w.fiftyTwoWeekHigh = result.fiftyTwoWeekHigh;
          w.fiftyTwoWeekLow = result.fiftyTwoWeekLow;
          w.prevClose = result.prevClose;
          w.volume = result.volume;
          w.lastFetched = Date.now();
          w.priceFetchFailed = false;
          updated++;
        }catch(e){ w.priceFetchFailed = true; failed++; }
        await new Promise(r => setTimeout(r, 300));
      }
      markDirty();
      renderHoldings();
      showToast(`${updated} watchlist price${updated===1?'':'s'} updated${failed>0 ? ', '+failed+' failed (CORS/manual needed)' : ''}`);
    });

    const wlSortSel = document.getElementById('wlSort');
    if(wlSortSel) wlSortSel.addEventListener('change', ()=>{ state.watchlistSort = wlSortSel.value; renderHoldings(); });

    document.querySelectorAll('[data-wregion]').forEach(sel=>{
      sel.addEventListener('change', ()=>{
        const w = DATA.watchlist.find(x=>x.id===sel.dataset.wregion);
        if(w){ w.region = sel.value; markDirty(); renderHoldings(); }
      });
    });

    document.querySelectorAll('[data-delw]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const idx = DATA.watchlist.findIndex(x=>x.id===el.dataset.delw);
        if(idx>-1){
          const sym = DATA.watchlist[idx].symbol;
          DATA.watchlist.splice(idx,1);
          markDirty();
          renderHoldings();
          showToast(`${sym} removed from watchlist`);
        }
      });
    });

    document.querySelectorAll('#watchlistBody [data-wf]').forEach(td=>{
      td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
      td.addEventListener('blur', ()=>{
        if(td.textContent === td.dataset.origRaw) return;
        const w = DATA.watchlist.find(x=>x.id===td.dataset.id);
        if(!w) return;
        const field = td.dataset.wf;
        let raw = td.textContent.trim();
        if(field==='symbol'){
          w.symbol = raw.toUpperCase().replace(/[^A-Z0-9.\-]/g,'');
        } else if(field==='name'){
          w.name = raw;
        } else if(field==='targetPrice'){
          const cleaned = raw.replace(/[$₹,\s]/g,'').replace(/✓$/,'');
          const v = cleaned==='' || cleaned==='–' ? null : evalExpr(cleaned);
          w.targetPrice = (v===null || isNaN(v)) ? null : roundCents(v);
        } else if(field==='notes'){
          w.notes = raw;
        }
        markDirty();
        renderHoldings();
      });
      td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
    });

    const wlAddBtn = document.getElementById('wlAddBtn');
    if(wlAddBtn) wlAddBtn.addEventListener('click', ()=>{
      const symInp = document.getElementById('wlNewSym');
      const sym = symInp.value.trim().toUpperCase();
      if(!sym){ symInp.focus(); return; }
      const name = document.getElementById('wlNewName').value.trim();
      const region = document.getElementById('wlNewRegion').value;
      const targetRaw = document.getElementById('wlNewTarget').value;
      const targetPrice = targetRaw==='' ? null : (parseFloat(targetRaw) || null);
      DATA.watchlist.push({
        id: uid(), symbol: sym, name, region, targetPrice, notes: '',
        addedDate: toLocalISODate(new Date()),
        currentPrice: null, dayChangePct: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null,
        prevClose: null, volume: null, lastFetched: null, priceFetchFailed: false
      });
      markDirty();
      renderHoldings();
      showToast(`${sym} added to watchlist`);
    });
  }

  /* ---- Snapshot & timeframe ---- */
  const snapBtn = document.getElementById('hRecordSnapshot');
  if(snapBtn) snapBtn.addEventListener('click', ()=>{ recordPortfolioSnapshot(y); renderHoldings(); });
  
  document.querySelectorAll('[data-timeframe]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsTimeframe = b.dataset.timeframe; renderHoldings();
  }));

  /* ---- Portfolio history chart ---- */
  destroyChart('portfolioHistory');
  if(!showSold && !showRecurring && snaps.length > 1){
    const labels = snaps.map(s => s.date.slice(5));
    const chartValueFor = (s) => isAll ? s.totalValue : (s.platforms && s.platforms[state.holdingsView] ? s.platforms[state.holdingsView].totalValue : null);
    const chartInvestedFor = (s) => isAll ? s.totalInvested : (s.platforms && s.platforms[state.holdingsView] ? s.platforms[state.holdingsView].totalInvested : null);
    const hasAnyPlatformData = isAll || snaps.some(s => s.platforms && s.platforms[state.holdingsView]);
    charts.portfolioHistory = safeChart(document.getElementById('chartPortfolioHistory'), {
      type: 'line',
      data: { 
        labels, 
        datasets: [
          {label:'Portfolio value', data: snaps.map(chartValueFor), borderColor:'#C9A961', backgroundColor:'rgba(201,169,97,0.08)', fill:true, tension:0.3, pointRadius:3, spanGaps:true},
          {label:'Invested', data: snaps.map(chartInvestedFor), borderColor:'#6FA491', borderDash:[4,3], tension:0.3, pointRadius:0, spanGaps:true}
        ] 
      },
      options: { responsive:true, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
        plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
        scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
    });
    if(!hasAnyPlatformData){
      document.getElementById('chartPortfolioHistory').parentElement.insertAdjacentHTML('beforeend',
        '<div class="section-sub" style="margin-top:8px; margin-bottom:0;">No per-platform history yet for this platform — snapshots taken before this feature only stored the combined total. New snapshots from here on will track it.</div>');
    }
  } else if(!showSold && !showRecurring && document.getElementById('chartPortfolioHistory')){
    document.getElementById('chartPortfolioHistory').parentElement.innerHTML = 
      '<div class="section-sub" style="padding:40px 0; text-align:center;">Need at least 2 snapshots to draw a chart.<br>Click 📸 Record snapshot on different days.</div>';
  }
  
  /* ---- Filter & sort listeners ---- */
  const filterInput = document.getElementById('hFilter');
  if(filterInput){
    filterInput.addEventListener('input', (e)=>{
      state.holdingsFilter = e.target.value;
      state.holdingsPage = 1;
      const selStart = e.target.selectionStart, selEnd = e.target.selectionEnd;
      renderHoldings();
      const newInput = document.getElementById('hFilter');
      if(newInput){
        newInput.focus();
        newInput.setSelectionRange(selStart, selEnd);
      }
    });
  }
  const sortSelect = document.getElementById('hSort');
  if(sortSelect){
    sortSelect.addEventListener('change', (e)=>{
      state.holdingsSort = e.target.value;
      state.holdingsPage = 1;
      renderHoldings();
    });
  }

  /* ---- Charts (open view only) ---- */
  destroyChart('holdingAlloc');
  destroyChart('holdingPl');

  if(!showSold && !showRecurring && allocLabels.length > 0){
    charts.holdingAlloc = safeChart(document.getElementById('chartHoldingAlloc'), {
      type: 'doughnut',
      data: { labels: allocLabels, datasets: [{ data: allocVals, backgroundColor: allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor: '#1C2726', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { 
          legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, font: { size: 10.5 } } },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.raw;
                const pct = allocTotal > 0 ? ((val / allocTotal) * 100).toFixed(1) : 0;
                return ` ${context.label}: ${fmt$(val)} (${pct}%)`;
              }
            }
          }
        } }
    });

    charts.holdingPl = safeChart(document.getElementById('chartHoldingPl'), {
      type: 'bar',
      data: { labels: plLabels, datasets: [{ label: 'Unrealized P&L', data: plVals, backgroundColor: plColors, borderRadius: 4 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { color: '#26332F' }, ticks: { callback: v => '$' + v } }, y: { grid: { display: false } } } }
    });
  }
}