/* =========================================================================
   BROKER IMPORT & SYNC  (Zerodha, Angel One, any CSV/Excel trade file)

   1) FILE IMPORT  -- the only way to get your full buy/sell HISTORY.
      Zerodha's and Angel One's APIs only expose today's trades, so history
      comes from the tradebook file you download from the broker (Zerodha:
      Console > Reports > Tradebook, CSV or XLSX, up to 365 days per file).
      Every trade is filed in the YEAR of its date, into the platform you
      pick, with duplicate protection (re-importing a file, or overlapping
      files, never double-counts).
   2) API SNAPSHOT SYNC -- the Supabase function `broker-sync` stores your
      broker's CURRENT holdings; this file compares them with the app and
      lets you apply the differences after a preview. Nothing changes until
      you click Apply.

   Nothing here talks to a broker directly and no credentials ever touch the
   browser.
   ========================================================================= */
(function(root){
'use strict';

const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r6 = v => Math.round(v * 1e6) / 1e6;
const r4 = v => Math.round(v * 1e4) / 1e4;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* The app declares DATA, state and XLSX_SOURCES with top-level let/const in
   core-data.js. Those are shared between scripts as bare names but are NOT
   properties of `window`, so `window.DATA` is undefined in a real browser.
   These accessors read the bare names (falling back to window for tests). */
const getData       = () => (typeof DATA !== 'undefined' ? DATA : root.DATA);
const getState      = () => (typeof state !== 'undefined' ? state : root.state);
const getXlsxSource = () => (typeof XLSX_SOURCES !== 'undefined' ? XLSX_SOURCES : root.XLSX_SOURCES);

/* ------------------------------------------------------------------ CSV */
function parseCsv(text){
  text = String(text == null ? '' : text);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sample = text.split(/\r?\n/).slice(0, 30);
  const score = ch => sample.reduce((a, l) => a + (l.split(ch).length - 1), 0);
  let delim = ',';
  if (score('\t') > score(',') && score('\t') >= score(';')) delim = '\t';
  else if (score(';') > score(',')) delim = ';';
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); rows.push(row);
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/* ------------------------------------------------------------- headers */
const hnorm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ALIASES = {
  symbol:   ['symbol','tradingsymbol','trading symbol','scrip symbol','scrip name','scrip','instrument','stock name','stock','security name','security','name of the security','company'],
  date:     ['trade date','tradedate','date','execution date','executed date','activity date','transaction date','filltime','fill time','order execution time','executed at'],
  type:     ['trade type','type','side','buy/sell','buy sell','b/s','transaction type','transactiontype','trans code','action','order type'],
  qty:      ['quantity','qty','shares','no of shares','traded qty','traded quantity','fillsize','fill size'],
  price:    ['price','trade price','traded price','tradeprice','rate','avg price','average price','fillprice','fill price','net rate'],
  amount:   ['amount','trade value','tradevalue','value','net amount','net total'],
  ref:      ['trade id','tradeid','trade no','trade number','fillid','fill id','exchange trade id'],
  orderRef: ['order id','orderid','order no','order number'],
  exchange: ['exchange','exch'],
  segment:  ['segment'],
  isin:     ['isin']
};
const ALIAS_INDEX = {};
Object.keys(ALIASES).forEach(f => { ALIAS_INDEX[f] = ALIASES[f].map(hnorm); });

function findHeader(rows){
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(hnorm);
    const cols = {};
    Object.keys(ALIAS_INDEX).forEach(f => {
      for (const a of ALIAS_INDEX[f]) { const at = cells.indexOf(a); if (at >= 0) { cols[f] = at; break; } }
    });
    if (cols.symbol !== undefined && cols.qty !== undefined && cols.date !== undefined && cols.type !== undefined &&
        (cols.price !== undefined || cols.amount !== undefined)) return { idx: i, cols };
  }
  return null;
}

/* --------------------------------------------------------------- values */
function parseNum(v){
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  let s = String(v).trim(); if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.\-eE]/g, '');
  if (!s || s === '-' || s === '.') return NaN;
  const n = parseFloat(s);
  return isNaN(n) ? NaN : (neg ? -n : n);
}
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
function validYmd(y, m, d){
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/* returns {date:'YYYY-MM-DD', time:'HH:MM:SS'|null} or null */
function parseDate(v, order){
  order = order || 'dmy';
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const d = new Date(v.getTime() + 12 * 3600 * 1000);            // survives SheetJS time-zone drift
    return { date: validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), time: null };
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000) + 12 * 3600 * 1000); return { date: validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), time: null }; }
    return null;
  }
  const s = String(v).trim();
  const tm = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const time = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}` : null;
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { const d = validYmd(+m[1], +m[2], +m[3]); return d ? { date: d, time } : null; }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
    let day, mon;
    if (a > 12) { day = a; mon = b; } else if (b > 12) { day = b; mon = a; }
    else if (order === 'mdy') { mon = a; day = b; } else { day = a; mon = b; }
    const d = validYmd(y, mon, day); return d ? { date: d, time } : null;
  }
  if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{2,4})/))) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()]; let y = +m[3]; if (y < 100) y += 2000;
    const d = mon ? validYmd(y, mon, +m[1]) : null; return d ? { date: d, time } : null;
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/))) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = mon ? validYmd(+m[3], mon, +m[2]) : null; return d ? { date: d, time } : null;
  }
  return null;
}
function parseType(v){
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (/^(b|buy|bought|purchase|buy to open|buy to close|bo)$/.test(s) || /^buy\b/.test(s)) return 'buy';
  if (/^(s|sell|sold|sale|sell to close|sell to open|so)$/.test(s) || /^sell\b/.test(s)) return 'sell';
  return null;
}
function cleanSymbol(raw, exchange, market){
  let s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/^(NSE|BSE|NFO|BFO)\s*[:\-]\s*/, '');
  s = s.replace(/-(EQ|BE|BL|BZ|SM|ST|N1|N2|IL|GC|RR|IV)$/, '');       // Angel One / NSE series suffixes
  s = s.replace(/\s+/g, '');
  const ex = String(exchange || '').trim().toUpperCase();
  if (market === 'IN' && ex.startsWith('BSE') && !/\.(BO|NS)$/.test(s)) s += '.BO';
  if (market === 'US') s = s.replace(/^([A-Z]{1,5})[.\/]([A-Z])$/, '$1-$2');       // BRK.B -> BRK-B (Yahoo style) so prices load
  return s;
}

/* Friendly reasons for the transaction codes that show up in broker activity reports (Robinhood etc.) */
const CODE_REASONS = {
  cdiv: 'dividend (use the dividend import)', mdiv: 'dividend (use the dividend import)', div: 'dividend (use the dividend import)',
  slip: 'stock-lending income', int: 'interest', gold: 'Robinhood Gold fee', gdbp: 'Robinhood Gold fee', dtax: 'foreign dividend tax',
  ach: 'bank transfer', achdep: 'bank transfer', acho: 'bank transfer', achi: 'bank transfer', xenl: 'transfer', rtp: 'bank transfer',
  spl: 'stock split — not imported (adjust that holding by hand)', sxch: 'stock exchange / merger — not imported', mrgs: 'merger — not imported',
  bto: 'options trade (options are not supported)', stc: 'options trade (options are not supported)', sto: 'options trade (options are not supported)',
  btc: 'options trade (options are not supported)', oexp: 'options expiry (options are not supported)', oasgn: 'options assignment (options are not supported)', oexch: 'options exercise (options are not supported)'
};
const codeReason = v => CODE_REASONS[String(v == null ? '' : v).trim().toLowerCase()] || 'not a buy/sell row';
const canon = s => String(s || '').toUpperCase().replace(/\.NS$/, '');

/* ------------------------------------------------ rows -> normalised trades */
function normalizeTrades(rows, opts){
  opts = opts || {};
  const market = opts.market || 'auto';
  const out = { trades: [], skipped: [], meta: { headerRow: null, columns: null, rows: 0 } };
  const h = findHeader(rows);
  if (!h) { out.error = 'Could not find a header row. Expected columns like Symbol, Date, Buy/Sell, Quantity and Price (Zerodha Console tradebook, Angel One trade history, or a similar CSV/XLSX).'; return out; }
  out.meta.headerRow = h.idx; out.meta.columns = h.cols;
  /* "Auto" date order: US-style (month first) for US platforms and for files with a Robinhood-style "Trans Code" column */
  const looksUs = hnorm(rows[h.idx][h.cols.type]) === 'trans code';
  let order = opts.dateOrder; if (!order || order === 'auto') order = (looksUs || market === 'US') ? 'mdy' : 'dmy';
  const c = h.cols, get = (r, f) => c[f] === undefined ? undefined : r[c[f]];
  for (let i = h.idx + 1; i < rows.length; i++) {
    const r = rows[i]; out.meta.rows++;
    const line = i + 1;
    if (!r || !r.some(x => x != null && String(x).trim() !== '')) continue;
    const seg = String(get(r, 'segment') == null ? '' : get(r, 'segment')).trim().toUpperCase();
    if (seg && !/^(EQ|EQUITY|CASH|CM|E)$/.test(seg)) { out.skipped.push({ line, reason: `segment ${seg} not supported (only equity)` }); continue; }
    const type = parseType(get(r, 'type'));
    if (!type) { out.skipped.push({ line, reason: codeReason(get(r, 'type')) }); continue; }
    const ex = get(r, 'exchange');
    const symbol = cleanSymbol(get(r, 'symbol'), ex, market);
    if (!symbol) { out.skipped.push({ line, reason: 'no symbol' }); continue; }
    const qty = Math.abs(parseNum(get(r, 'qty')));
    if (!(qty > 0)) { out.skipped.push({ line, reason: 'no quantity' }); continue; }
    let price = parseNum(get(r, 'price'));
    if (!(price > 0)) { const amt = Math.abs(parseNum(get(r, 'amount'))); if (amt > 0) price = amt / qty; }
    if (!(price > 0)) { out.skipped.push({ line, reason: 'no price' }); continue; }
    const pd = parseDate(get(r, 'date'), order);
    if (!pd || !pd.date) { out.skipped.push({ line, reason: 'unreadable date' }); continue; }
    const ref = String(get(r, 'ref') == null ? '' : get(r, 'ref')).trim() || null;
    const orderRef = String(get(r, 'orderRef') == null ? '' : get(r, 'orderRef')).trim() || null;
    out.trades.push({ symbol, date: pd.date, time: pd.time, type, qty: r6(qty), price: r6(price), ref, orderRef, exchange: ex ? String(ex).trim().toUpperCase() : null, line });
  }
  out.trades.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1
    : (a.time && b.time && a.time !== b.time) ? (a.time < b.time ? -1 : 1)
    : a.type !== b.type ? (a.type === 'buy' ? -1 : 1) : a.line - b.line);
  return out;
}
function parseTradeFile(text, opts){ return normalizeTrades(parseCsv(text), opts); }

/* --------------------------------------------------------------- planning */
const yearsOf = D => Object.keys(D || {}).filter(k => /^\d{4}$/.test(k)).map(Number).sort((a, b) => a - b);
const fp = l => `${l.date}|${l.type}|${r6(num(l.qty))}|${r4(num(l.price))}`;
function findPlatform(D, y, sel){
  const list = (D[y] && D[y].investments) || [];
  if (sel.platformSid) { const p = list.find(x => x.sid === sel.platformSid); if (p) return p; }
  if (sel.platformId) { const p = list.find(x => x.id === sel.platformId); if (p) return p; }
  if (sel.platformName) return list.find(x => String(x.name || '').trim().toLowerCase() === String(sel.platformName).trim().toLowerCase()) || null;
  return null;
}
function platformMatches(p, ref){
  if (ref.sid) return p.sid === ref.sid;
  return String(p.name || '').trim().toLowerCase() === String(ref.name || '').trim().toLowerCase();
}
/* "Estimated" lots written by the live-holdings sync (no real date/price known).
   Importing the real trades for that symbol supersedes them. */
function placeholderLots(D, platform, symbol){
  const out = []; const ref = { sid: platform.sid, name: platform.name }; const c = canon(symbol); const al = aliasTarget(D, platform, c);
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => {
    if (!platformMatches(p, ref)) return;
    (p.holdings || []).forEach(h => { if (!h || (canon(h.symbol) !== c && canon(h.symbol) !== al)) return;
      (h.lots || []).forEach(l => { if (l && l.src === 'sync-est') out.push({ year: y, platform: p, h, lot: l }); }); });
  }));
  return out;
}
/* ---- merging into what you already have: your symbols and names are never rewritten ----
   A broker symbol is matched to an existing holding by (1) the same symbol, (2) a remembered link you chose before
   (D.brokerSymbolMap), and only otherwise treated as NEW. */
const platformKey = p => String((p && (p.sid || p.name)) || '').trim().toLowerCase();
function aliasTarget(D, platform, canonSym){
  const m = D && D.brokerSymbolMap && D.brokerSymbolMap[platformKey(platform)];
  return (m && m[canonSym]) || null;
}
function rememberAlias(D, platform, brokerCanon, appCanon){
  if (!D || !brokerCanon || !appCanon || brokerCanon === appCanon) return false;
  D.brokerSymbolMap = (D.brokerSymbolMap && typeof D.brokerSymbolMap === 'object') ? D.brokerSymbolMap : {};
  const k = platformKey(platform); D.brokerSymbolMap[k] = D.brokerSymbolMap[k] || {};
  if (D.brokerSymbolMap[k][brokerCanon] === appCanon) return false;
  D.brokerSymbolMap[k][brokerCanon] = appCanon; return true;
}
function findHolding(platform, symbol, D){
  const c = canon(symbol);
  let h = (platform.holdings || []).find(x => x && canon(x.symbol) === c);
  if (!h && D) { const a = aliasTarget(D, platform, c); if (a) h = (platform.holdings || []).find(x => x && canon(x.symbol) === a); }
  return h || null;
}
/* ov = choices made on screen but not saved yet: { mapping: { BROKERSYM: { target: 'new' | EXISTINGSYM } } } */
function resolveHolding(platform, symbol, D, ov){
  const c = canon(symbol), m = ov && ov.mapping && ov.mapping[c];
  if (m && m.target === 'new') return null;
  if (m && m.target) { const h = (platform.holdings || []).find(x => x && canon(x.symbol) === canon(m.target)); if (h) return h; }
  return findHolding(platform, symbol, D);
}
const titleCase = s => { const t = String(s || '').replace(/\.(NS|BO)$/i, '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
/* the three naming styles offered for a NEW holding (the name is free text; the symbol stays the ticker that prices are fetched with) */
function nameFor(typed, style, symbol, brokerName){
  const t = String(typed == null ? '' : typed).trim(); if (t) return t;
  if (style === 'title') return titleCase(symbol);
  if (style === 'company' && brokerName) return String(brokerName).trim();
  return symbol;
}
/* existing holdings that look like the same company under a different name/symbol, best first */
function suggestHoldings(platform, brokerSymbol, brokerName){
  const sq = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const bs = sq(canon(brokerSymbol)), bn = sq(brokerName); const out = [];
  (platform.holdings || []).forEach(h => {
    if (!h) return; const hs = sq(canon(h.symbol)), hn = sq(h.name); let score = 0;
    if (hs && hs === bs) score = 100;
    else if (hn && hn === bs) score = 90;
    else if (bn && (hn === bn || hs === bn)) score = 85;
    else if (hs && bs && Math.min(hs.length, bs.length) >= 3 && (hs.startsWith(bs) || bs.startsWith(hs))) score = 70;
    else if (hn && bs.length >= 3 && (hn.startsWith(bs) || hn.includes(bs))) score = 60;
    else if (bn && hn && Math.min(hn.length, bn.length) >= 4 && (hn.includes(bn) || bn.includes(hn))) score = 55;
    if (score) out.push({ symbol: canon(h.symbol), name: h.name || h.symbol, score });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
const validDate = (d, today) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); if (!m) return false; const y = +m[1], mo = +m[2], da = +m[3]; if (y < 1990 || mo < 1 || mo > 12 || da < 1 || da > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false; return !today || String(d) <= today; };
const APPROX_MAX_GAP_DAYS = 7;
function simulateOversell(existingLots, newLots){
  const all = existingLots.map(l => ({ d: l.date || (l.type === 'sell' ? '9999-12-31' : '0000'), t: l.type, q: num(l.qty) }))
    .concat(newLots.map(l => ({ d: l.date, t: l.type, q: num(l.qty) })));
  all.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (a.t === b.t ? 0 : a.t === 'buy' ? -1 : 1));
  let q = 0, over = 0;
  all.forEach(l => { if (l.t === 'sell') { if (l.q > q) { over += l.q - q; q = 0; } else q -= l.q; } else q += l.q; });
  return r6(over);
}

/* plan = what WOULD happen. Nothing is modified. */
function planImport(D, trades, sel, ov){
  const plan = { items: [], skipped: [], totals: { buys: 0, sells: 0, dups: 0, lots: 0 }, missingYears: [], missingPlatform: [], symbolInfo: {} };
  const byKey = new Map();
  const missY = new Set(), missP = new Set();
  const seenRefs = new Map();                       // "year|platform|symbol" -> Set(refs) seen within this import
  trades.forEach(t => {
    const y = Number(t.date.slice(0, 4));
    if (!D[y]) { missY.add(y); plan.skipped.push({ line: t.line, reason: `year ${y} is not in your ledger yet` }); return; }
    const platform = findPlatform(D, y, sel);
    if (!platform) { missP.add(y); plan.skipped.push({ line: t.line, reason: `platform ${sel.platformName || ''} does not exist in ${y} (add it there, or import only the years it exists in)` }); return; }
    const key = `${y}|${platform.id}|${canon(t.symbol)}`;
    let it = byKey.get(key);
    if (!it) {
      const h = resolveHolding(platform, t.symbol, D, ov);
      const cs = canon(t.symbol), prevInfo = plan.symbolInfo[cs];
      if (!prevInfo || y >= prevInfo.year) plan.symbolInfo[cs] = {            // what each broker symbol will merge into (latest year wins: that is where your naming lives)
        year: y, exists: !!h, matchedBy: !h ? null : (canon(h.symbol) === cs ? 'symbol' : (ov && ov.mapping && ov.mapping[cs] && ov.mapping[cs].target ? 'you' : 'link')),
        appSymbol: h ? h.symbol : null, appName: h ? (h.name || h.symbol) : null, suggestions: h ? [] : suggestHoldings(platform, t.symbol, null) };
      const exLots = h && Array.isArray(h.lots) ? h.lots : [];
      const refs = new Set(exLots.map(l => l.ref).filter(Boolean));
      const counts = new Map(); exLots.forEach(l => { const k = fp(l); counts.set(k, (counts.get(k) || 0) + 1); });
      it = { key, year: y, platformId: platform.id, platformName: platform.name, symbol: canon(t.symbol), holdingId: h ? h.id : null,
             placeholders: placeholderLots(D, platform, t.symbol).length,
             existingQty: h ? num(h.qty) : 0, exists: !!h, newLots: [], dups: 0, oversell: 0, _refs: refs, _counts: counts, _exLots: exLots };
      byKey.set(key, it); plan.items.push(it);
    }
    const dupByRef = t.ref && it._refs.has(t.ref);
    const k = fp(t);
    const n = it._counts.get(k) || 0;
    if (dupByRef || n > 0) {
      if (!dupByRef && n > 0) it._counts.set(k, n - 1);
      it.dups++; plan.totals.dups++; return;
    }
    if (t.ref) it._refs.add(t.ref);
    it.newLots.push({ type: t.type, qty: t.qty, price: t.price, date: t.date, ref: t.ref || null });
  });
  plan.items.forEach(it => {
    it.oversell = simulateOversell(it._exLots, it.newLots);
    it.buyQty = r6(it.newLots.filter(l => l.type === 'buy').reduce((a, l) => a + l.qty, 0));
    it.sellQty = r6(it.newLots.filter(l => l.type === 'sell').reduce((a, l) => a + l.qty, 0));
    plan.totals.buys += it.newLots.filter(l => l.type === 'buy').length;
    plan.totals.sells += it.newLots.filter(l => l.type === 'sell').length;
    plan.totals.lots += it.newLots.length;
    delete it._refs; delete it._counts; delete it._exLots;
  });
  plan.items = plan.items.filter(it => it.newLots.length || it.dups);
  plan.items.sort((a, b) => a.year - b.year || (a.symbol < b.symbol ? -1 : 1));
  plan.missingYears = Array.from(missY).sort(); plan.missingPlatform = Array.from(missP).sort();
  return plan;
}

function envOf(env){
  env = env || {};
  return {
    uid: env.uid || root.uid || (() => 'bi' + Math.random().toString(36).slice(2, 10)),
    recalcHolding: env.recalcHolding || root.recalcHolding || (() => {}),
    reconcile: env.reconcile || (root.YearSync && (d => root.YearSync.reconcile(d))) || (() => {}),
    batchId: env.batchId || (() => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    now: env.now || (() => new Date().toISOString()),
    today: env.today || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })
  };
}
/* years are applied oldest -> newest and the year-sync runs in between, so a
   holding created in an early year is already carried into later years
   before that year's own trades are added */
function applyImport(D, plan, selectedKeys, env, opts){
  opts = opts || {}; const E = envOf(env);
  const chosen = plan.items.filter(it => !selectedKeys || selectedKeys.has(it.key));
  const res = { lots: 0, holdingsCreated: 0, symbols: 0, years: [], merged: 0, aliases: 0 };
  const batch = E.batchId(), created = [], names = new Set();
  const years = Array.from(new Set(chosen.map(it => it.year))).sort((a, b) => a - b);
  years.forEach(y => {
    chosen.filter(it => it.year === y).forEach(it => {
      if (!it.newLots.length) return;
      const platform = (D[y].investments || []).find(p => p.id === it.platformId); if (!platform) return;
      platform.holdings = platform.holdings || [];
      /* merge into what you already have (same symbol, or a link you chose); only a genuinely new symbol creates a holding */
      const m = (opts.mapping || {})[it.symbol] || {};
      let h = resolveHolding(platform, it.symbol, D, { mapping: { [it.symbol]: { target: m.target } } });
      if (h) res.merged++;
      else {
        const linked = m.target && m.target !== 'new';
        const sym = linked ? canon(m.target) : canon(cleanSymbol(m.symbol || it.symbol, null, /INR/i.test(platform.currency || '') ? 'IN' : 'US'));
        const existing = findHolding(platform, sym, D);
        if (existing) h = existing;
        else {
          const first = it.newLots[0], last = it.newLots[it.newLots.length - 1];
          h = { id: E.uid(), symbol: sym, name: linked ? (m.targetName || sym) : nameFor(m.name, opts.naming, sym, null), type: 'stock', currentPrice: last.price, ytdStartPrice: first.price,
                lots: [], dividends: [], currency: platform.currency || 'USD' };
          platform.holdings.push(h); res.holdingsCreated++; created.push(h.id);
        }
      }
      if (canon(h.symbol) !== canon(it.symbol) && rememberAlias(D, platform, canon(it.symbol), canon(h.symbol))) res.aliases++;
      h.lots = h.lots || []; names.add(platform.name);
      it.newLots.forEach(l => { h.lots.push({ id: E.uid(), type: l.type, qty: l.qty, price: l.price, date: l.date, ref: l.ref || undefined, src: 'import', batch }); res.lots++; });
      E.recalcHolding(h); res.symbols++;
    });
    E.reconcile(D); res.years.push(y);
  });
  /* the real trades now explain these positions, so the estimated placeholders from the live sync go */
  const removed = [], seenPh = new Set(), recalc = new Set();
  chosen.forEach(it => {
    if (!it.newLots.length) return;
    const platform = ((D[it.year] && D[it.year].investments) || []).find(p => p.id === it.platformId); if (!platform) return;
    const key = (platform.sid || platform.name) + '|' + it.symbol; if (seenPh.has(key)) return; seenPh.add(key);
    placeholderLots(D, platform, it.symbol).forEach(x => {
      const i = x.h.lots.indexOf(x.lot); if (i < 0) return;
      x.h.lots.splice(i, 1); recalc.add(x); removed.push({ year: x.year, platformId: x.platform.id, symbol: canon(x.h.symbol), lot: x.lot });
    });
  });
  recalc.forEach(x => {
    E.recalcHolding(x.h);
    if (!(x.h.lots || []).length && !(x.h.dividends || []).length) x.platform.holdings = (x.platform.holdings || []).filter(z => z !== x.h);
  });
  if (removed.length) E.reconcile(D);
  res.replaced = removed.length;
  res.batch = batch;
  if (res.lots) logBatch(D, { id: batch, at: E.now(), kind: 'trades', platform: Array.from(names).join(', '), lots: res.lots, symbols: res.symbols, created, removed });
  return res;
}

/* --------------------------------------------- API snapshot -> proposals */
/* snapshot = { holdings:[{symbol,qty,avgPrice,lastPrice}], trades:[{ref,symbol,type,qty,price,product}] } */
function planHoldingsSync(D, year, sel, snapshot, ov){
  const plan = { year, items: [], note: null, meta: {} };
  const platform = D[year] ? findPlatform(D, year, sel) : null;
  if (!platform) { plan.note = `Platform not found in ${year}.`; return plan; }
  const E = envOf();
  const today = E.today();
  const mkt = sel.market || 'IN';
  /* when was this platform last reviewed? new quantity within a week of that is dated by the snapshot day (approximate);
     anything older, and a first-ever load, stays unknown until YOU give the date */
  const log = D.brokerSyncLog && D.brokerSyncLog[platformKey(platform)];
  const snapDate = snapshot.fetchedAt ? String(snapshot.fetchedAt).slice(0, 10) : '';
  let gapDays = null;
  if (log && log.snapshotAt && snapshot.fetchedAt) gapDays = (Date.parse(snapshot.fetchedAt) - Date.parse(log.snapshotAt)) / 864e5;
  const canApprox = !!snapDate && validDate(snapDate, today) && gapDays !== null && gapDays >= 0 && gapDays <= APPROX_MAX_GAP_DAYS;
  plan.meta = { snapshotAt: snapshot.fetchedAt || null, snapDate, canApprox, gapDays, lastSync: log || null, platformKey: platformKey(platform) };
  const brokerMap = new Map();
  (snapshot.holdings || []).forEach(b => { if (b && b.symbol) brokerMap.set(canon(cleanSymbol(b.symbol, b.exchange, mkt)), b); });
  const tradesBySym = new Map();
  (snapshot.trades || []).forEach(t => {
    if (t.product && String(t.product).toUpperCase() !== 'CNC' && String(t.product).toUpperCase() !== 'DELIVERY') return;   // intraday / F&O never count as holdings
    const s2 = canon(cleanSymbol(t.symbol, t.exchange, mkt)); if (!s2) return;
    (tradesBySym.get(s2) || tradesBySym.set(s2, []).get(s2)).push(t);
  });
  /* match every broker symbol to an existing holding FIRST, so a holding you named differently is never mistaken for "only in the app" */
  const matched = new Map();
  brokerMap.forEach((b, sym) => matched.set(sym, resolveHolding(platform, sym, D, ov)));
  const usedIds = new Set(Array.from(matched.values()).filter(Boolean).map(h => h.id));
  const appOnly = (platform.holdings || []).filter(h => h && num(h.qty) > 0 && !usedIds.has(h.id)).map(h => canon(h.symbol));
  const symbols = new Set([...brokerMap.keys(), ...appOnly]);
  symbols.forEach(sym => {
    const b = brokerMap.get(sym), h = brokerMap.has(sym) ? matched.get(sym) : findHolding(platform, sym, D);
    const appQty = h ? num(h.qty) : 0, appAvg = h ? num(h.avgPrice) : 0;
    const refs = new Set(((h && h.lots) || []).map(l => l.ref).filter(Boolean));
    const lots = []; let simQty = appQty, simCost = appQty * appAvg;
    (tradesBySym.get(sym) || []).forEach(t => {
      if (!t.ref || refs.has(t.ref)) return;
      const q = Math.abs(num(t.qty)), pr = num(t.price); if (!(q > 0) || !(pr > 0)) return;
      const type = parseType(t.type); if (!type) return;
      lots.push({ type, qty: r6(q), price: r6(pr), date: String(t.time || today).slice(0, 10), ref: t.ref, estimated: false });
      if (type === 'buy') { simQty += q; simCost += q * pr; } else { const avg = simQty > 0 ? simCost / simQty : 0; const s2 = Math.min(q, simQty); simCost -= s2 * avg; simQty -= s2; }
    });
    const bQty = b ? num(b.qty) : 0;
    const diff = r6(bQty - simQty);
    const last = b ? num(b.lastPrice) : num(h && h.currentPrice);
    const est = { ref: null, estimated: true, date: '', dateUnknown: true, prefillDate: (canApprox && b) ? snapDate : '' };      // a holding the broker no longer lists was sold at an unknown time: never guessed
    if (Math.abs(diff) > 1e-6) {
      if (diff > 0) {
        const implied = (bQty * num(b && b.avgPrice) - simCost) / diff;
        lots.push({ type: 'buy', qty: diff, price: r6(implied > 0 ? implied : (num(b && b.avgPrice) || last)), ...est });
      } else {
        lots.push({ type: 'sell', qty: -diff, price: r6(last > 0 ? last : simCost / Math.max(simQty, 1e-9)), ...est });
      }
    }
    if (!lots.length) return;
    const direct = h && canon(h.symbol) === sym;
    plan.items.push({ key: `${year}|${sym}`, symbol: sym, exists: !!h, holdingId: h ? h.id : null,
                      matchedBy: !h ? null : (direct ? 'symbol' : (ov && ov.mapping && ov.mapping[sym] && ov.mapping[sym].target ? 'you' : 'link')),
                      appSymbol: h ? h.symbol : null, appName: h ? (h.name || h.symbol) : null, appAvg, brokerAvg: b ? num(b.avgPrice) : 0,
                      brokerName: (b && b.name) || null, suggestions: h ? [] : suggestHoldings(platform, sym, b && b.name),
                      appQty, brokerQty: bQty, onlyInApp: !b, lots, estimated: lots.some(l => l.estimated), lastPrice: last });
  });
  plan.items.sort((x, y) => x.symbol < y.symbol ? -1 : 1);
  return plan;
}
/* Apply the chosen rows. Existing holdings only get quantity/average (via lots): their symbol, name, type and price are
   NEVER touched. A new holding is created only when nothing matches (or you say so), named as you chose.
   opts = { mapping:{ KEY:{target,name,symbol} }, dates:{ "KEY|lotIndex":"YYYY-MM-DD" }, globalDate, naming, snapshotAt } */
function applyHoldingsSync(D, year, sel, plan, selectedKeys, env, opts){
  opts = opts || {}; const E = envOf(env); const today = E.today();
  const platform = findPlatform(D, year, sel); if (!platform) return { lots: 0, holdingsCreated: 0, symbols: 0, merged: 0, aliases: 0 };
  platform.holdings = platform.holdings || [];
  const res = { lots: 0, holdingsCreated: 0, symbols: 0, merged: 0, aliases: 0 }; const batch = E.batchId(), created = [];
  const map = opts.mapping || {}, dates = opts.dates || {}; const mkt = sel.market || (/INR/i.test(platform.currency || '') ? 'IN' : 'US');
  const chosen = plan.items.filter(it => !selectedKeys || selectedKeys.has(it.key));
  chosen.forEach(it => {
    const m = map[it.symbol] || map[it.key] || {};
    const ov = { mapping: { [it.symbol]: { target: m.target } } };
    let h = resolveHolding(platform, it.symbol, D, ov);
    if (!h) {
      const sym = canon(cleanSymbol(m.symbol || it.symbol, null, mkt));
      const existing = findHolding(platform, sym, D);
      if (existing) h = existing;
      else {
        const first = it.lots[0];
        h = { id: E.uid(), symbol: sym, name: nameFor(m.name, opts.naming, sym, it.brokerName), type: 'stock', currentPrice: it.lastPrice || first.price,
              ytdStartPrice: first.price, lots: [], dividends: [], currency: platform.currency || 'USD' };
        platform.holdings.push(h); res.holdingsCreated++; created.push(h.id);
      }
    } else res.merged++;
    if (canon(h.symbol) !== canon(it.symbol) && rememberAlias(D, platform, canon(it.symbol), canon(h.symbol))) res.aliases++;      // next time this broker symbol goes to the same holding
    h.lots = h.lots || [];
    it.lots.forEach((l, i) => {
      let date = l.date || '', how = null;
      if (!date) {                                               // the lot's own date first, then the "one date for everything"; an invalid entry never wins
        const typed = [dates[`${it.key}|${i}`], opts.globalDate].map(v => String(v || '').trim()).find(v => v && validDate(v, today));
        if (typed) { date = typed; how = (l.prefillDate && typed === l.prefillDate) ? 'approx' : 'user'; }
      }
      h.lots.push({ id: E.uid(), type: l.type, qty: l.qty, price: l.price, date, ref: l.ref || undefined, src: l.estimated ? 'sync-est' : 'sync', batch,
                    ...(date ? (how === 'approx' ? { dateApprox: true } : how === 'user' ? { dateSource: 'user' } : {}) : { dateUnknown: true }) });
      res.lots++;
    });
    E.recalcHolding(h); res.symbols++;
  });
  /* only a COMPLETE review counts as "up to date" for dating later changes: every line the broker lists was applied (lines for holdings the broker doesn't list are optional) */
  if (opts.snapshotAt && plan.items.filter(it => !it.onlyInApp).every(it => chosen.indexOf(it) >= 0)) {
    D.brokerSyncLog = (D.brokerSyncLog && typeof D.brokerSyncLog === 'object') ? D.brokerSyncLog : {};
    D.brokerSyncLog[platformKey(platform)] = { snapshotAt: opts.snapshotAt, appliedAt: E.now() };
  }
  E.reconcile(D);
  res.batch = batch;
  if (res.lots) logBatch(D, { id: batch, at: E.now(), kind: 'sync', platform: platform.name, lots: res.lots, symbols: res.symbols, created });
  return res;
}

/* =========================================================================
   CURRENT-HOLDINGS FILE  (Zerodha Console > Portfolio > Holdings > Download, Angel One holdings statement, any
   table with Symbol + Quantity + Average price). These files carry NO dates, so the review asks you for them.
   ========================================================================= */
const HF_ALIASES = {
  symbol:  ['symbol','tradingsymbol','trading symbol','instrument','scrip name','scrip','stock name','stock','security name','security','company'],
  qty:     ['quantity available','quantity','qty','net qty','total quantity','holding quantity','available quantity','free quantity'],
  avg:     ['average price','avg price','avg cost','average cost','buy avg','average buy price','buy average','avg buy price'],
  last:    ['previous closing price','ltp','last price','close price','closing price','cmp','current price','market price'],
  isin:    ['isin']
};
const HF_INDEX = {}; Object.keys(HF_ALIASES).forEach(f => { HF_INDEX[f] = HF_ALIASES[f].map(hnorm); });
function findHoldingsHeader(rows){
  for (let i = 0, n = Math.min(rows.length, 40); i < n; i++) {
    const cells = rows[i].map(hnorm); const cols = {};
    Object.keys(HF_INDEX).forEach(f => { for (const a of HF_INDEX[f]) { const at = cells.indexOf(a); if (at >= 0) { cols[f] = at; break; } } });
    const pledged = []; cells.forEach((c, ix) => { if (/^quantity pledged/.test(c)) pledged.push(ix); });
    if (cols.symbol !== undefined && cols.qty !== undefined && cols.avg !== undefined) return { idx: i, cols, pledged };
  }
  return null;
}
function normalizeHoldingsFile(rows, opts){
  opts = opts || {};
  const out = { snapshot: { holdings: [], fetchedAt: null, source: 'file' }, skipped: [], meta: { rows: 0, pledgedRows: 0 } };
  const h = findHoldingsHeader(rows);
  if (!h) { out.error = 'Could not find a holdings table. Expected columns like Symbol (or Instrument), Quantity and Average price — for example Zerodha Console > Portfolio > Holdings > Download.'; return out; }
  const c = h.cols, get = (r, f) => c[f] === undefined ? undefined : r[c[f]];
  const seen = new Map();
  for (let i = h.idx + 1; i < rows.length; i++) {
    const r = rows[i]; out.meta.rows++; const line = i + 1;
    if (!r || !r.some(x => x != null && String(x).trim() !== '')) continue;
    const symbol = cleanSymbol(get(r, 'symbol'), null, opts.market || 'auto');
    if (!symbol || /^total/i.test(symbol)) { out.skipped.push({ line, reason: symbol ? 'total row' : 'no symbol' }); continue; }
    const qty = parseNum(get(r, 'qty')), avg = parseNum(get(r, 'avg'));
    if (!(qty > 0)) { out.skipped.push({ line, reason: 'no quantity held' }); continue; }
    if (!(avg > 0)) { out.skipped.push({ line, reason: 'no average price' }); continue; }
    if (h.pledged.some(ix => parseNum(r[ix]) > 0)) out.meta.pledgedRows++;
    const hold = { symbol, qty: r6(qty), avgPrice: avg, lastPrice: c.last !== undefined && parseNum(get(r, 'last')) > 0 ? parseNum(get(r, 'last')) : 0, isin: get(r, 'isin') ? String(get(r, 'isin')).trim() : undefined };
    const prev = seen.get(canon(symbol));
    if (prev) { const q = prev.qty + hold.qty; prev.avgPrice = (prev.qty * prev.avgPrice + hold.qty * hold.avgPrice) / q; prev.qty = r6(q); out.skipped.push({ line, reason: 'same symbol listed twice — quantities added together' }); }
    else { seen.set(canon(symbol), hold); out.snapshot.holdings.push(hold); }
  }
  return out;
}

/* Live history from the broker snapshot (Robinhood via SnapTrade): real dated activities */
function activitiesToTrades(snap){
  const out = [];
  (snap && snap.activities || []).forEach((a, i) => {
    if (!a || (a.type !== 'buy' && a.type !== 'sell')) return;
    const sym = cleanSymbol(a.symbol, null, 'US'), qty = Math.abs(num(a.qty)), price = num(a.price);
    if (!sym || !(qty > 0) || !(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) return;
    out.push({ symbol: sym, date: a.date, time: a.time || null, type: a.type, qty: r6(qty), price: r6(price), ref: a.id ? String(a.id) : null, orderRef: null, exchange: null, line: i + 1 });
  });
  out.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (x.type !== y.type ? (x.type === 'buy' ? -1 : 1) : x.line - y.line));
  return out;
}
function activitiesToDividends(snap){
  const out = [];
  (snap && snap.activities || []).forEach((a, i) => {
    if (!a || a.type !== 'dividend') return;
    const sym = cleanSymbol(a.symbol, null, 'US'), amt = num(a.amount);
    if (!sym || !(amt > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) return;
    out.push({ symbol: sym, date: a.date, amount: Math.round(amt * 100) / 100, qty: num(a.qty) > 0 ? r6(num(a.qty)) : null, perShare: num(a.price) > 0 ? r6(num(a.price)) : null, line: i + 1 });
  });
  out.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : x.line - y.line));
  return out;
}

/* =========================================================================
   UNDO / CLEAN-UP
   Every line this tool adds is tagged (src + batch id), and each Apply is
   logged, so a wrong-platform import can be taken back WITHOUT touching
   anything you typed yourself.
   ========================================================================= */
function logBatch(D, rec){
  D.importBatches = Array.isArray(D.importBatches) ? D.importBatches : [];
  D.importBatches.push(rec);
  if (D.importBatches.length > 30) D.importBatches.splice(0, D.importBatches.length - 30);
}
const IMPORT_SRC = new Set(['import', 'sync', 'sync-est']);
/* A holding removed from one year is also removed from every later year that
   merely CARRIES it (that is how the years stay in sync). But a later year's
   copy that holds data of its own -- lots you typed, an estimated lot from the
   live sync, dividends -- must survive: it is detached into a standalone
   holding first, so only the carried copies disappear. */
function detachDependents(D, year, p, g, E){
  yearsOf(D).filter(y => y > year).forEach(y => (D[y].investments || []).forEach(q => {
    if (!(p.sid ? q.sid === p.sid : q.name === p.name)) return;
    (q.holdings || []).forEach(h => {
      if (!h || h === g || h.sid !== g.sid) return;
      const own = (h.lots || []).some(l => l && !l.opening) || (h.dividends || []).length;
      if (own) { h.sid = 'k' + E.uid(); h.lots = (h.lots || []).filter(l => !(l && l.opening)); E.recalcHolding(h); }
    });
  }));
}
function dropEmptyHoldings(D, year, p, onlyIds, stats, E){
  const gone = (p.holdings || []).filter(h => h && (!onlyIds || onlyIds.has(h.id)) && !(h.lots || []).some(l => l && !l.opening) && !(h.dividends || []).length);
  gone.forEach(g => { stats.holdingsRemoved++; if (g.sid) detachDependents(D, year, p, g, E); });
  if (gone.length) p.holdings = (p.holdings || []).filter(h => !gone.includes(h));
}
/* take back ONE Apply (the last one by default) */
function undoBatch(D, batchId, env){
  const E = envOf(env); const stats = { lots: 0, dividends: 0, holdingsRemoved: 0 };
  const list = Array.isArray(D.importBatches) ? D.importBatches : [];
  const rec = batchId ? list.find(b => b.id === batchId) : list[list.length - 1];
  if (!rec) return Object.assign(stats, { none: true });
  const created = new Set(rec.created || []);
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => {
    (p.holdings || []).forEach(h => {
      if (!h) return;
      const nl = (h.lots || []).length, nd = (h.dividends || []).length;
      h.lots = (h.lots || []).filter(l => !(l && l.batch === rec.id));
      h.dividends = (h.dividends || []).filter(d => !(d && d.batch === rec.id));
      stats.lots += nl - h.lots.length; stats.dividends += nd - h.dividends.length;
      if (nl !== h.lots.length) E.recalcHolding(h);
    });
  }));
  stats.restored = 0;
  (rec.removed || []).forEach(r => {                      // estimated lots this import had replaced come back
    const plat = ((D[r.year] && D[r.year].investments) || []).find(p => p.id === r.platformId); if (!plat) return;
    plat.holdings = plat.holdings || [];
    let h = plat.holdings.find(x => x && canon(x.symbol) === r.symbol);
    if (!h) { h = { id: E.uid(), symbol: r.symbol, name: r.symbol, type: 'stock', currentPrice: num(r.lot.price), ytdStartPrice: num(r.lot.price), lots: [], dividends: [], currency: plat.currency || 'USD' }; plat.holdings.push(h); }
    h.lots = h.lots || []; h.lots.push(r.lot); E.recalcHolding(h); stats.restored++;
  });
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => dropEmptyHoldings(D, y, p, created, stats, E)));
  D.importBatches = list.filter(b => b.id !== rec.id);
  E.reconcile(D);
  stats.kind = rec.kind; stats.platform = rec.platform;
  return stats;
}
/* everything this tool ever imported or synced onto one platform (all years) */
function countImported(D, platformName){
  const out = { lots: 0, dividends: 0 }; const nm = String(platformName || '').trim().toLowerCase();
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => {
    if (String(p.name || '').trim().toLowerCase() !== nm) return;
    (p.holdings || []).forEach(h => { if (!h) return;
      out.lots += (h.lots || []).filter(l => l && IMPORT_SRC.has(l.src)).length;
      out.dividends += (h.dividends || []).filter(d => d && d.src === 'import').length; });
  }));
  return out;
}
function removeImported(D, platformName, env){
  const E = envOf(env); const stats = { lots: 0, dividends: 0, holdingsRemoved: 0 }; const nm = String(platformName || '').trim().toLowerCase();
  const touched = new Set();
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => {
    if (String(p.name || '').trim().toLowerCase() !== nm) return;
    (p.holdings || []).forEach(h => {
      if (!h) return;
      const nl = (h.lots || []).length, nd = (h.dividends || []).length;
      h.lots = (h.lots || []).filter(l => !(l && IMPORT_SRC.has(l.src)));
      h.dividends = (h.dividends || []).filter(d => !(d && d.src === 'import'));
      stats.lots += nl - h.lots.length; stats.dividends += nd - h.dividends.length;
      if (nl !== h.lots.length || nd !== h.dividends.length) { touched.add(h.id); if (nl !== h.lots.length) E.recalcHolding(h); }
    });
  }));
  yearsOf(D).forEach(y => (D[y].investments || []).forEach(p => {
    if (String(p.name || '').trim().toLowerCase() === nm) dropEmptyHoldings(D, y, p, touched, stats, E);
  }));
  if (Array.isArray(D.importBatches)) D.importBatches = D.importBatches.filter(b => String(b.platform || '').toLowerCase() !== nm);
  E.reconcile(D);
  return stats;
}

/* =========================================================================
   DIVIDEND IMPORT  (Zerodha dividend statement, or any CSV/Excel with
   Symbol + Date + Amount [or Quantity x Dividend-per-share])
   Each dividend is stored on the holding, in the YEAR it was paid, so it
   shows up in the Holdings "all years" total and in XIRR. Re-importing a file
   or importing overlapping financial years never double-counts.
   ========================================================================= */
const DIV_ALIASES = {
  symbol:   ['symbol','tradingsymbol','trading symbol','scrip symbol','scrip name','scrip','instrument','stock','stock name','security','security name','company','company name'],
  payDate:  ['payment date','pay date','credit date','credited on','date of payment','paid on','payout date','date of credit','activity date'],
  exDate:   ['ex date','ex-date','exdate','ex dividend date','ex div date','record date','date'],
  qty:      ['quantity','qty','shares','no of shares','eligible quantity','eligible qty','holding quantity'],
  perShare: ['dividend per share','dividend/share','dps','rate per share','dividend rate','per share'],
  amount:   ['net dividend amount','dividend amount','net dividend','net amount','amount','total dividend','total amount','dividend','credited amount','amount credited'],
  kind:     ['type','particulars','description','narration','event','corporate action'],
  code:     ['trans code','transaction code','trans type','activity type']
};
const DIV_INDEX = {}; Object.keys(DIV_ALIASES).forEach(f => { DIV_INDEX[f] = DIV_ALIASES[f].map(hnorm); });
function findDividendHeader(rows){
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(hnorm); const cols = {};
    Object.keys(DIV_INDEX).forEach(f => { for (const a of DIV_INDEX[f]) { const at = cells.indexOf(a); if (at >= 0) { cols[f] = at; break; } } });
    const hasDate = cols.payDate !== undefined || cols.exDate !== undefined;
    const hasAmt = cols.amount !== undefined || (cols.perShare !== undefined && cols.qty !== undefined);
    if (cols.symbol !== undefined && hasDate && hasAmt) return { idx: i, cols };
  }
  return null;
}
function normalizeDividends(rows, opts){
  opts = opts || {};
  const out = { dividends: [], skipped: [], meta: { headerRow: null, columns: null, rows: 0 } };
  const h = findDividendHeader(rows);
  if (!h) { out.error = 'Could not find a header row. Expected columns like Symbol, Date (payment or ex-date) and Amount (or Quantity and Dividend per share) — for example Zerodha Console > Reports > Downloads > Statement > Dividend statement.'; return out; }
  out.meta.headerRow = h.idx; out.meta.columns = h.cols;
  const c = h.cols, get = (r, f) => c[f] === undefined ? undefined : r[c[f]];
  let order = opts.dateOrder; if (!order || order === 'auto') order = (c.code !== undefined || opts.market === 'US') ? 'mdy' : 'dmy';      // same "Auto" rule as the trade import
  for (let i = h.idx + 1; i < rows.length; i++) {
    const r = rows[i]; out.meta.rows++; const line = i + 1;
    if (!r || !r.some(x => x != null && String(x).trim() !== '')) continue;
    if (c.code !== undefined) {                       // an activity report mixes buys, sells, deposits, dividends...: ONLY dividend codes may become dividends
      const code = String(get(r, 'code') == null ? '' : get(r, 'code')).trim().toLowerCase();
      if (!/^(cdiv|mdiv)$/.test(code)) { out.skipped.push({ line, reason: /^(buy|sell)$/.test(code) ? 'a trade, not a dividend' : (CODE_REASONS[code] || 'not a dividend row (' + (code || 'blank') + ')') }); continue; }
    }
    const kind = String(get(r, 'kind') == null ? '' : get(r, 'kind'));
    if (/interest/i.test(kind) && !/dividend/i.test(kind)) { out.skipped.push({ line, reason: 'interest, not a dividend' }); continue; }
    const symbol = cleanSymbol(get(r, 'symbol'), null, opts.market || 'auto');
    if (!symbol || /^total/i.test(symbol)) { out.skipped.push({ line, reason: symbol ? 'total row' : 'no symbol' }); continue; }
    let amount = parseNum(get(r, 'amount'));
    const qty = Math.abs(parseNum(get(r, 'qty'))), dps = parseNum(get(r, 'perShare'));
    if (!(amount > 0) && qty > 0 && dps > 0) amount = qty * dps;
    if (!(amount > 0)) { out.skipped.push({ line, reason: 'zero, negative or missing amount' }); continue; }
    let pd = c.payDate !== undefined ? parseDate(get(r, 'payDate'), order) : null;
    if (!pd || !pd.date) pd = c.exDate !== undefined ? parseDate(get(r, 'exDate'), order) : null;
    if (!pd || !pd.date) { out.skipped.push({ line, reason: 'unreadable date' }); continue; }
    out.dividends.push({ symbol, date: pd.date, amount: Math.round(amount * 100) / 100, qty: qty > 0 ? r6(qty) : null, perShare: dps > 0 ? r6(dps) : null, line });
  }
  out.dividends.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.line - b.line));
  return out;
}
const divFp = d => `${d.date}|${(Math.round(num(d.amount) * 100) / 100).toFixed(2)}`;
function planDividends(D, divs, sel){
  const plan = { items: [], skipped: [], missingYears: [], missingHoldings: [], totals: { payments: 0, dups: 0, amount: 0 } };
  const byKey = new Map(), missY = new Set(), missH = new Map();
  divs.forEach(d => {
    const y = Number(d.date.slice(0, 4));
    if (!D[y]) { missY.add(y); plan.skipped.push({ line: d.line, reason: `year ${y} is not in your ledger yet` }); return; }
    const platform = findPlatform(D, y, sel);
    if (!platform) { plan.skipped.push({ line: d.line, reason: `platform ${sel.platformName || ''} does not exist in ${y} (add it there, or import only the years it exists in)` }); return; }
    const h = findHolding(platform, d.symbol);
    if (!h) { const k = `${y} ${canon(d.symbol)}`; missH.set(k, (missH.get(k) || 0) + 1); plan.skipped.push({ line: d.line, reason: `${canon(d.symbol)} is not a holding in ${y} (import that year's tradebook first)` }); return; }
    const key = `${y}|${platform.id}|${canon(d.symbol)}`;
    let it = byKey.get(key);
    if (!it) {
      const counts = new Map(); (h.dividends || []).forEach(x => { if (x) { const k = divFp(x); counts.set(k, (counts.get(k) || 0) + 1); } });
      it = { key, year: y, platformId: platform.id, symbol: canon(d.symbol), holdingId: h.id, currency: platform.currency || h.currency || 'USD', newDivs: [], dups: 0, total: 0, _counts: counts };
      byKey.set(key, it); plan.items.push(it);
    }
    const k = divFp(d), n = it._counts.get(k) || 0;
    if (n > 0) { it._counts.set(k, n - 1); it.dups++; plan.totals.dups++; return; }
    it.newDivs.push({ date: d.date, amount: d.amount, qty: d.qty, perShare: d.perShare });
    it.total = Math.round((it.total + d.amount) * 100) / 100;
    plan.totals.payments++; plan.totals.amount = Math.round((plan.totals.amount + d.amount) * 100) / 100;
  });
  plan.items.forEach(it => { delete it._counts; });
  plan.items.sort((a, b) => a.year - b.year || (a.symbol < b.symbol ? -1 : 1));
  plan.missingYears = Array.from(missY).sort();
  plan.missingHoldings = Array.from(missH.keys()).sort();
  return plan;
}
function applyDividends(D, plan, selectedKeys, env){
  const E = envOf(env); const res = { payments: 0, symbols: 0, amount: 0 }; const batch = E.batchId(), names = new Set();
  plan.items.filter(it => it.newDivs.length && (!selectedKeys || selectedKeys.has(it.key))).forEach(it => {
    const platform = ((D[it.year] && D[it.year].investments) || []).find(p => p.id === it.platformId); if (!platform) return;
    const h = (platform.holdings || []).find(x => x && x.id === it.holdingId); if (!h) return;
    h.dividends = Array.isArray(h.dividends) ? h.dividends : [];
    names.add(platform.name);
    it.newDivs.forEach(d => { h.dividends.push({ id: E.uid(), date: d.date, amount: d.amount, currency: it.currency, qty: d.qty || undefined, perShare: d.perShare || undefined, src: 'import', batch }); res.payments++; res.amount += d.amount; });
    res.symbols++;
  });
  res.amount = Math.round(res.amount * 100) / 100;
  res.batch = batch;
  if (res.payments) logBatch(D, { id: batch, at: E.now(), kind: 'dividends', platform: Array.from(names).join(', '), lots: res.payments, symbols: res.symbols, created: [] });
  return res;
}

