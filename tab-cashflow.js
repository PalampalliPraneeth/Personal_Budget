/* =========================================================================
   CASH FLOW TAB
   ========================================================================= */
function ensureBanksMigration(){
  const y = state.year;
  if(!yearData(y).banks) yearData(y).banks = [];
  // Migrate old banks (balance/lastUpdated) to new format (m array)
  yearData(y).banks.forEach(b => {
    if(!b.m) b.m = n12();
    // If old single balance exists, stuff it into current month as a starting point
    if(b.balance !== undefined && b.balance !== null && b.m.every(v => v === null)){
      const today = new Date();
      const cm = today.getMonth();
      b.m[cm] = num(b.balance);
      delete b.balance;
      delete b.lastUpdated;
    }
    if(!b.type) b.type = 'checking';
    if(!b.transactions) b.transactions = [];
    if(b.lastUpdatedAt===undefined) b.lastUpdatedAt = null;
  });
}
const BANK_TYPE_LABELS = { checking:'Checking', savings:'Savings', other:'Other' };
function timeAgo(ts){
  if(!ts) return 'no updates yet';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins+' minute'+(mins===1?'':'s')+' ago';
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return hrs+' hour'+(hrs===1?'':'s')+' ago';
  const days = Math.floor(hrs/24);
  if(days < 30) return days+' day'+(days===1?'':'s')+' ago';
  const months = Math.floor(days/30);
  return months+' month'+(months===1?'':'s')+' ago';
}

