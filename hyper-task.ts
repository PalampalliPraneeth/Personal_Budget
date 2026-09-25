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

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Yahoo's quoteSummary endpoint (unlike the v8/chart price endpoint) requires
   a session cookie + matching "crumb" token. Cookies reportedly expire
   quickly and unpredictably, so we do this handshake fresh on every call
   rather than caching it — slower, but far less likely to silently break. */
async function getYahooCrumbAndCookie(): Promise<{ cookie: string; crumb: string }> {
  const cookieRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': YAHOO_UA },
    redirect: 'manual',
  });

  let cookies: string[] = [];
  // @ts-ignore — getSetCookie() exists on modern fetch Headers, may be missing from older type defs
  if (typeof cookieRes.headers.getSetCookie === 'function') {
    // @ts-ignore
    cookies = cookieRes.headers.getSetCookie();
  } else {
    const single = cookieRes.headers.get('set-cookie');
    if (single) cookies = [single];
  }
  if (!cookies.length) {
    throw new Error(`Step 1 failed: Yahoo gave no session cookie from fc.yahoo.com (status ${cookieRes.status})`);
  }
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YAHOO_UA, Cookie: cookieHeader },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 50 || crumb.includes('<')) {
    throw new Error(`Step 2 failed: getcrumb returned something invalid (status ${crumbRes.status}, body: ${crumb.slice(0, 80)})`);
  }

  return { cookie: cookieHeader, crumb };
}

async function handleSector(symbol: string): Promise<Response> {
  let cookie: string, crumb: string;
  try {
    ({ cookie, crumb } = await getYahooCrumbAndCookie());
  } catch (e) {
    return json({ error: `Crumb/cookie handshake failed: ${String(e)}` }, 502);
  }

  const target = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(target, {
    headers: {
      'User-Agent': YAHOO_UA,
      'Accept': 'application/json,text/plain,*/*',
      Cookie: cookie,
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

    // BUGFIX: the same Yahoo response already carries the 52-week range,
    // day range and volume, and the client (tab-holdings.js fetchLivePrice/
    // _extractPriceMeta, and Daily_Price_refresh.ts) reads all of these off
    // window.PRICE_PROXY_URL's response for the watchlist. Previously only
    // {symbol, price, changePct} were returned, so every watchlist row's
    // 52-week high/low, day range and volume stayed blank whenever this
    // proxy was used, even though the data was sitting right here.
    const numOrNull = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null);
    return json({
      symbol,
      price,
      changePct,
      prevClose: numOrNull(prevClose),
      fiftyTwoWeekHigh: numOrNull(meta?.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: numOrNull(meta?.fiftyTwoWeekLow),
      dayHigh: numOrNull(meta?.regularMarketDayHigh),
      dayLow: numOrNull(meta?.regularMarketDayLow),
      volume: numOrNull(meta?.regularMarketVolume),
    });
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
