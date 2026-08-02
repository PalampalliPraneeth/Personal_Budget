/* =========================================================================
   DEBT PAYOFF TAB
   ========================================================================= */
function planRowTotal(plan, row){
  return plan.columns.filter(c=>c.kind==='expense').reduce((a,c)=>a+num(row.values[c.id]),0);
}
function planRowIncome(plan, row){
  return plan.columns.filter(c=>c.kind==='income').reduce((a,c)=>a+num(row.values[c.id]),0);
}
function planRowRemaining(plan, row){
  return planRowIncome(plan,row) - planRowTotal(plan,row);
}

function simulatePayoffWithPlan(debts, plan){
  const items = debts.filter(d=>debtPendingCalc(d)>0).map(d=>{ const p=debtPendingCalc(d); return {
    name:d.name, balance:p, rate:(num(d.interest)/100)/12,
    minPay: d.emi && d.emi>0 ? Math.min(d.emi, p*1.5) : Math.max(p*0.03, 25)
  };});
  if(items.length===0) return {months:0, perDebt:{}, series:[{month:0,total:0}], payoffDate:new Date()};
  const remainders = plan.rows.map(r=>Math.max(0, planRowRemaining(plan,r)));
  const lastRemaining = remainders.length ? remainders[remainders.length-1] : 0;
  const order = ()=> items.filter(x=>x.balance>0.01).sort((a,b)=> b.rate-a.rate);
  const perDebt = {};
  const series = [{month:0, total: items.reduce((a,b)=>a+b.balance,0)}];
  let month=0;
  const maxMonths = 600;
  while(items.some(x=>x.balance>0.01) && month<maxMonths){
    const extra = month < remainders.length ? remainders[month] : lastRemaining;
    month++;
    items.forEach(x=>{ if(x.balance>0.01) x.balance += x.balance*x.rate; });
    items.forEach(x=>{
      if(x.balance<=0.01) return;
      const pay = Math.min(x.minPay, x.balance);
      x.balance -= pay;
    });
    let pool = extra;
    for(const x of order()){
      if(pool<=0) break;
      if(x.balance<=0.01) continue;
      const pay = Math.min(pool, x.balance);
      x.balance -= pay; pool -= pay;
    }
    items.forEach(x=>{
      if(x.balance<=0.01 && !(x.name in perDebt)) perDebt[x.name]=month;
    });
    series.push({month, total: items.reduce((a,b)=>a+Math.max(b.balance,0),0)});
  }
  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth()+month);
  return {months:month, perDebt, series, payoffDate, remainders, lastRemaining};
}

