/* =========================================================================
   YEAR SYNC -- one live, shared setup across every year.

   RULES (as requested):
   * Add something in a year (account, card, income source, category,
     savings account, goal, asset, investment, holding...) -> it appears in
     that year AND every later year (amounts start blank in the copies).
   * Delete it in a year -> removed from THAT year and every later year.
     Earlier years keep it, with all their history and totals.
   * Rename it in any year -> renamed in every year.
   * Change another setting (interest rate, limit, target, recurring plan...)
     -> applied to that year and every later year (earlier years keep the
     value that was true back then).
   * Totals carry forward from ALL prior years, not just the last one:
     bank/card opening balance, savings balance, retirement prior
     contributions, goal saved-so-far, debt cleared-so-far, holdings.

   Identity: every item gets a `sid` (shared id) that is the same in every
   year. Existing `id`s are never changed, so nothing that points at them
   (transfers, cron price updates, links) breaks.
   ========================================================================= */
(function(root){
'use strict';

const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const n12 = () => new Array(12).fill(null);
const round2 = v => Math.round(v*100)/100;
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
let _seq = 0;
const newId = () => (typeof root.uid === 'function')
  ? root.uid()
  : 'ys' + Date.now().toString(36) + (++_seq) + Math.random().toString(36).slice(2, 6);
const yearKeys = D => Object.keys(D || {}).filter(k => /^\d{4}$/.test(k)).map(Number).sort((a, b) => a - b);
const sumArr = a => (a || []).reduce((t, v) => t + num(v), 0);

/* ---- what is shared vs per-year, for every collection ----
   nameField : field that is the human label (renamed everywhere)
   shared    : other settings that flow forward (this year + later years)
   fresh(src): per-year fields a brand-new copy starts with
   Order matters: linked collections come after what they link to. */
const HOLDING = {
  key: 'holdings', nameField: 'symbol', idNorm: s => String(s == null ? '' : s).trim().toUpperCase(),
  shared: ['name', 'type', 'currency', 'region', 'recurring'],
  fresh: () => ({ dividends: [] })
};
const SPECS = [
  { key: 'income', nameField: 'name', shared: ['currency'],
    fresh: () => ({ m: n12() }) },
  { key: 'expenseGroups', nameField: 'name', shared: ['excludeFromTotal'],
    fresh: () => ({ categories: [] }),
    child: { key: 'categories', nameField: 'name', shared: ['currency'],
             fresh: () => ({ m: n12(), raw: n12(), notes: '' }) } },
  { key: 'banks', nameField: 'name',
    shared: ['currency', 'type', 'creditLimit', 'billingCycleDay', 'paymentDueDay'],
    fresh: () => ({ m: n12(), transactions: [], lastUpdatedAt: null }) },
  { key: 'savingsAccounts', nameField: 'name', shared: ['currency', 'interestRate'],
    fresh: () => ({ m: n12() }) },
  { key: 'retirementAccounts', nameField: 'name', shared: ['currency', 'returnRate'],
    fresh: () => ({ mSelf: n12(), mEmployer: n12(), priorSelf: 0, priorEmployer: 0 }) },
  { key: 'savingsGoals', nameField: 'name',
    shared: ['targetAmount', 'currency', 'endDate', 'icon'],
    link: { field: 'linkedAccountId', target: 'savingsAccounts' },
    fresh: () => ({ m: n12() }) },
  { key: 'debts', nameField: 'name', shared: ['total', 'interest', 'emi', 'currency'],
    fresh: () => ({ cleared: 0, m: n12() }) },
  { key: 'assets', nameField: 'name',
    shared: ['category', 'currency', 'purchasePrice', 'purchaseDate', 'currentValue'],
    link: { field: 'linkedDebtId', target: 'debts' },
    fresh: () => ({}) },
  { key: 'investments', nameField: 'name', shared: ['category', 'currency'],
    fresh: () => ({ m: n12(), currentValue: 0, invested: 0, holdings: [] }),
    child: HOLDING }
];

const st = { snap: null };

/* ----------------------------------------------------------------------
   identity (sid) assignment -- links same-named items across years
   ---------------------------------------------------------------------- */
function idOf(item, def){
  const raw = item[def.nameField];
  return def.idNorm ? def.idNorm(raw) : norm(raw);
}
function assignSidsList(list, def, earlier){
  // earlier: Map(normName -> sid) built from prior years for this collection
  const used = new Set();
  (list || []).forEach(it => { if (it && it.sid) used.add(it.sid); });
  (list || []).forEach(it => {
    if (!it || it.sid) return;
    const key = idOf(it, def);
    const hit = key && earlier ? earlier.get(key) : null;
    if (hit && !used.has(hit)) { it.sid = hit; used.add(hit); }
    else { it.sid = it.id || newId(); used.add(it.sid); }
  });
}
/* drop null / non-object junk entries so one bad row can never break the sync */
function sanitize(D){
  yearKeys(D).forEach(y => SPECS.forEach(spec => {
    const list = D[y] && D[y][spec.key];
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) if (!list[i] || typeof list[i] !== 'object') list.splice(i, 1);
    if (spec.child) list.forEach(it => {
      const kids = it[spec.child.key];
      if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) if (!kids[i] || typeof kids[i] !== 'object') kids.splice(i, 1);
    });
  }));
}
function assignSids(D){
  sanitize(D);
  const years = yearKeys(D);
  SPECS.forEach(spec => {
    const seen = new Map();            // normName -> sid   (top level)
    const seenChild = new Map();       // parentSid|normName -> sid
    years.forEach(y => {
      const list = D[y][spec.key];
      if (!Array.isArray(list)) return;
      assignSidsList(list, spec, seen);
      list.forEach(it => {
        const k = idOf(it, spec); if (k) seen.set(k, it.sid);
        if (spec.child && Array.isArray(it[spec.child.key])) {
          const earlierC = new Map();
          seenChild.forEach((sid, key) => { if (key.startsWith(it.sid + '|')) earlierC.set(key.slice(it.sid.length + 1), sid); });
          assignSidsList(it[spec.child.key], spec.child, earlierC);
          it[spec.child.key].forEach(c => { const ck = idOf(c, spec.child); if (ck) seenChild.set(it.sid + '|' + ck, c.sid); });
        }
      });
    });
  });
}

