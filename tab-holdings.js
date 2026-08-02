/* =========================================================================
   HOLDINGS TAB — granular stock / MF / ETF / index / crypto tracking
   ========================================================================= */
const HOLDING_TYPES = ['stock','mf','etf','index','crypto','other'];

/* ---------- FX helpers ---------- */
function _ensureFx(){
  if(typeof fxRates !== 'undefined' && fxRates) return fxRates;
  return { INR: 84.0 };
}
function _toUsd(val, currency){
  if(currency !== 'INR') return num(val);
  const r = _ensureFx().INR || 84.0;
  return num(val) / r;
}

/* ---------- Live price fetch (best effort) ---------- */
async function fetchLivePrice(symbol, isInian){
  let yahooSym = symbol.toUpperCase().trim();
  if(isIndian && !yahooSym.endsWith('.NS') && !yahooSym.endsWith('.BO')){
    yahooSym = yahooSym + '.NS';
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
      const price = meta?.regularMarketPrice;
      const prevClose = meta?.previousClose || meta?.chartPreviousClose;
      let changePct = null;
      if(prevClose && prevClose > 0 && typeof price === 'number'){
        changePct = ((price - prevClose) / prevClose) * 100;
      }
      if(typeof price === 'number' && price > 0) return {price, changePct};
    }catch(e){}
  }
  try{
    const res = await fetch(target);
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prevClose = meta?.previousClose || meta?.chartPreviousClose;
    let changePct = null;
    if(prevClose && prevClose > 0 && typeof price === 'number'){
      changePct = ((price - prevClose) / prevClose) * 100;
    }
    if(typeof price === 'number' && price > 0) return {price, changePct};
  }catch(e){}
  throw new Error('Could not fetch. Try entering the price manually.');
}

/* ---------- Data migration ---------- */
function ensureHoldingsMigration(){
  const y = state.year;
  if(!yearData(y).investments) return;
  yearData(y).investments.forEach(inv => {
    if(!inv.holdings) inv.holdings = [];
    inv.holdings.forEach(h => {
      if(!h.lots) h.lots = [];
      if(!h.dividends) h.dividends = [];
      if(!h.type) h.type = 'stock';
      if(!h.currency) h.currency = inv.currency || 'USD';
      if(h.lots.length === 0 && (h.qty > 0 || h.avgPrice > 0)){
        h.lots.push({qty: num(h.qty), price: num(h.avgPrice), date: `${y}-01-01`});
      }
      const totalQty = h.lots.reduce((a,l)=>a+num(l.qty),0);
      const totalCost = h.lots.reduce((a,l)=>a+num(l.qty)*num(l.price),0);
      h.qty = totalQty;
      h.avgPrice = totalQty > 0 ? totalCost / totalQty : 0;
    });
  });
}

function recalcHolding(h){
  const totalQty = h.lots.reduce((a,l)=>a+num(l.qty),0);
  const totalCost = h.lots.reduce((a,l)=>a+num(l.qty)*num(l.price),0);
  h.qty = totalQty;
  h.avgPrice = totalQty > 0 ? totalCost / totalQty : 0;
  if(!h.ytdStartPrice) h.ytdStartPrice = h.avgPrice;
}

