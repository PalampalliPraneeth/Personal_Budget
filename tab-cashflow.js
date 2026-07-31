/* =========================================================================
   CASH FLOW TAB
   ========================================================================= */
function renderCashFlow(){
  const y = state.year;
  const rows = computeCashFlow(y);
  const isFullYear = state.month==='ALL';
  const mi = isFullYear ? findLatestMonthWithData(y) : Number(state.month);
  const thisRow = rows[mi];
  const prevRow = mi>0 ? rows[mi-1] : null;

  const deltaHtml = (curr, prev)=>{
    if(prev===null) return `<div class="kpi-delta flat">no prior month in ${y}</div>`;
    const d = curr - prev.carryOut;
    return `<div class="kpi-delta ${d>=0?'up':'down'}">${d>=0?'▲':'▼'} ${fmt$(Math.abs(d))} vs ${MONTHS[mi-1]}</div>`;
  };

  const editCell = (i, field, value, extraClass)=>{
    const overridden = cfOverride(y,i,field)!==undefined;
    return `<td class="editable cf-cell ${extraClass||''} ${overridden?'overridden':''}" contenteditable="true" data-cfcell="${i}" data-cffield="${field}" title="${overridden?'Manually overridden — clear the cell to go back to the calculated value':''}">${fmt$(value,2)}</td>`;
  };

  const tableRows = rows.map((r,i)=>`
    <tr>
      <td>${MONTHS[i]}</td>
      ${editCell(i,'carryIn', r.carryIn)}
      ${editCell(i,'income', r.income)}
      ${editCell(i,'expenses', r.expenses)}
      ${editCell(i,'card', r.card)}
      ${editCell(i,'debtPaid', r.debtPaid)}
      <td style="font-weight:600; color:${r.netFlow>=0?'var(--teal-soft)':'var(--rust-soft)'}">${r.netFlow>=0?'+':''}${fmt$(r.netFlow,2)}</td>
      <td style="font-weight:700; color:var(--gold-soft)">${fmt$(r.carryOut,2)}</td>
    </tr>`).join('');

  const html = `
    <div class="section-title">Cash Flow · ${y}</div>
    <p class="section-sub">What you actually have on hand: income, minus categorized spending, minus card bill payments, minus debt payments — carried forward month over month. Every cell below is editable — type over anything to correct it for a specific month; clear a cell to go back to the calculated value.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Carried in from ${mi>0?MONTHS[mi-1]:'prior year'}</div><div class="kpi-value">${fmt$(thisRow.carryIn)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">${MONTHS[mi]} net flow</div><div class="kpi-value">${thisRow.netFlow>=0?'+':''}${fmt$(thisRow.netFlow)}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Card + debt paid this month</div><div class="kpi-value">${fmt$(thisRow.card+thisRow.debtPaid)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Cash on hand, end of ${MONTHS[mi]}</div><div class="kpi-value">${fmt$(thisRow.carryOut)}</div>${deltaHtml(thisRow.carryOut, prevRow)}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Running cash balance</h3></div>
      <div class="chart-box tall"><canvas id="chartCashRunning"></canvas></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Month by month</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th><th>Carry-in</th><th>Income</th><th>Expenses</th><th>Card Paid</th><th>Debt Paid</th><th>Net Flow</th><th>Carry-out</th></tr></thead>
          <tbody id="cfBody">${tableRows}</tbody>
        </table>
      </div>
      <div class="section-sub" style="margin-top:10px; margin-bottom:0;">Expenses exclude groups marked "excluded from totals" (like Credit Card Spend) — those show in Card Paid instead, and debt principal payments show in Debt Paid, so nothing is counted twice while still hitting your real cash balance. Cells with a gold underline have been manually overridden for that month.</div>
    </div>
  `;
  document.getElementById('panel-cashflow').innerHTML = html;

  document.querySelectorAll('#cfBody [data-cfcell]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.prev = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.prev) return; // no actual edit — don't mark dirty
      const i = Number(td.dataset.cfcell), field = td.dataset.cffield;
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      if(raw===''){
        setCfOverride(y, i, field, null);
      } else {
        const v = parseFloat(raw);
        if(!isNaN(v)) setCfOverride(y, i, field, v);
        else return; // unparseable — leave as-is, don't mark dirty
      }
      markDirty('cashflow');
      renderCashFlow();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

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
