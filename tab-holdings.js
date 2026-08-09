/* =========================================================================
   HOLDINGS TAB — granular stock / MF / ETF / index / crypto tracking
   ========================================================================= */
const HOLDING_TYPES = ['stock','mf','etf','index','crypto','other'];

function _ensureFx(){
  if(typeof fxRates !== 'undefined' && fxRates && fxRates.INR) return fxRates;
  return { INR: 95.0 };
}

function _isIndianPlatform(inv){
  const n = (inv.name||'').toLowerCase();
  const c = (inv.category||'').toLowerCase();
  return c.includes('indian') || c.includes('angel') ||
         n.includes('zerodha') || n.includes('groww') || 
         n.includes('angel') || n.includes('loan') ||
         n.includes('coin by');
}

/* Auto-derives the "start of year" price for YTD math, instead of a manual
   field: uses the earliest portfolio snapshot recorded this year for that
   symbol (real historical data), falling back to avg cost if you haven't
   snapshotted yet. No UI entry needed — it just works off data you're
   already recording. */
function _ytdStartPriceFor(h){
  const sym = (h.symbol || '').toString().toUpperCase();
  const snaps = getPortfolioSnapshots(state.year);
  if(snaps.length && sym){
    const first = snaps.find(s => s.holdings && s.holdings[sym] && s.holdings[sym].price);
    if(first) return { price: first.holdings[sym].price, date: first.date };
  }
  return { price: h.avgPrice || 0, date: null };
}

function getPortfolioSnapshots(y){
  return yearData(y).portfolioSnapshots || [];
}
function filterSnapshots(snaps, timeframe){
  if(!snaps.length) return [];
  const now = new Date();
  let cutoff = new Date(0);
  switch(timeframe){
    case '1W': cutoff = new Date(now.getTime() - 7*24*60*60*1000); break;
    case '1M': cutoff = new Date(now.getTime() - 30*24*60*60*1000); break;
    case '3M': cutoff = new Date(now.getTime() - 90*24*60*60*1000); break;
    case '6M': cutoff = new Date(now.getTime() - 180*24*60*60*1000); break;
    case '1Y': cutoff = new Date(now.getTime() - 365*24*60*60*1000); break;
    case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
    default: return snaps;
  }
  return snaps.filter(s => new Date(s.date) >= cutoff);
}
function recordPortfolioSnapshot(y, silent){
  ensureHoldingsMigration();
  const snaps = yearData(y).portfolioSnapshots || [];
  const today = new Date().toISOString().slice(0,10);
  const all = aggregateAllHoldings(y);
  const totalValue = all.reduce((a,r)=>a+r.currentValue,0);
  const totalInvested = all.reduce((a,r)=>a+r.invested,0);
  const holdings = {};
  all.forEach(h => { holdings[h.symbol] = { value: h.currentValue, invested: h.invested, qty: h.qty, price: h.currentPrice }; });
  const filtered = snaps.filter(s => s.date !== today);
  filtered.push({date: today, totalValue, totalInvested, totalPl: totalValue-totalInvested, holdings});
  yearData(y).portfolioSnapshots = filtered.slice(-365); // keep last year of daily snaps
  markDirty('holdings');
  if(!silent) showToast('Snapshot recorded: '+today);
}

/* ---------- FX helpers ---------- */
/* Reuse the investments tab's live FX. If it hasn't loaded yet, trigger it. */
async function ensureHoldingsFx(){
  if(typeof ensureFxRates === 'function' && (!fxRates || !fxRates.INR)){
    await ensureFxRates();
  }
}

/* ---------- Last price refresh timestamp ---------- */
/* Written by both the daily server-side refresh (see
   supabase-functions/daily-price-refresh) and by a manual "Fetch live
   prices" click, so the displayed time is accurate either way. */
