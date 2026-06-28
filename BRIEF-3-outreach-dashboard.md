# BRIEF 3 — The Outreach Dashboard / Power Dialer (Twilio) : how it works, how to work on it

> Paste this at the start of any chat about **the outreach/dialer tool** — the system that
> RUNS outreach to leads (calls, SMS, email sequences). This is a DIFFERENT product from the
> Recaller SaaS (BRIEF 2). Strategy is BRIEF 1.

## What it is
An in-house outreach cockpit at **vyrrahlabs.com/admin** — built on Twilio + SendGrid +
Supabase — to work the lead list: power dialing, SMS + email sequences, two-way
conversations, contact management, opt-out handling. Used to drive the outreach from
BRIEF 1 (booking audits / starting tool trials).

## Repo & deploy
- **Dir:** `/tmp/vyrrah-website` (shared repo). **NOT git-connected** — deploy via
  `VERCEL_TOKEN=<token> node scripts/deploy.mjs` (same as the tool; one deploy ships everything).
- **Stack:** Vercel serverless · Supabase · Twilio (calls + SMS) · SendGrid (email).
- **Twilio sending number:** **+15106310835** (Oakland) — in `api/_lib/twilio.js`.
  Auth uses Account SID + Auth Token (API Key auth did NOT work — don't switch back).

## Files (this product)
- **`api/index.js`** — the outreach engine (catch-all for `/api/(.*)`). ~1,600 lines.
- **`admin.html`** — the dashboard UI ("Vyrrah Dialer — Admin"): Contacts, Power dialer,
  Conversations, Sequences tabs.
- `api/_lib/twilio.js`, `api/_lib/supabase.js`, `api/_lib/auth.js` (shared libs).

## ⚠️ Do NOT touch (other chats own these)
- `api/tool.js`, `recover.html`, `start.html`, `command.html` → the **Recaller SaaS** (BRIEF 2).
- `index.html` + marketing pages → the **marketing redesign chat**.
- Keep this product's routes (`/api/...`) and the Recaller routes (`/api/tool/...`) separate;
  `vercel.json` routes `/api/tool/(.*)` BEFORE `/api/(.*)` — don't reorder.

## Data model (Supabase tables for outreach)
`leads` (the ~2,370 imported, scored), `sequences`, `sms_messages`, `calls`, `opt_outs`.
(The Recaller SaaS uses separate `tool_*` tables — don't cross them.)

## Endpoints (`/api/...`)
- **auth/login, auth/verify** — admin auth.
- **contacts** (list / `:id` / **import** / newsletter-add / eod-stop), 
- **sms/send**, **sms/conversation**,
- **calls/dial**, **calls/bridge**, **calls/:id**,
- **conversations** (unified inbox),
- **dashboard/stats**,
- **sequences** (list / **trigger** / **bulk-trigger** / **process** / **email-trigger** /
  **email-bulk-trigger**),
- **webhooks/**: sms, voice, status, recording, quickmail, sendgrid, sendgrid-events.
- **Cron:** `/api/sequences/process` runs daily **09:00** (vercel.json) to advance sequences.

## History / gotchas (so you don't repeat them)
- **Quickmail** was trialed then dropped (API only supports listing/adding prospects, no
  campaign creation; webhook DB writes had to run *before* responding). Email moved to SendGrid.
- **JustCall** abandoned in favor of Twilio.
- Vercel Hobby **12-function limit** → everything consolidated into single catch-alls
  (`api/index.js` here, `api/tool.js` for the SaaS). Don't split back into many files.
- Lead import: CSVs used "Mobile Number"/"Company Phone Number" columns; phones normalized
  to E.164 (raised usable leads 575 → 2,370).
- Twilio webhooks: process work BEFORE `res.json()` (Vercel kills the function after response);
  prefer sequential awaits over `Promise.all` with Supabase's lazy builders.

## State / plan
- Functional outreach dashboard deployed at `/admin` with the lead list loaded.
- Next per BRIEF 1: wire sequences to the chosen channel motion (cold → audit; or tool trial),
  ensure opt-out/compliance, and A2P 10DLC before scaled SMS.
- Coordinate any deploy with the other chats (one `deploy.mjs` ships the whole repo).
