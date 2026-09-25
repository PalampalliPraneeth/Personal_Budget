// Supabase Edge Function: daily-price-refresh
// -------------------------------------------------------------------------
// Runs on a schedule (via pg_cron). Refreshes every open holding's price
// (and every watchlist ticker), writes it back, records a portfolio
// snapshot, and stamps ledger:pricesUpdatedAt:v1 — which is what
// tab-holdings.js reads to show "Prices last refreshed: ...".
//
// What changed vs. the previous version (all deliberate fixes):
//  1. NO MORE LOST EDITS. The old version loaded your ledger, spent a minute
//     fetching prices, then wrote its stale copy of the WHOLE ledger back —
//     silently wiping anything you typed/saved in the browser meanwhile.
//     Now it (a) fetches prices first without touching the ledger, then
//     (b) re-reads the ledger fresh, (c) applies ONLY price fields to it and
//     (d) writes with a compare-and-swap on updated_at. If you saved
//     something in between, it re-reads and retries instead of overwriting.
//  2. Each unique symbol is fetched once (not once per platform per year),
//     a few in parallel, with per-request timeouts and one retry on
//     429/5xx — the old sequential loop could run past the edge-runtime
//     wall-clock limit on bigger portfolios and die before saving anything.
//  3. priceFetchFailed is cleared on success (before, a failed browser
//     fetch left holdings showing "—" forever even after this job fixed
//     the price).
//  4. "Prices last refreshed" is only stamped if at least one price
//     really updated (before, a Yahoo outage still stamped "just now").
//  5. Watchlist tickers are refreshed too (price, day change, 52-week
//     range, volume).
//  6. FX fallback is your last recorded rate, not a hard-coded guess.
//
// IMPORTANT: LEDGER_ID below must exactly match the LEDGER_ID constant in
// your storage-bridge.js.

const LEDGER_ID = 'the-ledger-main-7663'; // ← change if your storage-bridge.js uses a different value
const DATA_KEY = 'ledger:data:v1';
const TIMESTAMP_KEY = 'ledger:pricesUpdatedAt:v1';

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 3;
const PER_WORKER_DELAY_MS = 250; // stay polite to Yahoo's rate limits
const WRITE_ATTEMPTS = 4;
const FX_LAST_RESORT = 95.0; // only used if the FX API is down AND no rate was ever recorded

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

