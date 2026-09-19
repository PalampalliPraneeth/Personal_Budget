# The Ledger — Full Setup Guide

A personal finance tracker (budget, expenses, debt, investments, holdings,
cash flow) that runs as a static site in your browser, with Supabase as the
backend for data storage, live price refreshes, and email reminders.

This guide takes you from an empty Supabase account to a fully working copy
of your own. Follow it in order — later steps depend on earlier ones.

---

## What you're setting up

- **Frontend**: plain HTML/CSS/JS files. No build step. Hosted anywhere that
  serves static files (GitHub Pages, Netlify, Vercel, or even just opening
  `index.html` locally for testing).
- **Database**: one Supabase Postgres table (`ledger_data`) that stores your
  entire ledger as a JSON blob, plus a couple of small keys (your reminder
  email, price-refresh timestamps).
- **Edge Functions** (three, all in Supabase, written in Deno/TypeScript):
  1. `hyper-task` — proxies live stock/crypto price lookups to Yahoo Finance
     (avoids browser CORS issues).
  2. `daily-price-refresh` — runs on a schedule, refreshes every holding's
     price automatically.
  3. `send-recurring-reminders` — runs on a schedule, emails you 7/3/1 days
     before a recurring investment is due, funding-account math included.
- **Cron**: two scheduled jobs (via `pg_cron`, built into Supabase) that call
  functions 2 and 3 above automatically.

---

## Step 1 — Create your Supabase project

1. Go to [supabase.com](https://supabase.com), sign up/log in, and click
   **New Project**.
2. Pick any name and a strong database password (you won't need the
   password directly — Supabase manages it — but save it somewhere safe).
3. Wait ~2 minutes for the project to finish provisioning.
4. Once it's ready, go to **Project Settings → API**. You'll need two values
   from this page throughout this guide:
   - **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
   - **anon / public key** — a long string starting with `eyJ...` (or, on
     newer projects, `sb_publishable_...`)

   Keep this tab open — you'll come back to it for the **service_role** key
   too, though you won't need to copy that one anywhere manually (Edge
   Functions get it automatically — more on that in Step 5).

---

## Step 2 — Create the database table

1. In the Supabase dashboard, open the **SQL Editor** (left sidebar).
2. Run this:

```sql
create table ledger_data (
  user_id     text not null,
  data_key    text not null,
  data_json   jsonb,
  updated_at  timestamptz default now(),
  primary key (user_id, data_key)
);
```

That's the entire schema. Everything — your ledger data, your reminder
email, price-refresh timestamps — lives in this one table as rows keyed by
`(user_id, data_key)`.

### About Row Level Security (RLS)

By default, Supabase enables RLS on new tables, which blocks all access
until you add a policy. This app's frontend talks to the database directly
using the public **anon** key (no login system beyond an app-level PIN), so
it needs a policy that allows that. The simplest version, matching how this
project is currently built:

```sql
alter table ledger_data enable row level security;

create policy "allow anon full access"
  on ledger_data
  for all
  using (true)
  with check (true);
```

**Be aware of the trade-off:** this means *anyone* who has your anon key
and your `user_id` (called `LEDGER_ID` in this app — see Step 4) can read
and write that data. The anon key ends up embedded in the frontend
JavaScript, so it's not secret. The only thing standing between a stranger
and your data is them guessing your `LEDGER_ID` string. Two things help:
- Pick a long, random, non-guessable `LEDGER_ID` in Step 4 (not something
  like `"my-budget"`).
- Don't publish your deployed site's URL publicly if you're relying on that
  obscurity.

If you want real per-user security later, that requires adding Supabase
Auth (real login) and switching the RLS policy to check `auth.uid()` —
a bigger change than this guide covers, but worth knowing it's the proper
long-term fix if this ever matters more to you.

---

## Step 3 — Point the frontend at your project

Open **`storage-bridge.js`** and edit the top of the file:

```js
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co'; // ← your Project URL from Step 1
const SUPABASE_ANON_KEY = 'eyJ...';                        // ← your anon/public key from Step 1

const LEDGER_ID = 'pick-something-long-and-random-here';   // ← see the RLS note above
```

Pick your own `LEDGER_ID` — any string works, but make it long and
unguessable (e.g. mash your keyboard for 20+ characters). Every Edge
Function in this repo that touches the database also has a `LEDGER_ID`
constant near the top — **all of them must match this exact string**, or
the function will look for data that doesn't exist under a different key.
You'll set those in Step 5.