/* ---------- Aggregation ---------- */
function aggregateAllHoldings(y){
  ensureHoldingsMigration();
  const map = {};
  yearData(y).investments.forEach(inv => {
    const isINR = inv.currency === 'INR';
    (inv.holdings || []).forEach(h => {
      const sym = (h.symbol || 'unknown').toString().toUpperCase();
      if(!map[sym]) map[sym] = {
        symbol: sym, name: h.name || sym, type: h.type || 'stock',
        qty: 0, invested: 0, currentValue: 0, ytdStartValue: 0,
        platforms: [], prices: [], avgPrices: [], ytdPrices: []
      };
      const q = num(h.qty);
      const avgUSD = _toUsd(h.avgPrice, isINR ? 'INR' : 'USD');
      const curUSD = _toUsd(h.currentPrice, isINR ? 'INR' : 'USD');
      const ytdUSD = _toUsd(h.ytdStartPrice || h.avgPrice, isINR ? 'INR' : 'USD');
      map[sym].qty += q;
      map[sym].invested += q * avgUSD;
      map[sym].currentValue += q * curUSD;
      map[sym].ytdStartValue += q * ytdUSD;
      map[sym].platforms.push(inv.name);
      map[sym].prices.push(curUSD);
      map[sym].avgPrices.push(avgUSD);
      map[sym].ytdPrices.push(ytdUSD);
    });
  });
  return Object.values(map).map(h => {
    h.avgPrice = h.qty > 0 ? h.invested / h.qty : 0;
    h.currentPrice = h.prices.length ? h.prices.reduce((a,b)=>a+b,0)/h.prices.length : 0;
    h.ytdStartPrice = h.qty > 0 ? h.ytdStartValue / h.qty : 0;
    h.plNet = h.currentValue - h.invested;
    h.plPct = h.invested > 0 ? h.plNet / h.invested : 0;
    h.ytdPl = h.currentValue - h.ytdStartValue;
    h.ytdPct = h.ytdStartValue > 0 ? h.ytdPl / h.ytdStartValue : 0;
    h.platforms = [...new Set(h.platforms)];
    return h;
  }).sort((a,b) => b.currentValue - a.currentValue);
}

function platformHoldings(y, platformId, showClosed){
  ensureHoldingsMigration();
  const inv = yearData(y).investments.find(i => i.id === platformId);
  if(!inv) return [];
  const isINR = inv.currency === 'INR';
  const fx = _ensureFx().INR || 84.0;
  return (inv.holdings || [])
    .filter(h => showClosed || num(h.qty) > 0)
    .map(h => {
      const q = num(h.qty), avg = num(h.avgPrice), cur = num(h.currentPrice);
      const ytd = num(h.ytdStartPrice) || avg;
      const invested = q * avg, current = q * cur, ytdVal = q * ytd;
      const pl = current - invested, ytdPl = current - ytdVal;
      const dayChg = h.dayChangePct !== null && h.dayChangePct !== undefined ? h.dayChangePct : null;
      const dayChgStr = dayChg !== null ? (dayChg >= 0 ? '+' : '') + dayChg.toFixed(2) + '%' : '—';
      const dayChgColor = dayChg > 0 ? 'var(--good)' : dayChg < 0 ? 'var(--danger)' : 'var(--text-dim)';
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      return {
        ...h, qty: q, avgPrice: avg, currentPrice: cur, ytdStartPrice: ytd,
        invested, currentValue: current, ytdValue: ytdVal,
        plNet: pl, plPct: invested > 0 ? pl / invested : 0,
        ytdNet: ytdPl, ytdPct: ytdVal > 0 ? ytdPl / ytdVal : 0,
        dayChangePct: dayChg, dayChangeStr: dayChgStr, dayChangeColor: dayChgColor,
        dAvg: fmt(avg), dCur: fmt(cur), dYtd: fmt(ytd),
        dInv: fmt(invested), dVal: fmt(current), dPl: fmt(pl), dYtdPl: fmt(ytdPl),
        tAvg: tip(avg), tCur: tip(cur), tYtd: tip(ytd),
        tInv: tip(invested), tVal: tip(current), tPl: tip(pl), tYtdPl: tip(ytdPl)
      };
    }).sort((a,b) => b.currentValue - a.currentValue);
}