function renderDebt(){
  const y = state.year;
  const debts = [...yearData(y).debts].sort((a,b)=>{
    const pa = debtPendingCalc(a), pb = debtPendingCalc(b);
    if(pa <= 0 && pb > 0) return 1;   // a paid off → push down
    if(pb <= 0 && pa > 0) return -1;  // b paid off → push down
    return pb - pa;                    // both active: bigger pending first
  });
  const totalPending = sumArr(debts.map(d=>debtPendingCalc(d)));
  const totalOriginal = sumArr(debts.map(d=>d.total));
  const totalCleared = sumArr(debts.map(d=>d.cleared));
  const plan = DATA.paymentPlan;

  const cards = debts.map(d=>{
    const clearedToDate = debtClearedToDate(d);
    const pct2 = d.total>0 ? Math.min(100, (clearedToDate/d.total)*100) : 100;
    const isPaid = debtPendingCalc(d)<=0;
    return `
    <div class="debt-card" data-debt-id="${d.id}">
      <div class="debt-card-head">
        <div><span class="debt-name">${d.name}</span>${isPaid?'<span class="debt-tag" style="color:var(--good); border-color:var(--good);">paid off</span>':''}</div>
        <div class="debt-figs">
          <span>Interest <b class="editable-inline" contenteditable="true" data-debtfield="interest" data-id="${d.id}">${d.interest}</b>%/yr</span>
          <span>EMI/min <b class="editable-inline" contenteditable="true" data-debtfield="emi" data-id="${d.id}">${d.emi||0}</b></span>
        </div>
      </div>
      <div class="runway ${isPaid?'':''}"><div class="runway-fill" style="width:${pct2}%"></div></div>
      <div class="debt-foot">
        <span>Cleared: <b class="editable-inline" style="color:var(--teal-soft)" contenteditable="true" data-debtfield="clearedDisplay" data-id="${d.id}">${clearedToDate.toFixed(2)}</b> <span style="opacity:.55">(incl. ${fmt$(sumArr(d.m),2)} from monthly payments this year)</span></span>
        <span>Pending: <b style="color:var(--rust-soft)">${fmt$(debtPendingCalc(d),2)}</b></span>
        <span>Original: <b class="editable-inline" contenteditable="true" data-debtfield="total" data-id="${d.id}">${d.total}</b></span>
      </div>
      ${d.note?`<div class="section-sub" style="margin-top:8px;">⚑ ${d.note}</div>`:''}
    </div>`;
  }).join('');

  const sim = simulatePayoffWithPlan(debts, plan);
  const freedomText = sim.months===0 ? 'You are debt-free right now.' :
    `${sim.months} month${sim.months===1?'':'s'} from today — around <span style="color:var(--gold-soft)">${sim.payoffDate.toLocaleDateString('en-US',{month:'long', year:'numeric'})}</span>`;

  const colHeaders = plan.columns.map(c=>
    `<th>${c.name}${c.kind==='memo'?' <span style="opacity:.6;">(memo)</span>':c.kind==='income'?' <span style="opacity:.6;">(income)</span>':''} <span class="row-del" data-delcol="${c.id}" title="remove column">✕</span></th>`
  ).join('');

  const planRowsHtml = plan.rows.map(r=>{
    const total = planRowTotal(plan,r);
    const remaining = planRowRemaining(plan,r);
    const cells = plan.columns.map(c=>{
      const val = r.values[c.id];
      const display = (val===null||val===undefined) ? '' : val;
      return `<td class="editable ${!display?'zero':''}" contenteditable="true" data-plancell="${r.id}" data-col="${c.id}">${display===''?'–':display}</td>`;
    }).join('');
    return `<tr data-planrow="${r.id}">
      <td>${r.label} <span class="row-del" data-delplanrow="${r.id}">✕</span></td>
      ${cells}
      <td style="font-weight:600;">${fmt$(total,2)}</td>
      <td style="font-weight:700; color:${remaining>=0?'var(--teal-soft)':'var(--rust-soft)'}">${fmt$(remaining,2)}</td>
    </tr>`;
  }).join('');

  const html = `
    <div class="section-title">Debt Payoff Planner · ${y}</div>
    <p class="section-sub">What's left, what it costs monthly, and when it disappears based on a real month-by-month plan.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="kpi-card c-danger"><div class="kpi-label">Total Pending</div><div class="kpi-value">${fmt$(totalPending)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Already Cleared</div><div class="kpi-value">${fmt$(totalCleared)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Original Debt Total</div><div class="kpi-value">${fmt$(totalOriginal)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Loans</h3></div>
      ${cards}
      <div class="addcat-row">
        <input type="text" id="newDebtName" placeholder="New loan / debt name…">
        <button class="btn primary small" id="addDebtBtn">+ Add debt</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Payment plan</h3><span class="section-sub" style="margin:0;">Lay out expected salary and expenses month by month. Whatever's "Remaining" each month goes toward your highest-interest debt first — after the last planned month, that same "Remaining" amount keeps repeating.</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th>${colHeaders}<th>Total</th><th>Remaining</th></tr></thead>
          <tbody id="planBody">${planRowsHtml}</tbody>
        </table>
      </div>
      <div class="addcat-row">
        <input type="text" id="newPlanRow" placeholder="New month, e.g. May 2027…">
        <button class="btn small" id="addPlanRowBtn">+ Add month</button>
      </div>
      <div class="addcat-row">
        <input type="text" id="newPlanCol" placeholder="New column, e.g. Investment…">
        <select id="newPlanColKind" style="background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font-family:var(--font-body); font-size:12.5px;">
          <option value="expense">Counts against remaining</option>
          <option value="income">Adds to remaining (income)</option>
          <option value="memo">Memo only — not counted</option>
        </select>
        <button class="btn small" id="addPlanColBtn">+ Add column</button>
      </div>

      <div class="freedom-banner" style="margin-top:18px;">
        <div><div class="small">DEBT-FREE PROJECTION</div><div class="big">${freedomText}</div></div>
        <div class="small">based on ${fmt$(totalPending)} pending today, minimum payments, plus each month's "Remaining" above</div>
      </div>
      <div class="chart-box"><canvas id="chartPayoff"></canvas></div>
    </div>
  `;
  document.getElementById('panel-debt').innerHTML = html;

  document.querySelectorAll('.editable-inline').forEach(el=>{
    el.addEventListener('focus', ()=>{ el.dataset.origRaw = el.textContent; });
    el.addEventListener('blur', ()=>{
      if(el.textContent === el.dataset.origRaw) return;
      const id = el.dataset.id, field = el.dataset.debtfield;
      const d = debts.find(x=>x.id===id);
      const v = parseFloat(el.textContent.replace(/[^0-9.\-]/g,''));
      const safeV = isNaN(v) ? 0 : v;
      if(field==='clearedDisplay'){
        const beforeDisplay = debtClearedToDate(d);
        if(beforeDisplay===safeV) return;
        d.cleared = safeV - sumArr(d.m); // back-solve baseline so displayed total-cleared matches what was typed
      } else {
        if(d[field]===safeV) return;
        d[field] = safeV;
      }
      markDirty(); renderDebt();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){e.preventDefault(); el.blur();}});
  });

  document.getElementById('addDebtBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newDebtName');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    debts.push({id:uid(), name, total:0, cleared:0, interest:0, emi:0, m:n12()});
    markDirty(); renderDebt();
  });

  document.querySelectorAll('[data-plancell]').forEach(td=>{
    td.addEventListener('focus', ()=>{
      td.dataset.origRaw = td.textContent;
      if(td.textContent==='–') td.textContent='';
    });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const rowId = td.dataset.plancell, colId = td.dataset.col;
      const row = plan.rows.find(r=>r.id===rowId);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v = null;
      const before = row.values[colId]===undefined ? null : row.values[colId];
      if(before===v) return;
      row.values[colId] = v;
      td.textContent = v===null ? '–' : v;
      td.classList.toggle('zero', !v);
      markDirty(); renderDebt();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });
  document.querySelectorAll('[data-delplanrow]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = plan.rows.findIndex(r=>r.id===el.dataset.delplanrow);
      if(idx>-1 && confirm('Remove this month from the plan?')){ plan.rows.splice(idx,1); markDirty(); renderDebt(); }
    });
  });
  document.querySelectorAll('[data-delcol]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = plan.columns.findIndex(c=>c.id===el.dataset.delcol);
      if(idx>-1 && confirm('Remove the "'+plan.columns[idx].name+'" column?')){
        const removedId = plan.columns[idx].id;
        plan.columns.splice(idx,1);
        plan.rows.forEach(r=>{ delete r.values[removedId]; });
        markDirty(); renderDebt();
      }
    });
  });
  document.getElementById('addPlanRowBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newPlanRow');
    const label = inp.value.trim();
    if(!label){ inp.focus(); return; }
    plan.rows.push({id:uid(), label, values:{}});
    markDirty(); renderDebt();
  });
  document.getElementById('addPlanColBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newPlanCol');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    const kind = document.getElementById('newPlanColKind').value;
    plan.columns.push({id:uid(), name, kind});
    markDirty(); renderDebt();
  });

  destroyChart('payoff');
  charts.payoff = safeChart(document.getElementById('chartPayoff'), {
    type:'line',
    data:{ labels: sim.series.map(s=>'M'+s.month), datasets:[
      {label:'Remaining balance', data: sim.series.map(s=>s.total), borderColor:'#C06A46', backgroundColor:'rgba(192,106,70,0.12)', fill:true, tension:.25, pointRadius:0}
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}, ticks:{maxTicksLimit:12}} } }
  });
}
