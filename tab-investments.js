/* =========================================================================
   INVESTMENTS TAB  —  with live USD/INR conversion
   ========================================================================= */
const INVEST_CATS = ['Indian Stocks','US Stocks','Crypto','Angel Investing','Other'];

/* ---------- FX helpers ---------- */
let fxRates = null;
let fxLastFetch = 0;
const FX_TTL = 60 * 60 * 1000; // cache 1 hour
const FX_FALLBACK_INR = 84.0;

async function ensureFxRates(){
  if (fxRates && (Date.now() - fxLastFetch) < FX_TTL) return fxRates;
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) throw new Error('FX HTTP ' + res.status);
    const data = await res.json();
    fxRates = data.rates;
    fxLastFetch = Date.now();
    console.log('[FX] USD/INR =', fxRates.INR);
    return fxRates;
  } catch(e) {
    console.warn('[FX] fetch failed, using fallback', FX_FALLBACK_INR);
    fxRates = { INR: FX_FALLBACK_INR };
    fxLastFetch = Date.now();
    return fxRates;
  }
}

function inrToUsd(inr, rates){
  const rate = (rates || fxRates || { INR: FX_FALLBACK_INR }).INR || FX_FALLBACK_INR;
  return inr / rate;
}

function fmtInr(v){
  if (v === null || v === undefined) return '₹0.00';
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (neg ? '-₹' : '₹') + s;
}

/* Convert any value to USD for display / math */
function toUsd(item, fieldOrValue){
  let v = (typeof fieldOrValue === 'number') ? fieldOrValue : item[fieldOrValue];
  if (v === null || v === undefined || isNaN(v)) return 0;
  if (item.currency === 'INR') return inrToUsd(v);
  return v;
}

