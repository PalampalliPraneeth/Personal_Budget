// Supabase Edge Function: fetch-price (+ sector lookup)
// -------------------------------------------------------------------------
// Two modes on the same function/URL, so no new deployment is needed for
// the sector pie chart in Investments:
//   ?symbol=AAPL                  -> price + day change (unchanged, default)
//   ?symbol=AAPL&mode=sector      -> { sector, industry } from Yahoo's
//                                     assetProfile module. Works well for
//                                     stocks/ETFs; mutual funds often don't
//                                     have a single sector (they hold many),
//                                     so expect null there — the client
//                                     falls back to grouping those under
//                                     "Diversified / Fund" rather than
//                                     erroring.

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function handleSector(symbol: string): Promise<Response> {
  const target = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile`;
  const res = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    return json({ error: `Yahoo Finance returned ${res.status} ${res.statusText}`, yahooBodySnippet: bodyText.slice(0, 300) }, 502);
  }
  let data: any;
  try { data = JSON.parse(bodyText); } catch {
    return json({ error: 'Non-JSON response from Yahoo (likely a block page)', yahooBodySnippet: bodyText.slice(0, 300) }, 502);
  }
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile;
  const sector = profile?.sector ?? null;
  const industry = profile?.industry ?? null;
  return json({ symbol, sector, industry });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol');
    const mode = url.searchParams.get('mode');
    if (!symbol) {
      return json({ error: 'symbol query param is required' }, 400);
    }
    if (mode === 'sector') {
      return await handleSector(symbol);
    }

    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
      },
    });

    const bodyText = await res.text(); // read as text first so we can inspect it either way

    if (!res.ok) {
      // Surface exactly what Yahoo said, so we know if it's a block, a rate
      // limit, or something else — instead of a generic 502.
      return json({
        error: `Yahoo Finance returned ${res.status} ${res.statusText}`,
        yahooBodySnippet: bodyText.slice(0, 300),
      }, 502);
    }

    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return json({
        error: 'Yahoo Finance returned a 200 but the body was not JSON (likely a block page)',
        yahooBodySnippet: bodyText.slice(0, 300),
      }, 502);
    }

    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? null;
    const prevClose = meta?.previousClose ?? meta?.chartPreviousClose ?? null;

    if (typeof price !== 'number' || price <= 0) {
      return json({
        error: 'No price found for that symbol',
        chartError: data?.chart?.error ?? null,
      }, 404);
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