/* ----------------------------------------------------------------------
   copying an item into another year
   ---------------------------------------------------------------------- */
function findBySid(list, sid){ return (list || []).find(x => x.sid === sid) || null; }

function copyItem(spec, src, D, srcYear, destYear){
  const c = { id: newId(), sid: src.sid, carryFromPrior: true };
  c[spec.nameField] = src[spec.nameField];
  spec.shared.forEach(f => { if (src[f] !== undefined) c[f] = clone(src[f]); });
  Object.assign(c, spec.fresh(src));
  if (spec.key === 'debts') c.cleared = 0;            // recomputed by carry
  if (spec.link) {
    const tgt = (D[srcYear][spec.link.target] || []).find(t => t.id === src[spec.link.field]);
    const mapped = tgt ? findBySid(D[destYear][spec.link.target], tgt.sid) : null;
    c[spec.link.field] = mapped ? mapped.id : null;
  }
  if (spec.child) {
    const kids = (src[spec.child.key] || []).filter(k => k && !(spec.child === HOLDING && isClosedHolding(k)));
    c[spec.child.key] = kids.map(k => copyChild(spec.child, k, src, c));
  }
  return c;
}
function isClosedHolding(h){ return h.status === 'closed' || num(h.qty) <= 0; }
function copyChild(def, src, parentSrc, parentDest){
  const c = { id: newId(), sid: src.sid };
  c[def.nameField] = src[def.nameField];
  def.shared.forEach(f => { if (src[f] !== undefined) c[f] = clone(src[f]); });
  Object.assign(c, def.fresh(src));
  if (def === HOLDING) {
    const y = parentDest.__year || new Date().getFullYear();
    c.currentPrice = num(src.currentPrice);
    c.ytdStartPrice = num(src.currentPrice) || num(src.avgPrice);
    c.lots = [{ id: newId(), type: 'buy', qty: num(src.qty), price: num(src.avgPrice), date: `${y}-01-01`, opening: true }];
    if (typeof root.recalcHolding === 'function') root.recalcHolding(c);
    else { c.qty = num(src.qty); c.avgPrice = num(src.avgPrice); }
  }
  return c;
}