const PRICE_TIMESTAMP_KEY = 'ledger:pricesUpdatedAt:v1';
let _priceRefreshTimestamp = undefined; // undefined = not loaded yet, null = loaded, none recorded
async function ensurePriceRefreshTimestamp(){
  if(_priceRefreshTimestamp !== undefined) return;
  try{
    const res = await window.storage.get(PRICE_TIMESTAMP_KEY, false);
    _priceRefreshTimestamp = (res && res.value) ? res.value : null;
  }catch(e){ _priceRefreshTimestamp = null; }
}
async function recordPriceRefreshNow(){
  const nowIso = new Date().toISOString();
  try{ await window.storage.set(PRICE_TIMESTAMP_KEY, nowIso, false); }catch(e){}
  _priceRefreshTimestamp = nowIso;
}
function _formatPriceRefreshTimestamp(){
  if(_priceRefreshTimestamp === undefined) return 'checking…';
  if(_priceRefreshTimestamp === null) return 'never';
  try{ return new Date(_priceRefreshTimestamp).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); }
  catch(e){ return 'unknown'; }
}
function _toUsd(val, currency){
  if(currency !== 'INR') return num(val);
  const r = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : 95.0;
  return num(val) / r;
}
/* ---------- Live price fetch (best effort) ---------- */
async function fetchLivePrice(symbol, isIndian){
  let yahooSym = symbol.toUpperCase().trim();
  if(isIndian && !yahooSym.endsWith('.NS') && !yahooSym.endsWith('.BO')){
    yahooSym = yahooSym + '.NS';
  }

  // Preferred path: your own serverless function does the Yahoo Finance call
  // server-to-server, so there's no browser CORS involved at all. Set
  // window.PRICE_PROXY_URL (e.g. in storage-bridge.js) to enable this —
  // see supabase-functions/fetch-price/README.md for a deployable example.
  if(typeof window !== 'undefined' && window.PRICE_PROXY_URL){
    try{
      const res = await fetch(`${window.PRICE_PROXY_URL}?symbol=${encodeURIComponent(yahooSym)}`);
      if(res.ok){
        const data = await res.json();
        if(typeof data.price === 'number' && data.price > 0){
          return {price: data.price, changePct: (typeof data.changePct === 'number') ? data.changePct : null};
        }
      }
    }catch(e){ /* fall through to the public proxies below */ }
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
  if(!yearData(y).portfolioSnapshots) yearData(y).portfolioSnapshots = [];
  if(!yearData(y).investments) return;
  yearData(y).investments.forEach(inv => {
    if(!inv.currency) inv.currency = _isIndianPlatform(inv) ? 'INR' : 'USD';
    if(!inv.holdings) inv.holdings = [];
    inv.holdings.forEach(h => {
      if(!h.lots) h.lots = [];
      if(!h.dividends) h.dividends = [];
      if(!h.type) h.type = 'stock';
      if(!h.currency) h.currency = inv.currency || 'USD';
      h.lots.forEach(l => { if(!l.type) l.type = 'buy'; if(!l.id) l.id = uid(); });
      if(h.lots.length === 0 && (h.qty > 0 || h.avgPrice > 0)){
        h.lots.push({id: uid(), type:'buy', qty: num(h.qty), price: num(h.avgPrice), date: `${y}-01-01`});
      }
      recalcHolding(h);
    });
  });
}

function recalcHolding(h){
  const lots = (h.lots||[]).slice().sort((a,b)=> new Date(a.date||0) - new Date(b.date||0));
  let qty = 0, costBasis = 0, realizedPL = 0, boughtQty = 0, soldQty = 0, proceeds = 0, costBasisSold = 0, lastSellDate = null;
  lots.forEach(l=>{
    const lq = num(l.qty);
    if(l.type === 'sell'){
      const avgCost = qty > 0 ? costBasis/qty : 0;
      const sq = Math.min(lq, qty);
      const saleCost = sq*avgCost;
      realizedPL += sq*num(l.price) - saleCost;
      proceeds += sq*num(l.price);
      costBasisSold += saleCost;
      costBasis -= saleCost;
      qty -= sq;
      soldQty += sq;
      if(!lastSellDate || (l.date && l.date > lastSellDate)) lastSellDate = l.date;
    } else {
      qty += lq;
      costBasis += lq*num(l.price);
      boughtQty += lq;
    }
  });
  h.qty = qty;
  h.avgPrice = qty > 0 ? costBasis/qty : 0;
  h.realizedPL = realizedPL;
  h.totalBoughtQty = boughtQty;
  h.totalSoldQty = soldQty;
  h.avgSellPrice = soldQty > 0 ? proceeds/soldQty : 0;
  h.costBasisSold = costBasisSold;
  h.proceeds = proceeds;
  h.lastSellDate = lastSellDate;
  h.status = (qty > 0.0000001 || soldQty <= 0) ? 'open' : 'closed';
  if(!h.ytdStartPrice) h.ytdStartPrice = h.avgPrice;
}

/* ---------- Aggregation ---------- */
function aggregateAllHoldings(y){
  ensureHoldingsMigration();
  const map = {};
  yearData(y).investments.forEach(inv => {
    const isINR = inv.currency === 'INR';
    (inv.holdings || []).forEach(h => {
      if(h.status === 'closed') return;
      const sym = (h.symbol || 'unknown').toString().toUpperCase();
      if(!map[sym]) map[sym] = {
        symbol: sym, name: h.name || sym, type: h.type || 'stock',
        qty: 0, invested: 0, currentValue: 0, ytdStartValue: 0,
        platforms: [], prices: [], avgPrices: [], ytdPrices: [],
        dayPLUSD: 0, dayPLKnown: false
      };
      const q = num(h.qty);
      const avgUSD = _toUsd(h.avgPrice, isINR ? 'INR' : 'USD');
      const curUSD = _toUsd(h.currentPrice, isINR ? 'INR' : 'USD');
      const ytdUSD = _toUsd(_ytdStartPriceFor(h).price, isINR ? 'INR' : 'USD');
      map[sym].qty += q;
      map[sym].invested += q * avgUSD;
      map[sym].currentValue += q * curUSD;
      map[sym].ytdStartValue += q * ytdUSD;
      map[sym].platforms.push(inv.name);
      map[sym].prices.push(curUSD);
      map[sym].avgPrices.push(avgUSD);
      map[sym].ytdPrices.push(ytdUSD);
      if(h.dayChangePct !== null && h.dayChangePct !== undefined && num(h.currentPrice) > 0){
        // Derive $/share change from % + current price, then convert to USD.
        const prevCloseLocal = num(h.currentPrice) / (1 + h.dayChangePct/100);
        const dayChangePerShareUSD = _toUsd(num(h.currentPrice) - prevCloseLocal, isINR ? 'INR' : 'USD');
        map[sym].dayPLUSD += q * dayChangePerShareUSD;
        map[sym].dayPLKnown = true;
      }
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
    const prevTotalUSD = h.currentValue - h.dayPLUSD;
    h.dayChangePct = (h.dayPLKnown && prevTotalUSD > 0) ? (h.dayPLUSD / prevTotalUSD) * 100 : null;
    h.dayChgPerShareUSD = (h.dayPLKnown && h.qty > 0) ? h.dayPLUSD / h.qty : null;
    return h;
  }).sort((a,b) => b.currentValue - a.currentValue);
}

function platformHoldings(y, platformId){
  ensureHoldingsMigration();
  const inv = yearData(y).investments.find(i => i.id === platformId);
  if(!inv) return [];
  const isINR = inv.currency === 'INR';
  const fx = _ensureFx().INR || 95.0;
  return (inv.holdings || [])
    .filter(h => h.status !== 'closed')
    .map(h => {
      const q = num(h.qty), avg = num(h.avgPrice), cur = num(h.currentPrice);
      const ytdInfo = _ytdStartPriceFor(h);
      const ytd = ytdInfo.price || avg;
      const invested = q * avg, current = q * cur, ytdVal = q * ytd;
      const pl = current - invested, ytdPl = current - ytdVal;
      const investedUSD = isINR ? invested / fx : invested;
      const currentUSD  = isINR ? current / fx : current;
      const ytdUSD      = isINR ? ytdVal / fx : ytdVal;
      const plUSD       = isINR ? pl / fx : pl;
      const ytdPlUSD    = isINR ? ytdPl / fx : ytdPl;
      const dayChg = h.dayChangePct !== null && h.dayChangePct !== undefined ? h.dayChangePct : null;
      const dayChgStr = dayChg !== null ? (dayChg >= 0 ? '+' : '') + dayChg.toFixed(2) + '%' : '—';
      const dayChgColor = dayChg > 0 ? 'var(--good)' : dayChg < 0 ? 'var(--danger)' : 'var(--text-dim)';
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      let dayPLLocal = null, dayPLUSD = null, dayChgPerShareLocal = null;
      if(dayChg !== null && cur > 0){
        const prevClose = cur / (1 + dayChg/100);
        dayChgPerShareLocal = cur - prevClose; // e.g. Yahoo's "+4.97" in "+4.97 (+2.27%)"
        dayPLLocal = q * dayChgPerShareLocal; // total $ made/lost today on this position, in the platform's own currency
        dayPLUSD = isINR ? dayPLLocal / fx : dayPLLocal;
      }
      const ytdBaselineNote = ytdInfo.date
        ? `YTD baseline: ${fmt(ytd)} (from your ${ytdInfo.date} snapshot)`
        : `YTD baseline: ${fmt(ytd)} (no snapshot yet this year — using avg cost)`;
      return {
        ...h, qty: q, avgPrice: avg, currentPrice: cur, ytdStartPrice: ytd,
        invested, currentValue: current, ytdValue: ytdVal,
        investedUSD, currentValueUSD: currentUSD, ytdValueUSD: ytdUSD,
        plNet: pl, plNetUSD: plUSD, plPct: invested > 0 ? pl / invested : 0,
        ytdNet: ytdPl, ytdNetUSD: ytdPlUSD, ytdPct: ytdVal > 0 ? ytdPl / ytdVal : 0, ytdBaselineNote,
        dayChangePct: dayChg, dayChangeStr: dayChgStr, dayChangeColor: dayChgColor,
        dayPLUSD, dDayPl: dayPLLocal !== null ? fmt(dayPLLocal) : '—', tDayPl: dayPLLocal !== null ? tip(dayPLLocal) : null,
        dDayChgAmt: dayChgPerShareLocal !== null ? fmt(dayChgPerShareLocal) : null,
        tDayChgAmt: dayChgPerShareLocal !== null ? tip(dayChgPerShareLocal) : null,
        dAvg: fmt(avg), dCur: fmt(cur), dYtd: fmt(ytd),
        dInv: fmt(invested), dVal: fmt(current), dPl: fmt(pl), dYtdPl: fmt(ytdPl),
        tAvg: tip(avg), tCur: tip(cur), tYtd: tip(ytd),
        tInv: tip(invested), tVal: tip(current), tPl: tip(pl), tYtdPl: tip(ytdPl)
      };
    }).sort((a,b) => b.currentValue - a.currentValue);
}

function platformSoldHoldings(y, platformId){
  ensureHoldingsMigration();
  const inv = yearData(y).investments.find(i => i.id === platformId);
  if(!inv) return [];
  const isINR = inv.currency === 'INR';
  const fx = _ensureFx().INR || 95.0;
  return (inv.holdings || [])
    .filter(h => h.status === 'closed')
    .map(h => {
      const costBasisSold = num(h.costBasisSold), proceeds = num(h.proceeds), realized = num(h.realizedPL);
      const fmt = (v) => isINR ? fmt$(v/fx, 2) : fmt$(v, 2);
      const tip = (v) => isINR ? fmtInr(v) : null;
      return {
        ...h,
        dAvgBuy: fmt(h.avgPrice), dAvgSell: fmt(h.avgSellPrice),
        dCostBasis: fmt(costBasisSold), dProceeds: fmt(proceeds), dRealized: fmt(realized),
        tCostBasis: tip(costBasisSold), tProceeds: tip(proceeds), tRealized: tip(realized),
        realizedUSD: isINR ? realized/fx : realized,
        realizedPct: costBasisSold > 0 ? realized/costBasisSold : 0
      };
    })
    .sort((a,b) => new Date(b.lastSellDate||0) - new Date(a.lastSellDate||0));
}

function allSoldHoldingsByPlatform(y){
  ensureHoldingsMigration();
  const investments = yearData(y).investments || [];
  return investments
    .map(inv => ({ platformId: inv.id, platformName: inv.name, rows: platformSoldHoldings(y, inv.id) }))
    .filter(p => p.rows.length > 0);
}

/* ---------- Sell modal ---------- */
function openSellModal(h, onConfirm){
  const old = document.getElementById('sellModalOverlay');
  if(old) old.remove();

  const maxQty = h.qty;
  const defaultPrice = h.currentPrice || h.avgPrice || 0;
  const today = new Date().toISOString().slice(0,10);

  const overlay = document.createElement('div');
  overlay.id = 'sellModalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Sell ${h.symbol}</h3>
      <p class="modal-sub">${h.name && h.name!==h.symbol ? h.name+' · ' : ''}You currently hold ${maxQty} share${maxQty===1?'':'s'}.</p>
      <div class="modal-field">
        <label>Quantity <span class="hint">max ${maxQty}</span></label>
        <input type="number" id="sellQty" value="${maxQty}" min="0" max="${maxQty}" step="any">
      </div>
      <div class="modal-field">
        <label>Sale price / share</label>
        <input type="number" id="sellPrice" value="${defaultPrice || ''}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="sellDate" value="${today}" max="${today}">
      </div>
      <div class="modal-preview">
        <span class="label">Estimated realized P&L</span>
        <span class="value" id="sellPreviewVal">—</span>
      </div>
      <div class="modal-actions">
        <button class="btn" id="sellCancelBtn">Cancel</button>
        <button class="btn primary" id="sellConfirmBtn">Confirm sale</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const qtyEl = overlay.querySelector('#sellQty');
  const priceEl = overlay.querySelector('#sellPrice');
  const dateEl = overlay.querySelector('#sellDate');
  const previewEl = overlay.querySelector('#sellPreviewVal');

  function updatePreview(){
    const q = Math.min(Math.max(parseFloat(qtyEl.value)||0, 0), maxQty);
    const p = parseFloat(priceEl.value)||0;
    const est = q*(p - (h.avgPrice||0));
    previewEl.textContent = (est>=0?'+':'') + fmt$(est,2);
    previewEl.style.color = est>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
  }
  updatePreview();
  qtyEl.addEventListener('input', updatePreview);
  priceEl.addEventListener('input', updatePreview);

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#sellCancelBtn').addEventListener('click', close);

  overlay.querySelector('#sellConfirmBtn').addEventListener('click', ()=>{
    const qty = parseFloat(qtyEl.value);
    const price = parseFloat(priceEl.value);
    const date = dateEl.value || today;
    if(!qty || qty<=0){ qtyEl.focus(); return; }
    if(qty > maxQty){ qtyEl.value = maxQty; qtyEl.focus(); return; }
    if(isNaN(price) || price<0){ priceEl.focus(); return; }
    close();
    onConfirm(qty, price, date);
  });

  qtyEl.focus(); qtyEl.select();
}

/* ---------- Render ---------- */
function renderHoldings(){
  const y = state.year;
  ensureHoldingsMigration();
  ensureHoldingsFx();
  if(typeof ensureFxRates === 'function' && (!fxRates || !fxRates.INR)){
    ensureFxRates().then(() => { renderHoldings(); });
  }
  if(_priceRefreshTimestamp === undefined){
    ensurePriceRefreshTimestamp().then(() => { renderHoldings(); });
  }
  if(!state.holdingsView) state.holdingsView = 'ALL';
  if(state.holdingsSubView === undefined) state.holdingsSubView = 'open';
  if(state.holdingsTypeFilter === undefined) state.holdingsTypeFilter = null; // null = All types
  if(state.holdingsTypeFilterOpen === undefined) state.holdingsTypeFilterOpen = false;
  if(state.holdingsSort === undefined) state.holdingsSort = 'valueDesc';
  if(state.holdingsFilter === undefined) state.holdingsFilter = '';

  if(!state.holdingsTimeframe) state.holdingsTimeframe = 'ALL';
  const snaps = filterSnapshots(getPortfolioSnapshots(y), state.holdingsTimeframe);

  const investments = yearData(y).investments || [];
  const allRows = aggregateAllHoldings(y);
  const isAll = state.holdingsView === 'ALL';
  let rows = isAll ? allRows : platformHoldings(y, state.holdingsView);
  let soldGroups = isAll ? allSoldHoldingsByPlatform(y) : [{ platformId: state.holdingsView, platformName: (investments.find(i=>i.id===state.holdingsView)||{}).name || '', rows: platformSoldHoldings(y, state.holdingsView) }].filter(g=>g.rows.length>0);
  if(state.holdingsTypeFilter !== null){
    const activeTypes = state.holdingsTypeFilter;
    rows = rows.filter(r => activeTypes.includes(r.type));
    soldGroups = soldGroups.map(g => ({...g, rows: g.rows.filter(r => activeTypes.includes(r.type))})).filter(g => g.rows.length > 0);
  }
  const showSold = state.holdingsSubView === 'sold';

  const filterText = (state.holdingsFilter || '').toLowerCase().trim();
  let filteredRows = filterText 
    ? rows.filter(r => ((r.name||'')+' '+(r.symbol||'')+' '+(r.type||'')).toLowerCase().includes(filterText))
    : rows;
  
  const sortMode = state.holdingsSort || 'valueDesc';
  filteredRows = [...filteredRows].sort((a,b) => {
    switch(sortMode){
      case 'nameAsc': return (a.name||'').localeCompare(b.name||'');
      case 'nameDesc': return (b.name||'').localeCompare(a.name||'');
      case 'investedDesc': return b.invested - a.invested;
      case 'investedAsc': return a.invested - b.invested;
      case 'plDesc': return b.plNet - a.plNet;
      case 'plAsc': return a.plNet - b.plNet;
      case 'valueAsc': return a.currentValue - b.currentValue;
      case 'type': return (a.type||'').localeCompare(b.type||'') || b.currentValue - a.currentValue;
      case 'dayplDesc': return (b.dayPLUSD||0) - (a.dayPLUSD||0);
      case 'dayplAsc': return (a.dayPLUSD||0) - (b.dayPLUSD||0);
      default: return b.currentValue - a.currentValue;
    }
  });
  
  /* ---- KPIs: OPEN vs SOLD view ---- */
  let kpiHtml = '';
  if(showSold){
    // SOLD VIEW: Realized metrics
    const allSold = soldGroups.flatMap(g=>g.rows);
    const totalRealized = allSold.reduce((a,r)=>a+(r.realizedUSD||0),0);
    const totalProceeds = allSold.reduce((a,r)=>a+(r.proceeds||0),0);
    const totalCostBasisSold = allSold.reduce((a,r)=>a+(r.costBasisSold||0),0);
    const winners = allSold.filter(r=>(r.realizedUSD||0)>0);
    const losers = allSold.filter(r=>(r.realizedUSD||0)<0);
    const winRate = allSold.length > 0 ? (winners.length / allSold.length) * 100 : 0;
    const avgWin = winners.length > 0 ? winners.reduce((a,r)=>a+(r.realizedUSD||0),0)/winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((a,r)=>a+(r.realizedUSD||0),0)/losers.length : 0;
    const biggestWin = allSold.length ? Math.max(...allSold.map(r=>r.realizedUSD||0)) : 0;
    const biggestLoss = allSold.length ? Math.min(...allSold.map(r=>r.realizedUSD||0)) : 0;
    const totalRealizedPct = totalCostBasisSold > 0 ? totalRealized / totalCostBasisSold : 0;

    kpiHtml = `
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
        <div class="kpi-card ${totalRealized>=0?'c-teal':'c-danger'}"><div class="kpi-label">Total Realized P&L</div><div class="kpi-value">${totalRealized>=0?'+':''}${fmt$(totalRealized)}</div><div class="kpi-delta ${totalRealized>=0?'up':'down'}">${totalRealized>=0?'+':''}${pct(totalRealizedPct)}</div></div>
        <div class="kpi-card c-gold"><div class="kpi-label">Total Proceeds</div><div class="kpi-value">${fmt$(totalProceeds)}</div></div>
        <div class="kpi-card c-rust"><div class="kpi-label">Cost Basis (sold)</div><div class="kpi-value">${fmt$(totalCostBasisSold)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Win Rate</div><div class="kpi-value">${winRate.toFixed(1)}%</div><div class="kpi-delta flat">${winners.length}W / ${losers.length}L of ${allSold.length}</div></div>
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr); margin-top:12px;">
        <div class="kpi-card c-teal"><div class="kpi-label">Avg Winner</div><div class="kpi-value">+${fmt$(avgWin)}</div></div>
        <div class="kpi-card c-danger"><div class="kpi-label">Avg Loser</div><div class="kpi-value">${fmt$(avgLoss)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Biggest Win</div><div class="kpi-value">+${fmt$(biggestWin)}</div></div>
        <div class="kpi-card c-danger"><div class="kpi-label">Biggest Loss</div><div class="kpi-value">${fmt$(biggestLoss)}</div></div>
      </div>
    `;
    } else {
    // OPEN VIEW: Standard portfolio metrics
    const totalInvested = rows.reduce((a,r)=>a+(r.investedUSD!==undefined?r.investedUSD:r.invested),0);
    const totalCurrent  = rows.reduce((a,r)=>a+(r.currentValueUSD!==undefined?r.currentValueUSD:r.currentValue),0);
    const totalYtdStart = rows.reduce((a,r)=>a+((r.ytdValueUSD!==undefined?r.ytdValueUSD:r.ytdValue)||(r.investedUSD!==undefined?r.investedUSD:r.invested)),0);
    const totalPl       = totalCurrent - totalInvested;
    const totalYtdPl    = totalCurrent - totalYtdStart;
    const totalPlPct    = totalInvested > 0 ? totalPl / totalInvested : 0;
    // const totalYtdPlPct = totalYtdStart > 0 ? totalYtdPl / totalYtdStart : 0; // superseded by Day Change P&L below
    const totalDayPl    = rows.reduce((a,r)=>a+(r.dayPLUSD||0),0);
    const totalDayPrevValue = totalCurrent - totalDayPl; // portfolio value as of yesterday's close
    const totalDayPlPct = totalDayPrevValue > 0 ? totalDayPl / totalDayPrevValue : 0;
    const anyDayDataKnown = rows.some(r => r.dayChangePct !== null && r.dayChangePct !== undefined);
    const fxRate = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : null;
    const fxSource = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? 'live' : 'updating...';
    kpiHtml = `
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
        <div class="kpi-card c-gold"><div class="kpi-label">Total Invested</div><div class="kpi-value">${fmt$(totalInvested)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Current Value</div><div class="kpi-value">${fmt$(totalCurrent)}</div></div>
        <div class="kpi-card ${totalPl>=0?'c-teal':'c-danger'}"><div class="kpi-label">Unrealized P&L</div><div class="kpi-value">${totalPl>=0?'+':''}${fmt$(totalPl)}</div><div class="kpi-delta ${totalPl>=0?'up':'down'}">${totalPl>=0?'+':''}${pct(totalPlPct)}</div></div>
        <!-- YTD P&L card removed here — replaced by Day Change P&L below -->
        <div class="kpi-card ${!anyDayDataKnown?'':(totalDayPl>=0?'c-teal':'c-danger')}"><div class="kpi-label">Day Change P&L</div><div class="kpi-value">${anyDayDataKnown ? (totalDayPl>=0?'+':'')+fmt$(totalDayPl) : '—'}</div><div class="kpi-delta ${totalDayPl>=0?'up':'down'}">${anyDayDataKnown ? (totalDayPl>=0?'+':'')+pct(totalDayPlPct) : 'Click Fetch live prices'}</div></div>
      </div>
      <div class="section-sub" style="margin-top:8px; margin-bottom:0; text-align:right;">
        ${fxRate ? `FX rate: <b style="color:var(--gold-soft);">1 USD = ${fxRate.toFixed(2)} INR</b> <span style="color:var(--text-faint);">(${fxSource})</span>` : '<span style="color:var(--text-faint);">Fetching FX rate...</span>'}
      </div>
    `;
  }

  /* ---- Platform pills ---- */
  const pills = [
    {id:'ALL', label:'All Platforms', count: allRows.length},
    ...investments.map(inv => ({id: inv.id, label: inv.name, count: (inv.holdings||[]).filter(h=>h.status!=='closed').length}))
  ];
  const pillHtml = `<div class="pill-row" style="margin-bottom:18px;">${pills.map(p=>`
    <button class="pill ${state.holdingsView===p.id?'active':''}" data-hpill="${p.id}">
      ${p.label} <span style="opacity:.6;font-size:10px;">(${p.count})</span>
    </button>
  `).join('')}</div>`;

  /* ---- Holdings / Sold toggle ---- */
  const subToggle = `
    <div class="seg-toggle">
      <button class="seg-btn ${!showSold?'active':''}" data-subview="open">📈 Holdings <span class="seg-count">${rows.length}</span></button>
      <button class="seg-btn ${showSold?'active':''}" data-subview="sold">💰 Sold <span class="seg-count">${soldGroups.reduce((a,g)=>a+g.rows.length,0)}</span></button>
    </div>
  `;

  /* ---- Type filter (checkbox dropdown, filters everything on the page) ---- */
  const activeTypesForUI = state.holdingsTypeFilter === null ? HOLDING_TYPES : state.holdingsTypeFilter;
  const typeFilterPanelHtml = `
    <div id="typeFilterPanel" style="display:${state.holdingsTypeFilterOpen?'flex':'none'}; gap:14px; flex-wrap:wrap; align-items:center; background:var(--bg-card); border:1px solid var(--line); border-radius:9px; padding:10px 14px; margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;font-weight:600;">
        <input type="checkbox" id="typeFilterAll" ${activeTypesForUI.length===HOLDING_TYPES.length?'checked':''}> All
      </label>
      ${HOLDING_TYPES.map(t=>`
        <label style="display:flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;">
          <input type="checkbox" class="typeFilterBox" value="${t}" ${activeTypesForUI.includes(t)?'checked':''}> ${t}
        </label>
      `).join('')}
    </div>
  `;

  /* ---- Toolbar ---- */
  const toolbar = showSold ? '' : `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap;">
      <button class="btn small" id="hFetchPrices">🔄 Fetch live prices</button>
      <span class="section-sub" style="margin:0;">Fetching uses Yahoo Finance. Browsers may block it (CORS) — if so, enter prices manually.</span>
    </div>
  `;

  /* ---- Charts (only for open view) ---- */
  const allocRows = rows.filter(r => (r.currentValueUSD !== undefined ? r.currentValueUSD : r.currentValue) > 0.01).slice(0, 12);
  const allocLabels = allocRows.map(r => r.symbol || r.name);
  const allocVals   = allocRows.map(r => r.currentValueUSD !== undefined ? r.currentValueUSD : r.currentValue);
  const allocTotal = allocVals.reduce((a,b)=>a+b,0);

  const plRows = rows.filter(r => Math.abs(r.plNetUSD !== undefined ? r.plNetUSD : r.plNet) > 0.01)
                     .sort((a,b) => ((b.plNetUSD !== undefined ? b.plNetUSD : b.plNet) || 0) - ((a.plNetUSD !== undefined ? a.plNetUSD : a.plNet) || 0))
                     .slice(0, 15);
  const plLabels = plRows.map(r => r.symbol || r.name);
  const plVals   = plRows.map(r => r.plNetUSD !== undefined ? r.plNetUSD : r.plNet);
  const plColors = plVals.map(v => v >= 0 ? '#7FAE79' : '#C06A46');

  /* ---- Table headers ---- */
  const typeTh = `<th id="typeFilterTh" style="cursor:pointer; white-space:nowrap;" title="Filter by type">Type <span id="typeFilterIcon" style="opacity:.75;">🔽</span></th>`;
  const thead = isAll
    ? `<tr><th>Name</th><th>Symbol</th><th>Qty</th><th>Avg Price</th><th data-tip="Last Traded Price" class="has-tip">LTP</th><th style="min-width:70px;">Day Chg</th><th>Invested</th><th>Current Value</th><th>Unrealized P&L</th><th>Day P&L</th><th data-tip="Calculated automatically from your earliest snapshot this year" class="has-tip">YTD P&L</th>${typeTh}<th>Platforms</th></tr>`
    : `<tr><th>Symbol</th><th>Name</th>${typeTh}<th>Qty</th><th>Avg Price</th><th data-tip="Last Traded Price" class="has-tip">LTP</th><th style="min-width:70px;">Day Chg</th><th>Invested</th><th>Current Value</th><th>Unrealized P&L</th><th>Day P&L</th><th data-tip="Calculated automatically from your earliest snapshot this year — hover a row's value to see the exact baseline" class="has-tip">YTD P&L</th><th></th></tr>`;

  /* ---- OPEN table body ---- */
  const tbody = filteredRows.map(r => {
    const plColor = (v) => v>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
    if(isAll){
      const dayColor = r.dayChangePct===null ? 'var(--text-dim)' : (r.dayChangePct>=0 ? 'var(--good)' : 'var(--danger)');
      const dayPlColor = r.dayChangePct===null ? 'var(--text-dim)' : plColor(r.dayPLUSD||0);
      return `<tr>
        <td>${r.name}</td>
        <td style="font-weight:600;">${r.symbol}</td>
        <td>${r.qty}</td>
        <td>${fmt$(r.avgPrice,2)}</td>
        <td>${fmt$(r.currentPrice,2)}</td>
        <td style="color:${dayColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;">${r.dayChangePct===null?'—':(r.dayChangePct>=0?'+':'')+fmt$(r.dayChgPerShareUSD,2)+' ('+(r.dayChangePct>=0?'+':'')+r.dayChangePct.toFixed(2)+'%)'}</td>
        <td style="font-weight:600;">${fmt$(r.invested,2)}</td>
        <td style="font-weight:600;color:var(--gold-soft);">${fmt$(r.currentValue,2)}</td>
        <td style="font-weight:600;color:${plColor(r.plNet)}">${r.plNet>=0?'+':''}${fmt$(r.plNet,2)} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
        <td style="font-weight:600;color:${dayPlColor};">${r.dayChangePct===null?'—':(r.dayPLUSD>=0?'+':'')+fmt$(r.dayPLUSD,2)}</td>
        <td style="color:${plColor(r.ytdPl)}">${r.ytdPl>=0?'+':''}${fmt$(r.ytdPl,2)} <span style="font-size:11px;opacity:.75;">(${r.ytdPct>=0?'+':''}${pct(r.ytdPct)})</span></td>
        <td><span class="debt-tag">${r.type}</span></td>
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
      <td style="color:${r.dayChangeColor}; font-weight:600; font-family:var(--font-mono); font-size:11.5px;" ${r.tDayChgAmt?`data-tip="${r.tDayChgAmt}" class="has-tip"`:''}>${r.dDayChgAmt===null?'—':(r.dayChangePct>=0?'+':'')+r.dDayChgAmt+' ('+r.dayChangeStr+')'}</td>
      <td style="font-weight:600;" ${tip(r.tInv)}>${r.dInv}</td>
      <td style="font-weight:600;color:var(--gold-soft);" ${tip(r.tVal)}>${r.dVal}</td>
      <td style="font-weight:600;color:${plColor(r.plNet)}" ${tip(r.tPl)}>${r.plNet>=0?'+':''}${r.dPl} <span style="font-size:11px;opacity:.75;">(${r.plPct>=0?'+':''}${pct(r.plPct)})</span></td>
      <td style="font-weight:600;color:${r.dayChangePct===null?'var(--text-dim)':plColor(r.dayPLUSD||0)};" ${tip(r.tDayPl)}>${r.dayChangePct===null?'—':(r.dayPLUSD>=0?'+':'')+r.dDayPl}</td>
      <td style="color:${plColor(r.ytdNet)}" title="${r.ytdBaselineNote}">${r.ytdNet>=0?'+':''}${r.dYtdPl} <span style="font-size:11px;opacity:.75;">(${r.ytdPct>=0?'+':''}${pct(r.ytdPct)})</span></td>
      <td style="white-space:nowrap;"><button class="btn small sell" data-sellh="${r.id}">Sell</button> <span class="row-del" data-delh="${r.id}" title="Delete this holding entirely">✕</span></td>
    </tr>`;
  }).join('');

  /* ---- SOLD table ---- */
  const soldTheadCols = isAll
    ? `<th>Platform</th><th>Symbol</th><th>Name</th><th>Type</th><th>Qty Sold</th><th>Avg Buy</th><th>Avg Sell</th><th>Cost Basis</th><th>Proceeds</th><th>Realized P&L</th><th>Sold</th>`
    : `<th>Symbol</th><th>Name</th><th>Type</th><th>Qty Sold</th><th>Avg Buy</th><th>Avg Sell</th><th>Cost Basis</th><th>Proceeds</th><th>Realized P&L</th><th>Sold</th>`;
  function soldRowHtml(r, platformName){
    const plColor = (v) => v>=0 ? 'var(--teal-soft)' : 'var(--rust-soft)';
    return `<tr>
      ${isAll ? `<td><span class="debt-tag" style="font-size:10px;">${platformName}</span></td>` : ''}
      <td style="font-weight:600;">${r.symbol}</td>
      <td>${r.name||''}</td>
      <td><span class="debt-tag">${r.type}</span></td>
      <td>${r.totalSoldQty}</td>
      <td>${r.dAvgBuy}</td>
      <td>${r.dAvgSell}</td>
      <td ${r.tCostBasis?`data-tip="${r.tCostBasis}" class="has-tip"`:''}>${r.dCostBasis}</td>
      <td ${r.tProceeds?`data-tip="${r.tProceeds}" class="has-tip"`:''}>${r.dProceeds}</td>
      <td style="font-weight:600;color:${plColor(r.realizedPL)}" ${r.tRealized?`data-tip="${r.tRealized}" class="has-tip"`:''}>${r.realizedPL>=0?'+':''}${r.dRealized} <span style="font-size:11px;opacity:.75;">(${r.realizedPct>=0?'+':''}${pct(r.realizedPct)})</span></td>
      <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim); white-space:nowrap;">${r.lastSellDate||'—'}</td>
    </tr>`;
  }
  const soldSection = `
    <div class="card" style="margin-top:20px;">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Sold ${isAll ? '· all platforms' : '· ' + (investments.find(i=>i.id===state.holdingsView)||{}).name}</h3>
      </div>
      <p class="section-sub">Fully or partially exited positions. Kept separate from the totals above so they don't skew your current allocation.</p>
      ${!soldGroups.length ? '<div class="section-sub" style="padding:16px 0; text-align:center;">Nothing sold yet. Switch to Holdings and use the Sell button on a position.</div>' :
        isAll
          ? soldGroups.map(g => `
              <div style="margin-bottom:18px;">
                <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--gold-soft); font-weight:600; margin-bottom:6px;">${g.platformName}</div>
                <div class="table-scroll">
                  <table class="ledger">
                    <thead><tr>${soldTheadCols}</tr></thead>
                    <tbody>${g.rows.map(r=>soldRowHtml(r, g.platformName)).join('')}</tbody>
                  </table>
                </div>
              </div>
            `).join('')
          : `<div class="table-scroll">
              <table class="ledger">
                <thead><tr>${soldTheadCols}</tr></thead>
                <tbody>${soldGroups[0].rows.map(r=>soldRowHtml(r)).join('')}</tbody>
              </table>
            </div>`
      }
    </div>
  `;

  /* ---- Add form ---- */
  const addForm = (isAll || showSold) ? '' : `
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

  /* ---- Portfolio history chart ---- */
  const chartSection = showSold ? '' : `
    <div class="card" style="margin-bottom:20px;">
      <div class="card-head" style="flex-wrap:wrap; gap:10px;">
        <h3>Portfolio history</h3>
        <div class="pill-row" style="margin:0;">
          ${['ALL','YTD','1Y','6M','3M','1M','1W'].map(tf=>`
            <button class="pill ${state.holdingsTimeframe===tf?'active':''}" data-timeframe="${tf}">${tf}</button>
          `).join('')}
        </div>
        <button class="btn small" id="hRecordSnapshot">📸 Record snapshot</button>
      </div>
      <div class="chart-box tall"><canvas id="chartPortfolioHistory"></canvas></div>
      <div class="section-sub" style="margin-top:8px; margin-bottom:0;">
        ${snaps.length ? 'Snapshots: ' + snaps.length + ' · Last: ' + snaps[snaps.length-1].date : 'No snapshots yet. Click 📸 to record today\'s portfolio value.'}
      </div>
    </div>
  `;

  /* ---- Allocation + P&L charts (only open view) ---- */
  const openCharts = showSold ? '' : `
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
  `;

  const html = `
    <div class="section-title">Holdings · ${y}</div>
    <p class="section-sub">Every stock, mutual fund, ETF, index, and crypto you own. <b>All Platforms</b> shows the consolidated view. Click a platform pill to edit its individual holdings. YTD uses Jan 1 price (defaults to your avg cost if not set).</p>
    <p class="section-sub" style="margin-top:-8px;">🕒 Prices last refreshed: <b style="color:var(--gold-soft);">${_formatPriceRefreshTimestamp()}</b> <span style="color:var(--text-faint);">(auto-refreshes daily on the server, even if you don't have this open)</span></p>

    ${kpiHtml}

    ${chartSection}

    ${pillHtml}
    ${subToggle}

    ${showSold ? soldSection : `
    ${toolbar}

    ${openCharts}

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; flex:1;">
          <input type="text" id="hFilter" placeholder="🔍 Filter by name, symbol, or type…" value="${state.holdingsFilter||''}" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 12px;font-family:var(--font-body);font-size:12.5px;flex:1;min-width:160px;max-width:260px;">
          <select id="hSort" style="appearance:none;-webkit-appearance:none;background:var(--bg-card);color:var(--text);border:1px solid var(--line);padding:7px 28px 7px 10px;border-radius:7px;font-family:var(--font-mono);font-size:12px;cursor:pointer;min-width:170px;">
            <option value="valueDesc" ${sortMode==='valueDesc'?'selected':''}>Sort: Value (high→low)</option>
            <option value="valueAsc" ${sortMode==='valueAsc'?'selected':''}>Sort: Value (low→high)</option>
            <option value="nameAsc" ${sortMode==='nameAsc'?'selected':''}>Sort: Name A→Z</option>
            <option value="nameDesc" ${sortMode==='nameDesc'?'selected':''}>Sort: Name Z→A</option>
            <option value="investedDesc" ${sortMode==='investedDesc'?'selected':''}>Sort: Invested (high→low)</option>
            <option value="investedAsc" ${sortMode==='investedAsc'?'selected':''}>Sort: Invested (low→high)</option>
            <option value="plDesc" ${sortMode==='plDesc'?'selected':''}>Sort: P&L (high→low)</option>
            <option value="plAsc" ${sortMode==='plAsc'?'selected':''}>Sort: P&L (low→high)</option>
            <option value="type" ${sortMode==='type'?'selected':''}>Sort: Type</option>
            <option value="dayplDesc" ${sortMode==='dayplDesc'?'selected':''}>Sort: Day P&L (high→low)</option>
            <option value="dayplAsc" ${sortMode==='dayplAsc'?'selected':''}>Sort: Day P&L (low→high)</option>
          </select>
        </div>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);">Showing ${filteredRows.length} of ${rows.length}</span>
      </div>
      ${typeFilterPanelHtml}
      <div class="table-scroll">
        <table class="ledger">
          <thead>${thead}</thead>
            <tbody id="holdingsBody">${filteredRows.length ? tbody : '<tr><td colspan="13" style="color:var(--text-faint);text-align:center;padding:20px;">No holdings match your filter.</td></tr>'}</tbody>
        </table>
      </div>
      ${addForm}
    </div>
    `}
  `;
  document.getElementById('panel-holdings').innerHTML = html;

  /* ---- Toggle handler ---- */
  document.querySelectorAll('[data-subview]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsSubView = b.dataset.subview; renderHoldings();
  }));

  /* ---- Type filter handlers ---- */
  const typeFilterTh = document.getElementById('typeFilterTh');
  if(typeFilterTh) typeFilterTh.addEventListener('click', ()=>{
    state.holdingsTypeFilterOpen = !state.holdingsTypeFilterOpen; renderHoldings();
  });
  const typeFilterAll = document.getElementById('typeFilterAll');
  if(typeFilterAll) typeFilterAll.addEventListener('change', ()=>{
    state.holdingsTypeFilter = typeFilterAll.checked ? null : [];
    renderHoldings();
  });
  document.querySelectorAll('.typeFilterBox').forEach(cb => cb.addEventListener('change', ()=>{
    let sel = (state.holdingsTypeFilter === null ? HOLDING_TYPES.slice() : state.holdingsTypeFilter.slice());
    if(cb.checked){ if(!sel.includes(cb.value)) sel.push(cb.value); }
    else { sel = sel.filter(t => t !== cb.value); }
    state.holdingsTypeFilter = sel;
    renderHoldings();
  }));

  /* ---- Handlers ---- */
  document.querySelectorAll('[data-hpill]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsView = b.dataset.hpill; renderHoldings();
  }));

  if(!isAll && !showSold){
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
            const buyLots = h.lots.filter(l => l.type !== 'sell');
            const otherBuysQty = buyLots.slice(0,-1).reduce((a,l)=>a+num(l.qty),0);
            const targetLastBuyQty = Math.max((v||0) + num(h.totalSoldQty) - otherBuysQty, 0);
            if(buyLots.length === 1){ buyLots[0].qty = targetLastBuyQty; }
            else if(buyLots.length === 0){ h.lots.push({id: uid(), type:'buy', qty: v||0, price: h.avgPrice||0, date: `${y}-01-01`}); }
            else { buyLots[buyLots.length-1].qty = targetLastBuyQty; }
            recalcHolding(h);
          } else if(field === 'avgPrice'){
            const buyLots = h.lots.filter(l => l.type !== 'sell');
            const oldTotal = buyLots.reduce((a,l)=>a+num(l.qty)*num(l.price),0);
            const oldQty = buyLots.reduce((a,l)=>a+num(l.qty),0);
            if(oldQty > 0){
              const ratio = (v * oldQty) / oldTotal;
              buyLots.forEach(l => l.price = num(l.price) * ratio);
            }
            recalcHolding(h);
          } else if(field === 'currentPrice'){
            h.currentPrice = v || 0;
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
        const newH = {
          id: uid(), symbol: sym, name: name || sym, type,
          currentPrice: cur, ytdStartPrice: avg,
          lots: [{id: uid(), type:'buy', qty, price: avg, date: new Date().toISOString().slice(0,10)}],
          dividends: [], currency: inv.currency || 'USD'
        };
        recalcHolding(newH);
        inv.holdings.push(newH);
        markDirty(); renderHoldings();
      });

      document.querySelectorAll('[data-sellh]').forEach(el => el.addEventListener('click', ()=>{
        const h = inv.holdings.find(x => x.id === el.dataset.sellh);
        if(!h) return;
        if(h.qty <= 0){ showToast('Nothing left to sell on this holding'); return; }
        openSellModal(h, (qty, price, date) => {
          h.lots.push({id: uid(), type:'sell', qty, price, date});
          recalcHolding(h);
          markDirty('holdings');
          renderHoldings();
          showToast(`Sold ${qty} ${h.symbol} @ ${fmt$(price,2)}`);
        });
      }));

      
    }
  }

    /* ---- Fetch live prices (All Platforms or single platform) ---- */
  if(!showSold){
    const fetchBtn = document.getElementById('hFetchPrices');
    if(fetchBtn){
      fetchBtn.addEventListener('click', async ()=>{
        fetchBtn.textContent = '⏳ Fetching...';
        fetchBtn.disabled = true;
        let updated = 0, failed = 0;

        if(isAll){
          for(const inv of investments){
            for(const h of (inv.holdings || [])){
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
          }
        } else {
          const inv = investments.find(i => i.id === state.holdingsView);
          if(inv){
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
          }
        }

        markDirty();
        if(updated > 0){ await recordPriceRefreshNow(); recordPortfolioSnapshot(y, true); }
        renderHoldings();
        showToast(`${updated} prices updated${failed>0 ? ', '+failed+' failed (CORS/manual needed)' : ''}`);
      });
    }
  }

  /* ---- Snapshot & timeframe ---- */
  const snapBtn = document.getElementById('hRecordSnapshot');
  if(snapBtn) snapBtn.addEventListener('click', ()=>{ recordPortfolioSnapshot(y); renderHoldings(); });
  
  document.querySelectorAll('[data-timeframe]').forEach(b => b.addEventListener('click', ()=>{
    state.holdingsTimeframe = b.dataset.timeframe; renderHoldings();
  }));

  /* ---- Portfolio history chart ---- */
  destroyChart('portfolioHistory');
  if(!showSold && snaps.length > 1){
    const labels = snaps.map(s => s.date.slice(5));
    charts.portfolioHistory = safeChart(document.getElementById('chartPortfolioHistory'), {
      type: 'line',
      data: { 
        labels, 
        datasets: [
          {label:'Portfolio value', data: snaps.map(s=>s.totalValue), borderColor:'#C9A961', backgroundColor:'rgba(201,169,97,0.08)', fill:true, tension:0.3, pointRadius:3},
          {label:'Invested', data: snaps.map(s=>s.totalInvested), borderColor:'#6FA491', borderDash:[4,3], tension:0.3, pointRadius:0}
        ] 
      },
      options: { responsive:true, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
        plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
        scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
    });
  } else if(!showSold && document.getElementById('chartPortfolioHistory')){
    document.getElementById('chartPortfolioHistory').parentElement.innerHTML = 
      '<div class="section-sub" style="padding:40px 0; text-align:center;">Need at least 2 snapshots to draw a chart.<br>Click 📸 Record snapshot on different days.</div>';
  }
  
  /* ---- Filter & sort listeners ---- */
  const filterInput = document.getElementById('hFilter');
  if(filterInput){
    filterInput.addEventListener('input', (e)=>{
      state.holdingsFilter = e.target.value;
      const selStart = e.target.selectionStart, selEnd = e.target.selectionEnd;
      renderHoldings();
      const newInput = document.getElementById('hFilter');
      if(newInput){
        newInput.focus();
        newInput.setSelectionRange(selStart, selEnd);
      }
    });
  }
  const sortSelect = document.getElementById('hSort');
  if(sortSelect){
    sortSelect.addEventListener('change', (e)=>{
      state.holdingsSort = e.target.value;
      renderHoldings();
    });
  }

  /* ---- Charts (open view only) ---- */
  destroyChart('holdingAlloc');
  destroyChart('holdingPl');

  if(!showSold && allocLabels.length > 0){
    charts.holdingAlloc = safeChart(document.getElementById('chartHoldingAlloc'), {
      type: 'doughnut',
      data: { labels: allocLabels, datasets: [{ data: allocVals, backgroundColor: allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor: '#1C2726', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { 
          legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, font: { size: 10.5 } } },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.raw;
                const pct = allocTotal > 0 ? ((val / allocTotal) * 100).toFixed(1) : 0;
                return ` ${context.label}: ${fmt$(val)} (${pct}%)`;
              }
            }
          }
        } }
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