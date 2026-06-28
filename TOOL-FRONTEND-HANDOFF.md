# Vyrrah Recaller — Frontend Handoff (for redesign + testing)

The **Recaller tool** (missed-call recovery SaaS) has 3 customer-facing pages.
These are SEPARATE from the marketing site (index.html) and the outreach dashboard (admin.html).

## ⚠️ Rules for the redesign chat
- ✅ You MAY freely redesign: `start.html`, `recover.html`, `command.html` (HTML/CSS/JS only).
- ❌ Do NOT change the `fetch()` URLs, request bodies, or response field names — the backend
  (`api/tool.js`) depends on them. Restyle freely; keep the API contract identical.
- ❌ Do NOT touch `api/tool.js`, `api/index.js`, `admin.html`, `index.html`, or `vercel.json` routes.
- Brand: bg `#070707`, red `#c8251e`, gold `#f0a500`. Fonts: Fraunces (display), Syne, DM Sans (body).

## The 3 pages, their routes, and live test URLs

| Page file | Route(s) | Who uses it | Live test URL |
|---|---|---|---|
| `start.html` | `/start` | Prospect signing up (onboarding) | https://vyrrahlabs.com/start |
| `recover.html` | `/recaller`, `/recover` | The paying client (their dashboard) | https://vyrrahlabs.com/recaller?token=c0409a978ca3b0dac0c096df1c7eebeba9a10f687dbfe167 |
| `command.html` | `/command` | Godwin (internal fleet admin) | https://vyrrahlabs.com/command |

**Live demo client for testing:** "Vyrrah Demo Clinic", number `+15108519627`, status active.
Magic token above loads its real dashboard with live data. You can also TEXT `+15108519627`
to see the AI reply in real time (it's the demo line).

## API contract per page (do not change these)

### start.html → onboarding
- `POST /api/tool/clients` — body: `{ practice_name, owner_name, owner_email, owner_phone, real_line, avg_customer_value, timezone }` → returns `{ client_id, magic_token, twilio_number }`.
- `GET /api/tool/verify-status?token=<magic_token>` — polled every few sec; returns `{ forwarding_verified: bool }`. Page shows green/confetti when it flips true.
- `GET /api/tool/demo?...` — live demo widget (sends a sample text-back).

### recover.html → client dashboard
- `GET /api/tool/dashboard?token=<magic_token>` — hero stats: recovered count, revenue, ROI multiple, recovery rate.
- `GET /api/tool/inbox?token=<magic_token>` — conversation threads + messages.
- `POST /api/tool/reply` — body: `{ token, conversation_id, body }` → owner takeover reply.
- `GET /api/tool/insights?token=<magic_token>` — recommendations, trends.
- `GET /api/tool/appointments?token=<magic_token>` — booked appts.
- Auto-refreshes; keep the polling intervals.

### command.html → internal admin (Godwin only)
- `GET /api/tool/admin-overview` — all clients, MRR, recovered totals, health flags, pool stock.
- `POST /api/tool/admin-action` — body: `{ client_id, action }` where action ∈ pause|resume|churn|set_value|reactivate_trial.
- `POST /api/tool/pool/refill` — tops up the number pool.
- ⚠️ NOTE: admin auth is being re-enabled. After that lands, these calls must send header
  `x-admin-key: <ADMIN_KEY>`. Build the UI to read the key from a prompt/localStorage and
  attach it to every admin fetch. (Until it lands, calls work without the header.)

## NEW backend hooks ready to wire (added this build)
- **Onboard-by-URL:** `GET /api/tool/enrich?url=<their-website>` → `{ ok, suggested:{ practice_name, phone, email, business_hours, services } }`.
  In start.html: add a "Paste your website" field that calls this and prefills the form. (Tested live: returns clean data for real dental sites.)
- **Money-clock + first-win:** `GET /api/tool/dashboard?token=` now also returns:
  - `lifetime: { recovered, booked, est_revenue_saved }` — animate a count-up "revenue recovered" hero from this.
  - `first_win: { caller, est_value, booked, created_at } | null` — if present and small lifetime, show the 🎉 first-win celebration.
  - each `recovered_conversations[]` now has a `summary` string (one-line, e.g. `"do you take Delta Dental?" · booked`) — show it as the thread headline.
- **Legal:** `/privacy` and `/terms` pages now exist — link them in footers/signup.
- **Referral loop:** `GET /api/tool/referral?token=` → `{ enabled, referral_link, referred_count, converted_count, free_months_earned }` (or `{ enabled:false }` until its migration runs). Add a "Refer a practice, get a free month" card to recover.html using `referral_link`.
- **Reactivation consent:** the reactivation toggle now accepts `{ consent_confirmed:true }` — add a one-time checkbox ("I confirm these patients consented to be contacted") before enabling reactivation.
- **Signup referral capture:** if `/start` is opened with `?ref=CODE`, pass that `ref` value through in the `POST /api/tool/clients` body so the referrer gets credited.
- **Concierge forwarding ("set it up for me"):** on the forwarding step, add a secondary button → `POST /api/tool/concierge` body `{ token }` → returns `{ ok, booking_link }`. On success, show "We'll call you to set it up — grab a slot: <booking_link>". This rescues the single biggest onboarding drop-off (non-technical owners scared of carrier codes).

## Self-serve account + retention (NEW — wire into recover.html)
The client should manage everything from the dashboard — no emailing/calling anyone.
- `GET /api/tool/account?token=` → `{ status, trial_days_left, billing_enabled, can_pause, can_resume, monthly_price, value_last_30d }`. Render an "Account" panel.
- `POST /api/tool/account/action` body `{ token, action, reason?, confirm? }`:
  - `action:'subscribe'` → returns `{ redirect }` (Dodo checkout) or marks active. Use for trial→paid **self-serve** (replaces "Godwin will call you").
  - `action:'pause'` → pauses (keeps number, stops texting). 
  - `action:'resume'` → reactivates.
  - `action:'cancel'` → **save-flow**: first call returns `{ save_flow:true, value_last_30d, offers:[pause, keep] }` — show this retention screen. Only resend with `confirm:true` to actually cancel.
- **Onboarding is now fully self-serve:** signup → instant number from pool → forwarding (with concierge fallback) → live verification → `subscribe`. No human in the loop. Make the trial-end CTA call `subscribe`, not a cal link.

## Two copy closers a hard buyer asked for (paste-ready)
1. **ROI calculator citation** — under the calculator add small print:
   *"Based on industry studies showing ~30–40% of inbound calls to medical/dental practices go unanswered. Your free week replaces this estimate with your real numbers."*
2. **Trust/HIPAA line near signup** — small reassurance block:
   *"Your data is yours. We never sell it, we sign BAAs with our providers, and you can export or delete it anytime. See our [Privacy Policy](/privacy)."*

## Suggested redesign priorities (CX wins already specced)
- recover.html: giant live "money recovered" count-up hero; first-win celebration state;
  one-line AI call summaries per thread; mobile PWA (add-to-home-screen) feel.
- start.html: "paste your website → we autofill everything" field; carrier-specific
  forwarding instructions; ROI calculator slider; "free week, no card" framing.
- command.html: health-flag color coding (broken forwarding = red), churn-risk badges.

All copy/visuals are yours to reinvent — just keep the fetch contracts above intact.