/* ----------------------------------------------------------------------
   snapshots + diff (detect what the user just did)
   ---------------------------------------------------------------------- */
function sharedSig(def, it){
  const o = {};
  o.__name = it[def.nameField];
  def.shared.forEach(f => { o[f] = it[f]; });
  if (def === HOLDING) o.__closed = (it.status === 'closed');
  return JSON.stringify(o);
}
function takeSnap(D){
  const snap = {};
  yearKeys(D).forEach(y => {
    snap[y] = {};
    SPECS.forEach(spec => {
      const m = {};
      (D[y][spec.key] || []).forEach(it => {
        if (!it || !it.sid) return;
        const entry = { sig: sharedSig(spec, it), kids: {} };
        if (spec.child) (it[spec.child.key] || []).forEach(k => { if (k && k.sid) entry.kids[k.sid] = sharedSig(spec.child, k); });
        m[it.sid] = entry;
      });
      snap[y][spec.key] = m;
    });
  });
  return snap;
}

function diffYear(D, snap, y, spec){
  const ops = [];
  const cur = {}; (D[y][spec.key] || []).forEach(it => { if (it && it.sid) cur[it.sid] = it; });
  const prev = (snap[y] && snap[y][spec.key]) || {};
  Object.keys(cur).forEach(sid => {
    if (!prev[sid]) ops.push({ t: 'add', y, spec, sid });
    else {
      const it = cur[sid]; const sig = sharedSig(spec, it);
      if (sig !== prev[sid].sig) ops.push({ t: 'upd', y, spec, sid, prevSig: prev[sid].sig });
      if (spec.child) {
        const curK = {}; (it[spec.child.key] || []).forEach(k => { if (k && k.sid) curK[k.sid] = k; });
        const prevK = prev[sid].kids || {};
        Object.keys(curK).forEach(ks => {
          if (!(ks in prevK)) ops.push({ t: 'addc', y, spec, sid, ksid: ks });
          else if (sharedSig(spec.child, curK[ks]) !== prevK[ks]) ops.push({ t: 'updc', y, spec, sid, ksid: ks, prevSig: prevK[ks] });
        });
        Object.keys(prevK).forEach(ks => { if (!(ks in curK)) ops.push({ t: 'delc', y, spec, sid, ksid: ks }); });
      }
    }
  });
  Object.keys(prev).forEach(sid => { if (!cur[sid]) ops.push({ t: 'del', y, spec, sid }); });
  return ops;
}

function applyShared(def, from, to, onlyChanged){
  def.shared.forEach(f => {
    if (from[f] !== undefined) to[f] = clone(from[f]);
    else delete to[f];
  });
}