/* =========================================================================
   UI  (Data tab card)
   ========================================================================= */
function syncUrl(){
  if (root.BROKER_SYNC_URL) return root.BROKER_SYNC_URL;
  const p = root.PRICE_PROXY_URL || '';
  return p ? p.replace(/\/[^\/]*$/, '/broker-sync') : '';
}
/* The app re-draws the whole Data tab after many actions, which re-creates this
   card. Without memory the platform dropdown fell back to Zerodha every time,
   so the file after your first import went to Zerodha instead of the platform
   you picked. These two remember your choice and the last result message. */
let lastPlatform = null;           // { sid, name }
let lastNotice = null;             // { id, html, t }
function platformOptions(D, year){
  return ((D[year] && D[year].investments) || []).map(p => ({ sid: p.sid || null, id: p.id, name: p.name, currency: p.currency || 'USD' }));
}
function guessPlatform(opts, hint){
  const h = String(hint || '').toLowerCase();
  return opts.find(o => o.name.toLowerCase().includes(h)) || opts[0] || null;
}
async function readFile(file, headerFn, what){
  const name = String(file.name || '').toLowerCase();
  if (/\.(xlsx|xls)$/.test(name)) {
    if (typeof root.XLSX === 'undefined' && typeof root.loadFirstWorking === 'function') await root.loadFirstWorking(getXlsxSource(), () => typeof root.XLSX !== 'undefined');
    if (typeof root.XLSX === 'undefined') throw new Error('Could not load the Excel reader. Save the file as CSV and try again.');
    const buf = await file.arrayBuffer();
    const wb = root.XLSX.read(buf, { type: 'array', cellDates: true });
    let best = null;
    wb.SheetNames.forEach(sn => { const rows = root.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null }); if ((headerFn || findHeader)(rows) && (!best || rows.length > best.length)) best = rows; });
    if (!best) throw new Error('No sheet in this workbook looks like ' + (what || 'a tradebook (needs Symbol, Date, Buy/Sell, Quantity, Price)') + '.');
    return best;
  }
  return parseCsv(await file.text());
}
/* A tradebook named like "tradebook-ZH1234.csv" or "AngelOne_..." that is being imported into a different
   platform is almost always a slip of the dropdown, so say so right in the preview (nothing is blocked). */
