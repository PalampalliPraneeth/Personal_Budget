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
  });
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

    <div class="card">
      <div class="card-head"><h3>Bank accounts — month by month</h3><span class="section-sub" style="margin:0;">Enter your end-of-month balance for each account. This is what the row above compares against.</span></div>
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
      <div class="addcat-row" style="margin-top:14px;">
        <input type="text" id="newBankName" placeholder="New bank name, e.g. HDFC, Schwab, Chase…" style="min-width:200px;">
        <select id="newBankCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addBankBtn">+ Add bank</button>
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

  /* ---- Add bank ---- */
  document.getElementById('addBankBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newBankName');
    const name = inp.value.trim();
    const currency = document.getElementById('newBankCurrency').value;
    if(!name){ inp.focus(); return; }
    banks.push({id:uid(), name, m:n12(), currency});
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