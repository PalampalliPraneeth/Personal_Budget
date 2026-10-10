// Supabase Edge Function: broker-sync
// -------------------------------------------------------------------------
// Fetches your CURRENT holdings (and today's delivery trades) from Zerodha
// (Kite Connect Personal API, free) and Angel One (SmartAPI, free) and stores
// a SNAPSHOT for the app to review. It never edits your ledger itself -- the
// app shows the differences and only changes holdings when you press Apply.
//
// Why snapshots and not full history: both brokers' APIs only return TODAY's
// trades. Full buy/sell history comes from the tradebook FILE import in the
// app (Data tab).
//
// DEPLOY WITH JWT CHECK OFF (the Zerodha login redirect is a plain browser
// navigation and can't carry a Supabase auth header):
//   supabase functions deploy broker-sync --no-verify-jwt
// The only action that does anything sensitive without a login flow is
// `sync`, and it needs the x-sync-secret header.
//
// SECRETS (Project Settings > Edge Functions > Secrets):
//   BROKER_SYNC_SECRET    long random string; the cron job sends it
//   ZERODHA_API_KEY, ZERODHA_API_SECRET        (Kite Connect "Personal" app)
//   ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET
//   SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY   (Robinhood, via a free SnapTrade *Personal* account:
//        connect Robinhood in the SnapTrade dashboard, then copy the Personal API key from
//        https://dashboard.snaptrade.com/api-key). Robinhood has no official API; SnapTrade is the safe route.
//   (optional) SNAPTRADE_ACCOUNT_MATCH  regex of the account/institution name to read (default: robinhood)
//   (optional) SNAPTRADE_API_PREFIX     default /api/v1 (falls back to no prefix automatically)
//   (optional) ANGEL_BASE_URL   default https://apiconnect.angelone.in
//   (optional) ANGEL_PUBLIC_IP  the static IP you registered with Angel One (sent in X-ClientPublicIP)
//
// ZERODHA REDIRECT URL (Kite developer console) -- use the plain function URL:
//   https://<project-ref>.supabase.co/functions/v1/broker-sync
//   Kite adds ?request_token=...&status=success itself; the function recognises
//   that as the login callback. (The longer ...?op=zerodha_callback form also works.)
//
// LEDGER_ID must match the LEDGER_ID constant in storage-bridge.js.

const LEDGER_ID = 'the-ledger-main-7663';
const FETCH_TIMEOUT_MS = 12000;
const KITE_BASE = 'https://api.kite.trade';
const KITE_LOGIN = 'https://kite.zerodha.com/connect/login';

const env = (k: string): string => (Deno.env.get(k) ?? '').trim();
const SUPABASE_URL = () => env('SUPABASE_URL');
const SERVICE_KEY = () => env('SUPABASE_SERVICE_ROLE_KEY');
const restHeaders = () => ({
  apikey: SERVICE_KEY(),
  Authorization: `Bearer ${SERVICE_KEY()}`,
  'Content-Type': 'application/json',
});

