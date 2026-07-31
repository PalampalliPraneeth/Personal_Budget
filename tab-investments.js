/* =========================================================================
   INVESTMENTS TAB
   ========================================================================= */
const INVEST_CATS = ['Indian Stocks','US Stocks','Crypto','Angel Investing','Other'];
function renderInvestments(){
  const y = state.year;
  const items = [...yearData(y).investments].sort((a,b)=>{
    const ai = INVEST_CATS.indexOf(a.category), bi = INVEST_CATS.indexOf(b.category);
    return (ai===-1?99:ai) - (bi===-1?99:bi);
  });
  const totals = investContribTotals(y);
  const currentTotal = sumArr(items.map(i=>i.currentValue));
  const investedTotal = sumArr(items.map(i=>i.invested));
  const gain = currentTotal - investedTotal;

  let lastCat = null;
  const rows = items.map(it=>{
    const catHeaderRow = it.category!==lastCat ? (()=>{ lastCat=it.category; return `<tr><td colspan="16" style="background:var(--bg-card-hi); color:var(--gold-soft); font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; padding:6px 10px;">${it.category}</td></tr>`; })() : '';
    const cells = it.m.map((v,i)=>{
      const val = v===null||v===undefined? '' : v;
      return `<td class="editable ${!val?'zero':''}" contenteditable="true" data-field="m" data-idx="${i}" data-id="${it.id}">${val===''?'–':val}</td>`;
    }).join('');
    return catHeaderRow + `<tr data-row-id="${it.id}">
      <td>${it.name} <span class="row-del" data-del="${it.id}">✕</span></td>
      <td>
        <select data-catsel="${it.id}" style="background:var(--bg-card-hi); color:var(--gold-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11.5px; padding:3px 4px;">
          ${INVEST_CATS.map(c=>`<option value="${c}" ${it.category===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </td>
      ${cells}
      <td style="font-weight:600;">${fmt$(sumArr(it.m),2)}</td>
      <td class="editable" contenteditable="true" data-field="currentValue" data-id="${it.id}">${it.currentValue||0}</td>
      <td class="editable" contenteditable="true" data-field="invested" data-id="${it.id}">${it.invested||0}</td>
    </tr>`;
  }).join('');

  const alloc = {};
  items.forEach(it=>{ alloc[it.category] = (alloc[it.category]||0) + num(it.currentValue); });
  const allocSorted = Object.entries(alloc).sort((a,b)=>b[1]-a[1]);
  const allocLabels = allocSorted.map(e=>e[0]);
  const allocVals = allocSorted.map(e=>e[1]);

  const html = `
    <div class="section-title">Investments · ${y}</div>
    <p class="section-sub">Every holding's monthly contribution, plus current value vs. what you've put in.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="kpi-card c-teal"><div class="kpi-label">Current Portfolio Value</div><div class="kpi-value">${fmt$(currentTotal)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Total Invested</div><div class="kpi-value">${fmt$(investedTotal)}</div></div>
      <div class="kpi-card ${gain>=0?'c-teal':'c-danger'}"><div class="kpi-label">Unrealized Gain / Loss</div><div class="kpi-value">${gain>=0?'+':''}${fmt$(gain)}</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Monthly contributions</h3></div>
        <div class="chart-box"><canvas id="chartInvestTrend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Portfolio allocation</h3></div>
        <div class="chart-box"><canvas id="chartAlloc"></canvas></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Holdings</h3><span class="section-sub" style="margin:0;">Year contributed: <b style="color:var(--gold-soft)">${fmt$(sumArr(totals),2)}</b></span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Holding</th><th>Category</th>${monthHeaderCells()}<th>Year</th><th>Current Value</th><th>Invested</th></tr></thead>
          <tbody id="investBody">${rows}
            <tr class="total-row"><td>Total</td><td></td>${totals.map(t=>`<td>${fmt$(t)}</td>`).join('')}<td>${fmt$(sumArr(totals))}</td><td>${fmt$(currentTotal)}</td><td>${fmt$(investedTotal)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="addcat-row">
        <input type="text" id="newInvestName" placeholder="New holding name…">
        <button class="btn primary small" id="addInvestBtn">+ Add holding</button>
      </div>
    </div>
  `;
  document.getElementById('panel-investments').innerHTML = html;

  document.getElementById('investBody').querySelectorAll('td.editable').forEach(td=>{
    td.addEventListener('focus', ()=>{
      td.dataset.origRaw = td.textContent;
      if(td.textContent==='–') td.textContent='';
    });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const id = td.dataset.id, field = td.dataset.field;
      const item = items.find(x=>x.id===id);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v=null;
      if(field==='m'){
        const idx = Number(td.dataset.idx);
        const before = item.m[idx]===undefined ? null : item.m[idx];
        if(before===v) return;
        item.m[idx] = v; td.textContent = v===null?'–':v; td.classList.toggle('zero', !v);
      } else {
        const before = item[field]||0;
        if(before===(v||0)) return;
        item[field] = v||0; td.textContent = v||0;
      }
      markDirty(); renderInvestments();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });
  document.getElementById('investBody').querySelectorAll('[data-del]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const realItems = yearData(y).investments;
      const idx = realItems.findIndex(x=>x.id===el.dataset.del);
      if(idx>-1 && confirm('Remove "'+realItems[idx].name+'"?')){ realItems.splice(idx,1); markDirty(); renderInvestments(); }
    });
  });
  document.getElementById('investBody').querySelectorAll('[data-catsel]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const item = items.find(x=>x.id===sel.dataset.catsel);
      item.category = sel.value; markDirty(); renderInvestments();
    });
  });
  document.getElementById('addInvestBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newInvestName');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    yearData(y).investments.push({id:uid(), name, category:'Other', m:n12(), currentValue:0, invested:0});
    markDirty(); renderInvestments();
  });

  destroyChart('investTrend'); destroyChart('alloc');
  charts.investTrend = safeChart(document.getElementById('chartInvestTrend'), {
    type:'bar',
    data:{ labels:MONTHS, datasets:[{label:'Contributions', data:totals, backgroundColor:'#6FA491', borderRadius:4}] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
  charts.alloc = safeChart(document.getElementById('chartAlloc'), {
    type:'doughnut',
    data:{ labels:allocLabels, datasets:[{data:allocVals, backgroundColor:allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2}] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins:{legend:{position:'right', labels:{boxWidth:9,boxHeight:9, font:{size:10.5}}}} }
  });
}