function renderCashFlow(){
  const y = state.year;
  const rows = computeCashFlow(y);
  const isFullYear = state.month==='ALL';
  const mi = isFullYear ? currentSnapshotMonth(y) : Number(state.month);
  const thisRow = rows[mi];
  const prevRow = mi>0 ? rows[mi-1] : null;

  /* ---- Banks ---- */
  ensureBanksMigration();
  const banks = yearData(y).banks;

  /* ---- Cash summary card + clickable bank list (Monarch-style) ---- */
  const bankUsdAt = (b, i) => {
    const v = (b.m||[])[i];
    if(v===null || v===undefined) return null;
    return nativeMonthToUsd(v, b.currency, y, i);
  };
  const cashSnapIdx = currentSnapshotMonth(y);
  const cashTotal = sumArr(banks.map(b => bankUsdAt(b, cashSnapIdx) || 0));
  const cashPrevTotal = cashSnapIdx>0 ? sumArr(banks.map(b => bankUsdAt(b, cashSnapIdx-1) || 0)) : null;
  const cashDelta = cashPrevTotal===null ? null : cashTotal - cashPrevTotal;
  const cashDeltaPct = (cashPrevTotal && cashPrevTotal!==0) ? (cashDelta/Math.abs(cashPrevTotal))*100 : null;

  // Same components Net Worth uses, so "% of assets" lines up with Overview.
  const invCurrentForAssets = sumArr(yearData(y).investments.map(it => {
    const platRows = (it.holdings && it.holdings.length && typeof platformHoldings === 'function') ? platformHoldings(y, it.id) : [];
    if(platRows.length) return sumArr(platRows.map(r=>r.currentValueUSD));
    return nativeMonthToUsd(num(it.currentValue), it.currency, y, cashSnapIdx);
  }));
  const savingsForAssets = sumArr((yearData(y).savingsAccounts||[]).map(acc=>nativeMonthToUsd(num((acc.m||[])[cashSnapIdx]), acc.currency, y, cashSnapIdx)));
  const retirementForAssets = sumArr((yearData(y).retirementAccounts||[]).map(r=>retirementAccountTotalBalance(r)));
  const totalAssets = cashTotal + invCurrentForAssets + savingsForAssets + retirementForAssets;
  const cashPctOfAssets = totalAssets>0 ? (cashTotal/totalAssets)*100 : null;

  const bankRows = banks.map(b=>{
    const bal = bankUsdAt(b, cashSnapIdx);
    const initial = (b.name||'?').trim().charAt(0).toUpperCase() || '?';
    return `
    <div class="bank-row" data-bank-open="${b.id}">
      <div class="bank-row-icon">${initial}</div>
      <div class="bank-row-main">
        <div class="bank-row-name">${b.name}</div>
        <div class="bank-row-sub">${BANK_TYPE_LABELS[b.type]||'Checking'}</div>
      </div>
      <div class="bank-row-right">
        <div class="bank-row-balance">${bal===null?'—':fmt$(bal,2)}</div>
        <div class="bank-row-sub">${timeAgo(b.lastUpdatedAt)}</div>
      </div>
    </div>`;
  }).join('');

  const cashCard = `
    <div class="card cash-summary-card">
      <div class="cash-summary-head">
        <div class="cash-summary-title">Cash</div>
        <div class="cash-summary-value">${fmt$(cashTotal,2)}</div>
      </div>
      <div class="cash-summary-sub">
        ${cashDelta===null ? `<span class="section-sub" style="margin:0;">no prior month in ${y}</span>` : `
          <span class="cash-delta ${cashDelta>=0?'up':'down'}">${cashDelta>=0?'↑':'↓'} ${fmt$(Math.abs(cashDelta),2)}${cashDeltaPct===null?'':' ('+(cashDelta>=0?'+':'-')+Math.abs(cashDeltaPct).toFixed(1)+'%)'}</span>
          <span class="cash-delta-period">${MONTHS[cashSnapIdx-1]||'prior'} → ${MONTHS[cashSnapIdx]}</span>
        `}
        ${cashPctOfAssets===null?'':`<span class="cash-pct-assets">${cashPctOfAssets.toFixed(0)}% of assets</span>`}
      </div>
      <div class="bank-row-list">
        ${bankRows || '<div class="section-sub" style="padding:14px 0; text-align:center; margin:0;">No bank accounts yet — add one below.</div>'}
      </div>
      <div class="addcat-row" style="margin-top:14px;">
        <input type="text" id="newBankName" placeholder="New bank name, e.g. HDFC, Schwab, Chase…" style="min-width:200px;">
        <select id="newBankType" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="other">Other</option>
        </select>
        <select id="newBankCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addBankBtn">+ Add bank</button>
      </div>
    </div>
  `;

  const deltaHtml = (curr, prev)=>{
    if(prev===null) return `<div class="kpi-delta flat">no prior month in ${y}</div>`;
    const d = curr - prev.carryOut;
    return `<div class="kpi-delta ${d>=0?'up':'down'}">${d>=0?'▲':'▼'} ${fmt$(Math.abs(d))} vs ${MONTHS[mi-1]}</div>`;
  };

  const editCell = (i, field, value, extraClass)=>{
    const overridden = cfOverride(y,i,field)!==undefined;
    return `<td class="editable cf-cell ${extraClass||''} ${overridden?'overridden':''}" contenteditable="true" data-cfcell="${i}" data-cffield="${field}" title="${overridden?'Manually overridden — clear the cell to go back to the calculated value':''}">${fmt$(value,2)}</td>`;
  };

  /* ---- Cash Flow Month-by-Month Table ---- */
  const tableRows = rows.map((r,i)=>`
    <tr>
      <td>${MONTHS[i]}</td>
      ${editCell(i,'carryIn', r.carryIn)}
      ${editCell(i,'income', r.income)}
      ${editCell(i,'expenses', r.expenses)}
      ${editCell(i,'card', r.card)}
      ${editCell(i,'debtPaid', r.debtPaid)}
      ${editCell(i,'retirement', r.retirement)}
      <td style="font-weight:600; color:${r.netFlow>=0?'var(--teal-soft)':'var(--rust-soft)'}">${r.netFlow>=0?'+':''}${fmt$(r.netFlow,2)}</td>
      <td style="font-weight:700; color:var(--gold-soft)">${fmt$(r.carryOut,2)}</td>
    </tr>`).join('');

  /* ---- Reconciliation row: computed cash vs bank balances ---- */
  const reconcileRows = rows.map((r,i)=>{
    const bankTotal = banks.reduce((a,b)=>a+num((b.m||[])[i]),0);
    const diff = bankTotal - r.carryOut;
    const match = Math.abs(diff) < 1;
    const hasBankData = banks.length > 0 && banks.some(b => (b.m||[])[i] !== null && (b.m||[])[i] !== undefined);
    return `<tr>
      <td>${MONTHS[i]}</td>
      <td style="color:var(--gold-soft); font-weight:600;">${fmt$(r.carryOut,2)}</td>
      <td style="color:var(--teal-soft); font-weight:600;">${hasBankData?fmt$(bankTotal,2):'—'}</td>
      <td style="color:${match?'var(--good)':Math.abs(diff)<100?'var(--gold-soft)':'var(--danger)'}; font-weight:600;">
        ${hasBankData?(match?'✓':(diff>=0?'+':'')+fmt$(diff,2)):'—'}
      </td>
    </tr>`;
  }).join('');

  /* ---- Banks Month-by-Month Table (like Expenses) ---- */
  const bankMonthRows = banks.map(b=>{
    const cells = MONTHS.map((_,i)=>{
      const v = (b.m||[])[i];
      const val = v===null||v===undefined ? '' : v;
      return `<td class="editable ${!val?'zero':''}" contenteditable="true" data-bfield="m" data-bid="${b.id}" data-idx="${i}">${val===''?'–':val}</td>`;
    }).join('');
    const total = sumArr(b.m||[]);
    return `<tr data-bank-id="${b.id}">
      <td style="font-weight:600;">${b.name} <span class="row-del" data-delbank="${b.id}">✕</span></td>
      ${cells}
      <td style="font-weight:700;">${fmt$(total,2)}</td>
      <td style="color:var(--text-dim); font-size:11px;">${b.currency||'USD'}</td>
    </tr>`;
  }).join('');

  const html = `
    <div class="section-title">Cash Flow · ${y}</div>
    <p class="section-sub">What you actually have on hand: income, minus categorized spending, minus card bill payments, minus debt payments, minus your own retirement contribution — carried forward month over month. Every cell below is editable — type over anything to correct it for a specific month; clear a cell to go back to the calculated value.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Carried in from ${mi>0?MONTHS[mi-1]:'prior year'}</div><div class="kpi-value">${fmt$(thisRow.carryIn)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">${MONTHS[mi]} net flow</div><div class="kpi-value">${thisRow.netFlow>=0?'+':''}${fmt$(thisRow.netFlow)}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Card + debt + retirement this month</div><div class="kpi-value">${fmt$(thisRow.card+thisRow.debtPaid+thisRow.retirement)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Cash on hand, end of ${MONTHS[mi]}</div><div class="kpi-value">${fmt$(thisRow.carryOut)}</div>${deltaHtml(thisRow.carryOut, prevRow)}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Running cash balance</h3></div>
      <div class="chart-box tall"><canvas id="chartCashRunning"></canvas></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Month by month — computed cash flow</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th><th>Carry-in</th><th>Income</th><th>Expenses</th><th>Card Paid</th><th>Debt Paid</th><th>Retirement</th><th>Net Flow</th><th>Carry-out</th></tr></thead>
          <tbody id="cfBody">${tableRows}</tbody>
        </table>
      </div>
      <div class="section-sub" style="margin-top:10px; margin-bottom:0;">
        <b>How this works:</b> <b>Carry-in</b> is what you had at the start. <b>Income</b> adds to it. <b>Expenses</b>, <b>Card Paid</b>, <b>Debt Paid</b>, and <b>Retirement</b> (your own contribution — employer match isn't your cash, so it's excluded) subtract. The result is <b>Net Flow</b>. <b>Carry-out</b> = Carry-in + Net Flow. That carry-out becomes next month's carry-in automatically.
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Reconciliation — computed vs. actual bank balances</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th><th>Computed Cash</th><th>Banks Total</th><th>Difference</th></tr></thead>
          <tbody>${reconcileRows}</tbody>
        </table>
      </div>
      <div class="section-sub" style="margin-top:10px; margin-bottom:0;">
        Enter your actual bank balances below month by month. <b>✓</b> means your tracked numbers match reality. If there's a gap, you missed income, an expense, a transfer, or a debt payment.
      </div>
    </div>

    ${cashCard}

    <div class="card">
      <div class="card-head"><h3>Advanced: bank accounts, month by month</h3><span class="section-sub" style="margin:0;">Direct editing for any month — the card above only touches the current month via "Add money."</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Bank / Account</th>${monthHeaderCells()}<th>Year</th><th>Currency</th></tr></thead>
          <tbody id="bankBody">${bankMonthRows}
            <tr class="total-row"><td>Total across banks</td>${MONTHS.map((_,i)=>{
              const t = banks.reduce((a,b)=>a+num((b.m||[])[i]),0);
              return `<td>${t>0?fmt$(t):'—'}</td>`;
            }).join('')}<td>${fmt$(banks.reduce((a,b)=>a+sumArr(b.m||[]),0))}</td><td></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('panel-cashflow').innerHTML = html;

  /* ---- Cash flow cell handlers ---- */
  document.querySelectorAll('#cfBody [data-cfcell]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.prev = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.prev) return;
      const i = Number(td.dataset.cfcell), field = td.dataset.cffield;
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      if(raw===''){
        setCfOverride(y, i, field, null);
      } else {
        const v = parseFloat(raw);
        if(!isNaN(v)) setCfOverride(y, i, field, v);
        else return;
      }
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Cash Flow '+MONTHS[i], field:field, oldVal:td.dataset.prev, newVal:raw});
      renderCashFlow();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Bank month cell handlers ---- */
  document.querySelectorAll('#bankBody [data-bfield="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const b = banks.find(x=>x.id===td.dataset.bid);
      if(!b) return;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v = null;
      if(!b.m) b.m = n12();
      const before = b.m[idx];
      if(before===v) return;
      b.m[idx] = v;
      b.lastUpdatedAt = Date.now();
      td.textContent = v===null?'–':roundCents(v);
      td.classList.toggle('zero', !v);
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Bank '+b.name, field:MONTHS[idx], oldVal:before===null?'empty':before, newVal:v===null?'empty':v});
      renderCashFlow();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Delete bank ---- */
  document.querySelectorAll('[data-delbank]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = banks.findIndex(x=>x.id===el.dataset.delbank);
      if(idx>-1 && confirm('Remove "'+banks[idx].name+'"?')){
        const name = banks[idx].name;
        banks.splice(idx,1);
        markDirty('cashflow', {tab:'cashflow', action:'delete', target:'Bank '+name});
        renderCashFlow();
      }
    });
  });

  /* ---- Open bank detail (Monarch-style click-through) ---- */
  document.querySelectorAll('[data-bank-open]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const b = banks.find(x=>x.id===el.dataset.bankOpen);
      if(b) openBankDetailModal(b, y);
    });
  });

  /* ---- Add bank ---- */
  document.getElementById('addBankBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newBankName');
    const name = inp.value.trim();
    const type = document.getElementById('newBankType').value;
    const currency = document.getElementById('newBankCurrency').value;
    if(!name){ inp.focus(); return; }
    banks.push({id:uid(), name, m:n12(), currency, type, transactions:[], lastUpdatedAt:null});
    markDirty('cashflow', {tab:'cashflow', action:'add', target:'Bank '+name});
    renderCashFlow();
  });

  /* ---- Charts ---- */
  destroyChart('cashRunning');
  charts.cashRunning = safeChart(document.getElementById('chartCashRunning'), {
    type:'line',
    data:{ labels: MONTHS, datasets:[
      {label:'Cash on hand (end of month)', data: rows.map(r=>r.carryOut), borderColor:'#C9A961', backgroundColor:'rgba(201,169,97,0.12)', fill:true, tension:.3},
      {label:'Net flow', data: rows.map(r=>r.netFlow), borderColor:'#6FA491', borderDash:[4,3], tension:.3, pointRadius:2}
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
}
/* ---------- Bank detail modal (Monarch-style click-through) ---------- */
function openBankDetailModal(bank, y){
  const old = document.getElementById('bankDetailOverlay');
  if(old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bankDetailOverlay';
  overlay.className = 'modal-overlay';

  const monthIdx = currentSnapshotMonth(y);
  const balUsd = nativeMonthToUsd(num((bank.m||[])[monthIdx]), bank.currency, y, monthIdx);
  const txns = [...(bank.transactions||[])].sort((a,b)=> (b.date||'').localeCompare(a.date||'')).slice(0,10);

  const txnRows = txns.map(t=>{
    const catLabel = t.category==='income' ? '💰 Income' : t.category==='transfer' ? '🔁 Transfer' : '📝 Other';
    const color = num(t.amount)>=0 ? 'var(--good)' : 'var(--danger)';
    return `<div class="bank-txn-row">
      <div class="bank-txn-main">
        <div class="bank-txn-date">${t.date}</div>
        <div class="bank-txn-cat">${catLabel}${t.note?' · '+t.note:''}</div>
      </div>
      <div class="bank-txn-amt" style="color:${color};">${num(t.amount)>=0?'+':''}${fmt$(t.amount,2)}</div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="modal-card" style="width:420px;">
      <h3>🏦 ${bank.name}</h3>
      <p class="modal-sub">${BANK_TYPE_LABELS[bank.type]||'Checking'} · ${bank.currency||'USD'}</p>
      <div class="modal-preview">
        <span class="label">Balance (${MONTHS[monthIdx]})</span>
        <span class="value">${fmt$(balUsd,2)}</span>
      </div>
      <div style="max-height:220px; overflow-y:auto; margin-bottom:18px;">
        ${txnRows || '<div class="section-sub" style="text-align:center; padding:14px 0;">No transactions logged yet — anything you add here will show up in this list.</div>'}
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn" id="bankDetailCloseBtn">Close</button>
        <button class="btn primary" id="bankDetailAddMoneyBtn">+ Add money</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#bankDetailCloseBtn').addEventListener('click', close);
  overlay.querySelector('#bankDetailAddMoneyBtn').addEventListener('click', ()=>{
    close();
    openAddMoneyModal(bank, y);
  });
}