/* ---------------------------------------------------------------- helpers */
export async function fetchT(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

/* RFC 6238 TOTP (HMAC-SHA1, 30s step). Angel One needs the 6-digit code. */
export async function totp(secretB32: string, nowMs: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32) as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/* Kite tokens are flushed around 06:00 IST every day (= 00:30 UTC). */
export function nextKiteExpiry(nowMs: number): string {
  const d = new Date(nowMs);
  let exp = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30, 0);
  if (nowMs >= exp) exp += 24 * 3600 * 1000;
  return new Date(exp).toISOString();
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n = (v: unknown): number => { const x = parseFloat(String(v ?? '')); return isNaN(x) ? 0 : x; };
const pick = (o: any, ...keys: string[]) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

/* ------------------------------------------------------- Supabase storage */
async function loadRow(key: string) {
  const url = `${SUPABASE_URL()}/rest/v1/ledger_data?user_id=eq.${encodeURIComponent(LEDGER_ID)}&data_key=eq.${encodeURIComponent(key)}&select=data_json,updated_at`;
  const res = await fetchT(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`REST select failed: ${res.status}`);
  const rows = await res.json();
  return rows?.[0] ?? null;
}
async function upsertKey(key: string, value: unknown) {
  const url = `${SUPABASE_URL()}/rest/v1/ledger_data?on_conflict=user_id,data_key`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { ...restHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: LEDGER_ID, data_key: key, data_json: value, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error(`REST upsert failed for ${key}: ${res.status}`);
}
/* tokens live in their own table that the browser's anon key cannot read
   (RLS on, no policies -- see broker-sync-setup.sql) */
async function loadToken(broker: string): Promise<{ access_token: string; expires_at: string } | null> {
  const url = `${SUPABASE_URL()}/rest/v1/broker_tokens?broker=eq.${encodeURIComponent(broker)}&select=access_token,expires_at`;
  const res = await fetchT(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`token select failed: ${res.status}`);
  const rows = await res.json();
  return rows?.[0] ?? null;
}
async function saveToken(broker: string, accessToken: string, expiresAt: string) {
  const url = `${SUPABASE_URL()}/rest/v1/broker_tokens?on_conflict=broker`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { ...restHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ broker, access_token: accessToken, expires_at: expiresAt, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error(`token save failed: ${res.status}`);
}

const snapKey = (b: string) => `ledger:broker:${b}:v1`;
const statusKey = (b: string) => `ledger:broker:${b}:status:v1`;
async function writeStatus(broker: string, status: string, message: string) {
  try { await upsertKey(statusKey(broker), { status, message, at: new Date().toISOString() }); } catch (_) { /* best effort */ }
}

/* ---------------------------------------------------------------- Zerodha */
export function normalizeZerodhaHoldings(data: any[]): any[] {
  return (Array.isArray(data) ? data : [])
    .map((h) => ({
      symbol: String(h.tradingsymbol ?? '').trim(),
      exchange: h.exchange ?? null,
      isin: h.isin ?? null,
      qty: n(h.quantity) + n(h.t1_quantity),
      avgPrice: n(h.average_price),
      lastPrice: n(h.last_price),
      collateral: n(h.collateral_quantity),
    }))
    .filter((h) => h.symbol && h.qty > 0);
}
export function normalizeZerodhaTrades(data: any[]): any[] {
  return (Array.isArray(data) ? data : [])
    .map((t) => ({
      ref: t.trade_id != null ? String(t.trade_id) : null,
      orderRef: t.order_id != null ? String(t.order_id) : null,
      symbol: String(t.tradingsymbol ?? '').trim(),
      exchange: t.exchange ?? null,
      type: String(t.transaction_type ?? '').toLowerCase(),
      qty: n(t.quantity),
      price: n(t.average_price ?? t.price),
      time: String(t.fill_timestamp ?? t.exchange_timestamp ?? t.order_timestamp ?? ''),
      product: t.product ?? null,
    }))
    .filter((t) => t.symbol && t.ref && t.qty > 0 && t.price > 0 && (t.type === 'buy' || t.type === 'sell'));
}

export async function zerodhaExchangeToken(requestToken: string): Promise<string> {
  const apiKey = env('ZERODHA_API_KEY'), secret = env('ZERODHA_API_SECRET');
  if (!apiKey || !secret) throw new Error('ZERODHA_API_KEY / ZERODHA_API_SECRET secrets are not set');
  const checksum = await sha256Hex(apiKey + requestToken + secret);
  const res = await fetchT(`${KITE_BASE}/session/token`, {
    method: 'POST',
    headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  const tok = body?.data?.access_token;
  if (!res.ok || !tok) throw new Error(`Zerodha login failed: ${body?.message ?? res.status}`);
  return tok;
}
async function kiteGet(path: string, accessToken: string) {
  const res = await fetchT(`${KITE_BASE}${path}`, {
    headers: { 'X-Kite-Version': '3', Authorization: `token ${env('ZERODHA_API_KEY')}:${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zerodha ${path}: ${body?.message ?? res.status}${body?.error_type === 'TokenException' ? ' (login expired)' : ''}`);
  return body?.data ?? [];
}

export async function syncZerodha(): Promise<{ ok: boolean; message: string }> {
  const tok = await loadToken('zerodha');
  if (!tok || new Date(tok.expires_at).getTime() <= Date.now()) {
    await writeStatus('zerodha', 'login_required', 'Zerodha login expired — use "Log in to Zerodha & sync" in the app');
    return { ok: false, message: 'login required' };
  }
  try {
    const holdings = normalizeZerodhaHoldings(await kiteGet('/portfolio/holdings', tok.access_token));
    let trades: any[] = [], tradesError: string | null = null;
    try { trades = normalizeZerodhaTrades(await kiteGet('/trades', tok.access_token)); } catch (e) { tradesError = String(e); }
    await upsertKey(snapKey('zerodha'), { broker: 'zerodha', fetchedAt: new Date().toISOString(), holdings, trades, tradesError });
    await writeStatus('zerodha', 'ok', `${holdings.length} holdings`);
    return { ok: true, message: `${holdings.length} holdings, ${trades.length} trades today` };
  } catch (e) {
    const msg = String(e);
    await writeStatus('zerodha', /login expired|TokenException/.test(msg) ? 'login_required' : 'error', msg.slice(0, 200));
    return { ok: false, message: msg };
  }
}

/* -------------------------------------------------------------- Angel One */
const angelBase = () => env('ANGEL_BASE_URL') || 'https://apiconnect.angelone.in';
const angelHeaders = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  // optional: set ANGEL_PUBLIC_IP to the static IP you registered with Angel One (and ANGEL_LOCAL_IP / ANGEL_MAC if you like)
  'X-ClientLocalIP': env('ANGEL_LOCAL_IP') || '127.0.0.1',
  'X-ClientPublicIP': env('ANGEL_PUBLIC_IP') || '127.0.0.1',
  'X-MACAddress': env('ANGEL_MAC') || '00:00:00:00:00:00',
  'X-PrivateKey': env('ANGEL_API_KEY'),
  ...extra,
});
export function normalizeAngelHoldings(data: any): any[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.holdings) ? data.holdings : [];
  return list
    .map((h: any) => ({
      symbol: String(pick(h, 'tradingsymbol', 'tradingSymbol') ?? '').trim(),
      exchange: pick(h, 'exchange') ?? null,
      isin: pick(h, 'isin') ?? null,
      qty: n(pick(h, 'quantity', 'qty')) + n(pick(h, 't1quantity', 't1Quantity', 't1_quantity')),
      avgPrice: n(pick(h, 'averageprice', 'averagePrice', 'average_price')),
      lastPrice: n(pick(h, 'ltp', 'lastPrice', 'last_price')),
      collateral: n(pick(h, 'collateralquantity', 'collateral_quantity')),
    }))
    .filter((h: any) => h.symbol && h.qty > 0);
}
export function normalizeAngelTrades(data: any, todayIso: string): any[] {
  const list = Array.isArray(data) ? data : [];
  return list
    .map((t: any) => {
      const ft = String(pick(t, 'filltime', 'fillTime') ?? '');
      return {
        ref: pick(t, 'fillid', 'fillId') != null ? String(pick(t, 'fillid', 'fillId')) : null,
        orderRef: pick(t, 'orderid', 'orderId') != null ? String(pick(t, 'orderid', 'orderId')) : null,
        symbol: String(pick(t, 'tradingsymbol', 'tradingSymbol') ?? '').trim(),
        exchange: pick(t, 'exchange') ?? null,
        type: String(pick(t, 'transactiontype', 'transactionType') ?? '').toLowerCase(),
        qty: n(pick(t, 'fillsize', 'fillSize', 'quantity')),
        price: n(pick(t, 'fillprice', 'fillPrice', 'price')),
        time: /^\d{4}-\d{2}-\d{2}/.test(ft) ? ft : `${todayIso} ${ft || '00:00:00'}`,
        product: pick(t, 'producttype', 'productType') ?? null,
      };
    })
    .filter((t: any) => t.symbol && t.ref && t.qty > 0 && t.price > 0 && (t.type === 'buy' || t.type === 'sell'));
}

export async function angelLogin(nowMs = Date.now()): Promise<string> {
  const cc = env('ANGEL_CLIENT_CODE'), pin = env('ANGEL_PIN'), sec = env('ANGEL_TOTP_SECRET');
  if (!env('ANGEL_API_KEY') || !cc || !pin || !sec) throw new Error('Angel One secrets are not fully set (ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET)');
  const res = await fetchT(`${angelBase()}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: angelHeaders(),
    body: JSON.stringify({ clientcode: cc, password: pin, totp: await totp(sec, nowMs) }),
  });
  const body = await res.json().catch(() => ({}));
  const jwt = body?.data?.jwtToken;
  if (!res.ok || !body?.status || !jwt) throw new Error(`Angel One login failed: ${body?.message ?? res.status}${body?.errorcode ? ' [' + body.errorcode + ']' : ''}`);
  return jwt;
}
async function angelGet(path: string, jwt: string) {
  const res = await fetchT(`${angelBase()}${path}`, { headers: angelHeaders({ Authorization: `Bearer ${jwt}` }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === false) throw new Error(`Angel One ${path}: ${body?.message ?? res.status}`);
  return body?.data ?? [];
}

export async function syncAngel(): Promise<{ ok: boolean; message: string }> {
  try {
    const jwt = await angelLogin();
    const holdings = normalizeAngelHoldings(await angelGet('/rest/secure/angelbroking/portfolio/v1/getAllHolding', jwt));
    const todayIso = new Date().toISOString().slice(0, 10);
    // the trade book can count as an "order" API (static-IP rules); holdings are still useful without it
    let trades: any[] = [], tradesError: string | null = null;
    try { trades = normalizeAngelTrades(await angelGet('/rest/secure/angelbroking/order/v1/getTradeBook', jwt), todayIso); } catch (e) { tradesError = String(e); }
    await upsertKey(snapKey('angelone'), { broker: 'angelone', fetchedAt: new Date().toISOString(), holdings, trades, tradesError });
    await writeStatus('angelone', 'ok', `${holdings.length} holdings`);
    return { ok: true, message: `${holdings.length} holdings, ${trades.length} trades today` };
  } catch (e) {
    const msg = String(e);
    await writeStatus('angelone', 'error', msg.slice(0, 200));
    return { ok: false, message: msg };
  }
}

/* ------------------------------------------------- Robinhood (via SnapTrade) */
/* SnapTrade Personal API key: signed requests, NO userId / userSecret (SnapTrade resolves the user from the key).
   Signature = base64( HMAC-SHA256( consumerKey, canonicalJSON({content, path, query}) ) ) -- exactly as documented at
   https://docs.snaptrade.com/docs/request-signatures (keys sorted at every level, no whitespace, content=null for GET). */
const SNAP_BASE = () => env('SNAPTRADE_BASE_URL') || 'https://api.snaptrade.com';

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}
export async function hmacSha256B64(message: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  let bin = ''; for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
export async function snapSignature(path: string, query: string, body: unknown, consumerKey: string): Promise<string> {
  return hmacSha256B64(canonicalJson({ content: body === undefined ? null : body, path, query }), consumerKey);
}

type SnapState = { prefix: string | null };
async function snapGet(st: SnapState, path: string, params: Record<string, string | number> = {}): Promise<any> {
  const clientId = env('SNAPTRADE_CLIENT_ID'), key = env('SNAPTRADE_CONSUMER_KEY');
  if (!clientId || !key) throw new Error('SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY secrets are not set');
  const first = env('SNAPTRADE_API_PREFIX') || '/api/v1';
  const prefixes = st.prefix !== null ? [st.prefix] : (first === '' ? [''] : [first, '']);
  let lastErr: Error | null = null;
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    let query = `clientId=${encodeURIComponent(clientId)}&timestamp=${Math.floor(Date.now() / 1000)}`;
    for (const [k, v] of Object.entries(params)) query += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
    const fullPath = `${prefix}${path}`;
    const signature = await snapSignature(fullPath, query, null, key);       // signs the exact path + query that is sent
    const res = await fetchT(`${SNAP_BASE()}${fullPath}?${query}`, { headers: { Signature: signature, Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404 && i < prefixes.length - 1) { lastErr = new Error(`SnapTrade ${path}: 404`); continue; }     // legacy /api/v1 prefix gone -> try the root path
    if (!res.ok) throw new Error(`SnapTrade ${path}: ${res.status} ${body?.detail ?? body?.message ?? ''}`.trim());
    st.prefix = prefix;
    return body;
  }
  throw lastErr ?? new Error(`SnapTrade ${path}: failed`);
}

export function normalizeSnapPositions(body: any): any[] {
  const list = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
  const out: any[] = [];
  for (const p of list) {
    if (!p || p.cash_equivalent === true) continue;
    let symbol = '', kind = 'stock', currency: string | null = null, qty = 0;
    if (p.instrument) {                                            // current shape: results[].instrument
      kind = String(p.instrument.kind ?? 'stock'); symbol = String(p.instrument.symbol ?? '');
      currency = p.currency ?? p.instrument.currency ?? null; qty = n(p.units);
    } else {                                                       // older shape: symbol.symbol.symbol
      const sy = p.symbol?.symbol ?? p.symbol;
      symbol = String((typeof sy === 'string' ? sy : (sy?.symbol ?? sy?.raw_symbol)) ?? '');
      const t = sy?.type?.code; kind = t === 'crypto' ? 'crypto' : t === 'et' ? 'etf' : t === 'ad' ? 'adr' : t === 'cef' ? 'cef' : 'stock';
      currency = p.currency?.code ?? null; qty = n(p.units) + n(p.fractional_units);
    }
    if (!['stock', 'etf', 'adr', 'cef'].includes(kind) || !symbol || !(qty > 0)) continue;      // options, crypto, cash, futures are not holdings here
    out.push({ symbol, exchange: null, qty, avgPrice: n(p.cost_basis ?? p.average_purchase_price), lastPrice: n(p.price), currency });
  }
  return out;
}
export function mergeHoldings(list: any[]): any[] {
  const m = new Map<string, any>();
  for (const h of list) {
    const cur = m.get(h.symbol);
    if (!cur) { m.set(h.symbol, { ...h }); continue; }
    const q = cur.qty + h.qty;
    cur.avgPrice = q > 0 ? (cur.qty * cur.avgPrice + h.qty * h.avgPrice) / q : 0;
    cur.qty = q; cur.lastPrice = h.lastPrice || cur.lastPrice;
  }
  return Array.from(m.values());
}

const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/* A timestamp at exactly 00:00:00 means the broker only gave a DATE -> keep that date. A real time of day is turned into the
   New York date (Robinhood trades are US market time), so an evening trade never lands on the next day. */
export function snapDate(ts: unknown): { date: string; time: string | null } | null {
  if (typeof ts !== 'string' || !ts) return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  if (!m[2] || (m[2] === '00' && m[3] === '00' && m[4] === '00')) return { date: m[1], time: null };
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: m[1], time: null };
  return { date: NY_DATE.format(d), time: d.toISOString() };
}
export function normalizeSnapActivities(list: any[]): any[] {
  const out: any[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || a.option_symbol) continue;
    const type = String(a.type ?? '').toUpperCase();
    const sym = String(a.symbol?.symbol ?? a.symbol?.raw_symbol ?? '');
    if (!sym) continue;
    const d = snapDate(a.trade_date) ?? snapDate(a.settlement_date);
    if (!d) continue;
    const units = Math.abs(n(a.units)); let price = n(a.price); const amount = n(a.amount);
    const base = { id: a.id ? String(a.id) : null, symbol: sym, date: d.date, time: d.time, currency: a.currency?.code ?? null, fee: n(a.fee) };
    if (type === 'BUY' || type === 'SELL' || type === 'REI') {      // REI = dividend reinvested into shares, i.e. a buy
      if (!(price > 0) && units > 0 && amount) price = Math.abs(amount) / units;
      if (!(units > 0 && price > 0)) continue;
      out.push({ ...base, type: type === 'SELL' ? 'sell' : 'buy', qty: units, price, amount });
    } else if (type === 'DIVIDEND') {
      if (!(amount > 0)) continue;
      out.push({ ...base, type: 'dividend', qty: units > 0 ? units : null, price: price > 0 ? price : null, amount });
    }
  }
  return out;
}
async function snapActivities(st: SnapState, accountId: string): Promise<any[]> {
  const all: any[] = []; let offset = 0;
  for (let page = 0; page < 40; page++) {                          // 40 x 1000 = far more history than any personal account
    const body = await snapGet(st, `/accounts/${accountId}/activities`, { offset, limit: 1000, type: 'BUY,SELL,DIVIDEND,REI' });
    const data = Array.isArray(body?.data) ? body.data : [];
    all.push(...data); offset += data.length;
    if (!data.length || offset >= n(body?.pagination?.total)) break;
  }
  return all;
}

export async function syncRobinhood(): Promise<{ ok: boolean; message: string }> {
  try {
    const st: SnapState = { prefix: null };
    const accounts = await snapGet(st, '/accounts');
    const rx = new RegExp(env('SNAPTRADE_ACCOUNT_MATCH') || 'robinhood', 'i');
    const mine = (Array.isArray(accounts) ? accounts : []).filter((a: any) => a?.id && rx.test(String(a.institution_name ?? '') + ' ' + String(a.name ?? '')));
    if (!mine.length) throw new Error('No Robinhood account found in SnapTrade - connect Robinhood in the SnapTrade dashboard first');
    let holdings: any[] = [], raw: any[] = [];
    for (const a of mine) {
      let pos: any;
      try { pos = await snapGet(st, `/accounts/${a.id}/positions/all`); }
      catch (e) { if (String(e).includes('404')) pos = await snapGet(st, `/accounts/${a.id}/positions`); else throw e; }
      holdings = holdings.concat(normalizeSnapPositions(pos));
      raw = raw.concat(await snapActivities(st, a.id));
    }
    const merged = mergeHoldings(holdings);
    const activities = normalizeSnapActivities(raw).slice(0, 30000);
    await upsertKey(snapKey('robinhood'), { broker: 'robinhood', fetchedAt: new Date().toISOString(), holdings: merged, activities, accounts: mine.map((a: any) => ({ id: a.id, name: a.name ?? null })) });
    await writeStatus('robinhood', 'ok', `${merged.length} holdings, ${activities.length} history lines`);
    return { ok: true, message: `${merged.length} holdings, ${activities.length} history lines` };
  } catch (e) {
    const msg = String(e);
    await writeStatus('robinhood', 'error', msg.slice(0, 200));
    return { ok: false, message: msg };
  }
}

/* ------------------------------------------------------------ HTTP routes */
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const page = (title: string, msg: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui;max-width:520px;margin:12vh auto;padding:0 20px;line-height:1.5"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let op = url.searchParams.get('op') ?? '';
  // Kite redirects to the registered URL with request_token + status; accept that with no ?op=
  if (!op && url.searchParams.has('request_token') && url.searchParams.has('status')) op = 'zerodha_callback';

  if (op === 'zerodha_login') {
    const key = env('ZERODHA_API_KEY');
    if (!key) return page('Not set up', 'ZERODHA_API_KEY secret is missing.', 500);
    return new Response(null, { status: 302, headers: { Location: `${KITE_LOGIN}?v=3&api_key=${encodeURIComponent(key)}` } });
  }

  if (op === 'zerodha_callback') {
    const rt = url.searchParams.get('request_token');
    if (url.searchParams.get('status') !== 'success' || !rt) return page('Zerodha login was not completed', 'Go back to the app and try again.', 400);
    try {
      const token = await zerodhaExchangeToken(rt);
      await saveToken('zerodha', token, nextKiteExpiry(Date.now()));
      const r = await syncZerodha();
      return page(r.ok ? 'Zerodha connected ✓' : 'Connected, but the sync had a problem', r.ok ? `${r.message}. You can close this tab and press “Review Zerodha holdings” in the app.` : r.message, r.ok ? 200 : 502);
    } catch (e) {
      return page('Zerodha login failed', String(e), 502);
    }
  }

  if (op === 'sync') {
    const secret = env('BROKER_SYNC_SECRET');
    const given = req.headers.get('x-sync-secret') ?? '';
    if (!secret || !constantTimeEqual(secret, given)) return json({ error: 'unauthorized' }, 401);
    const which = url.searchParams.get('broker') ?? 'all';
    const work = (async () => {
      const out: Record<string, unknown> = {};
      if (which === 'all' || which === 'zerodha') out.zerodha = await syncZerodha();
      if (which === 'all' || which === 'angelone') out.angelone = await syncAngel();
      if (which === 'all' || which === 'robinhood') out.robinhood = await syncRobinhood();
      console.log('broker-sync:', JSON.stringify(out));
    })().catch((e) => console.error('broker-sync fatal', String(e)));
    // @ts-ignore EdgeRuntime is a Supabase-provided global
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
    return json({ status: 'started' }, 202);
  }

  return json({ error: 'unknown op' }, 404);
}

// @ts-ignore Deno global
if (typeof Deno !== 'undefined' && (Deno as any).serve && !(globalThis as any).__BROKER_SYNC_TEST__) {
  (Deno as any).serve((req: Request) => handle(req));
}
