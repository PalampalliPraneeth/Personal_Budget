// Supabase Edge Function: send-recurring-reminders
// -------------------------------------------------------------------------
// Runs on a schedule (via pg_cron — see the setup notes for the exact SQL).
// Loads your ledger data and, for every active recurring buy, checks
// whether its next occurrence is exactly 7, 3, or 1 day(s) away. Each of
// those is its own separate email (LEAD_DAYS below), grouped by platform
// and funding bank account, plus a forward-looking calendar of everything
// coming up over the next ~90 days. Sent to the address saved via
// notify-settings.js (Overview tab → "✉️ Reminders").
//
// Like daily-price-refresh, this talks to Supabase's REST API directly via
// fetch() rather than importing @supabase/supabase-js, to avoid cold-start
// import time eating into pg_net's timeout window. Email is sent via
// Resend's REST API (https://resend.com) — a single fetch call, no SDK.
//
// REQUIRED SECRETS (set with `supabase secrets set NAME=value`):
//   RESEND_API_KEY   — from resend.com's dashboard (free tier is enough for this)
//   REMINDER_FROM    — the "from" address. Must be on a domain you've verified
//                      in Resend, OR their shared sandbox address for testing —
//                      check your Resend dashboard for the exact current value,
//                      since sandbox sender addresses are Resend's to change,
//                      not something to hardcode here from memory.
//
// IMPORTANT: LEDGER_ID below must exactly match the LEDGER_ID constant in
// your storage-bridge.js.

const LEDGER_ID = 'the-ledger-main-7663'; // ← change if your storage-bridge.js uses a different value
const DATA_KEY = 'ledger:data:v1';
const EMAIL_KEY = 'notify:email';
const NOTIFIED_KEY = 'push:notifiedDates:v2'; // bumped from v1 — dedupe key now includes the lead-time bucket

const LEAD_DAYS = [7, 3, 1]; // how many days before a due date to send a reminder — one email per bucket
const FORWARD_LOOKING_DAYS = 90; // how far ahead the "Next recurring investments" calendar looks
const FORWARD_LOOKING_MAX_PER_PLAN = 6; // caps a weekly plan from dominating that calendar

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const REMINDER_FROM = Deno.env.get('REMINDER_FROM')!;