/* What to paint inside a cell */
function displayCell(item, v, rates){
  if (v === null || v === undefined) return '–';
  if (item.currency === 'INR') return fmt$(inrToUsd(v, rates), 2);
  return Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

/* ---------- Render ---------- */
function renderInvestments(){
  /* Fetch rates on first visit; re-render once they arrive */
  if (!fxRates) {
    ensureFxRates().then(() => { renderInvestments(); });
  }

  const rates = fxRates || { INR: FX_FALLBACK_INR };
  const y = state.year;

  /* Auto-tag & correct Indian platforms to INR */
  yearData(y).investments.forEach(it => {
    const name = (it.name || '').toLowerCase();
    const cat = (it.category || '').toLowerCase();
    const isIndian = cat.includes('indian') || cat.includes('angel') ||
                     name.includes('zerodha') || name.includes('groww') || 
                     name.includes('angel') || name.includes('loan') ||
                     name.includes('coin by');
    // Force-correct: if it looks Indian, make it INR regardless of old saved value
    if (isIndian) it.currency = 'INR';
    else if (!it.currency) it.currency = 'USD';
  });

  const items = [...yearData(y).investments].sort((a,b)=>{
    const ai = INVEST_CATS.indexOf(a.category), bi = INVEST_CATS.indexOf(b.category);
    return (ai===-1?99:ai) - (bi===-1?99:bi);
  });

  /* ---- Totals in USD ---- */
  const totalsUSD = n12().map(() => 0);
  items.forEach(it => {
    it.m.forEach((v, i) => { totalsUSD[i] += toUsd(it, v); });
  });
  // For any platform that has real holdings tracked in the Holdings tab, pull its
  // current/invested value FROM there instead of the old manually-typed fields, so
  // this stays in sync automatically rather than needing separate upkeep.
  function dynamicValuesFor(it){
    const platRows = (it.holdings && it.holdings.length) ? platformHoldings(y, it.id) : [];
    if(!platRows.length) return null;
    return {
      currentValue: platRows.reduce((a,r)=>a+r.currentValueUSD,0),
      invested: platRows.reduce((a,r)=>a+r.investedUSD,0),
    };
  }
  const currentTotalUSD = items.reduce((a, it) => {
    const dyn = dynamicValuesFor(it);
    return a + (dyn ? dyn.currentValue : toUsd(it, 'currentValue'));
  }, 0);
  const investedTotalUSD = items.reduce((a, it) => {
    const dyn = dynamicValuesFor(it);
    return a + (dyn ? dyn.invested : toUsd(it, 'invested'));
  }, 0);
  const gainUSD = currentTotalUSD - investedTotalUSD;

  /* ---- Build rows ---- */
  let lastCat = null;
  const rows = items.map(it => {
    const catHeaderRow = it.category !== lastCat ? (() => {
      lastCat = it.category;
      return `<tr><td colspan="18" style="background:var(--bg-card-hi); color:var(--gold-soft); font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; padding:6px 10px;">${it.category}</td></tr>`;
    })() : '';

    const cells = it.m.map((v, i) => {
      const display = displayCell(it, v, rates);
      const tip = (it.currency === 'INR' && v !== null && v !== undefined) ? fmtInr(v) : null;
      return `<td class="editable ${!v ? 'zero' : ''} ${tip ? 'has-tip' : ''}"
                  contenteditable="true"
                  data-field="m" data-idx="${i}" data-id="${it.id}"
                  ${tip ? `data-tip="${tip}"` : ''}
                  data-raw="${v === null || v === undefined ? '' : v}">${display}</td>`;
    }).join('');

    const yearTotal = it.m.reduce((a, v) => a + toUsd(it, v), 0);
    const dyn = dynamicValuesFor(it);

    /* Name is clickable if holdings exist; Current/Invested are plain display */
    const nameLink = dyn
      ? `<span style="cursor:pointer;color:var(--gold-soft);font-weight:500;" data-golink="${it.id}" data-tip="Click to view/edit ${it.name}'s positions in Holdings" class="has-tip">${it.name}</span>`
      : it.name;

    let cvCell, invCell;
    if(dyn){
      cvCell = `<td style="font-weight:600;">${fmt$(dyn.currentValue,2)}</td>`;
      invCell = `<td style="font-weight:600;">${fmt$(dyn.invested,2)}</td>`;
    } else {
      const cvDisplay = displayCell(it, it.currentValue, rates);
      const invDisplay = displayCell(it, it.invested, rates);
      const cvTip = it.currency === 'INR' ? fmtInr(it.currentValue) : null;
      const invTip = it.currency === 'INR' ? fmtInr(it.invested) : null;
      cvCell = `<td class="editable ${cvTip?'has-tip':''}" contenteditable="true" data-field="currentValue" data-id="${it.id}" ${cvTip?`data-tip="${cvTip}"`:''} data-raw="${it.currentValue||0}">${cvDisplay}</td>`;
      invCell = `<td class="editable ${invTip?'has-tip':''}" contenteditable="true" data-field="invested" data-id="${it.id}" ${invTip?`data-tip="${invTip}"`:''} data-raw="${it.invested||0}">${invDisplay}</td>`;
    }

    return catHeaderRow + `<tr data-row-id="${it.id}">
      <td>${nameLink} <span class="row-del" data-del="${it.id}">✕</span></td>
      <td>
        <select data-catsel="${it.id}" style="background:var(--bg-card-hi); color:var(--gold-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11.5px; padding:3px 4px;">
          ${INVEST_CATS.map(c => `<option value="${c}" ${it.category===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </td>
      <td>
        <select data-currency="${it.id}" style="background:var(--bg-card-hi); color:var(--teal-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11.5px; padding:3px 4px;">
          <option value="USD" ${it.currency==='USD'?'selected':''}>USD</option>
          <option value="INR" ${it.currency==='INR'?'selected':''}>INR</option>
        </select>
      </td>
      ${cells}
      <td style="font-weight:600;">${fmt$(yearTotal,2)}</td>
      ${cvCell}
      ${invCell}
    </tr>`;
  }).join('');

  /* ---- Allocation in USD ---- */
  const alloc = {};
  items.forEach(it => { alloc[it.category] = (alloc[it.category]||0) + toUsd(it, 'currentValue'); });
  const allocSorted = Object.entries(alloc).sort((a,b)=>b[1]-a[1]);
  const allocLabels = allocSorted.map(e=>e[0]);
  const allocVals   = allocSorted.map(e=>e[1]);

  /* ---- HTML ---- */
  const html = `
    <div class="section-title">Investments · ${y}</div>
    <p class="section-sub">Every holding's monthly contribution, plus current value vs. what you've put in. <b style="color:var(--teal-soft)">Indian Stocks marked "INR" are auto-converted to USD.</b> Hover any converted cell to see the original amount. Rates fetched live (cached 1 hr). <b style="color:var(--gold-soft)">Click any platform name</b> that has Holdings tracked to jump straight to its positions.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="kpi-card c-teal"><div class="kpi-label">Current Portfolio Value (USD)</div><div class="kpi-value">${fmt$(currentTotalUSD)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Total Invested (USD)</div><div class="kpi-value">${fmt$(investedTotalUSD)}</div></div>
      <div class="kpi-card ${gainUSD>=0?'c-teal':'c-danger'}"><div class="kpi-label">Unrealized Gain / Loss (USD)</div><div class="kpi-value">${gainUSD>=0?'+':''}${fmt$(gainUSD)}</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Monthly contributions (USD)</h3></div>
        <div class="chart-box"><canvas id="chartInvestTrend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Portfolio allocation (USD)</h3></div>
        <div class="chart-box"><canvas id="chartAlloc"></canvas></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Holdings</h3><span class="section-sub" style="margin:0;">Year contributed: <b style="color:var(--gold-soft)">${fmt$(totalsUSD.reduce((a,b)=>a+b,0),2)}</b> &nbsp;|&nbsp; Rate: <b style="color:var(--teal-soft)">1 USD = ${(rates.INR||FX_FALLBACK_INR).toFixed(2)} INR</b></span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Holding</th><th>Category</th><th>Currency</th>${monthHeaderCells()}<th>Year (USD)</th><th>Current Value (USD)</th><th>Invested (USD)</th></tr></thead>
          <tbody id="investBody">${rows}
            <tr class="total-row"><td>Total</td><td></td><td></td>${totalsUSD.map(t=>`<td>${fmt$(t)}</td>`).join('')}<td>${fmt$(totalsUSD.reduce((a,b)=>a+b,0))}</td><td>${fmt$(currentTotalUSD)}</td><td>${fmt$(investedTotalUSD)}</td></tr>
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

  /* ---- Handlers ---- */
  document.getElementById('investBody').querySelectorAll('td.editable').forEach(td=>{
    td.addEventListener('focus', ()=>{
      td.dataset.origRaw = td.textContent;
      const raw = td.dataset.raw;
      if (raw !== undefined && raw !== '') td.textContent = raw;
      else if (td.textContent==='–') td.textContent = '';
    });

    td.addEventListener('blur', ()=>{
      if (td.textContent === td.dataset.origRaw) return;
      const id = td.dataset.id, field = td.dataset.field;
      const item = items.find(x=>x.id===id);
      // Strip $, ₹, commas, spaces
      const raw = td.textContent.trim().replace(/[$₹,]/g,'').replace(/\s+/g,'');
      let v = raw===''? null : parseFloat(raw);
      if (isNaN(v)) v = null;

      if (field==='m'){
        const idx = Number(td.dataset.idx);
        const before = item.m[idx]===undefined ? null : item.m[idx];
        if (before===v) return;
        item.m[idx] = v;
      } else {
        const before = item[field]||0;
        if (before===(v||0)) return;
        item[field] = v||0;
      }
      markDirty(); renderInvestments();
    });

    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  document.getElementById('investBody').querySelectorAll('[data-del]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const realItems = yearData(y).investments;
      const idx = realItems.findIndex(x=>x.id===el.dataset.del);
      if (idx>-1 && confirm('Remove "'+realItems[idx].name+'"?')){ realItems.splice(idx,1); markDirty(); renderInvestments(); }
    });
  });

  document.getElementById('investBody').querySelectorAll('[data-catsel]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const item = items.find(x=>x.id===sel.dataset.catsel);
      item.category = sel.value;
      if (item.category==='Indian Stocks' && !item.currency) item.currency = 'INR';
      markDirty(); renderInvestments();
    });
  });

  document.getElementById('investBody').querySelectorAll('[data-currency]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const item = items.find(x=>x.id===sel.dataset.currency);
      item.currency = sel.value;
      markDirty(); renderInvestments();
    });
  });

  document.getElementById('investBody').querySelectorAll('[data-golink]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const platformId = el.dataset.golink;
      state.holdingsView = platformId;
      state.holdingsSubView = 'open';
      const holdingsTabBtn = document.querySelector('.tab-btn[data-tab="holdings"]');
      if(holdingsTabBtn) holdingsTabBtn.click();
    });
  });

  document.getElementById('addInvestBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newInvestName');
    const name = inp.value.trim();
    if (!name){ inp.focus(); return; }
    const isIndian = /india|zerodha|groww|angel/i.test(name);
    yearData(y).investments.push({
      id: uid(), name, category: isIndian ? 'Indian Stocks' : 'Other',
      currency: isIndian ? 'INR' : 'USD',
      m: n12(), currentValue: 0, invested: 0
    });
    markDirty(); renderInvestments();
  });

  /* ---- Charts (USD values) ---- */
  destroyChart('investTrend'); destroyChart('alloc');
  charts.investTrend = safeChart(document.getElementById('chartInvestTrend'), {
    type:'bar',
    data:{ labels:MONTHS, datasets:[{label:'Contributions (USD)', data:totalsUSD, backgroundColor:'#6FA491', borderRadius:4}] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
  const allocTotal = allocVals.reduce((a,b)=>a+b,0);
  charts.alloc = safeChart(document.getElementById('chartAlloc'), {
    type:'doughnut',
    data:{ labels:allocLabels, datasets:[{data:allocVals, backgroundColor:allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2}] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins:{
        legend:{position:'right', labels:{boxWidth:9,boxHeight:9, font:{size:10.5}}},
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw;
              const pct = allocTotal > 0 ? ((val / allocTotal) * 100).toFixed(1) : 0;
              return `${context.label}: ${fmt$(val)} (${pct}%)`;
            }
          }
        }
      } }
  });
}