function applyOps(D, ops){
  const years = yearKeys(D);
  let n = 0;
  ops.forEach(op => {
    const { spec, sid, y } = op;
    const later = years.filter(y2 => y2 > y);
    if (op.t === 'add') {
      const src = findBySid(D[y][spec.key], sid);
      later.forEach(y2 => {
        const list = D[y2][spec.key] || (D[y2][spec.key] = []);
        if (findBySid(list, sid)) return;
        const same = list.find(x => idOf(x, spec) === idOf(src, spec));
        if (same) { same.sid = sid; return; }
        const copy = copyItem(spec, src, D, y, y2);
        if (copy.holdings) copy.holdings.forEach(h => { h.lots.forEach(l => { l.date = `${y2}-01-01`; }); });
        list.push(copy); n++;
      });
    } else if (op.t === 'del') {
      later.forEach(y2 => {
        const list = D[y2][spec.key]; if (!list) return;
        const i = list.findIndex(x => x.sid === sid);
        if (i >= 0) { list.splice(i, 1); n++; }
      });
    } else if (op.t === 'upd') {
      const src = findBySid(D[y][spec.key], sid);
      const prevName = JSON.parse(op.prevSig).__name;
      const nameChanged = prevName !== src[spec.nameField];
      years.forEach(y2 => {
        if (y2 === y) return;
        const it = findBySid(D[y2][spec.key], sid); if (!it) return;
        if (nameChanged) it[spec.nameField] = src[spec.nameField];
        if (y2 > y) {
          const p = JSON.parse(op.prevSig);
          spec.shared.forEach(f => { if (JSON.stringify(p[f]) !== JSON.stringify(src[f])) { if (src[f] === undefined) delete it[f]; else it[f] = clone(src[f]); } });
        }
        n++;
      });
    } else if (op.t === 'addc') {
      const parent = findBySid(D[y][spec.key], sid);
      const src = findBySid(parent[spec.child.key], op.ksid);
      later.forEach(y2 => {
        const p2 = findBySid(D[y2][spec.key], sid); if (!p2) return;
        p2[spec.child.key] = p2[spec.child.key] || [];
        if (findBySid(p2[spec.child.key], op.ksid)) return;
        const same = p2[spec.child.key].find(x => !x.sid && idOf(x, spec.child) === idOf(src, spec.child));
        if (same) { same.sid = op.ksid; return; }
        p2.__year = y2;
        const c = copyChild(spec.child, src, parent, p2);
        delete p2.__year;
        p2[spec.child.key].push(c); n++;
      });
    } else if (op.t === 'delc') {
      later.forEach(y2 => {
        const p2 = findBySid(D[y2][spec.key], sid); if (!p2) return;
        const list = p2[spec.child.key] || [];
        const i = list.findIndex(x => x.sid === op.ksid);
        if (i >= 0) { list.splice(i, 1); n++; }
      });
    } else if (op.t === 'updc') {
      const parent = findBySid(D[y][spec.key], sid);
      const src = findBySid(parent[spec.child.key], op.ksid);
      const p = JSON.parse(op.prevSig);
      const nameChanged = p.__name !== src[spec.child.nameField];
      years.forEach(y2 => {
        if (y2 === y) return;
        const p2 = findBySid(D[y2][spec.key], sid); if (!p2) return;
        const k = findBySid(p2[spec.child.key], op.ksid); if (!k) return;
        if (nameChanged) k[spec.child.nameField] = src[spec.child.nameField];
        if (y2 > y) spec.child.shared.forEach(f => { if (JSON.stringify(p[f]) !== JSON.stringify(src[f])) { if (src[f] === undefined) delete k[f]; else k[f] = clone(src[f]); } });
        n++;
      });
    }
  });
  return n;
}

/* ----------------------------------------------------------------------
   carry-forward totals from ALL prior years (recomputed every time, so
   editing an old year immediately updates every later year)
   ---------------------------------------------------------------------- */
function prevOf(D, spec, y, sid){
  const years = yearKeys(D).filter(v => v < y).reverse();
  for (const py of years) { const it = findBySid(D[py][spec.key], sid); if (it) return { it, y: py }; }
  return null;
}
function lastFilled(arr){ for (let i = 11; i >= 0; i--) { if (arr && arr[i] !== null && arr[i] !== undefined) return arr[i]; } return null; }
function lastPositive(arr){ for (let i = 11; i >= 0; i--) { if (arr && num(arr[i]) > 0) return num(arr[i]); } return null; }

