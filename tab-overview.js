function goToTab(tabId, highlightSelector){
  guardAndSwitch(()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tabId));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+tabId));
    if(tabId==='expenses' && highlightSelector){
      const m = highlightSelector.match(/data-group-id="([^"]+)"/);
      if(m) collapsedGroups[m[1]] = false;
    }
    renderActive();
    if(highlightSelector){
      requestAnimationFrame(()=>{
        const el = document.querySelector(highlightSelector);
        if(el){
          el.scrollIntoView({behavior:'smooth', block:'center'});
          el.classList.add('flash-highlight');
          setTimeout(()=>el.classList.remove('flash-highlight'), 1600);
        }
      });
    }
  });
}

function renderOverview(){
  const y = state.year;
  const prevY = y-1;
  const hasPrevYear = !!DATA[prevY];
  const incT = incomeTotals(y), expT = expenseTotalsCounted(y), cardT = expenseTotalsExcluded(y);
  const incNow = sumArr(incT), expNow = sumArr(expT), cardNow = sumArr(cardT);
  const net = incNow - expNow; 
  const hasExcluded = yearData(y).expenseGroups.some(g=>g.excludeFromTotal);

  const incPrevYear = hasPrevYear ? sumArr(incomeTotals(prevY)) : 0;
  const expPrevYear = hasPrevYear ? sumArr(expenseTotalsCounted(prevY)) : 0;

  const cfRows = computeCashFlow(y);
  const cfIdx = findLatestMonthWithData(y);
  const cashOnHand = cfRows[cfIdx].carryOut;
  const cashPrevMonth = cfIdx>0 ? cfRows[cfIdx-1].carryOut : null;

  const fx = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : 84.0;
  const invCurrent = sumArr(yearData(y).investments.map(i => {
    if (i.currency === 'INR') return num(i.currentValue) / fx;
    return num(i.currentValue);
  }));

  const debts = yearData(y).debts;
  const debtPending = sumArr(debts.map(d=>debtPendingCalc(d)));
  const netWorth = cashOnHand + invCurrent - debtPending;

  const deltaHtml = (curr,prev,inverse)=>{
    if(!hasPrevYear) return `<div class="kpi-delta flat">no ${prevY} data to compare</div>`;
    if(prev===0 && curr===0) return `<div class="kpi-delta flat">flat vs ${prevY}</div>`;
    const d = prev===0 ? 100 : ((curr-prev)/Math.abs(prev))*100;
    const goodDir = inverse ? d<=0 : d>=0;
    const arrow = d>=0 ? '▲' : '▼';
    return `<div class="kpi-delta ${goodDir?'up':'down'}">${arrow} ${Math.abs(d).toFixed(1)}% vs ${prevY}</div>`;
  };

  const html = `
  <div class="section-title">Overview</div>
  <p class="section-sub">Full-year snapshot for ${y}${hasPrevYear?', compared against '+prevY:''} — this tab always shows the whole year, regardless of the month selector above (that selector still drives Cash Flow, Expenses, and Debt Payoff). Click any card or chart segment to jump to where that figure comes from.</p>

  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(170px,1fr));">
    <!-- NET WORTH: now first -->
    <div class="kpi-card ${netWorth>=0?'c-gold':'c-danger'}">
      <div class="kpi-label">Net Worth</div>
      <div class="kpi-value">${fmt$(netWorth)}</div>
      <div class="kpi-delta flat">cash + investments − debt</div>
    </div>

    <div class="kpi-card c-gold clickable" data-goto="income">
      <div class="kpi-label">Income (${y})</div>
      <div class="kpi-value">${fmt$(incNow)}</div>
      ${deltaHtml(incNow, incPrevYear)}
    </div>
    <div class="kpi-card c-rust clickable" data-goto="expenses">
      <div class="kpi-label">Expenses (${y})</div>
      <div class="kpi-value">${fmt$(expNow)}</div>
      ${deltaHtml(expNow, expPrevYear, true)}
    </div>

    <!-- NET SAVINGS: hidden for now -->
    <!--
    <div class="kpi-card ${net>=0?'c-teal':'c-danger'}">
      <div class="kpi-label">Net Savings (${y})</div>
      <div class="kpi-value">${fmt$(net)}</div>
      ${deltaHtml(net, incPrevYear-expPrevYear)}
    </div>
    -->

    <div class="kpi-card c-gold clickable" data-goto="cashflow">
      <div class="kpi-label">Cash on Hand, end of ${MONTHS[cfIdx]}</div>
      <div class="kpi-value">${fmt$(cashOnHand)}</div>
      ${cashPrevMonth===null ? '<div class="kpi-delta flat">no prior month in '+y+'</div>' : `<div class="kpi-delta ${cashOnHand>=cashPrevMonth?'up':'down'}">${cashOnHand>=cashPrevMonth?'▲':'▼'} ${fmt$(Math.abs(cashOnHand-cashPrevMonth))} vs ${MONTHS[cfIdx-1]}</div>`}
    </div>
    <div class="kpi-card c-teal clickable" data-goto="investments">
      <div class="kpi-label">Invested (current value)</div>
      <div class="kpi-value">${fmt$(invCurrent)}</div>
      <div class="kpi-delta flat">across ${yearData(y).investments.length} holdings</div>
    </div>
    <div class="kpi-card c-danger clickable" data-goto="debt">
      <div class="kpi-label">Debt Remaining</div>
      <div class="kpi-value">${fmt$(debtPending)}</div>
      <div class="kpi-delta flat">across ${debts.filter(d=>debtPendingCalc(d)>0).length} open loans</div>
    </div>
  </div>

  ${hasExcluded ? `<div class="notice">Card payments of <b>${fmt$(cardNow)}</b> this year aren't added into Expenses above — they're excluded by default since those purchases are already counted under their own category (groceries, dining, etc.) when you swipe. They still reduce your real cash balance though — see the <b>Cash Flow</b> tab.</div>` : ''}

  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h3>Income vs. expenses, month by month</h3></div>
      <div class="chart-box tall"><canvas id="chartTrend"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Where ${y} went</h3></div>
      <div class="chart-box tall"><canvas id="chartBreakdown"></canvas></div>
      <div class="section-sub" style="margin-top:8px; margin-bottom:0;">Click a slice to open that category.</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>Debt runway</h3><span class="section-sub" style="margin:0;">${fmt$(debtPending)} left of ${fmt$(sumArr(debts.map(d=>d.total)))} originally owed · click a bar to open that loan</span></div>
    <div class="chart-box short"><canvas id="chartDebtMini"></canvas></div>
  </div>
  `;
  document.getElementById('panel-overview').innerHTML = html;

  document.querySelectorAll('#panel-overview [data-goto]').forEach(el=>{
    el.addEventListener('click', ()=> goToTab(el.dataset.goto));
  });

  destroyChart('trend'); destroyChart('breakdown'); destroyChart('debtmini');

  charts.trend = safeChart(document.getElementById('chartTrend'), {
    type:'bar',
    data:{ labels:MONTHS, datasets:[
      {label:'Income', data:incT, backgroundColor:'#C9A961', borderRadius:4, barPercentage:0.6},
      {label:'Expenses', data:expT, backgroundColor:'#C06A46', borderRadius:4, barPercentage:0.6},
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10, boxHeight:10}}},
      onClick:(evt,els)=>{ if(els.length) goToTab(els[0].datasetIndex===0?'income':'expenses'); },
      onHover:(evt,els)=>{ evt.native.target.style.cursor = els.length?'pointer':'default'; },
      scales:{ y:{ grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });

  const groupsSorted = yearData(y).expenseGroups
    .filter(g=>!g.excludeFromTotal)
    .map(g=>({g, total: sumArr(groupTotals(g))}))
    .sort((a,b)=> b.total-a.total);
  const labels = groupsSorted.map(x=>x.g.name);
  const vals = groupsSorted.map(x=>x.total);
  const breakdownTotal = vals.reduce((a,b)=>a+b,0); // ← ADD THIS LINE

  charts.breakdown = safeChart(document.getElementById('chartBreakdown'), {
    type:'doughnut',
    data:{ labels, datasets:[{ data:vals, backgroundColor:labels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'62%',
      onClick:(evt,els)=>{ if(els.length){ const g=groupsSorted[els[0].index].g; goToTab('expenses', `[data-group-id="${g.id}"]`); } },
      onHover:(evt,els)=>{ evt.native.target.style.cursor = els.length?'pointer':'default'; },
      plugins:{
        legend:{position:'right', labels:{boxWidth:9, boxHeight:9, padding:10, font:{size:10.5}}},
        tooltip:{
          callbacks:{
            label: function(ctx){
              const v = ctx.raw;
              const pct = breakdownTotal > 0 ? ((v/breakdownTotal)*100).toFixed(1) : 0;
              return ` ${ctx.label}: ${fmt$(v)} (${pct}%)`;
            }
          }
        }
      } }
  });

  const debtsSorted = debts.slice().sort((a,b)=> debtPendingCalc(b)-debtPendingCalc(a));
  charts.debtmini = safeChart(document.getElementById('chartDebtMini'), {
    type:'bar',
    data:{ labels: debtsSorted.map(d=>d.name), datasets:[
      {label:'Cleared', data:debtsSorted.map(d=>debtClearedToDate(d)), backgroundColor:'#6FA491', stack:'s'},
      {label:'Pending', data:debtsSorted.map(d=>debtPendingCalc(d)), backgroundColor:'#C06A46', stack:'s'}
    ]},
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
      onClick:(evt,els)=>{ if(els.length){ const d=debtsSorted[els[0].index]; goToTab('debt', `[data-debt-id="${d.id}"]`); } },
      onHover:(evt,els)=>{ evt.native.target.style.cursor = els.length?'pointer':'default'; },
      scales:{ x:{ stacked:true, grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v} }, y:{stacked:true, grid:{display:false}} } }
  });
}