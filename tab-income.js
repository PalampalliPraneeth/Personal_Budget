/* =========================================================================
   INCOME TAB
   ========================================================================= */
let incomeFullYearView = false;

/* A row literally named "Retirement" is treated as your own 401(k)/IRA
   contribution showing up as income you earned but never took home as cash
   — see Savings → Retirement → "Your contributions" for the source data.
   It's kept in sync automatically, and its cells are locked (not hand-edited)
   so there's no way for it to silently drift out of sync with Savings. */
function syncAutoIncomeRows(y){
  if(typeof retirementSelfContribTotals !== 'function') return;
  const items = yearData(y).income;
  const retTotals = retirementSelfContribTotals(y);
  items.forEach(it=>{
    if((it.name||'').trim().toLowerCase()==='retirement'){
      it.m = retTotals.map(v=>roundCents(num(v)));
      it.raw = n12();
      it.currency = 'USD'; // retirementSelfContribTotals() already returns USD-converted figures
    }
  });
}

function renderIncome(){
  const y = state.year;
  syncAutoIncomeRows(y);
  const items = yearData(y).income;
  const totals = incomeTotals(y);
  const isMonthScope = state.month !== 'ALL';
  const showFullYear = incomeFullYearView || !isMonthScope;
  const monthsToShow = showFullYear ? [0,1,2,3,4,5,6,7,8,9,10,11] : [Number(state.month)];
  const totalsShown = monthsToShow.map(i=>totals[i]);
  const html = `
    <div class="section-title">Income · ${y}</div>
    <p class="section-sub">Every wage entry, editable in place. Click a cell to change it, or add a new income line below. A source named "Retirement" auto-fills from Savings → Retirement → "Your contributions" — that one's locked here, since it's computed, not typed.</p>
    <div class="view-toggle">
      ${isMonthScope ? `<button class="btn small" id="incomeViewToggle">${showFullYear && incomeFullYearView ? '◀ Show only '+MONTHS[Number(state.month)] : 'Show full year →'}</button>` : `<span class="section-sub" style="margin:0;">Showing the full year — pick a specific month above to narrow the table.</span>`}
    </div>
    <div class="card">
      <div class="card-head"><h3>Income sources</h3><span class="section-sub" style="margin:0;">Year total: <b style="color:var(--gold-soft)">${fmt$(sumArr(totals),2)}</b></span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Source</th>${monthHeaderCells(monthsToShow)}<th>Year</th><th>Notes</th><th>Currency</th></tr></thead>
          <tbody id="incomeBody">
            ${items.map(it=>{
              const isAutoRetirement = (it.name||'').trim().toLowerCase()==='retirement';
              return makeEditableRow(it, monthsToShow, isAutoRetirement ? {locked:true, lockedTip:'Auto-filled from Savings → Retirement → "Your contributions" — edit it there, not here.'} : undefined);
            }).join('')}
            <tr class="total-row"><td>Total</td>${totalsShown.map(t=>`<td>${fmt$(t)}</td>`).join('')}<td>${fmt$(sumArr(totals))}</td><td></td><td></td></tr>
          </tbody>
        </table>
      </div>
      <div class="addcat-row">
        <input type="text" id="newIncomeName" placeholder="New income source name…">
        <select id="newIncomeCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
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

  const viewToggle = document.getElementById('incomeViewToggle');
  if(viewToggle){
    viewToggle.addEventListener('click', ()=>{ incomeFullYearView = !incomeFullYearView; renderIncome(); });
  }

  document.getElementById('addIncomeBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newIncomeName');
    const currencySel = document.getElementById('newIncomeCurrency');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    items.push({id:uid(), name, m:n12(), currency: currencySel.value || 'USD'});
    markDirty(); renderIncome();
  });

  destroyChart('incomeTrend');
  charts.incomeTrend = safeChart(document.getElementById('chartIncomeTrend'), {
    type:'line',
    data:{ labels:MONTHS, datasets: items.map((it,i)=>({
      // Charted in USD so every source shares one axis — a raw INR figure
      // plotted next to a raw USD figure would silently mislead here.
      label: it.name, data: it.m.map((v,mi)=>nativeMonthToUsd(v, it.currency, y, mi)), borderColor: PALETTE[i%PALETTE.length], backgroundColor:'transparent', tension:.3, spanGaps:true
    })).concat([{label:'Total', data:totals, borderColor:'#EEE7D8', borderDash:[4,3], tension:.3}]) },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10, font:{size:10}}}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
}