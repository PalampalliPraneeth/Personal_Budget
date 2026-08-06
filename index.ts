// Supabase Edge Function: fetch-price
// -------------------------------------------------------------------------
// Runs on Supabase's servers, so the call to Yahoo Finance happens
// server-to-server — no browser CORS involved. The browser only ever talks
// to this function, which you own, and this function talks to Yahoo.
//
// Deploy (from your project root, with the Supabase CLI installed):
//   supabase functions deploy fetch-price --no-verify-jwt
//
// Then note the URL Supabase gives you, something like:
//   https://<project-ref>.functions.supabase.co/fetch-price
//
// Wire it into the app by setting this BEFORE tab-holdings.js loads
// (e.g. add one line near the top of storage-bridge.js, or a small inline
// <script> in index.html just above the tab-holdings.js <script> tag):
//   window.PRICE_PROXY_URL = 'https://<project-ref>.functions.supabase.co/fetch-price';
//
// If window.PRICE_PROXY_URL is never set, tab-holdings.js quietly falls
// back to the old public-CORS-proxy chain, so this is purely additive —
// nothing breaks if you don't deploy it.

const CORS_HEADERS: Record<string, string> = {
  // Tighten this to your actual site's origin once deployed, e.g.
  // 'Access-Control-Allow-Origin': 'https://your-ledger-domain.com',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
      return json({ error: 'symbol query param is required' }, 400);
    }

    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LedgerPriceBot/1.0)' },
    });

    if (!res.ok) {
      return json({ error: `Yahoo Finance returned ${res.status}` }, 502);
    }

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? null;
    const prevClose = meta?.previousClose ?? meta?.chartPreviousClose ?? null;

    if (typeof price !== 'number' || price <= 0) {
      return json({ error: 'No price found for that symbol' }, 404);
    }

    const changePct =
      typeof price === 'number' && typeof prevClose === 'number' && prevClose > 0
        ? ((price - prevClose) / prevClose) * 100
        : null;

    return json({ symbol, price, changePct });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
