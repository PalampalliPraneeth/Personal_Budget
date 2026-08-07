// Supabase Edge Function: daily-price-refresh
// -------------------------------------------------------------------------
// Runs on a schedule (via pg_cron, set up in the SQL Editor — see the SQL
// block in this folder's README) rather than being called from the browser.
// It loads your ledger data directly from the ledger_data table, fetches a
// fresh price for every open holding, writes the updated data back, and
// stamps ledger:pricesUpdatedAt:v1 with the current time — which is what
// tab-holdings.js reads to show "Prices last refreshed: ...".
//
// Because this writes to your data with full access (not just your own
// read/write via the anon key), it uses the SUPABASE_SERVICE_ROLE_KEY that
// Supabase automatically provides to every Edge Function — no secret to
// configure. Unlike fetch-price, this function is NOT meant to be called
// from the browser, so JWT verification stays ON (the default) and the
// pg_cron job authenticates with the service role key instead.
//
// IMPORTANT: LEDGER_ID below must exactly match the LEDGER_ID constant in
// your storage-bridge.js.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const LEDGER_ID = 'the-ledger-main-7663'; // ← change if your storage-bridge.js uses a different value
const DATA_KEY = 'ledger:data:v1';
const TIMESTAMP_KEY = 'ledger:pricesUpdatedAt:v1';

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

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey);

  const { data: row, error } = await sb
    .from('ledger_data')
    .select('data_json')
    .eq('user_id', LEDGER_ID)
    .eq('data_key', DATA_KEY)
    .maybeSingle();

  if (error || !row) {
    return new Response(JSON.stringify({ error: 'No ledger data found for this LEDGER_ID' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
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
        } catch (_e) {
          failed++;
        }
        await sleep(250); // stay polite to Yahoo's rate limits
      }
    }
  }

  await sb.from('ledger_data').upsert(
    { user_id: LEDGER_ID, data_key: DATA_KEY, data_json: DATA, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,data_key' },
  );

  await sb.from('ledger_data').upsert(
    {
      user_id: LEDGER_ID,
      data_key: TIMESTAMP_KEY,
      data_json: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,data_key' },
  );

  return new Response(JSON.stringify({ updated, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