function recomputeCarry(D){
  yearKeys(D).forEach(y => {
    const yd = D[y];
    (yd.banks || []).forEach(b => {
      if (!b.carryFromPrior) return;
      const p = prevOf(D, SPECS[2], y, b.sid);
      if (!p) return;
      const end = lastFilled(p.it.m);
      b.openingBalance = round2(end !== null ? num(end) : num(p.it.openingBalance));
    });
    (yd.savingsAccounts || []).forEach(a => {
      if (!a.carryFromPrior) return;
      const p = prevOf(D, SPECS[3], y, a.sid);
      if (!p) return;
      const end = lastPositive(p.it.m);
      a.openingBalance = round2(end !== null ? end : num(p.it.openingBalance));
    });
    (yd.retirementAccounts || []).forEach(r => {
      if (!r.carryFromPrior || r.priorManual) return;      // typed by hand -> keep it
      const p = prevOf(D, SPECS[4], y, r.sid);
      if (!p) return;                                  // first year: the value you typed is the base
      r.priorSelf = round2(num(p.it.priorSelf) + sumArr(p.it.mSelf));
      r.priorEmployer = round2(num(p.it.priorEmployer) + sumArr(p.it.mEmployer));
      r.priorAuto = true;
    });
    (yd.savingsGoals || []).forEach(g => {
      if (!g.carryFromPrior) return;
      const p = prevOf(D, SPECS[5], y, g.sid);
      if (p) g.openingSaved = round2(num(p.it.openingSaved) + sumArr(p.it.m));
    });
    (yd.debts || []).forEach(d => {
      if (!d.carryFromPrior || d.clearedManual) return;    // typed by hand -> keep it
      const p = prevOf(D, SPECS[6], y, d.sid);
      if (p) { d.cleared = round2(num(p.it.cleared) + sumArr(p.it.m)); d.clearedAuto = true; }
    });
    (yd.investments || []).forEach(inv => {
      const p = prevOf(D, SPECS[8], y, inv.sid);
      if (!p) return;
      (inv.holdings || []).forEach(h => {
        const ph = findBySid(p.it.holdings, h.sid); if (!ph) return;
        const open = (h.lots || []).find(l => l.opening);
        if (!open) return;
        open.qty = num(ph.qty); open.price = num(ph.avgPrice); open.date = `${y}-01-01`;
        if (typeof root.recalcHolding === 'function') root.recalcHolding(h);
      });
      // a position fully sold last year does not carry into this one (unless you traded it here)
      inv.holdings = (inv.holdings || []).filter(h => {
        const ph = findBySid(p.it.holdings, h.sid);
        const onlyOpening = (h.lots || []).length === 1 && h.lots[0].opening;
        return !(ph && onlyOpening && num(ph.qty) <= 0);
      });
    });
  });
}

/* ----------------------------------------------------------------------
   blank years (e.g. a 2027 created by the old "Add year" button, which
   made an EMPTY year) are filled from the nearest earlier year with data.
   A year that already holds anything of its own is NEVER touched here, and
   every seeded year is remembered so deleting things later can't bring the
   copies back.
   ---------------------------------------------------------------------- */
function isBlankYear(yd){ return SPECS.every(s => !((yd && yd[s.key]) || []).length); }
function seedFrom(D, base, y){
  const yd = D[y];
  SPECS.forEach(spec => {
    yd[spec.key] = yd[spec.key] || [];
    (D[base][spec.key] || []).forEach(src => {
      const c = copyItem(spec, src, D, base, y);
      if (c.holdings) c.holdings.forEach(h => { h.lots.forEach(l => { l.date = `${y}-01-01`; }); });
      yd[spec.key].push(c);
    });
  });
}
function seedBlankYears(D){
  D.yearSyncSeeded = D.yearSyncSeeded || {};
  let n = 0;
  yearKeys(D).forEach(y => {
    if (D.yearSyncSeeded[y] || !isBlankYear(D[y])) return;
    const base = yearKeys(D).filter(v => v < y && !isBlankYear(D[v])).pop();
    if (base === undefined) return;
    seedFrom(D, base, y);
    D.yearSyncSeeded[y] = true; n++;
  });
  return n;
}
/* Manual "Sync all years now": copy anything a later year is missing from
   the year before it (top level + categories + holdings). Nothing that a
   year already has is changed or removed. */