/* ---------- Render ---------- */
function renderHoldings(){
  const y = state.year;
  ensureHoldingsMigration();
  if(!state.holdingsView) state.holdingsView = 'ALL';
  if(state.showClosedHoldings === undefined) state.showClosedHoldings = false;

  const investments = yearData(y).investments || [];
  const allRows = aggregateAllHoldings(y);
  const isAll = state.holdingsView === 'ALL';
  const rows = isAll ? allRows : platformHoldings(y, state.holdingsView, state.showClosedHoldings);
  
  const totalInvested = rows.reduce((a,r)=>a+r.invested,0);
  const totalCurrent  = rows.reduce((a,r)=>a+r.currentValue,0);
  const totalYtdStart = rows.reduce((a,r)=>a+(r.ytdStartValue||r.invested),0);
  const totalPl       = totalCurrent - totalInvested;
  const totalYtdPl    = totalCurrent - totalYtdStart;

  /* ---- Platform pills ---- */
  const pills = [
    {id:'ALL', label:'All Platforms', count: allRows.length},
    ...investments.map(inv => ({id: inv.id, label: inv.name, count: (inv.holdings||[]).filter(h=>num(h.qty)>0).length}))
  ];
  const pillHtml = `<div class="pill-row" style="margin-bottom:18px;">${pills.map(p=>`
    <button class="pill ${state.holdingsView===p.id?'active':''}" data-hpill="${p.id}">
      ${p.label} <span style="opacity:.6;font-size:10px;">(${p.count})</span>
    </button>
  `).join('')}</div>`;

  /* ---- Toolbar ---- */
  const toolbar = isAll ? '' : `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap;">
      <button class="btn small" id="hFetchPrices">🔄 Fetch live prices</button>
      <label style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim); display:flex; align-items:center; gap:6px; cursor:pointer;">
        <input type="checkbox" id="hShowClosed" ${state.showClosedHoldings?'checked':''}> Show closed (zero qty)
      </label>
      <span class="section-sub" style="margin:0;">Fetching uses Yahoo Finance. Browsers may block it (CORS) — if so, enter prices manually.</span>
    </div>
  `;

  /* ---- Charts data prep ---- */
  const chartRows = rows.filter(r => r.currentValue > 0 || r.invested > 0).slice(0, 12);
  const allocLabels = chartRows.map(r => r.symbol || r.name);
  const allocVals   = chartRows.map(r => r.currentValue);
  const plLabels    = chartRows.map(r => r.symbol || r.name);
  const plVals      = chartRows.map(r => r.plNet || 0);
  const plColors    = plVals.map(v => v >= 0 ? '#7FAE79' : '#C06A46');

  /* ---- Table ---- */
  const thead = isAll
    ? `<tr><th>Symbol</th><th>Name</th><th>Type</th><th>Qty</th><th>Avg Price</th><th>Current</th><th>Invested</th><th>Value</th><th>Unrealized P&L</th><th>YTD P&L</th><th>Platforms</th></tr>`
    : `<tr><th>Symbol</th><th>Name</th><th>Type</th><th>Qty</th><th>Avg Price</th><th>Current</th><th style="min-width:70px;">Day Chg</th><th>YTD Start</th><th>Invested</th><th>Value</th><th>Unrealized P&L</th><th>YTD P&L</th><th></th></tr>`;

  const tbody = rows.map(r => {
    const plColor = (v) => v>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
    if(isAll){
      return `<tr>
        <td style="font-weight:600;">${r.symbol}</td>
        <td>${r.name}</td>
        <td><span class="debt-tag">${r.type}</span></td>
        <td>${r.qty}</td>
        <td>${fmt$(r.avgPrice,2)}</td>
        <td>${fmt$(r.currentPrice,2)}</td>
        <td style="font-weight:600;">${fmt$(r.invested,2)}</td>
        <td style="font-weight:600;color:var(--gold-soft);">${fmt$(r.currentValue,2)}</td>
        <td style="font-weight:600;color:${plColor(r.plNet)}">${r.plNet>=0?'+':''}${fmt$(r.plNet,2)} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
        <td style="color:${plColor(r.ytdPl)}">${r.ytdPl>=0?'+':''}${fmt$(r.ytdPl,2)} <span style="font-size:11px;opacity:.75;">(${r.ytdPct>=0?'+':''}${pct(r.ytdPct)})</span></td>
        <td><span class="debt-tag" style="font-size:10px;">${r.platforms.join(', ')}</span></td>
      </tr>`;
    }
    const tip = (t) => t ? `data-tip="${t}" class="has-tip"` : '';
    return `<tr data-hid="${r.id}">
      <td style="font-weight:600;" class="editable" contenteditable="true" data-f="symbol" data-id="${r.id}">${r.symbol||''}</td>
      <td class="editable" contenteditable="true" data-f="name" data-id="${r.id}">${r.name||''}</td>
      <td><select data-htype="${r.id}" style="background:var(--bg-card-hi);color:var(--gold-soft);border:1px solid var(--line);border-radius:5px;font-family:var(--font-mono);font-size:11.5px;padding:3px 4px;">
        ${HOLDING_TYPES.map(t=>`<option value="${t}" ${r.type===t?'selected':''}>${t}</option>`).join('')}
      </select></td>
      <td class="editable" contenteditable="true" data-f="qty" data-id="${r.id}" data-raw="${r.qty}">${r.qty||0}</td>
      <td class="editable" contenteditable="true" data-f="avgPrice" data-id="${r.id}" ${tip(r.tAvg)} data-raw="${r.avgPrice}">${r.dAvg}</td>
      <td class="editable" contenteditable="true" data-f="currentPrice" data-id="${r.id}" ${tip(r.tCur)} data-raw="${r.currentPrice}">${r.dCur}</td>
      <td style="color:${r.dayChangeColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;">${r.dayChangeStr}</td>
      <td class="editable" contenteditable="true" data-f="ytdStartPrice" data-id="${r.id}" ${tip(r.tYtd)} data-raw="${r.ytdStartPrice}">${r.dYtd}</td>
      <td style="font-weight:600;" ${tip(r.tInv)}>${r.dInv}</td>
      <td style="font-weight:600;color:var(--gold-soft);" ${tip(r.tVal)}>${r.dVal}</td>
      <td style="font-weight:600;color:${plColor(r.plNet)}" ${tip(r.tPl)}>${r.plNet>=0?'+':''}${r.dPl} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
      <td style="color:${plColor(r.ytdNet)}" ${tip(r.tYtdPl)}>${r.ytdNet>=0?'+':''}${r.dYtdPl} <span style="font-size:11px;opacity:.75;">(${r.ytdPct>=0?'+':''}${pct(r.ytdPct)})</span></td>
      <td><span class="row-del" data-delh="${r.id}">✕</span></td>
    </tr>`;
  }).join('');

  /* ---- Add form ---- */
  const addForm = isAll ? '' : `
    <div class="addcat-row" style="margin-top:14px;">
      <input type="text" id="hNewSym" placeholder="Symbol" style="min-width:80px;">
      <input type="text" id="hNewName" placeholder="Name" style="min-width:120px;">
      <select id="hNewType" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
        ${HOLDING_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
      <input type="number" id="hNewQty" placeholder="Qty" step="any" style="width:70px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <input type="number" id="hNewAvg" placeholder="Avg price" step="any" style="width:90px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <input type="number" id="hNewCur" placeholder="Current" step="any" style="width:90px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
      <button class="btn primary small" id="hAddBtn">+ Add</button>
    </div>
  `;

  const html = `
    <div class="section-title">Holdings · ${y}</div>
    <p class="section-sub">Every stock, mutual fund, ETF, index, and crypto you own. <b>All Platforms</b> shows the consolidated view. Click a platform pill to edit its individual holdings. YTD uses Jan 1 price (defaults to your avg cost if not set).</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Total Invested</div><div class="kpi-value">${fmt$(totalInvested)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Current Value</div><div class="kpi-value">${fmt$(totalCurrent)}</div></div>
      <div class="kpi-card ${totalPl>=0?'c-teal':'c-danger'}"><div class="kpi-label">Unrealized P&L</div><div class="kpi-value">${totalPl>=0?'+':''}${fmt$(totalPl)}</div></div>
      <div class="kpi-card ${totalYtdPl>=0?'c-teal':'c-danger'}"><div class="kpi-label">YTD P&L</div><div class="kpi-value">${totalYtdPl>=0?'+':''}${fmt$(totalYtdPl)}</div></div>
    </div>

    ${pillHtml}
    ${toolbar}

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

    <div class="card">
      <div class="table-scroll">
        <table class="ledger">
          <thead>${thead}</thead>
          <tbody id="holdingsBody">${tbody}</tbody>
        </table>
      </div>
      ${addForm}
    </div>
  `;
  document.getElementById('panel-holdings').innerHTML = html;

  /* ---- Handlers ---- */
  document.querySelectorAll('[data-hpill]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsView = b.dataset.hpill; renderHoldings();
  }));

  if(!isAll){
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
            if(h.lots.length === 1){ h.lots[0].qty = v || 0; }
            else if(h.lots.length === 0){ h.lots.push({qty: v||0, price: h.avgPrice||0, date: `${y}-01-01`}); }
            else { h.lots[h.lots.length-1].qty = v || 0; }
            recalcHolding(h);
          } else if(field === 'avgPrice'){
            const oldTotal = h.lots.reduce((a,l)=>a+num(l.qty)*num(l.price),0);
            const oldQty = h.lots.reduce((a,l)=>a+num(l.qty),0);
            if(oldQty > 0){
              const ratio = (v * oldQty) / oldTotal;
              h.lots.forEach(l => l.price = num(l.price) * ratio);
            }
            recalcHolding(h);
          } else if(field === 'currentPrice'){
            h.currentPrice = v || 0;
          } else if(field === 'ytdStartPrice'){
            h.ytdStartPrice = v || 0;
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
        if(!sym){ document.getElementById('hNewSym').focus(); return; }
        inv.holdings.push({
          id: uid(), symbol: sym, name: name || sym, type,
          qty, avgPrice: avg, currentPrice: cur, ytdStartPrice: avg,
          lots: [{qty, price: avg, date: new Date().toISOString().slice(0,10)}],
          dividends: [], currency: inv.currency || 'USD'
        });
        markDirty(); renderHoldings();
      });

      const fetchBtn = document.getElementById('hFetchPrices');
      if(fetchBtn){
        fetchBtn.addEventListener('click', async ()=>{
          fetchBtn.textContent = '⏳ Fetching...';
          fetchBtn.disabled = true;
          let updated = 0, failed = 0;
          for(const h of inv.holdings){
            if(num(h.qty) <= 0) continue;
            try{
              const result = await fetchLivePrice(h.symbol, inv.currency==='INR');
              h.currentPrice = result.price;
              h.dayChangePct = result.changePct;
              h.lastFetched = Date.now();
              updated++;
            }catch(e){ failed++; }
            await new Promise(r => setTimeout(r, 300));
          }
          markDirty(); renderHoldings();
          showToast(`${updated} prices updated${failed>0 ? ', '+failed+' failed (CORS/manual needed)' : ''}`);
        });
      }

      const closedCb = document.getElementById('hShowClosed');
      if(closedCb){
        closedCb.addEventListener('change', ()=>{
          state.showClosedHoldings = closedCb.checked;
          renderHoldings();
        });
      }
    }
  }

  /* ---- Charts ---- */
  destroyChart('holdingAlloc');
  destroyChart('holdingPl');

  if(allocLabels.length > 0){
    charts.holdingAlloc = safeChart(document.getElementById('chartHoldingAlloc'), {
      type: 'doughnut',
      data: { labels: allocLabels, datasets: [{ data: allocVals, backgroundColor: allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor: '#1C2726', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, font: { size: 10.5 } } } } }
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