function brokerHintMismatch(fileName, platformName){
  const f = String(fileName || '').toLowerCase(), p = String(platformName || '').toLowerCase();
  const kinds = [ ['Zerodha', /zerodha|(^|[^a-z])zh\d{3,}|kite/, /zerodha/], ['Angel One', /angel/, /angel/], ['Robinhood', /robinhood/, /robinhood/] ];
  for (const [label, fileRe, platRe] of kinds) {
    if (fileRe.test(f) && !platRe.test(p)) return `<div class="notice" style="border-color:var(--gold); margin-bottom:8px;">⚠ This file looks like a <b>${esc(label)}</b> file, but the selected platform is <b>${esc(platformName || 'none')}</b>. If that's a mistake, pick the right platform in the dropdown at the top and drop the file again.</div>`;
  }
  return '';
}
function mountUI(el){
  if (!el) return;
  const D = () => getData() || {};            // before the ledger has loaded there is simply nothing to list
  const curYear = () => { const st = getState(); return (st && st.year) || new Date().getFullYear(); };
  const todayYear = () => { const y = new Date().getFullYear(); return D()[y] ? y : curYear(); };
  const opts = platformOptions(D(), curYear());
  el.innerHTML = `
    <div class="card-head"><h3>Broker import &amp; sync (Zerodha, Angel One, any CSV/Excel)</h3></div>
    <div class="notice">Brokers' APIs only share <b>today's</b> trades, so your <b>full history</b> comes from the tradebook file (Zerodha: Console &rarr; Reports &rarr; Tradebook &rarr; Download, up to 365 days per file; repeat for older years). Nothing is changed until you press Apply.</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:10px 0;">
      <label style="font-size:12px;">Platform to import into
        <select id="biPlatform" class="input" style="margin-left:6px;">${opts.map(o => `<option value="${esc(o.id)}" data-sid="${esc(o.sid || '')}" data-cur="${esc(o.currency)}" data-name="${esc(o.name)}">${esc(o.name)} (${esc(o.currency)})</option>`).join('') || '<option value="">No platforms in this year</option>'}</select></label>
      <label style="font-size:12px;">Dates like 03/04/2024 mean
        <select id="biDateOrder" class="input" style="margin-left:6px;"><option value="auto">Auto (month first for US / Robinhood files)</option><option value="dmy">3 April (day first)</option><option value="mdy">March 4 (month first)</option></select></label>
    </div>
    <div class="dropzone" id="biDrop"><div>📄 Drop a tradebook (.csv / .xlsx) here, or click to browse</div>
      <input type="file" id="biFile" accept=".csv,.xlsx,.xls,.txt"></div>
    <div id="biPreview" style="margin-top:12px;"></div>
    <hr style="border:0; border-top:1px solid var(--border, #333); margin:18px 0;">
    <div style="font-weight:600; margin-bottom:6px;">Import dividends</div>
    <div style="font-size:12px; color:var(--text-dim); margin-bottom:8px;">Zerodha: Console &rarr; Reports &rarr; Downloads &rarr; Statement &rarr; <b>Dividend statement</b> (pick the financial year, repeat for each year). Any CSV/Excel with Symbol, Date and Amount works too. Dividends are filed in the year they were paid, onto the matching holding &mdash; so import the tradebook for that year first. They feed the Holdings &ldquo;all years&rdquo; total and XIRR.</div>
    <div class="dropzone" id="biDivDrop"><div>💰 Drop a dividend statement (.csv / .xlsx) here, or click to browse</div>
      <input type="file" id="biDivFile" accept=".csv,.xlsx,.xls,.txt"></div>
    <div id="biDivPreview" style="margin-top:12px;"></div>
    <hr style="border:0; border-top:1px solid var(--border, #333); margin:18px 0;">
    <div style="font-weight:600; margin-bottom:6px;">Undo an import</div>
    <div id="biUndoInfo" style="font-size:12px; color:var(--text-dim); margin-bottom:8px;"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn" id="biUndoLast">Undo last import</button>
      <button class="btn" id="biRemoveAll">Remove everything imported on the selected platform</button>
    </div>
    <div id="biUndoResult" style="margin-top:10px;"></div>
    <hr style="border:0; border-top:1px solid var(--border, #333); margin:18px 0;">
    <div style="font-weight:600; margin-bottom:6px;">Sync current holdings from your broker (API)</div>
    <div style="font-size:12px; color:var(--text-dim); margin-bottom:8px;">Needs the <code>broker-sync</code> Supabase function (setup steps are in <code>broker-sync-setup.sql</code>). It stores a snapshot of what your broker says you hold right now; you review the differences here before anything changes. <b>Robinhood</b> (through the free SnapTrade service) also brings your dated trade and dividend history, so no file is needed for it.</div>
    <div style="font-size:12px; margin-bottom:6px;"><b>Or import a current-holdings file</b> (no dates inside — the review will ask you for them): Zerodha Console → Portfolio → Holdings → Download, Angel One's holdings statement, or any table with Symbol, Quantity and Average price.</div>
    <div class="dropzone" id="biHFDrop"><div>📊 Drop a holdings file (.csv / .xlsx) here, or click to browse</div>
      <input type="file" id="biHFFile" accept=".csv,.xlsx,.xls,.txt"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <button class="btn" id="biZLogin">Log in to Zerodha &amp; sync</button>
      <button class="btn" id="biZLoad">Review Zerodha holdings</button>
      <button class="btn" id="biRLoad">Review Robinhood (history + holdings)</button>
      <button class="btn" id="biALoad">Review Angel One holdings</button>
    </div>
    <div id="biSyncPreview" style="margin-top:12px;"></div>`;
  const $ = id => el.querySelector('#' + id);
  const selPlatform = () => {
    const s = $('biPlatform'); const o = s.options[s.selectedIndex];
    if (!o) return {};
    const out = { platformId: s.value, platformSid: o.dataset.sid || null, platformName: o.dataset.name || String(o.textContent || '').replace(/ \([A-Z]{3}\)$/, ''), currency: o.dataset.cur };
    lastPlatform = { sid: out.platformSid, name: out.platformName };          // remember whatever is selected at the moment it is used
    return out;
  };
  /* mark as unsaved only -- the app's Save / Discard bar then lets YOU decide; nothing is auto-saved */
  const markChanged = (what, target) => { root.markDirty && root.markDirty('holdings', { tab: 'data', action: what, target: String(target || '') }); };
  const SAVE_HINT = ' <b>Not saved yet</b> — press <b>Save</b> (top right) to keep it, or <b>Discard</b> to take it back.';
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const holdingsOf = platform => ((platform && platform.holdings) || []).filter(Boolean).slice().sort((a, b) => String(a.name || a.symbol).localeCompare(String(b.name || b.symbol)));
  /* "Goes to": merge into a holding you already have (default when the symbol matches), or a NEW holding with the name/symbol you choose */
  function mapSelectHtml(sym, info, platform, stTarget, stName, stSym, brokerName, naming){
    const hs = holdingsOf(platform);
    const optOf = (h, star) => `<option value="${esc(canon(h.symbol))}" ${stTarget === canon(h.symbol) ? 'selected' : ''}>${star ? '★ ' : ''}${esc(h.name || h.symbol)} (${esc(h.symbol)})</option>`;
    const sugg = (info.suggestions || []).map(x => hs.find(h => canon(h.symbol) === x.symbol)).filter(Boolean);
    const suggIds = new Set(sugg.map(h => h.id));
    const showNew = stTarget === 'new' || (!info.exists && !stTarget);
    const defName = stName !== undefined ? stName : nameFor('', naming, sym, brokerName);
    return `<select data-map="${esc(sym)}" class="input" style="max-width:250px;">`
      + `<option value="" ${!stTarget ? 'selected' : ''}>${info.exists ? 'Merge into: ' + esc(info.appName) + ' (' + esc(info.appSymbol) + ')' : 'New holding'}</option>`
      + (info.exists ? `<option value="new" ${stTarget === 'new' ? 'selected' : ''}>+ Create a separate new holding</option>` : '')
      + (sugg.length ? `<optgroup label="Suggested — looks like the same company">${sugg.map(h => optOf(h, true)).join('')}</optgroup>` : '')
      + `<optgroup label="Merge into one of my holdings">${hs.filter(h => !suggIds.has(h.id)).map(h => optOf(h, false)).join('')}</optgroup></select>`
      + `<div data-newfields="${esc(sym)}" style="${showNew ? '' : 'display:none; '}margin-top:4px;">`
      + `<input class="input" data-newname="${esc(sym)}" data-sym="${esc(sym)}" data-bname="${esc(brokerName || '')}" value="${esc(defName)}" placeholder="Name" style="width:150px;"> `
      + `<input class="input" data-newsym="${esc(sym)}" value="${esc(stSym !== undefined ? stSym : sym)}" placeholder="Ticker" style="width:105px;" title="Used to fetch prices — keep the ticker; put the friendly name in Name"></div>`;
  }
  function captureMapping(box, base){
    const mapping = Object.assign({}, base || {});
    Array.from(box.querySelectorAll('select[data-map]')).forEach(el => { const k = el.dataset.map; mapping[k] = Object.assign({}, mapping[k], { target: el.value || undefined }); });
    Array.from(box.querySelectorAll('input[data-newname]')).forEach(el => { const k = el.dataset.newname; mapping[k] = Object.assign({}, mapping[k], { name: el.value }); });
    Array.from(box.querySelectorAll('input[data-newsym]')).forEach(el => { const k = el.dataset.newsym; mapping[k] = Object.assign({}, mapping[k], { symbol: el.value }); });
    return mapping;
  }
  const targetsOnly = mapping => { const o = {}; Object.keys(mapping || {}).forEach(k => { if (mapping[k] && mapping[k].target) o[k] = { target: mapping[k].target }; }); return o; };
  const namingSelect = (id, cur) => `<label style="font-size:12px;">Names for NEW holdings <select id="${id}" class="input"><option value="symbol" ${cur === 'symbol' ? 'selected' : ''}>Broker symbol (e.g. RELIANCE)</option><option value="title" ${cur === 'title' ? 'selected' : ''}>Capitalised (e.g. Reliance)</option><option value="company" ${cur === 'company' ? 'selected' : ''}>Company name when the broker gives one</option></select></label>`;
  function applyNamingTo(box, style){ Array.from(box.querySelectorAll('input[data-newname]')).forEach(el => { el.value = nameFor('', style, el.dataset.sym, el.dataset.bname); }); }
  const showNotice = (id, html) => { const b = $(id); if (b) b.innerHTML = html; lastNotice = { id, html, t: Date.now() }; try { refreshUndo(); } catch (_) {} };   // keeps the "imported so far" line current
  const market = () => (selPlatform().currency === 'INR' ? 'IN' : 'US');
  /* best match for a broker word: an exact name first, then names starting with it, never a mutual-fund
     platform (e.g. "Coin by Zerodha MF") when a stocks platform exists */
  const MF_NAME = /coin|mutual|\bmf\b|fund/i;
  const bestIndex = (word) => {
    const w = word.toLowerCase(); const nm = o => o.name.trim().toLowerCase();
    let i = opts.findIndex(o => nm(o) === w); if (i >= 0) return i;
    i = opts.findIndex(o => nm(o).startsWith(w) && !MF_NAME.test(o.name)); if (i >= 0) return i;
    i = opts.findIndex(o => nm(o).includes(w) && !MF_NAME.test(o.name)); if (i >= 0) return i;
    return opts.findIndex(o => nm(o).includes(w));
  };
  const hintSel = (name) => { const i = bestIndex(name); if (i >= 0) { $('biPlatform').selectedIndex = i; selPlatform(); } };
  const restoreSel = () => {
    if (!lastPlatform) return false;
    let i = lastPlatform.sid ? opts.findIndex(o => o.sid === lastPlatform.sid) : -1;
    if (i < 0) i = opts.findIndex(o => o.name === lastPlatform.name);
    if (i < 0) return false;
    $('biPlatform').selectedIndex = i; return true;
  };

  /* ---- file import ---- */
  let lastPlan = null, lastPlanName = '';
  async function handleFile(file){
    const box = $('biPreview'); box.innerHTML = '<div style="color:var(--text-dim)">Reading file…</div>';
    try {
      const rows = await readFile(file);
      const parsed = normalizeTrades(rows, { market: market(), dateOrder: $('biDateOrder').value });
      if (parsed.error) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(parsed.error)}</div>`; return; }
      tradeState = { mapping: {}, naming: 'symbol' };
      showTradeParsed(parsed);
      box.insertAdjacentHTML('afterbegin', brokerHintMismatch(file.name, selPlatform().platformName));
    } catch (e) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(e.message || e)}</div>`; }
  }
  let tradeState = { mapping: {}, naming: 'symbol' }, lastTradeParsed = null;
  function showTradeParsed(parsed){
    lastTradeParsed = parsed;
    lastPlan = planImport(D(), parsed.trades, selPlatform(), { mapping: targetsOnly(tradeState.mapping) });
    lastPlanName = selPlatform().platformName || '';
    lastPlan._skipped = parsed.skipped || [];
    renderPlan($('biPreview'), parsed);
  }
  function renderPlan(box, parsed){
    const p = lastPlan;
    const skippedAll = (p._skipped || []).concat(p.skipped);
    const reasons = {}; skippedAll.forEach(s => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
    const platformNow = findPlatform(D(), todayYear(), selPlatform());
    const symList = Object.keys(p.symbolInfo || {}).sort();
    const mapHtml = symList.length ? `<div style="margin:10px 0;"><b>Where each broker symbol goes</b>
        <div style="font-size:11px; color:var(--text-faint); margin:2px 0 6px;">Symbols you already have are <b>merged</b> — your symbol and name are never changed, only quantity and average price. Only a symbol that matches nothing becomes a new holding; pick a suggestion to merge it, or choose how to name it.</div>
        <div style="overflow-x:auto;"><table class="ledger" style="min-width:420px;"><thead><tr><th>Broker symbol</th><th>Goes to</th></tr></thead><tbody>${symList.map(sym => { const si = p.symbolInfo[sym], m = tradeState.mapping[sym] || {}; return `<tr><td><b>${esc(sym)}</b>${si.exists ? ` <span style="color:var(--text-faint)">${si.matchedBy === 'symbol' ? '✓ same symbol' : '↔ link'}</span>` : ' <span style="color:var(--good)">new</span>'}</td><td>${mapSelectHtml(sym, si, platformNow, m.target, m.name, m.symbol, null, tradeState.naming)}</td></tr>`; }).join('')}</tbody></table></div>
        <div style="margin-top:6px;">${namingSelect('biNamingT', tradeState.naming)} <button class="btn" id="biApplyNamingT">Apply to new rows</button></div></div>` : '';
    const rowsHtml = p.items.map(it => `
      <tr>
        <td><input type="checkbox" data-k="${esc(it.key)}" ${it.newLots.length ? 'checked' : 'disabled'}></td>
        <td>${it.year}</td><td><b>${esc(it.symbol)}</b>${it.exists ? ` <span style="color:var(--text-faint)">(in app: ${it.existingQty})</span>` : ' <span style="color:var(--good)">new</span>'}</td>
        <td style="color:var(--good)">+${it.buyQty}</td><td style="color:var(--bad)">−${it.sellQty}</td><td>${it.dups ? it.dups + ' already there' : ''}</td>
        <td style="color:var(--gold-soft)">${it.oversell > 0 ? '⚠ sells ' + it.oversell + ' more than held — import the older tradebook first' : ''}${it.placeholders ? ' ' + it.placeholders + ' estimated lot(s) from live sync will be replaced' : ''}</td>
      </tr>`).join('');
    box.innerHTML = `
      <div style="font-size:13px; margin-bottom:6px;">Importing into: <b>${esc(selPlatform().platformName || '')}</b> (${esc(selPlatform().currency || '')})</div>
      <div style="font-size:13px; margin-bottom:8px;"><b>${parsed.trades.length}</b> trades read · <b>${p.totals.lots}</b> new (${p.totals.buys} buys, ${p.totals.sells} sells) · ${p.totals.dups} duplicates skipped · ${skippedAll.length} rows skipped</div>
      ${p.missingYears.length ? `<div class="notice" style="border-color:var(--gold)">Trades dated ${p.missingYears.join(', ')} were skipped because that year isn't in your ledger. Use <b>Add year</b> for it (your setup carries over), then import again.</div>` : ''}
      ${Object.keys(reasons).length ? `<div style="font-size:11px; color:var(--text-faint); margin-bottom:6px;">Skipped: ${Object.keys(reasons).map(r => `${reasons[r]}× ${esc(r)}`).join(' · ')}</div>` : ''}
      ${p.totals.lots > 0 ? `${mapHtml}<div style="overflow-x:auto;"><table class="ledger" style="min-width:560px;"><thead><tr><th></th><th>Year</th><th>Symbol</th><th>Buys</th><th>Sells</th><th>Dupes</th><th>Check</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div style="margin-top:10px;"><button class="btn" id="biApply">Apply selected → ${esc(selPlatform().platformName || '')}</button></div>` : `<div style="color:var(--text-dim)">Nothing new to import${p.totals.dups ? ' — these ' + p.totals.dups + ' trades are already in your ledger' : ''}.</div>`}`;
    if (!box.__tradeWired) { box.__tradeWired = true; box.addEventListener('change', e => {            // choosing a different "goes to" re-plans, so the preview is always true
      if (e && e.target && e.target.dataset && e.target.dataset.map !== undefined && lastTradeParsed) { tradeState.mapping = captureMapping(box, tradeState.mapping); showTradeParsed(lastTradeParsed); }
    }); }
    const nb = box.querySelector('#biApplyNamingT'); if (nb) nb.addEventListener('click', () => { tradeState.naming = (box.querySelector('#biNamingT') || {}).value || 'symbol'; applyNamingTo(box, tradeState.naming); });
    const ap = box.querySelector('#biApply');
    if (ap) ap.addEventListener('click', () => {
      const keys = new Set(Array.from(box.querySelectorAll('input[data-k]:checked')).map(x => x.dataset.k));
      if (!keys.size) { root.showToast && root.showToast('Nothing selected'); return; }
      const applyName = lastPlanName;
      const mapping = captureMapping(box, tradeState.mapping);
      Object.keys(mapping).forEach(k => { if (mapping[k].target && mapping[k].target !== 'new') { const th = holdingsOf(platformNow).find(h => canon(h.symbol) === canon(mapping[k].target)); if (th) mapping[k].targetName = th.name || th.symbol; } });
      const res = applyImport(D(), lastPlan, keys, undefined, { mapping, naming: (box.querySelector('#biNamingT') || {}).value || tradeState.naming });
      markChanged('trades import', applyName);
      const rePlanDividends = lastDivParsed && !divApplied;      // a waiting dividend preview can only match once its holdings exist
      showNotice('biPreview', `<div class="notice" style="border-color:var(--good)">Imported ${res.lots} trades into ${res.symbols} holdings (${res.merged} merged into yours, ${res.holdingsCreated} new${res.aliases ? ', ' + res.aliases + ' link(s) remembered' : ''}) on <b>${esc(applyName)}</b>. Open the Holdings tab to see them. Prices refresh on the next daily job.${res.replaced ? ` ${res.replaced} estimated lot(s) from the live sync were replaced by these real trades — press Review holdings to re-check anything still missing.` : ''}${SAVE_HINT}</div>`);
      if (rePlanDividends) renderDivParsed($('biDivPreview'), lastDivParsed);
    });
  }
  const wireZone = (zoneId, inputId, handler) => {
    const zone = $(zoneId), input = $(inputId);
    zone.setAttribute('tabindex', '0'); zone.setAttribute('role', 'button');                 // reachable with the keyboard
    zone.setAttribute('aria-label', String((zone.textContent || 'Choose a file')).replace(/\s+/g, ' ').trim());
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    zone.addEventListener('click', e => { if (e.target === input) return; input.click(); });          // the app's CSS hides the real input, same as its own upload box
    ['dragover', 'dragenter'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList && zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList && zone.classList.remove('drag'); }));
    zone.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) handler(f); });
    input.addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) handler(f); try { e.target.value = ''; } catch (_) {} });   // lets you pick the same file again
  };
  wireZone('biDrop', 'biFile', handleFile);

  /* ---- dividend import ---- */
  let divPlan = null, divPlanName = '';
  const money = (v, cur) => (root.fmtNative ? root.fmtNative(v, cur) : (cur === 'INR' ? '₹' : '$') + Number(v).toFixed(2));
  async function handleDivFile(file){
    const box = $('biDivPreview'); box.innerHTML = '<div style="color:var(--text-dim)">Reading file…</div>';
    try {
      let rows;
      if (/\.(xlsx|xls)$/i.test(String(file.name || ''))) {
        if (typeof root.XLSX === 'undefined' && typeof root.loadFirstWorking === 'function') await root.loadFirstWorking(getXlsxSource(), () => typeof root.XLSX !== 'undefined');
        if (typeof root.XLSX === 'undefined') throw new Error('Could not load the Excel reader. Save the file as CSV and try again.');
        const wb = root.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        let best = null;
        wb.SheetNames.forEach(sn => { const r = root.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null }); if (findDividendHeader(r) && (!best || r.length > best.length)) best = r; });
        if (!best) throw new Error('No sheet in this workbook looks like a dividend statement (needs Symbol, Date and Amount).');
        rows = best;
      } else rows = parseCsv(await file.text());
      const parsed = normalizeDividends(rows, { market: market(), dateOrder: $('biDateOrder').value });
      if (parsed.error) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(parsed.error)}</div>`; return; }
      renderDivParsed(box, parsed);
      box.insertAdjacentHTML('afterbegin', brokerHintMismatch(file.name, selPlatform().platformName));
    } catch (e) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(e.message || e)}</div>`; }
  }
  let lastDivParsed = null, divApplied = false;
  function showDivParsed(parsed){ lastDivParsed = parsed; divApplied = false; renderDivParsed($('biDivPreview'), parsed); }
  function renderDivParsed(box, parsed){
    try {
      divPlan = planDividends(D(), parsed.dividends, selPlatform());
      divPlanName = selPlatform().platformName || '';
      const skippedAll = (parsed.skipped || []).concat(divPlan.skipped);
      const reasons = {}; skippedAll.forEach(s => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
      const cur = selPlatform().currency || 'USD';
      const rowsHtml = divPlan.items.map(it => `<tr><td><input type="checkbox" data-k="${esc(it.key)}" ${it.newDivs.length ? 'checked' : 'disabled'}></td><td>${it.year}</td><td><b>${esc(it.symbol)}</b></td><td>${it.newDivs.length}</td><td style="color:var(--good)">${money(it.total, it.currency)}</td><td>${it.dups ? it.dups + ' already there' : ''}</td></tr>`).join('');
      const reasonKeys = Object.keys(reasons);
      box.innerHTML = `
        <div style="font-size:13px; margin-bottom:6px;">Importing into: <b>${esc(selPlatform().platformName || '')}</b> (${esc(cur)})</div>
        <div style="font-size:13px; margin-bottom:8px;"><b>${parsed.dividends.length}</b> dividends read · <b>${divPlan.totals.payments}</b> new, worth <b>${money(divPlan.totals.amount, cur)}</b> · ${divPlan.totals.dups} already there · ${skippedAll.length} skipped</div>
        ${divPlan.missingYears.length ? `<div class="notice" style="border-color:var(--gold)">Dividends paid in ${divPlan.missingYears.join(', ')} were skipped because that year isn't in your ledger. Use <b>Add year</b>, import that year's tradebook, then import again.</div>` : ''}
        ${reasonKeys.length ? `<div style="font-size:11px; color:var(--text-faint); margin-bottom:6px;">Skipped: ${reasonKeys.slice(0, 8).map(r => `${reasons[r]}× ${esc(r)}`).join(' · ')}${reasonKeys.length > 8 ? ` · and ${reasonKeys.length - 8} more reasons` : ''}</div>` : ''}
        ${divPlan.totals.payments > 0 ? `<div style="overflow-x:auto;"><table class="ledger" style="min-width:480px;"><thead><tr><th></th><th>Year</th><th>Symbol</th><th>Payments</th><th>Total</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
        <div style="margin-top:10px;"><button class="btn" id="biDivApply">Apply selected → ${esc(selPlatform().platformName || '')}</button></div>` : `<div style="color:var(--text-dim)">Nothing new to import${divPlan.totals.dups ? ' — these ' + divPlan.totals.dups + ' dividends are already in your ledger' : ''}.</div>`}`;
      const ap = box.querySelector('#biDivApply');
      if (ap) ap.addEventListener('click', () => {
        const keys = new Set(Array.from(box.querySelectorAll('input[data-k]:checked')).map(x => x.dataset.k));
        if (!keys.size) { root.showToast && root.showToast('Nothing selected'); return; }
        const applyDivName = divPlanName;
        const res = applyDividends(D(), divPlan, keys); divApplied = true;
        markChanged('dividends import', applyDivName);
        showNotice('biDivPreview', `<div class="notice" style="border-color:var(--good)">Imported ${res.payments} dividends (${money(res.amount, cur)}) onto ${res.symbols} holdings on <b>${esc(applyDivName)}</b>. See the "Dividends received" line in the Holdings tab.${SAVE_HINT}</div>`);
      });
    } catch (e) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(e.message || e)}</div>`; }
  }
  wireZone('biDivDrop', 'biDivFile', handleDivFile);

  /* ---- undo / clean-up ---- */
  const refreshUndo = () => {
    const b = (D().importBatches || []).slice(-1)[0], info = $('biUndoInfo'); if (!info) return;
    const nm = selPlatform().platformName || '', c = countImported(D(), nm);
    info.innerHTML = (b ? `Last import: <b>${esc(b.kind)}</b> on <b>${esc(b.platform)}</b> — ${b.lots} ${b.kind === 'dividends' ? 'dividends' : 'lines'} (${esc(new Date(b.at).toLocaleString())}).` : 'No import recorded yet by this version.')
      + ` Imported so far on <b>${esc(nm)}</b>: ${c.lots} trade lines, ${c.dividends} dividends. Only data this tool added is touched; anything you typed yourself stays.`;
  };
  $('biUndoLast').addEventListener('click', () => {
    const b = (D().importBatches || []).slice(-1)[0];
    if (!b) { showNotice('biUndoResult', '<div class="notice">Nothing to undo — no import has been recorded yet. To clean up older imports, use the other button.</div>'); return; }
    if (typeof root.confirm === 'function' && !root.confirm(`Undo the last import (${b.kind} on ${b.platform}, ${b.lots} lines)? Only those lines are removed.`)) return;
    const r = undoBatch(D(), b.id);
    markChanged('change', 'broker import');
    showNotice('biUndoResult', `<div class="notice" style="border-color:var(--good)">Undone: removed ${r.lots} trade lines, ${r.dividends} dividends and ${r.holdingsRemoved} empty holdings (${esc(r.kind || '')} on ${esc(r.platform || '')}).${r.restored ? ` ${r.restored} estimated lot(s) restored.` : ''}${SAVE_HINT}</div>`);
    refreshUndo();
  });
  $('biRemoveAll').addEventListener('click', () => {
    const nm = selPlatform().platformName || '', c = countImported(D(), nm);
    if (!nm) return;
    if (!c.lots && !c.dividends) { showNotice('biUndoResult', `<div class="notice">Nothing imported by this tool was found on ${esc(nm)}.</div>`); return; }
    if (typeof root.confirm === 'function' && !root.confirm(`Remove ${c.lots} imported trade lines and ${c.dividends} imported dividends from "${nm}" (all years)? Anything you typed yourself on "${nm}" is kept.`)) return;
    const r = removeImported(D(), nm);
    markChanged('change', 'broker import');
    showNotice('biUndoResult', `<div class="notice" style="border-color:var(--good)">Removed ${r.lots} trade lines, ${r.dividends} dividends and ${r.holdingsRemoved} empty holdings from <b>${esc(nm)}</b>.${SAVE_HINT}</div>`);
    refreshUndo();
  });
  $('biPlatform').addEventListener('change', refreshUndo);

  /* ---- API snapshot review ---- */
  /* ---------- review of a holdings snapshot (live API or a holdings file): merge, name, date -- then Apply ---------- */
  let reviewState = null, reviewCtx = null;
  function captureReview(box){
    if (!reviewState) return;
    reviewState.mapping = captureMapping(box, reviewState.mapping);
    Array.from(box.querySelectorAll('input[data-lotdate]')).forEach(el => { reviewState.dates[el.dataset.lotdate] = el.value || ''; });
    const checked = new Set(Array.from(box.querySelectorAll('input[data-k]:checked')).map(x => x.dataset.k));
    if (reviewCtx) reviewCtx.plan.items.forEach(it => { reviewState.ticks[it.key] = checked.has(it.key); });
    const g = box.querySelector('#biGlobalDate'); if (g) reviewState.globalDate = g.value || '';
    const n = box.querySelector('#biNamingH'); if (n) reviewState.naming = n.value || 'symbol';
  }
  function renderHoldingsReview(snap, info){
    const box = $('biSyncPreview'); const year = todayYear(); const today = localToday();
    const sel = Object.assign(selPlatform(), { market: market() });
    const platform = findPlatform(D(), year, sel);
    const st = reviewState;
    const plan = planHoldingsSync(D(), year, sel, snap, { mapping: targetsOnly(st.mapping) });
    reviewCtx = { snap, info, plan, sel, year };
    const mfWarn = MF_NAME.test(sel.platformName || '') ? `<div class="notice" style="border-color:var(--gold)">⚠ <b>${esc(sel.platformName)}</b> looks like a mutual-fund platform, but this snapshot holds your broker's <b>stock</b> holdings. Pick your stocks platform in the dropdown above first.</div>` : '';
    const lotCell = (it) => it.lots.map((l, i) => {
      const head = `${l.type === 'buy' ? '+' : '−'}${l.qty} @ ${l.price}${l.estimated ? ' (est.)' : ''}`;
      if (l.date) return `${head} · ${esc(l.date)}`;
      const k = `${it.key}|${i}`, v = st.dates[k] !== undefined ? st.dates[k] : (l.prefillDate || '');
      return `${head} · <input type="date" class="input" data-lotdate="${esc(k)}" value="${esc(v)}" max="${today}" style="width:140px;" title="When did this happen? Leave blank if you don't know — it is then saved as 'date unknown'."> ${l.prefillDate && v === l.prefillDate ? '<span style="color:var(--gold-soft)" title="the day this change was first seen — approximate">≈</span>' : ''}`;
    }).join('<br>');
    const how = it => it.onlyInApp ? 'Not in broker list — unticked' : (it.matchedBy === 'symbol' ? '✓ same symbol' : it.matchedBy === 'link' ? '↔ remembered link' : it.matchedBy === 'you' ? '↔ your choice' : '<span style="color:var(--good)">new</span>');
    const rowsHtml = plan.items.map(it => {
      const m = st.mapping[it.symbol] || {}; const on = st.ticks[it.key] !== undefined ? st.ticks[it.key] : !it.onlyInApp;
      return `<tr><td><input type="checkbox" data-k="${esc(it.key)}" ${on ? 'checked' : ''}></td>
        <td><b>${esc(it.symbol)}</b>${it.brokerName ? `<div style="font-size:10px;color:var(--text-faint)">${esc(it.brokerName)}</div>` : ''}</td>
        <td>${it.onlyInApp ? '<span style="color:var(--text-faint)">— (not in the broker list)</span>' : mapSelectHtml(it.symbol, it, platform, m.target, m.name, m.symbol, it.brokerName, st.naming)}</td>
        <td>${it.appQty}${it.exists ? ` @ ${Math.round(it.appAvg * 100) / 100}` : ''}</td><td>${it.brokerQty}${it.brokerAvg ? ` @ ${Math.round(it.brokerAvg * 100) / 100}` : ''}</td>
        <td>${lotCell(it)}</td><td style="color:var(--gold-soft)">${how(it)}</td></tr>`;
    }).join('');
    const meta = plan.meta || {};
    const lastLine = meta.lastSync ? (meta.canApprox ? `Changes since your last full review (${esc(String(meta.lastSync.snapshotAt || '').slice(0, 10))}) are pre-filled with the day they were first seen (≈ approximate) — change it if you know better.` : `Your last full review was more than a week ago, so nothing is guessed — please fill in the dates you know.`) : 'This is the first review for this platform, so nothing is guessed — please fill in the dates you know, or one date for all.';
    box.innerHTML = `
      <div style="font-size:13px; margin-bottom:6px;">${info.label} · into <b>${esc(sel.platformName || '')}</b> (${year})${info.status && info.status.status && info.status.status !== 'ok' ? ` · <span style="color:var(--gold-soft)">last run: ${esc(info.status.message || info.status.status)}</span>` : ''}</div>
      ${info.head || ''}${mfWarn}
      ${plan.note ? `<div class="notice">${esc(plan.note)}</div>` : ''}
      ${plan.items.length ? `
      <div class="notice" style="margin:8px 0;">
        <div style="margin-bottom:6px;"><b>Dates.</b> A broker never tells us when you bought or sold. Type the date on each line, or one date for the whole portfolio. A blank line is saved as <b>date unknown</b> (kept out of XIRR) — nothing is ever dated "today" for you.</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <label style="font-size:12px;">One date for every blank line <input type="date" id="biGlobalDate" class="input" max="${today}" value="${esc(st.globalDate || '')}"></label>
          <button class="btn" id="biFillDates">Fill all blank</button>
          ${meta.canApprox ? `<button class="btn" id="biApproxDates">Use the snapshot day (${esc(meta.snapDate)}, approximate) for all blank</button>` : ''}
        </div>
        <div style="font-size:11px; color:var(--text-faint); margin-top:6px;">${lastLine}</div>
        <div style="margin-top:8px;">${namingSelect('biNamingH', st.naming)} <button class="btn" id="biApplyNamingH">Apply to new rows</button></div>
        <div style="font-size:11px; color:var(--text-faint); margin-top:4px;">Holdings you already have are <b>merged</b>: their symbol and name are never changed — only quantity and average price. A new holding is created only when nothing matches; open "Goes to" to merge it into one of yours (★ = looks like the same company) or to choose its name.</div>
      </div>
      <div style="overflow-x:auto;"><table class="ledger" style="min-width:760px;"><thead><tr><th></th><th>Broker symbol</th><th>Goes to</th><th>In app (qty @ avg)</th><th>Broker (qty @ avg)</th><th>Proposed lines · date</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div style="margin-top:10px;"><button class="btn" id="biSyncApply">Apply selected → ${esc(sel.platformName || '')}</button></div>` : '<div style="color:var(--good)">Your holdings already match the broker. ✓</div>'}`;
    if (!box.__reviewWired) { box.__reviewWired = true; box.addEventListener('change', e => {       // a different "Goes to" re-plans, so quantities in the preview are always true
      if (e && e.target && e.target.dataset && e.target.dataset.map !== undefined && reviewCtx) { captureReview(box); renderHoldingsReview(reviewCtx.snap, reviewCtx.info); }
    }); }
    const fill = (val) => { Array.from(box.querySelectorAll('input[data-lotdate]')).forEach(el => { if (!el.value && val) el.value = val; }); };
    const fb = box.querySelector('#biFillDates'); if (fb) fb.addEventListener('click', () => { const g = box.querySelector('#biGlobalDate'); if (!g || !g.value) { root.showToast && root.showToast('Pick the date first'); return; } fill(g.value); });
    const ab = box.querySelector('#biApproxDates'); if (ab) ab.addEventListener('click', () => fill(meta.snapDate));
    const nb = box.querySelector('#biApplyNamingH'); if (nb) nb.addEventListener('click', () => { const v = (box.querySelector('#biNamingH') || {}).value || 'symbol'; st.naming = v; applyNamingTo(box, v); });
    const ap = box.querySelector('#biSyncApply');
    if (ap) ap.addEventListener('click', () => {
      captureReview(box);
      const keys = new Set(plan.items.filter(it => st.ticks[it.key]).map(it => it.key));
      if (!keys.size) { root.showToast && root.showToast('Nothing selected'); return; }
      const mapping = {}; Object.keys(st.mapping).forEach(k => { mapping[k] = Object.assign({}, st.mapping[k]); });
      const res = applyHoldingsSync(D(), year, sel, plan, keys, undefined, { mapping, dates: st.dates, globalDate: st.globalDate, naming: st.naming, snapshotAt: snap.fetchedAt || null });
      markChanged('change', 'broker import');
      showNotice('biSyncPreview', `<div class="notice" style="border-color:var(--good)">Applied ${res.lots} line(s) to ${res.symbols} holding(s) on <b>${esc(sel.platformName || '')}</b> — ${res.merged} merged into yours (names and symbols untouched), ${res.holdingsCreated} new${res.aliases ? `, ${res.aliases} link(s) remembered for next time` : ''}.${SAVE_HINT}</div>`);
    });
  }
  async function loadSnapshot(broker){
    const box = $('biSyncPreview'); box.innerHTML = '<div style="color:var(--text-dim)">Loading snapshot…</div>';
    try {
      const snapRes = await root.window.storage.get(`ledger:broker:${broker}:v1`, false);
      const stRes = await root.window.storage.get(`ledger:broker:${broker}:status:v1`, false).catch(() => null);
      const st = stRes && stRes.value ? JSON.parse(stRes.value) : null;
      if (!snapRes || !snapRes.value) { box.innerHTML = `<div class="notice">No ${broker} snapshot yet.${st ? ' Last status: ' + esc(st.message || st.status) : ''} Run the sync function first (see setup file).</div>`; return; }
      const snap = JSON.parse(snapRes.value);
      const year = todayYear();
      const sel = Object.assign(selPlatform(), { market: market() });
      if (broker === 'robinhood') {
        /* Robinhood (via SnapTrade) also brings real dated HISTORY: show it in the normal trade and dividend previews
           first; the holdings comparison only makes sense once that history has been applied. */
        if (sel.currency === 'INR') { box.innerHTML = `<div class="notice" style="border-color:var(--gold)">⚠ Robinhood data is in <b>USD</b>, but the selected platform <b>${esc(sel.platformName || '')}</b> is INR. Pick your Robinhood (USD) platform in the dropdown above, then press Review Robinhood again.</div>`; return; }
        showTradeParsed({ trades: activitiesToTrades(snap), skipped: [] });
        showDivParsed({ dividends: activitiesToDividends(snap), skipped: [] });
        const pending = (lastPlan && lastPlan.totals.lots > 0) || (divPlan && divPlan.totals.payments > 0);
        const whenR = snap.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : 'unknown time';
        if (pending) { box.innerHTML = `<div class="notice">Robinhood snapshot from <b>${esc(whenR)}</b> into <b>${esc(sel.platformName || '')}</b>: its <b>history</b> is shown in the trade-import and dividend-import previews above. <b>Apply the trades first, then the dividends</b>, press Save, then press <b>Review Robinhood</b> again — your holdings should then match and only real differences are listed.</div>`; return; }
      }
      const when = snap.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : 'unknown time';
      reviewState = { mapping: {}, dates: {}, naming: 'symbol', ticks: {}, globalDate: '' };
      renderHoldingsReview(snap, { label: `${esc(broker)} snapshot from <b>${esc(when)}</b>`, status: st });
    } catch (e) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(e.message || e)}</div>`; }
  }
  async function handleHFFile(file){
    const box = $('biSyncPreview'); box.innerHTML = '<div style="color:var(--text-dim)">Reading file…</div>';
    try {
      const rows = await readFile(file, findHoldingsHeader, 'a holdings table (needs Symbol, Quantity and Average price)');
      const parsed = normalizeHoldingsFile(rows, { market: market() });
      if (parsed.error) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(parsed.error)}</div>`; return; }
      const reasons = {}; parsed.skipped.forEach(x => { reasons[x.reason] = (reasons[x.reason] || 0) + 1; });
      const head = (Object.keys(reasons).length ? `<div style="font-size:11px; color:var(--text-faint); margin-bottom:6px;">Skipped: ${Object.keys(reasons).map(r => `${reasons[r]}× ${esc(r)}`).join(' · ')}</div>` : '')
        + (parsed.meta.pledgedRows ? `<div class="notice" style="border-color:var(--gold)">${parsed.meta.pledgedRows} row(s) list <b>pledged</b> shares separately; only the available quantity is used. Check those quantities below.</div>` : '');
      reviewState = { mapping: {}, dates: {}, naming: 'symbol', ticks: {}, globalDate: '' };
      renderHoldingsReview(parsed.snapshot, { label: `Holdings file <b>${esc(file.name || '')}</b> — ${parsed.snapshot.holdings.length} holdings, no dates inside`, head });
      box.insertAdjacentHTML('afterbegin', brokerHintMismatch(file.name, selPlatform().platformName));
    } catch (e) { box.innerHTML = `<div class="notice" style="border-color:var(--bad)">${esc(e.message || e)}</div>`; }
  }
  wireZone('biHFDrop', 'biHFFile', handleHFFile);
  // the review always uses the platform chosen in the dropdown -- it never switches it for you
  $('biZLoad').addEventListener('click', () => loadSnapshot('zerodha'));
  $('biALoad').addEventListener('click', () => loadSnapshot('angelone'));
  $('biRLoad').addEventListener('click', () => loadSnapshot('robinhood'));
  $('biZLogin').addEventListener('click', () => {
    const u = syncUrl();
    if (!u) { root.showToast && root.showToast('broker-sync URL not found'); return; }
    window.open(u + '?op=zerodha_login', '_blank', 'noopener');
  });
  if (!restoreSel()) hintSel('zerodha');
  refreshUndo();            // after the dropdown is restored, so it never overwrites the remembered platform
  $('biPlatform').addEventListener('change', () => selPlatform());
  if (lastNotice && Date.now() - lastNotice.t < 120000) { const b = $(lastNotice.id); if (b) b.innerHTML = lastNotice.html; }
}

const API = { normalizeHoldingsFile, findHoldingsHeader, resolveHolding, findHolding, aliasTarget, rememberAlias, suggestHoldings, nameFor, titleCase, validDate, platformKey, activitiesToTrades, activitiesToDividends, codeReason, undoBatch, countImported, removeImported, logBatch, normalizeDividends, planDividends, applyDividends, findDividendHeader, parseCsv, findHeader, parseNum, parseDate, parseType, cleanSymbol, normalizeTrades, parseTradeFile,
              planImport, applyImport, planHoldingsSync, applyHoldingsSync, simulateOversell, mountUI, canon };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.BrokerImport = API;
})(typeof window !== 'undefined' ? window : globalThis);