const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function loadKey(dataKey: string) {
  const url =
    `${SUPABASE_URL}/rest/v1/ledger_data` +
    `?user_id=eq.${encodeURIComponent(LEDGER_ID)}&data_key=eq.${encodeURIComponent(dataKey)}&select=data_json`;
  const res = await fetch(url, { headers: REST_HEADERS });
  if (!res.ok) throw new Error(`REST select failed for ${dataKey}: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const row = rows?.[0];
  if (!row) return null;
  if (typeof row.data_json !== 'string') return row.data_json; // already an object/array — nothing to parse
  try {
    return JSON.parse(row.data_json); // still JSON-encoded (e.g. the DATA blob) — unwrap it
  } catch {
    return row.data_json; // already a plain string (e.g. a bare email) — use it as-is
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

async function sendReminderEmail(to: string, subject: string, html: string, text: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: REMINDER_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

/* ---------------------------------------------------------------------
   Date logic below is a direct port of tab-holdings.js's
   _normalizedRecurring() / nextRecurringDate() / nextRecurringDateForPlan(),
   kept in lockstep so "due tomorrow" here matches what the Holdings and
   Overview tabs show in the browser. NOTE: this runs in UTC on the server,
   so right at your local midnight boundary it could be off by one day from
   what you see client-side — a fundamental limit of not knowing your
   timezone server-side, not a bug to chase further.
   --------------------------------------------------------------------- */
function toISODate(d: Date): string {
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function clampDayOfMonth(day: number, year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}
function nextRecurringDateFromDays(daysOfMonth: number[], today: Date): string | null {
  if (!daysOfMonth || !daysOfMonth.length) return null;
  const sorted = [...daysOfMonth].sort((a, b) => a - b);
  for (let i = 0; i < 25; i++) {
    const y = today.getUTCFullYear(), m = today.getUTCMonth() + i;
    for (const d of sorted) {
      const day = clampDayOfMonth(d, y, m);
      const candidate = new Date(Date.UTC(y, m, day));
      if (candidate >= today) return toISODate(candidate);
    }
  }
  return null;
}
function normalizedRecurring(r: any) {
  if (!r) return null;
  return { ...r, frequencyType: r.frequencyType || (r.daysOfMonth?.length ? 'daysOfMonth' : 'monthly') };
}
function nextRecurringDateForPlan(r: any, today: Date): string | null {
  const norm = normalizedRecurring(r);
  if (!norm) return null;
  if (norm.frequencyType === 'daysOfMonth') return nextRecurringDateFromDays(norm.daysOfMonth, today);
  if (!norm.startDate) return null;
  const start = new Date(norm.startDate + 'T00:00:00Z');
  if (norm.frequencyType === 'monthly' || norm.frequencyType === 'quarterly') {
    const monthStep = norm.frequencyType === 'quarterly' ? 3 : 1;
    const anchorDay = start.getUTCDate();
    for (let k = 0; k < 1000; k++) {
      const y = start.getUTCFullYear(), m = start.getUTCMonth() + k * monthStep;
      const day = clampDayOfMonth(anchorDay, y, m);
      const candidate = new Date(Date.UTC(y, m, day));
      if (candidate >= today) return toISODate(candidate);
    }
    return null;
  }
  const stepDays = norm.frequencyType === 'weekly' ? 7 : norm.frequencyType === 'biweekly' ? 14 : 1;
  if (start >= today) return toISODate(start);
  const diffDays = Math.floor((today.getTime() - start.getTime()) / 86400000);
  const stepsNeeded = Math.ceil(diffDays / stepDays);
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + stepsNeeded * stepDays);
  return toISODate(next);
}

/* Every occurrence of a recurring plan in [from, toExclusive), earliest
   first, capped at maxCount. Unlike nextRecurringDateForPlan() (which only
   ever returns the SINGLE next date), this powers the forward-looking
   "Next recurring investments" calendar — verified against known cases in
   testing (monthly, weekly, daysOfMonth, quarterly, and month-end
   clamping all match hand-computed expected dates). */
function occurrencesInRange(r: any, from: Date, toExclusive: Date, maxCount: number): string[] {
  const norm = normalizedRecurring(r);
  if (!norm) return [];
  const out: string[] = [];

  if (norm.frequencyType === 'daysOfMonth') {
    if (!norm.daysOfMonth?.length) return [];
    const sorted = [...norm.daysOfMonth].sort((a: number, b: number) => a - b);
    for (let i = 0; i < 36 && out.length < maxCount; i++) {
      const y = from.getUTCFullYear(), m = from.getUTCMonth() + i;
      if (new Date(Date.UTC(y, m, 1)) >= toExclusive) break;
      for (const d of sorted) {
        const day = clampDayOfMonth(d, y, m);
        const candidate = new Date(Date.UTC(y, m, day));
        if (candidate >= from && candidate < toExclusive) out.push(toISODate(candidate));
      }
    }
    return out.slice(0, maxCount);
  }

  if (!norm.startDate) return [];
  const start = new Date(norm.startDate + 'T00:00:00Z');

  if (norm.frequencyType === 'monthly' || norm.frequencyType === 'quarterly') {
    const monthStep = norm.frequencyType === 'quarterly' ? 3 : 1;
    const anchorDay = start.getUTCDate();
    for (let k = 0; k < 400 && out.length < maxCount; k++) {
      const y = start.getUTCFullYear(), m = start.getUTCMonth() + k * monthStep;
      const day = clampDayOfMonth(anchorDay, y, m);
      const candidate = new Date(Date.UTC(y, m, day));
      if (candidate >= toExclusive) break;
      if (candidate >= from) out.push(toISODate(candidate));
    }
    return out;
  }

  const stepDays = norm.frequencyType === 'weekly' ? 7 : norm.frequencyType === 'biweekly' ? 14 : 1;
  let cursor = new Date(start);
  if (cursor < from) {
    const diffDays = Math.floor((from.getTime() - cursor.getTime()) / 86400000);
    const stepsNeeded = Math.ceil(diffDays / stepDays);
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + stepsNeeded * stepDays);
  }
  while (cursor < toExclusive && out.length < maxCount) {
    out.push(toISODate(cursor));
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }
  return out;
}

/* ---------------------------------------------------------------------
   Money / funding-account helpers.
   --------------------------------------------------------------------- */
async function fetchUsdInrRate(): Promise<number> {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await res.json();
    const rate = data?.rates?.INR;
    if (typeof rate === 'number' && rate > 0) return rate;
  } catch (_e) { /* fall through to fallback */ }
  return 95.0; // matches the client's fallback in _ensureFx()
}
function convertAmount(amount: number, fromCurrency: string, toCurrency: string, fxRate: number): number {
  if (fromCurrency === toCurrency) return amount;
  if (fromCurrency === 'INR' && toCurrency === 'USD') return amount / fxRate;
  if (fromCurrency === 'USD' && toCurrency === 'INR') return amount * fxRate;
  return amount; // no other currency pairs exist in this app today
}
function fmtMoney(amount: number, currency: string): string {
  return `${currency === 'INR' ? '₹' : '$'}${amount.toFixed(2)}`;
}
function bankDisplayValueAt(bank: any, monthIdx: number): number {
  const v = bank?.m ? bank.m[monthIdx] : null;
  return v === null || v === undefined ? 0 : Number(v) || 0;
}
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type DueItem = {
  planId: string;
  symbol: string;
  platform: string;
  amount: number;
  currency: string;
  bankAccountId: string | null;
  bank: any | null;
};

type PlatformGroup = {
  platform: string;
  currency: string;
  totalNative: number;
  accounts: { bankName: string; bankCurrency: string; requiredNative: number; balanceNative: number }[];
  unlinkedNative: number;
  items: DueItem[];
};

/* Groups due items (already filtered to one lead-time bucket, e.g. all
   items due in exactly 7 days) by platform, then by funding bank account
   within each platform. This is the core structure both the HTML and text
   templates render from. */
function groupByPlatformAndAccount(items: DueItem[], fxRate: number, monthIdx: number): PlatformGroup[] {
  const byPlatform = new Map<string, {
    platform: string; currency: string; totalNative: number;
    accounts: Map<string, { bankName: string; bankCurrency: string; requiredNative: number; balanceNative: number }>;
    unlinkedNative: number; items: DueItem[];
  }>();

  for (const it of items) {
    if (!byPlatform.has(it.platform)) {
      byPlatform.set(it.platform, { platform: it.platform, currency: it.currency, totalNative: 0, accounts: new Map(), unlinkedNative: 0, items: [] });
    }
    const p = byPlatform.get(it.platform)!;
    p.totalNative += it.amount;
    p.items.push(it);

    if (!it.bankAccountId || !it.bank) {
      p.unlinkedNative += it.amount;
      continue;
    }
    const bankCurrency = it.bank.currency || 'USD';
    const requiredInBankCurrency = convertAmount(it.amount, it.currency, bankCurrency, fxRate);
    if (!p.accounts.has(it.bankAccountId)) {
      p.accounts.set(it.bankAccountId, {
        bankName: it.bank.name || 'Unnamed account',
        bankCurrency,
        requiredNative: 0,
        balanceNative: bankDisplayValueAt(it.bank, monthIdx),
      });
    }
    p.accounts.get(it.bankAccountId)!.requiredNative += requiredInBankCurrency;
  }

  return Array.from(byPlatform.values()).map(p => ({ ...p, accounts: Array.from(p.accounts.values()) }));
}

/* ---------------------------------------------------------------------
   Email templates.
   --------------------------------------------------------------------- */
function renderPlatformGroupsHtml(groups: PlatformGroup[]): string {
  return groups.map(p => {
    const accountsHtml = p.accounts.map(acc => {
      const ok = acc.balanceNative >= acc.requiredNative;
      const needLine = p.accounts.length > 1
        ? `<div>Needed from this account: <b>${fmtMoney(acc.requiredNative, acc.bankCurrency)}</b></div>` : '';
      const remainingLine = ok
        ? `<div>Remaining after investment: ${fmtMoney(acc.balanceNative - acc.requiredNative, acc.bankCurrency)}</div>` : '';
      const statusText = ok ? '✅ Funds available' : `⚠️ Add ${fmtMoney(acc.requiredNative - acc.balanceNative, acc.bankCurrency)}`;
      return `<div style="margin-top:8px; padding-top:8px; border-top:1px solid #e3ddcc; font-size:13px; color:#333;">
        ${needLine}
        <div>Funding account: <b>${escapeHtml(acc.bankName)}</b></div>
        <div>Available: ${fmtMoney(acc.balanceNative, acc.bankCurrency)}</div>
        <div style="color:${ok ? '#1a7f37' : '#b23b3b'}; font-weight:600;">Status: ${statusText}</div>
        ${remainingLine}
      </div>`;
    }).join('');

    const unlinkedHtml = p.unlinkedNative > 0.005
      ? `<div style="margin-top:8px; font-size:13px; color:#999;">${fmtMoney(p.unlinkedNative, p.currency)} — no funding account linked</div>` : '';

    const itemsHtml = p.items.map(it => `${escapeHtml(it.symbol)} — ${fmtMoney(it.amount, it.currency)}`).join('<br>');

    return `<div style="margin:14px 0; padding:14px 16px; background:#f7f5ef; border-radius:10px;">
      <div style="font-weight:700; font-size:15px; color:#1a1a1a;">${escapeHtml(p.platform)}</div>
      <div style="font-size:13px; color:#444; margin-top:2px;">Total required: <b>${fmtMoney(p.totalNative, p.currency)}</b></div>
      ${accountsHtml}
      ${unlinkedHtml}
      <div style="margin-top:10px; font-size:12.5px; color:#555;">${p.items.length > 1 ? 'Investments' : 'Investment'}:<br>${itemsHtml}</div>
    </div>`;
  }).join('');
}

function renderPlatformGroupsText(groups: PlatformGroup[]): string {
  return groups.map(p => {
    const lines: string[] = [];
    lines.push(p.platform);
    lines.push(`  Total required: ${fmtMoney(p.totalNative, p.currency)}`);
    p.accounts.forEach(acc => {
      const ok = acc.balanceNative >= acc.requiredNative;
      if (p.accounts.length > 1) lines.push(`  Needed from this account: ${fmtMoney(acc.requiredNative, acc.bankCurrency)}`);
      lines.push(`  Funding account: ${acc.bankName}`);
      lines.push(`  Available: ${fmtMoney(acc.balanceNative, acc.bankCurrency)}`);
      lines.push(`  Status: ${ok ? '✅ Funds available' : `⚠️ Add ${fmtMoney(acc.requiredNative - acc.balanceNative, acc.bankCurrency)}`}`);
      if (ok) lines.push(`  Remaining after investment: ${fmtMoney(acc.balanceNative - acc.requiredNative, acc.bankCurrency)}`);
    });
    if (p.unlinkedNative > 0.005) lines.push(`  ${fmtMoney(p.unlinkedNative, p.currency)} — no funding account linked`);
    lines.push(`  ${p.items.length > 1 ? 'Investments' : 'Investment'}:`);
    p.items.forEach(it => lines.push(`    ${it.symbol} — ${fmtMoney(it.amount, it.currency)}`));
    return lines.join('\n');
  }).join('\n\n');
}

type ForwardCalendar = { platform: string; currency: string; rows: { date: string; total: number }[] }[];

function renderForwardCalendarHtml(calendar: ForwardCalendar): string {
  if (!calendar.length) return '';
  const blocks = calendar.map(p => {
    const rows = p.rows.map(r =>
      `<tr><td style="padding:3px 16px 3px 0; color:#444;">${r.date}</td><td style="padding:3px 0; text-align:right;">${fmtMoney(r.total, p.currency)}</td></tr>`
    ).join('');
    return `<div style="margin:10px 0;">
      <div style="font-weight:600; font-size:13.5px; margin-bottom:2px;">${escapeHtml(p.platform)}</div>
      <table style="border-collapse:collapse; font-size:13px;"><tr><th style="text-align:left; color:#888; font-weight:500; padding:2px 16px 2px 0;">Date</th><th style="text-align:right; color:#888; font-weight:500;">Total</th></tr>${rows}</table>
    </div>`;
  }).join('');
  return `<h3 style="margin:22px 0 4px; font-size:15px;">📆 Next recurring investments</h3>${blocks}`;
}

function renderForwardCalendarText(calendar: ForwardCalendar): string {
  if (!calendar.length) return '';
  const blocks = calendar.map(p => {
    const rows = p.rows.map(r => `  ${r.date}\t${fmtMoney(r.total, p.currency)}`).join('\n');
    return `${p.platform}\n  Date\t\tTotal\n${rows}`;
  }).join('\n\n');
  return `\n\n📆 Next recurring investments\n${blocks}`;
}

/* Builds the forward-looking calendar across EVERY active plan (not just
   the ones triggering today's email) — shared across all lead-time emails
   sent in a single run. */
function buildForwardCalendar(plans: { platform: string; symbol: string; amount: number; currency: string; recurring: any }[], today: Date): ForwardCalendar {
  const rangeEnd = new Date(today);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + FORWARD_LOOKING_DAYS);

  const byPlatform = new Map<string, { currency: string; dateTotals: Map<string, number> }>();
  for (const p of plans) {
    const dates = occurrencesInRange(p.recurring, today, rangeEnd, FORWARD_LOOKING_MAX_PER_PLAN);
    if (!dates.length) continue;
    if (!byPlatform.has(p.platform)) byPlatform.set(p.platform, { currency: p.currency, dateTotals: new Map() });
    const entry = byPlatform.get(p.platform)!;
    dates.forEach(d => entry.dateTotals.set(d, (entry.dateTotals.get(d) || 0) + p.amount));
  }

  return Array.from(byPlatform.entries()).map(([platform, v]) => ({
    platform,
    currency: v.currency,
    rows: Array.from(v.dateTotals.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, total]) => ({ date, total })),
  }));
}

/* ---------------------------------------------------------------------
   Main run.
   --------------------------------------------------------------------- */
async function runReminderCheck(testMode = false) {
  try {
    if (testMode) {
      const email = await loadKey(EMAIL_KEY);
      if (!email) { console.log('send-recurring-reminders: TEST MODE — no reminder email saved yet, nothing to send to'); return; }
      await sendReminderEmail(
        email,
        'Test: recurring buy reminders are working',
        '<div style="font-family:sans-serif;"><h2>✅ It works</h2><p>This is a test email from send-recurring-reminders — if you got this, the Resend connection and your saved email address are both set up correctly.</p></div>',
        'It works — this is a test email from send-recurring-reminders. If you got this, the Resend connection and your saved email address are both set up correctly.'
      );
      console.log(`send-recurring-reminders: TEST MODE — sent a test email to ${email}`);
      return;
    }

    const DATA = await loadKey(DATA_KEY);
    if (!DATA) { console.log('send-recurring-reminders: no ledger data found'); return; }
    const email = await loadKey(EMAIL_KEY);
    if (!email) { console.log('send-recurring-reminders: no reminder email saved — nothing to send to'); return; }

    let notifiedDates: string[] = (await loadKey(NOTIFIED_KEY)) || [];

    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const monthIdx = today.getUTCMonth();

    // ---- Collect every active plan across every year, resolving its funding bank up front ----
    const allPlans: { planId: string; symbol: string; platform: string; amount: number; currency: string; bankAccountId: string | null; bank: any | null; recurring: any }[] = [];
    for (const yearKey of Object.keys(DATA)) {
      if (!/^\d+$/.test(yearKey)) continue;
      const banks = DATA[yearKey]?.banks || [];
      for (const inv of DATA[yearKey]?.investments || []) {
        for (const h of inv.holdings || []) {
          if (!h.recurring?.active) continue;
          const norm = normalizedRecurring(h.recurring);
          const hasSchedule = norm.frequencyType === 'daysOfMonth' ? !!norm.daysOfMonth?.length : !!norm.startDate;
          if (!hasSchedule) continue;
          const bankAccountId = norm.bankAccountId || null;
          const bank = bankAccountId ? (banks.find((b: any) => b.id === bankAccountId && b.type !== 'credit') || null) : null;
          allPlans.push({
            planId: h.id, symbol: h.symbol || h.name || 'a holding', platform: inv.name || 'a platform',
            amount: Number(norm.amount) || 0, currency: inv.currency || 'USD',
            bankAccountId, bank, recurring: norm,
          });
        }
      }
    }
    if (!allPlans.length) { console.log('send-recurring-reminders: no active recurring plans'); return; }

    // ---- Bucket by lead time: which plans' NEXT occurrence is exactly 7 / 3 / 1 day(s) away ----
    const dueByLead: Record<number, DueItem[]> = { 7: [], 3: [], 1: [] };
    const dueDateByLead: Record<number, string> = {};
    const newlyNotifiedKeys: string[] = [];

    for (const plan of allPlans) {
      const nextDate = nextRecurringDateForPlan(plan.recurring, today);
      if (!nextDate) continue;
      const nextDateObj = new Date(nextDate + 'T00:00:00Z');
      const diffDays = Math.round((nextDateObj.getTime() - today.getTime()) / 86400000);
      if (!LEAD_DAYS.includes(diffDays)) continue;

      const dedupeKey = `${plan.planId}|${nextDate}|${diffDays}`;
      if (notifiedDates.includes(dedupeKey)) continue; // already sent this exact reminder

      dueByLead[diffDays].push({
        planId: plan.planId, symbol: plan.symbol, platform: plan.platform, amount: plan.amount,
        currency: plan.currency, bankAccountId: plan.bankAccountId, bank: plan.bank,
      });
      dueDateByLead[diffDays] = nextDate;
      newlyNotifiedKeys.push(dedupeKey);
    }

    const activeLeadBuckets = LEAD_DAYS.filter(n => dueByLead[n].length > 0);
    if (!activeLeadBuckets.length) { console.log('send-recurring-reminders: nothing due in 7, 3, or 1 day(s)'); return; }

    // FX + forward calendar are shared across every email sent this run.
    const fxRate = await fetchUsdInrRate();
    const forwardCalendar = buildForwardCalendar(allPlans, today);
    const forwardHtml = renderForwardCalendarHtml(forwardCalendar);
    const forwardText = renderForwardCalendarText(forwardCalendar);

    for (const leadDays of activeLeadBuckets) {
      const { subject, html, text } = buildReminderEmail(leadDays, dueByLead[leadDays], dueDateByLead[leadDays], fxRate, monthIdx, forwardHtml, forwardText);
      await sendReminderEmail(email, subject, html, text);
      console.log(`send-recurring-reminders: sent ${leadDays}-day reminder for ${dueByLead[leadDays].length} plan(s) due ${dueDateByLead[leadDays]}`);
    }

    notifiedDates = notifiedDates.concat(newlyNotifiedKeys).slice(-300); // small de-dupe list, 3 buckets now instead of 1
    await upsertKey(NOTIFIED_KEY, notifiedDates);
  } catch (e) {
    console.error('send-recurring-reminders: fatal error', String(e));
  }
}

/* Builds one lead-time email's subject/html/text. Shared by the real check
   above and the preview check below, so a preview is GUARANTEED to look
   exactly like a real reminder — same function, just fed sample data. */
function buildReminderEmail(leadDays: number, items: DueItem[], dueDate: string, fxRate: number, monthIdx: number, forwardHtml: string, forwardText: string) {
  const groups = groupByPlatformAndAccount(items, fxRate, monthIdx);

  const totalsByCurrency: Record<string, number> = {};
  items.forEach(it => { totalsByCurrency[it.currency] = (totalsByCurrency[it.currency] || 0) + it.amount; });
  const totalStr = Object.entries(totalsByCurrency).map(([cur, amt]) => fmtMoney(amt, cur)).join(' + ');
  const platformCount = groups.length;

  const dayWord = leadDays === 1 ? 'tomorrow' : `in ${leadDays} days`;
  const subject = leadDays === 1
    ? `📅 Recurring buy${items.length === 1 ? '' : 's'} due tomorrow — ${totalStr}`
    : `📅 Recurring buys coming up ${dayWord} (${dueDate}) — ${totalStr}`;

  const html = `
    <div style="font-family:sans-serif; color:#222;">
      <h2 style="margin:0 0 4px;">📅 Upcoming recurring investments — ${leadDays} day${leadDays === 1 ? '' : 's'}</h2>
      <p style="color:#555; margin:0 0 4px;">Due ${dueDate} · ${totalStr} total across ${platformCount} platform${platformCount === 1 ? '' : 's'}.</p>
      ${renderPlatformGroupsHtml(groups)}
      ${forwardHtml}
    </div>`;

  const text = `📅 Upcoming recurring investments — ${leadDays} day${leadDays === 1 ? '' : 's'}\n` +
    `Due ${dueDate} · ${totalStr} total across ${platformCount} platform${platformCount === 1 ? '' : 's'}.\n\n` +
    renderPlatformGroupsText(groups) +
    forwardText;

  return { subject, html, text };
}

/* ---------------------------------------------------------------------
   Preview mode — hit the function with ?preview=1 to get sample 7/3/1-day
   emails sent to your saved address RIGHT NOW, built from made-up sample
   data instead of your real ledger. Goes through the exact same
   buildReminderEmail()/render functions production uses, so what you see
   is guaranteed to match a real reminder's layout — only the numbers are
   fake. Doesn't touch your real ledger data at all.
   --------------------------------------------------------------------- */
function buildPreviewSample(today: Date) {
  const iso = (offsetDays: number) => {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() + offsetDays);
    return toISODate(d);
  };
  const fakeBank = (balance: number, name: string) => {
    const m = Array(12).fill(null);
    m[today.getUTCMonth()] = balance;
    return { name, currency: 'USD', m };
  };
  const checking = fakeBank(620, 'Checking (preview)');
  const savings = fakeBank(100, 'Savings (preview)');

  const dueByLead: Record<number, DueItem[]> = {
    7: [
      { planId: 'preview-voo', symbol: 'VOO', platform: 'Robinhood', amount: 250, currency: 'USD', bankAccountId: 'preview-checking', bank: checking },
      { planId: 'preview-qqq', symbol: 'QQQ', platform: 'Robinhood', amount: 200, currency: 'USD', bankAccountId: 'preview-checking', bank: checking },
      { planId: 'preview-vti', symbol: 'VTI', platform: 'Fidelity', amount: 150, currency: 'USD', bankAccountId: 'preview-savings', bank: savings },
    ],
    3: [
      { planId: 'preview-abc', symbol: 'ABC', platform: 'Robinhood', amount: 300, currency: 'USD', bankAccountId: null, bank: null },
    ],
    1: [
      { planId: 'preview-xyz', symbol: 'XYZ', platform: 'Fidelity', amount: 500, currency: 'USD', bankAccountId: 'preview-savings', bank: savings },
    ],
  };
  const dueDateByLead: Record<number, string> = { 7: iso(7), 3: iso(3), 1: iso(1) };

  // A couple of ongoing plans purely to populate the forward calendar section.
  const forwardPlans = [
    { platform: 'Robinhood', symbol: 'VOO+QQQ', amount: 450, currency: 'USD', recurring: { frequencyType: 'monthly', startDate: iso(7) } },
    { platform: 'Fidelity', symbol: 'VTI', amount: 150, currency: 'USD', recurring: { frequencyType: 'monthly', startDate: iso(7) } },
  ];

  return { dueByLead, dueDateByLead, forwardPlans };
}

/* ---------------------------------------------------------------------
   Real-data manual test mode.

   Hit the function with ?realTest=1 to send ONE reminder immediately using
   the REAL ledger and the REAL next recurring date. This bypasses the normal
   7/3/1-day trigger window only for this manual test, so you can test the
   actual email/data now without waiting for the next eligible reminder day.

   It does NOT write to NOTIFIED_KEY, so running the real test will not consume
   or suppress a future 7/3/1-day production reminder.
   --------------------------------------------------------------------- */
async function runRealTestCheck() {
  try {
    const DATA = await loadKey(DATA_KEY);
    if (!DATA) {
      console.log('send-recurring-reminders: REAL TEST — no ledger data found');
      return;
    }

    const email = await loadKey(EMAIL_KEY);
    if (!email) {
      console.log('send-recurring-reminders: REAL TEST — no reminder email saved — nothing to send to');
      return;
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const monthIdx = today.getUTCMonth();

    // Load the same real active recurring plans used by production mode.
    const allPlans: {
      planId: string;
      symbol: string;
      platform: string;
      amount: number;
      currency: string;
      bankAccountId: string | null;
      bank: any | null;
      recurring: any;
    }[] = [];

    for (const yearKey of Object.keys(DATA)) {
      if (!/^\d+$/.test(yearKey)) continue;
      const banks = DATA[yearKey]?.banks || [];

      for (const inv of DATA[yearKey]?.investments || []) {
        for (const h of inv.holdings || []) {
          if (!h.recurring?.active) continue;

          const norm = normalizedRecurring(h.recurring);
          const hasSchedule = norm.frequencyType === 'daysOfMonth'
            ? !!norm.daysOfMonth?.length
            : !!norm.startDate;
          if (!hasSchedule) continue;

          const bankAccountId = norm.bankAccountId || null;
          const bank = bankAccountId
            ? (banks.find((b: any) => b.id === bankAccountId && b.type !== 'credit') || null)
            : null;

          allPlans.push({
            planId: h.id,
            symbol: h.symbol || h.name || 'a holding',
            platform: inv.name || 'a platform',
            amount: Number(norm.amount) || 0,
            currency: inv.currency || 'USD',
            bankAccountId,
            bank,
            recurring: norm,
          });
        }
      }
    }

    if (!allPlans.length) {
      console.log('send-recurring-reminders: REAL TEST — no active recurring plans');
      return;
    }

    // Find the earliest real upcoming occurrence across all active plans.
    let earliestDate: string | null = null;
    let earliestDiffDays = Number.POSITIVE_INFINITY;

    for (const plan of allPlans) {
      const nextDate = nextRecurringDateForPlan(plan.recurring, today);
      if (!nextDate) continue;

      const nextDateObj = new Date(nextDate + 'T00:00:00Z');
      const diffDays = Math.round((nextDateObj.getTime() - today.getTime()) / 86400000);

      if (diffDays < 0) continue;
      if (diffDays < earliestDiffDays) {
        earliestDiffDays = diffDays;
        earliestDate = nextDate;
      }
    }

    if (!earliestDate || !Number.isFinite(earliestDiffDays)) {
      console.log('send-recurring-reminders: REAL TEST — no upcoming recurring occurrence found');
      return;
    }

    const dueItems: DueItem[] = [];
    for (const plan of allPlans) {
      const nextDate = nextRecurringDateForPlan(plan.recurring, today);
      if (nextDate !== earliestDate) continue;

      dueItems.push({
        planId: plan.planId,
        symbol: plan.symbol,
        platform: plan.platform,
        amount: plan.amount,
        currency: plan.currency,
        bankAccountId: plan.bankAccountId,
        bank: plan.bank,
      });
    }

    if (!dueItems.length) {
      console.log('send-recurring-reminders: REAL TEST — earliest occurrence had no sendable items');
      return;
    }

    const fxRate = await fetchUsdInrRate();
    const forwardCalendar = buildForwardCalendar(allPlans, today);
    const forwardHtml = renderForwardCalendarHtml(forwardCalendar);
    const forwardText = renderForwardCalendarText(forwardCalendar);

    // Deliberately use the production email builder with REAL ledger data.
    // The only difference is the [REAL TEST] subject prefix so the test is
    // obvious and cannot be mistaken for a scheduled production reminder.
    const { subject, html, text } = buildReminderEmail(
      earliestDiffDays,
      dueItems,
      earliestDate,
      fxRate,
      monthIdx,
      forwardHtml,
      forwardText,
    );

    await sendReminderEmail(
      email,
      `[REAL TEST] ${subject}`,
      html,
      text,
    );

    console.log(
      `send-recurring-reminders: REAL TEST — sent real-data reminder for ${dueItems.length} plan(s) ` +
      `due ${earliestDate} (${earliestDiffDays} day(s) away) to ${email}`,
    );
  } catch (e) {
    console.error('send-recurring-reminders: real test error', String(e));
  }
}

async function runPreviewCheck() {
  try {
    const email = await loadKey(EMAIL_KEY);
    if (!email) { console.log('send-recurring-reminders: PREVIEW — no reminder email saved yet, nothing to send to'); return; }

    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const monthIdx = today.getUTCMonth();
    const fxRate = await fetchUsdInrRate();
    const { dueByLead, dueDateByLead, forwardPlans } = buildPreviewSample(today);
    const forwardCalendar = buildForwardCalendar(forwardPlans, today);
    const forwardHtml = renderForwardCalendarHtml(forwardCalendar);
    const forwardText = renderForwardCalendarText(forwardCalendar);

    for (const leadDays of LEAD_DAYS) {
      const { subject, html, text } = buildReminderEmail(leadDays, dueByLead[leadDays], dueDateByLead[leadDays], fxRate, monthIdx, forwardHtml, forwardText);
      await sendReminderEmail(
        email,
        `[PREVIEW] ${subject}`,
        `<div style="background:#fff3cd; color:#7a5c00; padding:8px 12px; border-radius:6px; font-family:sans-serif; font-size:12.5px; margin-bottom:10px;">This is a sample using made-up numbers — your real ledger wasn't touched.</div>${html}`,
        `[PREVIEW — sample numbers, your real ledger wasn't touched]\n\n${text}`
      );
    }
    console.log(`send-recurring-reminders: PREVIEW — sent 3 sample emails (7/3/1-day formats) to ${email}`);
  } catch (e) {
    console.error('send-recurring-reminders: preview error', String(e));
  }
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const testMode = params.get('test') === '1';
  const previewMode = params.get('preview') === '1';
  const realTestMode = params.get('realTest') === '1';

  // Acknowledge immediately so pg_net's timeout never trips, then do the
  // actual (potentially slow) work in the background.
  // @ts-ignore — EdgeRuntime is a Supabase-provided global, not a Deno type
  EdgeRuntime.waitUntil(
    previewMode
      ? runPreviewCheck()
      : realTestMode
        ? runRealTestCheck()
        : runReminderCheck(testMode),
  );

  return new Response(JSON.stringify({ status: 'started', testMode, previewMode, realTestMode }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
