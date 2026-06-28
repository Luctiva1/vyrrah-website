# Vyrrah Recaller — "Drop in your key and it's done" guide

The product is **live and working today** on smart templates + manual billing.
To unlock the last pieces, you only ever paste a value into Vercel's env settings —
no code changes. Everything is built to detect the key and switch on automatically.

## How to add any key
Vercel → your project → **Settings → Environment Variables** → add the name + value →
**Redeploy** (or it picks up on the next deploy). That's the whole process.

---

## The 3 drop-in keys (in priority order)

### 1. `OPENAI_API_KEY` — turns the AI receptionist ON  ⭐ biggest single upgrade
- Get it: platform.openai.com → API keys.
- Paste as `OPENAI_API_KEY`.
- **Effect:** the bot stops using templates and starts having real conversations —
  answering "do you take Delta Dental?", handling messy phrasing, booking naturally.
- Cost: ~$0.01–0.03 per recovered conversation on gpt-5-nano. Negligible vs a $500 plan.
- Until added: smart templates run (still books, still recovers — just less flexible).

### 2. `DODO_API_KEY` + `DODO_WEBHOOK_SECRET` (+ product ids) — automatic billing
- Get them: Dodo dashboard once KYC is approved.
- Paste `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_ID_TOOL` (and
  `DODO_PRODUCT_ID_RETAINER` if you want the $5k plan automated too).
- Point Dodo's webhook at: `https://vyrrahlabs.com/api/tool/dodo-webhook`
- **Effect:** trials auto-convert to paid, churn/past-due statuses sync automatically,
  pooled numbers auto-release on cancel.
- Until added: you invoice manually; the app still tracks every subscription state.

### 3. `ANTHROPIC_API_KEY` — optional AI fallback
- Only matters if you want a second brain when OpenAI errors. Safe to leave blank.

---

### 4. One DB migration — unlocks referrals + consent-gated reactivation
- Open Supabase → **SQL Editor** → paste the contents of
  [`migrations/2026-06-referral-consent.sql`](migrations/2026-06-referral-consent.sql) → Run.
- **Effect:**
  - Referral loop goes live: `GET /api/tool/referral?token=` returns each client's
    share link (`/start?ref=CODE`); referred signups auto-credit the referrer one
    free month on conversion.
  - Reactivation becomes consent-safe: it only texts an uploaded patient list once
    the client confirms consent (UI passes `consent_confirmed:true` to
    `/api/tool/reactivation/toggle`). Until migrated, reactivation simply doesn't
    send — the safe default.
- Until you run it: both features stay dormant and **nothing breaks** — the code
  detects the missing columns and no-ops.

---

## One-time things only YOU can do (paperwork, not code)

These are external registrations — the code is already wired for them.

| Item | Why it matters | Where |
|---|---|---|
| **A2P 10DLC registration** | Without it, US carriers filter/block your SMS. THE gate. | Twilio Console → Messaging → Regulatory Compliance → A2P. ~1–3 wks approval. Set `STRICT_TWILIO=1` after. |
| **BAAs** (Twilio, OpenAI, Supabase, SendGrid) | Required before medical clients (HIPAA). | Each vendor's compliance/legal page — request the BAA. |
| **ADMIN_KEY** | The `/command` center is now fail-closed. | Set a long random `ADMIN_KEY` in Vercel; type it once into /command (it's remembered). |

---

## Security note (changed this build)
Admin auth is now **fail-closed**. `/api/tool/admin-overview`, `admin-action`, and
`pool/refill` require the `x-admin-key` header matching `ADMIN_KEY` (or `ADMIN_PASSWORD`).
The `/command` page prompts for it once and stores it locally. If no key is configured,
every admin call is denied — so set `ADMIN_KEY` before relying on /command.

## What's already on (no key needed)
Missed-call text-back · AI booking (templates→AI) · native + Google calendar ·
reminders · reactivation drip · review requests · monthly ROI emails ·
self-healing forwarding watchdog · number-pool auto-refill · spam/robocall filter ·
operator alerts to you · live demo line · onboarding + forwarding verification.