function fillMissing(D){
  if (!D) return 0;
  assignSids(D);
  let n = 0;
  const years = yearKeys(D);
  years.forEach((y, i) => {
    if (i === 0) return;
    const py = years[i - 1];
    SPECS.forEach(spec => {
      const list = D[y][spec.key] || (D[y][spec.key] = []);
      (D[py][spec.key] || []).forEach(src => {
        if (!src || !src.sid) return;
        let mine = findBySid(list, src.sid);
        if (!mine) {
          const same = list.find(x => idOf(x, spec) === idOf(src, spec));
          if (same) { same.sid = src.sid; mine = same; }
        }
        if (!mine) {
          const c = copyItem(spec, src, D, py, y);
          if (c.holdings) c.holdings.forEach(h => { h.lots.forEach(l => { l.date = `${y}-01-01`; }); });
          list.push(c); n++;
        } else if (spec.child) {
          mine[spec.child.key] = mine[spec.child.key] || [];
          (src[spec.child.key] || []).forEach(k => {
            if (!k || !k.sid || findBySid(mine[spec.child.key], k.sid)) return;
            if (spec.child === HOLDING && isClosedHolding(k)) return;
            if (mine[spec.child.key].some(x => idOf(x, spec.child) === idOf(k, spec.child))) return;
            mine.__year = y; mine[spec.child.key].push(copyChild(spec.child, k, src, mine)); delete mine.__year; n++;
          });
        }
      });
    });
  });
  D.yearSyncSeeded = D.yearSyncSeeded || {};
  years.forEach(y => { D.yearSyncSeeded[y] = true; });
  assignSids(D);
  recomputeCarry(D);
  st.snap = takeSnap(D);
  return n;
}

/* ----------------------------------------------------------------------
   public API
   ---------------------------------------------------------------------- */
function init(D){
  if (!D) return 0;
  assignSids(D);
  const seeded = seedBlankYears(D);
  recomputeCarry(D);
  st.snap = takeSnap(D);
  return seeded;
}
function rebaseline(D){ return init(D); }

function reconcile(D){
  if (!D) return 0;
  if (!st.snap) { init(D); return 0; }
  assignSids(D);
  const ops = [];
  yearKeys(D).forEach(y => SPECS.forEach(spec => { if (Array.isArray(D[y][spec.key]) || st.snap[y]) ops.push(...diffYear(D, st.snap, y, spec)); }));
  // a brand-new year object (not created by createYear) is never diffed as a mass-add
  const n = ops.length ? applyOps(D, ops.filter(o => st.snap[o.y])) : 0;
  recomputeCarry(D);
  st.snap = takeSnap(D);
  return n;
}

function createYear(D, year){
  const years = yearKeys(D);
  const ny = year || (years.length ? Math.max(...years) + 1 : new Date().getFullYear());
  if (D[ny]) return ny;
  reconcile(D);                                        // flush pending edits first
  const base = years.filter(v => v < ny).pop();
  const yd = { income: [], expenseGroups: [], investments: [], debts: [], savingsAccounts: [], retirementAccounts: [], savingsGoals: [], assets: [], banks: [] };
  D[ny] = yd;
  if (base !== undefined) {
    SPECS.forEach(spec => {
      (D[base][spec.key] || []).forEach(src => {
        const c = copyItem(spec, src, D, base, ny);
        if (c.holdings) c.holdings.forEach(h => { h.lots.forEach(l => { l.date = `${ny}-01-01`; }); });
        yd[spec.key].push(c);
      });
    });
  }
  D.yearSyncSeeded = D.yearSyncSeeded || {}; D.yearSyncSeeded[ny] = true;
  init(D);
  return ny;
}

/* Balance helpers the renderers use ("what do I have right now, counting
   everything carried from earlier years?") */
function savingsBalanceAt(acc, monthIdx){
  const m = acc.m || [];
  for (let i = monthIdx; i >= 0; i--) { if (num(m[i]) > 0) return num(m[i]); }
  return acc.carryFromPrior ? num(acc.openingBalance) : 0;
}
function goalSavedBefore(goal){ return num(goal.openingSaved); }

const API = { init, rebaseline, reconcile, createYear, fillMissing, seedBlankYears, isBlankYear, assignSids, recomputeCarry, savingsBalanceAt, goalSavedBefore, SPECS, _state: st };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.YearSync = API;
})(typeof window !== 'undefined' ? window : globalThis);