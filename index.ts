// Supabase Edge Function: daily-price-refresh
// -------------------------------------------------------------------------
// Runs on a schedule (via pg_cron) rather than being called from the
// browser. Loads your ledger data, refreshes every open holding's price,
// writes it back, and stamps ledger:pricesUpdatedAt:v1 — which is what
// tab-holdings.js reads to show "Prices last refreshed: ...".
//
// NOTE: this version talks to Supabase's REST API directly via fetch()
// instead of importing @supabase/supabase-js. That import was the likely
// cause of "EarlyDrop" timeouts — resolving/compiling it on a cold start
// can itself take several seconds, enough to blow past pg_net's timeout
// before the handler even sends its first response. Plain fetch() has no
// import cost at all, so this removes that risk entirely.
//
// IMPORTANT: LEDGER_ID below must exactly match the LEDGER_ID constant in
// your storage-bridge.js.

const LEDGER_ID = 'the-ledger-main-7663'; // ← change if your storage-bridge.js uses a different value
const DATA_KEY = 'ledger:data:v1';
const TIMESTAMP_KEY = 'ledger:pricesUpdatedAt:v1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchYahooPrice(symbol: string, isIndian: boolean) {
  let yahooSym = symbol.toUpperCase().trim();
  if (isIndian && !yahooSym.endsWith('.NS') && !yahooSym.endsWith('.BO')) {
    yahooSym = yahooSym + '.NS';
  }
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  const res = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prevClose = meta?.previousClose ?? meta?.chartPreviousClose;
  if (typeof price !== 'number' || price <= 0) throw new Error('no price in response');
  const changePct =
    typeof prevClose === 'number' && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return { price, changePct };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRow() {
  const url =
    `${SUPABASE_URL}/rest/v1/ledger_data` +
    `?user_id=eq.${encodeURIComponent(LEDGER_ID)}&data_key=eq.${encodeURIComponent(DATA_KEY)}&select=data_json`;
  const res = await fetch(url, { headers: REST_HEADERS });
  if (!res.ok) throw new Error(`REST select failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function fetchUsdInrRate(): Promise<number> {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await res.json();
    const rate = data?.rates?.INR;
    if (typeof rate === 'number' && rate > 0) return rate;
  } catch (_e) { /* fall through to fallback */ }
  return 95.0; // matches the client's fallback in _ensureFx()
}

/* Mirrors the client's recordPortfolioSnapshot()/aggregateAllHoldings() math
   exactly, so a snapshot taken server-side looks identical to one taken by
   clicking "Fetch live prices" in the browser — same schema, same USD
   normalization. */
function computeYearSnapshot(yd: any, fxRate: number) {
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

function recordSnapshotsForAllYears(DATA: any, fxRate: number) {
  const today = new Date().toISOString().slice(0, 10);
  for (const yearKey of Object.keys(DATA)) {
    if (!/^\d+$/.test(yearKey)) continue;
    const yd = DATA[yearKey];
    if (!yd?.investments?.length) continue;
    if (!yd.portfolioSnapshots) yd.portfolioSnapshots = [];
    const snap = computeYearSnapshot(yd, fxRate);
    yd.portfolioSnapshots = yd.portfolioSnapshots
      .filter((s: any) => s.date !== today)
      .concat([{ date: today, ...snap }])
      .slice(-365);
  }
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

async function runRefresh() {
  try {
    const row = await loadRow();
    if (!row) {
      console.error('daily-price-refresh: no ledger data found for LEDGER_ID', LEDGER_ID);
      return;
    }

    let DATA = row.data_json;
    if (typeof DATA === 'string') DATA = JSON.parse(DATA);

    let updated = 0;
    let failed = 0;

    for (const yearKey of Object.keys(DATA)) {
      if (!/^\d+$/.test(yearKey)) continue; // skip non-year keys like paymentPlan
      const investments = DATA[yearKey]?.investments || [];
      for (const inv of investments) {
        const isIndian = inv.currency === 'INR';
        for (const h of inv.holdings || []) {
          if (!h.symbol || h.status === 'closed') continue;
          try {
            const { price, changePct } = await fetchYahooPrice(h.symbol, isIndian);
            h.currentPrice = price;
            h.dayChangePct = changePct;
            h.lastFetched = Date.now();
            updated++;
          } catch (e) {
            failed++;
            console.error('daily-price-refresh: failed for', h.symbol, String(e));
          }
          await sleep(250); // stay polite to Yahoo's rate limits
        }
      }
    }

    const fxRate = await fetchUsdInrRate();
    recordSnapshotsForAllYears(DATA, fxRate);

    await upsertKey(DATA_KEY, DATA);
    await upsertKey(TIMESTAMP_KEY, new Date().toISOString());

    console.log(`daily-price-refresh: done. updated=${updated} failed=${failed}`);
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
