# BRIEF 2 — Vyrrah Recaller (the $500/mo SaaS): how it works, how to work on it, the plan

> Paste this at the start of any chat about **the Recaller product** — features, backend,
> bugs, deploys, QA. Strategy lives in BRIEF 1; the separate outreach dialer is BRIEF 3.

## What it is
Missed-call recovery for local practices. A practice forwards its **unanswered/busy**
calls to a dedicated Twilio number; we instantly text the missed caller back, hold an
AI booking conversation, book into a calendar, and show the owner recovered revenue.
Plus: reactivation of lapsed patients, review requests, monthly ROI emails, referrals.

## Repo & deploy
- **Dir:** `/tmp/vyrrah-website` (shared with the marketing site + outreach dashboard).
- **NOT git-connected.** Deploy via: `VERCEL_TOKEN=<token> node scripts/deploy.mjs`
  (uploads git-tracked files, creates a prod deployment). **Token is not stored — Godwin
  pastes it each time.** Nothing is live until deployed.
- **Stack:** Vercel serverless · Supabase (Postgres) · Twilio (voice/SMS) · SendGrid (email)
  · AI chain OpenAI gpt-5-nano → Anthropic claude-haiku-4-5 → templates · Dodo Payments (billing).

## Files you may touch (the tool)
- **`api/tool.js`** — the entire engine (one Vercel catch-all, routed via `/api/tool/(.*)`).
- **`recover.html`** (`/recaller`, `/recover`) — client dashboard.
- **`start.html`** (`/start`) — self-serve onboarding.
- **`command.html`** (`/command`) — internal fleet admin.
- **`privacy.html` / `terms.html`** (`/privacy`, `/terms`).
- `api/_lib/auth.js`, `api/_lib/supabase.js`.

## ⚠️ Do NOT touch (other chats own these)
- **`index.html`** + marketing pages + `/api/analyze` → the **marketing-site redesign chat**.
- **`api/index.js`** + **`admin.html`** → the **outreach dialer** (BRIEF 3). Different product.
- Frontend redesign of start/recover/command is also coordinated with the redesign chat —
  see `TOOL-FRONTEND-HANDOFF.md` (keep API contracts intact; restyle freely).

## Key endpoints (`/api/tool/...`)
clients, clients/provision, verify-status, voice, voice-status, sms, sms-status, dashboard,
inbox, reply, report, insights, availability, appointments(/cancel), config, google/connect,
google/callback, patients(/import), reactivation/run(/toggle), reviews(/mark), demo,
pool(/refill), admin-overview, admin-action, block/unblock, checkout, pay, dodo-webhook,
cron-flush (daily), cron-weekly (weekly). **Newer:** enrich (onboard-by-URL), referral,
concierge (done-for-you forwarding), carrier (Twilio Lookup → forwarding code),
account + account/action (self-serve pause/resume/cancel save-flow/subscribe).

## Drop-in keys & one-time setup (see SETUP.md for the full guide)
Built to detect a key/column and switch on automatically — safe until then.
- `OPENAI_API_KEY` → real AI (else templates). Model-adaptive call (handles max_tokens vs max_completion_tokens).
- `DODO_API_KEY` + `DODO_WEBHOOK_SECRET` (+ product ids) → auto recurring billing + dunning.
- `ADMIN_KEY` → locks `/command` (fail-open until set, then header-authed). **Set this before real clients.**
- `STRICT_TWILIO=1` → reject forged webhooks (set after A2P).
- **DB migration** `migrations/2026-06-referral-consent.sql` → turns on referrals + consent-gated reactivation.

## Testing
- `python3 scripts/smoke.py` (after deploy) → critical-path pass/fail against production.
  Today it reads "X pass / Y staged-fail" where the fails are built-but-undeployed routes.
  Target after deploy: **all green.** `--full` also tests concierge (alerts Godwin).
- Tomorrow's runbook: `QA-TOMORROW.md`. Frontend wiring specs: `TOOL-FRONTEND-HANDOFF.md`.

## Current state (as of this brief)
- Large feature set **built and syntax-clean but STAGED** — not deployed (needs VERCEL_TOKEN).
- Demo client live: "Vyrrah Demo Clinic", number **+15108519627** (text it to see the AI/template reply).
- Outreach Twilio number (shared/demo) handled separately; this tool's demo line is +15108519627.

## The plan / roadmap (priority order)
1. **Deploy + smoke test** (need token) — make everything live and green.
2. **Config the gates:** `ADMIN_KEY`, `OPENAI_API_KEY`, `STRICT_TWILIO`; run the migration.
3. **A2P 10DLC + BAAs** (Godwin's paperwork) — unblocks scaled, compliant SMS.
4. **Frontend polish** (redesign chat): self-serve `/start` CTA, account/save-flow UI,
   money-clock + first-win + call-summaries, demo widget, HIPAA line, ROI citation.
5. **Backend next:** finish referral/consent UI hooks, Dodo customer-portal "update card".
6. Make the **retainer upsell** surface from the dashboard once ROI threshold crossed.