---

## Step 4 — Get a Resend account (for email reminders)

The reminder emails are sent via [Resend](https://resend.com), not through
Supabase itself.

1. Sign up at resend.com (free tier is enough for personal use).
2. Go to **API Keys** and create one. Copy it — you'll set it as a secret
   in Step 5.
3. Go to **Domains** (or just use their shared sandbox sender for testing —
   check your dashboard for the exact current sandbox address, since that's
   Resend's to change, not something to hardcode from memory). If you want
   emails from your own domain, verify it here; otherwise the sandbox
   address works fine to get started.

---

## Step 5 — Deploy the three Edge Functions

You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli)
installed locally (`npm install -g supabase`, or see their docs for other
install methods). From your project root:

```bash
supabase login
supabase link --project-ref xxxxxxxxxxxx   # the ref is in your Project URL
```

### 5a. Price proxy (`hyper-task`)

This is `Hypertask.ts` in the repo. **Deploy it under the name
`hyper-task`** — that's the exact name `storage-bridge.js` already expects
(`window.PRICE_PROXY_URL` is hardcoded to `/functions/v1/hyper-task`), so
using that name means zero extra config.

```bash
supabase functions deploy hyper-task --no-verify-jwt
```

`--no-verify-jwt` matters here — this function is called directly from the
browser (not from cron), with no auth token attached, since it's just a
public price lookup with no user data involved.

### 5b. Daily price refresh (`daily-price-refresh`)

This is `Daily_Price_refresh.ts`. First, open it and confirm the
`LEDGER_ID` constant near the top matches what you set in Step 3.

```bash
supabase functions deploy daily-price-refresh
```

No `--no-verify-jwt` here — this one only runs via cron (Step 6), and cron
sends a proper auth header, so the default JWT verification stays on.

### 5c. Recurring investment reminders (`send-recurring-reminders`)

This is `send-recurring-reminders.ts`. Same check — confirm `LEDGER_ID`
matches.

```bash
supabase functions deploy send-recurring-reminders
```

> **Naming tip, from hard experience:** deploy this under the name
> `send-recurring-reminders` — i.e. matching the filename exactly. An
> earlier setup of this same app deployed it under an unrelated name
> (`quick-action`) while every log message and comment inside the file
> still called it `send-recurring-reminders`. That mismatch alone caused a
> cron job to silently 404 for months. Keeping the deployed name matching
> the filename avoids that entire class of confusion.

Now set the two secrets this function needs:

```bash
supabase secrets set RESEND_API_KEY=re_your_key_here
supabase secrets set REMINDER_FROM="Your Ledger <onboarding@resend.dev>"
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
into every Edge Function by Supabase — you don't set those yourself.)

### Verify each function deployed correctly

Dashboard → **Edge Functions** — you should see all three listed, with
their deployed names exactly matching what you used above.

---

## Step 6 — Set up the cron jobs

Cron is how `daily-price-refresh` and `send-recurring-reminders` run
automatically instead of needing you to trigger them by hand.

In the SQL Editor, first make sure the extensions are on (usually on by
default on Supabase, but confirm):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

You need a Bearer token for the `Authorization` header below. Use either
your project's **anon key** or **service_role key** from Project Settings →
API — either works for calling your own functions. Get it there before
running the SQL.

### 6a. Daily price refresh — twice a day

```sql
select cron.schedule(
  'daily-price-refresh-job',
  '0 13,20 * * *',   -- 13:00 and 20:00 UTC — adjust to your timezone/preference
  $$
    select net.http_post(
      url := 'https://xxxxxxxxxxxx.supabase.co/functions/v1/daily-price-refresh',
      headers := jsonb_build_object(
        'apikey', 'YOUR_KEY_HERE',
        'Authorization', 'Bearer YOUR_KEY_HERE',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
```

### 6b. Recurring investment reminders — every 30 minutes

It checks a 7/3/1-day window, not every 30 minutes' worth of new work, so
running it this often is just to catch the right day promptly; it's safe —
the function de-duplicates so you never get the same reminder twice.

```sql
select cron.schedule(
  'send-recurring-reminders-job',
  '*/30 * * * *',
  $$
    select net.http_post(
      url := 'https://xxxxxxxxxxxx.supabase.co/functions/v1/send-recurring-reminders',
      headers := jsonb_build_object(
        'apikey', 'YOUR_KEY_HERE',
        'Authorization', 'Bearer YOUR_KEY_HERE',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
```

**Replace both URLs' project ref and both `YOUR_KEY_HERE` values** with
your own before running.

### Verify cron is actually working — don't just assume it is

This is the single most common failure point in this whole setup: a typo'd
URL or a missing auth header means the cron job "succeeds" (from
`pg_cron`'s point of view — it just queues an HTTP request) while the
actual HTTP call silently 404s or 401s. Always check the *real* response:

```sql
-- Test immediately, without waiting for the schedule:
select net.http_post(
  url := 'https://xxxxxxxxxxxx.supabase.co/functions/v1/send-recurring-reminders',
  headers := jsonb_build_object(
    'apikey', 'YOUR_KEY_HERE',
    'Authorization', 'Bearer YOUR_KEY_HERE',
    'Content-Type', 'application/json'
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 30000
) as request_id;

-- Wait ~10 seconds, then:
select id, status_code, content::text, created
from net._http_response
order by created desc
limit 3;
```

`status_code` should be `200`. If it's `404`, the URL or function name is
wrong. If it's `401`, the auth header is wrong. Fix it and re-test before
moving on — don't wait for the schedule to find out.

Once you get a `200`, cross-check Dashboard → Edge Functions →
`send-recurring-reminders` → **Logs** for a line like `nothing due in 7, 3,
or 1 day(s)` — that confirms the function's actual code ran, not just that
the network call succeeded.

---

## Step 7 — Host the frontend

Supabase only hosts your *data*, not the website itself. Any static host
works:

- **GitHub Pages** — push this repo to GitHub, enable Pages in the repo
  settings, done.
- **Netlify / Vercel** — drag-and-drop the folder or connect the repo, no
  build command needed.
- **Local testing** — just open `index.html` (or `main.html`) directly in
  a browser, or run a simple local server (`python3 -m http.server`) from
  the project folder.

There's no environment-specific build step — every file already has its
final config baked in from Step 3.

---

## Step 8 — First run

1. Open your deployed site. You'll be asked to set a PIN — this is a local
   app-level lock, not tied to Supabase Auth, and isn't recoverable if
   forgotten (there's no "forgot PIN" flow), so pick something you'll
   remember.
2. Add your bank accounts, credit cards, income, expenses, etc. — this all
   saves to your `ledger_data` table automatically as you go.
3. To turn on email reminders: **Overview tab → ✉️ Reminders**, enter and
   save your email address. That's the `notify:email` row the reminder
   function looks for — without it, `send-recurring-reminders` runs but
   has nowhere to send to (and says so in its logs).
4. To test reminders without waiting for a real 7/3/1-day match, hit your
   function directly with a query string:
   ```
   https://xxxxxxxxxxxx.supabase.co/functions/v1/send-recurring-reminders?preview=1
   ```
   sends 3 sample emails (fake numbers, doesn't touch your real data) so
   you can confirm the whole pipeline — Resend key, sender address, your
   saved email — works end to end.

---

## Troubleshooting

**Prices never update / "Prices last refreshed" never changes.**
Check `daily-price-refresh`'s logs and the `net._http_response` query from
Step 6 — almost always a cron URL/auth mismatch, the same class of bug
covered above.

**No reminder emails ever arrive, even on a real due date.**
Run the immediate test in Step 6 first — if `status_code` isn't `200`,
that's your answer. If it is `200`, check the function logs for `no
reminder email saved` (Step 8.3) or `no active recurring plans` (you don't
have any recurring investment set up on the Holdings tab yet).

**Data doesn't seem to save / "Supabase cloud" doesn't appear in the
browser console.**
Open the browser console — `storage-bridge.js` logs which backend it's
using on load. If it says "localStorage fallback" instead of "Supabase
cloud", your URL or anon key in Step 3 is malformed or too short — double
check you copied the whole key.

**Price lookups fail / holdings show no price.**
Confirm `hyper-task` deployed successfully and is reachable — open
`https://xxxxxxxxxxxx.supabase.co/functions/v1/hyper-task?symbol=AAPL`
directly in a browser; you should get back JSON with a price, not an
error page.
