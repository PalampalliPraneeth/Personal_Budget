/* =========================================================================
   INCOME TAB
   ========================================================================= */
function renderIncome(){
  const y = state.year;
  const items = yearData(y).income;
  const totals = incomeTotals(y);
  const html = `
    <div class="section-title">Income · ${y}</div>
    <p class="section-sub">Every wage entry, editable in place. Click a cell to change it, or add a new income line below.</p>
    <div class="card">
      <div class="card-head"><h3>Income sources</h3><span class="section-sub" style="margin:0;">Year total: <b style="color:var(--gold-soft)">${fmt$(sumArr(totals),2)}</b></span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Source</th>${monthHeaderCells()}<th>Year</th><th>Notes</th></tr></thead>
          <tbody id="incomeBody">
            ${items.map(it=>makeEditableRow(it)).join('')}
            <tr class="total-row"><td>Total</td>${totals.map(t=>`<td>${fmt$(t)}</td>`).join('')}<td>${fmt$(sumArr(totals))}</td><td></td></tr>
          </tbody>
        </table>
      </div>
      <div class="addcat-row">
        <input type="text" id="newIncomeName" placeholder="New income source name…">
        <button class="btn primary small" id="addIncomeBtn">+ Add income source</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Income trend</h3></div>
      <div class="chart-box"><canvas id="chartIncomeTrend"></canvas></div>
    </div>
  `;
  document.getElementById('panel-income').innerHTML = html;
  attachEditableHandlers(document.getElementById('incomeBody'), items, renderIncome);

  document.getElementById('addIncomeBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newIncomeName');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    items.push({id:uid(), name, m:n12()});
    markDirty(); renderIncome();
  });

  destroyChart('incomeTrend');
  charts.incomeTrend = safeChart(document.getElementById('chartIncomeTrend'), {
    type:'line',
    data:{ labels:MONTHS, datasets: items.map((it,i)=>({
      label: it.name, data: it.m, borderColor: PALETTE[i%PALETTE.length], backgroundColor:'transparent', tension:.3, spanGaps:true
    })).concat([{label:'Total', data:totals, borderColor:'#EEE7D8', borderDash:[4,3], tension:.3}]) },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10, font:{size:10}}}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
}
