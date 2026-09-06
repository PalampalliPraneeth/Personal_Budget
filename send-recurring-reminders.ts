// Supabase Edge Function: send-recurring-reminders
// -------------------------------------------------------------------------
// Runs on a schedule (via pg_cron — see the setup notes for the exact SQL).
// Loads your ledger data, finds every active recurring buy whose next date
// is TOMORROW, and emails ONE summary to the address saved via
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
const NOTIFIED_KEY = 'push:notifiedDates:v1'; // de-dupe so re-running the cron doesn't re-notify the same buy

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
    const tomorrow = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = toISODate(tomorrow);

    const due: { symbol: string; platform: string; amount: number; currency: string }[] = [];
    const newlyNotifiedKeys: string[] = [];

    for (const yearKey of Object.keys(DATA)) {
      if (!/^\d+$/.test(yearKey)) continue;
      for (const inv of DATA[yearKey]?.investments || []) {
        for (const h of inv.holdings || []) {
          if (!h.recurring?.active) continue;
          const norm = normalizedRecurring(h.recurring);
          const hasSchedule = norm.frequencyType === 'daysOfMonth' ? !!norm.daysOfMonth?.length : !!norm.startDate;
          if (!hasSchedule) continue;
          const nextDate = nextRecurringDateForPlan(norm, today);
          if (nextDate !== tomorrowStr) continue;
          const dedupeKey = `${h.id}|${nextDate}`;
          if (notifiedDates.includes(dedupeKey)) continue; // already notified this exact occurrence
          due.push({ symbol: h.symbol || h.name || 'a holding', platform: inv.name || 'a platform', amount: Number(norm.amount) || 0, currency: inv.currency || 'USD' });
          newlyNotifiedKeys.push(dedupeKey);
        }
      }
    }

    if (!due.length) { console.log('send-recurring-reminders: nothing due tomorrow'); return; }

    const totalsByCurrency: Record<string, number> = {};
    due.forEach(d => { totalsByCurrency[d.currency] = (totalsByCurrency[d.currency] || 0) + d.amount; });
    const totalStr = Object.entries(totalsByCurrency)
      .map(([cur, amt]) => `${cur === 'INR' ? '₹' : '$'}${amt.toFixed(2)}`)
      .join(' + ');

    const subject = due.length === 1
      ? `Recurring buy tomorrow: ${due[0].symbol}`
      : `${due.length} recurring buys tomorrow (${totalStr})`;

    const rowsHtml = due.map(d =>
      `<tr><td style="padding:4px 12px 4px 0;">${escapeHtml(d.symbol)}</td><td style="padding:4px 12px;color:#666;">${escapeHtml(d.platform)}</td><td style="padding:4px 0;text-align:right;">${d.currency === 'INR' ? '₹' : '$'}${d.amount.toFixed(2)}</td></tr>`
    ).join('');
    const html = `
      <div style="font-family:sans-serif; color:#222;">
        <h2 style="margin:0 0 4px;">Recurring buys due tomorrow</h2>
        <p style="color:#555; margin:0 0 16px;">${totalStr} total across ${new Set(due.map(d => d.platform)).size} platform(s).</p>
        <table style="border-collapse:collapse; width:100%; max-width:420px;">${rowsHtml}</table>
      </div>`;
    const text = `Recurring buys due tomorrow (${totalStr} total):\n` +
      due.map(d => `- ${d.symbol} (${d.platform}): ${d.currency === 'INR' ? '₹' : '$'}${d.amount.toFixed(2)}`).join('\n');

    await sendReminderEmail(email, subject, html, text);

    notifiedDates = notifiedDates.concat(newlyNotifiedKeys).slice(-200); // keep this small, it's just a de-dupe list
    await upsertKey(NOTIFIED_KEY, notifiedDates);

    console.log(`send-recurring-reminders: emailed reminder for ${due.length} plan(s) due ${tomorrowStr}`);
  } catch (e) {
    console.error('send-recurring-reminders: fatal error', String(e));
  }
}

Deno.serve(async (req: Request) => {
  const testMode = new URL(req.url).searchParams.get('test') === '1';

  // Acknowledge immediately so pg_net's timeout never trips, then do the
  // actual (potentially slow) work in the background.
  // @ts-ignore — EdgeRuntime is a Supabase-provided global, not a Deno type
  EdgeRuntime.waitUntil(runReminderCheck(testMode));

  return new Response(JSON.stringify({ status: 'started', testMode }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