/* ---------- Add Money modal ----------
   Everything this writes is ADDITIVE, never a replacement: the bank's
   balance for that month, and (if tagged Income) that income source's
   month, both get the new amount added to whatever's already there. Log
   two deposits in the same week — say $2,000 then $1,500 — and the
   month's income ends up $3,500, not stuck at whichever was entered last.
   ========================================================================= */
function openAddMoneyModal(bank, y){
  const old = document.getElementById('addMoneyOverlay');
  if(old) old.remove();

  const incomeSources = yearData(y).income || [];
  const todayISO = new Date().toISOString().slice(0,10);

  const overlay = document.createElement('div');
  overlay.id = 'addMoneyOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="width:400px;">
      <h3>+ Add money — ${bank.name}</h3>
      <p class="modal-sub">Adds to this account's balance for the month you pick. Tag it as Income and it also adds to that month's income — on top of anything already there, never replacing it.</p>
      <div class="modal-field">
        <label>Amount (${bank.currency||'USD'})</label>
        <input type="number" id="amAmount" min="0" step="any" placeholder="0.00">
      </div>
      <div class="modal-field">
        <label>Direction</label>
        <select id="amDirection" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          <option value="deposit">Deposit (+)</option>
          <option value="withdraw">Withdraw (−)</option>
        </select>
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="amDate" value="${todayISO}">
      </div>
      <div class="modal-field">
        <label>Category</label>
        <select id="amCategory" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          <option value="income">💰 Income (adds to your Income tab too)</option>
          <option value="transfer">🔁 Transfer between my own accounts</option>
          <option value="other">📝 Other / balance correction</option>
        </select>
      </div>
      <div class="modal-field" id="amIncomeSrcWrap">
        <label>Which income source? <span class="hint">uses the month from the date above</span></label>
        <select id="amIncomeSrc" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${incomeSources.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}
          <option value="__new__">+ New income source…</option>
        </select>
      </div>
      <div class="modal-field" id="amNewIncomeNameWrap" style="display:none;">
        <label>New income source name</label>
        <input type="text" id="amNewIncomeName" placeholder="e.g. Paycheck, Freelance, Side gig…">
      </div>
      <div class="modal-field">
        <label>Note <span class="hint">optional</span></label>
        <input type="text" id="amNote" placeholder="e.g. Biweekly paycheck">
      </div>
      <div class="modal-actions">
        <button class="btn" id="amCancelBtn">Cancel</button>
        <button class="btn primary" id="amSaveBtn">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const categorySelect = overlay.querySelector('#amCategory');
  const incomeSrcWrap = overlay.querySelector('#amIncomeSrcWrap');
  const incomeSrcSelect = overlay.querySelector('#amIncomeSrc');
  const newIncomeNameWrap = overlay.querySelector('#amNewIncomeNameWrap');
  function syncIncomeVisibility(){
    incomeSrcWrap.style.display = categorySelect.value==='income' ? 'block' : 'none';
    newIncomeNameWrap.style.display = (categorySelect.value==='income' && incomeSrcSelect.value==='__new__') ? 'block' : 'none';
  }
  categorySelect.addEventListener('change', syncIncomeVisibility);
  incomeSrcSelect.addEventListener('change', syncIncomeVisibility);
  syncIncomeVisibility();

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#amCancelBtn').addEventListener('click', close);

  overlay.querySelector('#amSaveBtn').addEventListener('click', ()=>{
    const amountInp = overlay.querySelector('#amAmount');
    let amount = parseFloat(amountInp.value);
    if(!amount || amount<=0){ amountInp.focus(); return; }
    const direction = overlay.querySelector('#amDirection').value;
    if(direction==='withdraw') amount = -amount;
    const dateStr = overlay.querySelector('#amDate').value;
    if(!dateStr){ overlay.querySelector('#amDate').focus(); return; }
    const dt = new Date(dateStr);
    const monthIdx = dt.getMonth();
    const category = categorySelect.value;
    const note = overlay.querySelector('#amNote').value.trim();

    // 1. Bank balance: ADD to whatever is already there for that month.
    if(!bank.m) bank.m = n12();
    bank.m[monthIdx] = num(bank.m[monthIdx]) + amount;
    bank.lastUpdatedAt = Date.now();

    // 2. Transaction log, for the history list in the detail view.
    if(!bank.transactions) bank.transactions = [];
    bank.transactions.push({id:uid(), date:dateStr, amount, category, note});

    // 3. If tagged Income, ADD to that income source's month too.
    let incomeName = null;
    if(category==='income' && amount>0){
      let srcId = incomeSrcSelect.value;
      const incomeList = yearData(y).income;
      if(srcId==='__new__'){
        const newName = overlay.querySelector('#amNewIncomeName').value.trim();
        if(!newName){ overlay.querySelector('#amNewIncomeName').focus(); return; }
        const newSrc = {id:uid(), name:newName, m:n12()};
        incomeList.push(newSrc);
        srcId = newSrc.id;
        incomeName = newName;
      }
      const src = incomeList.find(s=>s.id===srcId);
      if(src){
        src.m[monthIdx] = num(src.m[monthIdx]) + amount;
        incomeName = incomeName || src.name;
      }
    }

    markDirty('cashflow', {tab:'cashflow', action:'add', target:'Bank '+bank.name+' — '+(amount>=0?'deposit':'withdrawal'),
      field:MONTHS[monthIdx], newVal: (amount>=0?'+':'')+amount.toFixed(2) + (incomeName?' → income: '+incomeName:'')});
    close();
    renderCashFlow();
    showToast((amount>=0?'+':'')+fmt$(Math.abs(amount),2)+' '+(amount>=0?'added to':'withdrawn from')+' '+bank.name+(incomeName?' · added to '+incomeName+' income':''));
  });

  overlay.querySelector('#amAmount').focus();
}