type PriceInfo = {
  price: number;
  changePct: number | null;
  prevClose: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function yahooSymbolFor(symbol: string, isIndian: boolean): string {
  let s = String(symbol).toUpperCase().trim();
  if (isIndian && !s.endsWith('.NS') && !s.endsWith('.BO')) s = s + '.NS';
  return s;
}

async function fetchYahooOnce(yahooSym: string): Promise<PriceInfo> {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  const res = await fetch(target, {
    headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err: any = new Error(`Yahoo returned ${res.status}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prev = meta?.previousClose ?? meta?.chartPreviousClose;
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) throw new Error('no price in response');
  const prevClose = typeof prev === 'number' && prev > 0 ? prev : null;
  return {
    price,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    prevClose,
    fiftyTwoWeekHigh: typeof meta?.fiftyTwoWeekHigh === 'number' ? meta.fiftyTwoWeekHigh : null,
    fiftyTwoWeekLow: typeof meta?.fiftyTwoWeekLow === 'number' ? meta.fiftyTwoWeekLow : null,
    volume: typeof meta?.regularMarketVolume === 'number' ? meta.regularMarketVolume : null,
  };
}

async function fetchYahooPrice(yahooSym: string): Promise<PriceInfo> {
  try {
    return await fetchYahooOnce(yahooSym);
  } catch (e: any) {
    // Retry once for rate-limits, 5xx, and network/timeout errors — not for "no such symbol".
    const retryable = e?.retryable === true || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError;
    if (!retryable) throw e;
    await sleep(700);
    return await fetchYahooOnce(yahooSym);
  }
}

async function fetchUsdInrRate(DATA: any): Promise<number> {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await res.json();
    const rate = data?.rates?.INR;
    if (typeof rate === 'number' && rate > 0) return rate;
  } catch (_e) { /* fall through to last-known */ }
  // Last known real rate from the ledger's own month-by-month FX history.
  const hist = DATA?.fxRateHistory || {};
  const keys = Object.keys(hist).sort();
  for (let i = keys.length - 1; i >= 0; i--) {
    const r = hist[keys[i]]?.end;
    if (typeof r === 'number' && r > 0) return r;
  }
  return FX_LAST_RESORT;
}

/* ---------------- Ledger REST access ---------------- */
async function loadRow(dataKey: string): Promise<{ data_json: any; updated_at: string | null } | null> {
  const url =
    `${SUPABASE_URL}/rest/v1/ledger_data` +
    `?user_id=eq.${encodeURIComponent(LEDGER_ID)}&data_key=eq.${encodeURIComponent(dataKey)}&select=data_json,updated_at`;
  const res = await fetch(url, { headers: REST_HEADERS });
  if (!res.ok) throw new Error(`REST select failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function upsertKey(dataKey: string, value: unknown) {
  const url = `${SUPABASE_URL}/rest/v1/ledger_data?on_conflict=user_id,data_key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...REST_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      { user_id: LEDGER_ID, data_key: dataKey, data_json: value, updated_at: new Date().toISOString() },
    ]),
  });
  if (!res.ok) throw new Error(`REST upsert failed for ${dataKey}: ${res.status} ${await res.text()}`);
}

/* Compare-and-swap write: only succeeds if the row's updated_at is still what
   we read. Returns false if someone (you, in the browser) saved in between. */
async function conditionalWrite(dataKey: string, value: unknown, expectedUpdatedAt: string | null): Promise<boolean> {
  const cond = expectedUpdatedAt === null ? 'updated_at=is.null' : `updated_at=eq.${encodeURIComponent(expectedUpdatedAt)}`;
  const url =
    `${SUPABASE_URL}/rest/v1/ledger_data` +
    `?user_id=eq.${encodeURIComponent(LEDGER_ID)}&data_key=eq.${encodeURIComponent(dataKey)}&${cond}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...REST_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ data_json: value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`REST conditional update failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

/* ---------------- Ledger math ---------------- */
function parseData(raw: any): any {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
const isYearKey = (k: string) => /^\d+$/.test(k);

/* Every distinct Yahoo symbol we need a price for, across all years + watchlist. */
export function collectTargets(DATA: any): Set<string> {
  const out = new Set<string>();
  for (const yearKey of Object.keys(DATA || {})) {
    if (!isYearKey(yearKey)) continue;
    for (const inv of DATA[yearKey]?.investments || []) {
      const isIndian = inv.currency === 'INR';
      for (const h of inv.holdings || []) {
        if (!h?.symbol || h.status === 'closed') continue;
        out.add(yahooSymbolFor(h.symbol, isIndian));
      }
    }
  }
  for (const w of DATA?.watchlist || []) {
    if (!w?.symbol) continue;
    out.add(yahooSymbolFor(w.symbol, w.region === 'IN'));
  }
  return out;
}

async function fetchAllPrices(symbols: string[]): Promise<{ prices: Map<string, PriceInfo>; failed: string[] }> {
  const prices = new Map<string, PriceInfo>();
  const failed: string[] = [];
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= symbols.length) return;
      const sym = symbols[i];
      try {
        prices.set(sym, await fetchYahooPrice(sym));
      } catch (e) {
        failed.push(sym);
        console.error('daily-price-refresh: failed for', sym, String(e));
      }
      await sleep(PER_WORKER_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, worker));
  return { prices, failed };
}

/* Applies prices to holdings + watchlist IN PLACE. Only price-derived fields
   are touched — quantities, lots, names, everything else stays as the user
   last saved it. */
export function applyPrices(DATA: any, prices: Map<string, PriceInfo>, now = Date.now()) {
  let updated = 0, missing = 0;
  for (const yearKey of Object.keys(DATA || {})) {
    if (!isYearKey(yearKey)) continue;
    for (const inv of DATA[yearKey]?.investments || []) {
      const isIndian = inv.currency === 'INR';
      for (const h of inv.holdings || []) {
        if (!h?.symbol || h.status === 'closed') continue;
        const p = prices.get(yahooSymbolFor(h.symbol, isIndian));
        if (!p) { missing++; continue; } // keep the last known price; don't flag as failed for a transient miss
        h.currentPrice = p.price;
        h.dayChangePct = p.changePct;
        h.lastFetched = now;
        h.priceFetchFailed = false;
        updated++;
      }
    }
  }
  for (const w of DATA?.watchlist || []) {
    if (!w?.symbol) continue;
    const p = prices.get(yahooSymbolFor(w.symbol, w.region === 'IN'));
    if (!p) continue;
    w.currentPrice = p.price;
    w.dayChangePct = p.changePct;
    w.prevClose = p.prevClose;
    w.fiftyTwoWeekHigh = p.fiftyTwoWeekHigh;
    w.fiftyTwoWeekLow = p.fiftyTwoWeekLow;
    w.volume = p.volume;
    w.lastFetched = now;
    w.priceFetchFailed = false;
  }
  return { updated, missing };
}

/* Mirrors the client's recordPortfolioSnapshot()/aggregateAllHoldings() math,
   so a snapshot taken server-side looks identical to one taken by clicking
   "Fetch live prices" in the browser — same schema, same USD normalization. */
export function computeYearSnapshot(yd: any, fxRate: number) {
  const map: Record<string, { value: number; invested: number; qty: number; price: number }> = {};
  const platforms: Record<string, { totalValue: number; totalInvested: number; totalPl: number }> = {};
  let totalValue = 0, totalInvested = 0;
  for (const inv of yd?.investments || []) {
    const isINR = inv.currency === 'INR';
    let platValue = 0, platInvested = 0;
    for (const h of inv.holdings || []) {
      if (!h.symbol || h.status === 'closed') continue;
      const q = Number(h.qty) || 0;
      const avgUSD = isINR ? (Number(h.avgPrice) || 0) / fxRate : (Number(h.avgPrice) || 0);
      const curUSD = isINR ? (Number(h.currentPrice) || 0) / fxRate : (Number(h.currentPrice) || 0);
      const sym = h.symbol.toUpperCase();
      const value = q * curUSD, invested = q * avgUSD;
      totalValue += value;
      totalInvested += invested;
      platValue += value;
      platInvested += invested;
      if (!map[sym]) map[sym] = { value: 0, invested: 0, qty: 0, price: curUSD };
      map[sym].value += value;
      map[sym].invested += invested;
      map[sym].qty += q;
      map[sym].price = curUSD;
    }
    if (inv.id) platforms[inv.id] = { totalValue: platValue, totalInvested: platInvested, totalPl: platValue - platInvested };
  }
  return { totalValue, totalInvested, totalPl: totalValue - totalInvested, holdings: map, platforms };
}

export function recordSnapshotsForAllYears(DATA: any, fxRate: number, today = new Date().toISOString().slice(0, 10)) {
  for (const yearKey of Object.keys(DATA)) {
    if (!isYearKey(yearKey)) continue;
    const yd = DATA[yearKey];
    if (!yd?.investments?.length) continue;
    if (!Array.isArray(yd.portfolioSnapshots)) yd.portfolioSnapshots = [];
    const snap = computeYearSnapshot(yd, fxRate);
    yd.portfolioSnapshots = yd.portfolioSnapshots
      .filter((s: any) => s.date !== today)
      .concat([{ date: today, ...snap }])
      .slice(-365);
  }
}

/* ---------------- Main ---------------- */
export async function runRefresh() {
  try {
    // 1) Read once, only to learn WHICH symbols to fetch. Nothing is written yet.
    const first = await loadRow(DATA_KEY);
    if (!first) {
      console.error('daily-price-refresh: no ledger data found for LEDGER_ID', LEDGER_ID);
      return;
    }
    const symbols = Array.from(collectTargets(parseData(first.data_json)));
    if (!symbols.length) {
      console.log('daily-price-refresh: nothing to refresh (no open holdings or watchlist tickers)');
      return;
    }

    // 2) Slow part: fetch prices. The ledger is NOT held in memory during this.
    const { prices, failed } = await fetchAllPrices(symbols);
    if (prices.size === 0) {
      console.error(`daily-price-refresh: every price lookup failed (${failed.length}) — leaving ledger and timestamp untouched`);
      return;
    }

    // 3) Re-read the ledger FRESH, apply only prices, write with compare-and-swap.
    let written = false;
    let updated = 0, missing = 0;
    let fxRate: number | null = null;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS && !written; attempt++) {
      const row = await loadRow(DATA_KEY);
      if (!row) throw new Error('ledger row disappeared during refresh');
      const DATA = parseData(row.data_json);
      const res = applyPrices(DATA, prices);
      updated = res.updated; missing = res.missing;
      if (fxRate === null) fxRate = await fetchUsdInrRate(DATA);
      recordSnapshotsForAllYears(DATA, fxRate);
      written = await conditionalWrite(DATA_KEY, DATA, row.updated_at);
      if (!written) {
        console.log(`daily-price-refresh: ledger changed while refreshing (attempt ${attempt}/${WRITE_ATTEMPTS}) — re-reading`);
        await sleep(300 * attempt);
      }
    }
    if (!written) {
      console.error('daily-price-refresh: gave up after repeated concurrent edits — nothing written; will retry on next schedule');
      return;
    }

    await upsertKey(TIMESTAMP_KEY, new Date().toISOString());
    console.log(`daily-price-refresh: done. holdings updated=${updated} unavailable=${missing} symbolsFailed=${failed.length}${failed.length ? ' (' + failed.join(',') + ')' : ''}`);
  } catch (e) {
    console.error('daily-price-refresh: fatal error', String(e));
  }
}

Deno.serve(async (_req: Request) => {
  // Acknowledge immediately so pg_net's timeout never trips, then do the
  // actual (potentially slow) work in the background.
  // @ts-ignore — EdgeRuntime is a Supabase-provided global, not a Deno type
  EdgeRuntime.waitUntil(runRefresh());

  return new Response(JSON.stringify({ status: 'started' }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
