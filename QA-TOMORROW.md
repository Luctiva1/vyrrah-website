# Vyrrah Recaller — Tomorrow's short QA (≈10 minutes)

Everything is built and staged. Tomorrow is: add keys → deploy → run one script →
eyeball a few things. If the script is all-green and the manual checks pass, you're
clear to start selling.

## Step 1 — Add keys in Vercel (2 min)
Set in Vercel → Settings → Environment Variables (details in `SETUP.md`):
- `OPENAI_API_KEY`  ← biggest one; turns the AI demo on
- (optional now) `DODO_*`, `ANTHROPIC_API_KEY`, `ADMIN_KEY`
Leave `ADMIN_KEY` unset for now if you don't want a password on /command yet.

## Step 2 — Deploy (1 min)
```
cd /tmp/vyrrah-website
VERCEL_TOKEN=<your-token> node scripts/deploy.mjs
```

## Step 3 — Run the smoke test (10 sec)
```
python3 scripts/smoke.py
```
**Expected: all green (10 passed, 0 failed).** Today it's 5/5 because the new code
isn't live yet — after deploy the other 5 (privacy, terms, enrich, referral,
dashboard lifetime) flip to PASS.
If anything is RED, stop and tell me the line — don't send a prospect.

## Step 4 — 5-minute manual sniff test (the buyer's path)
1. **Demo brain (the make-or-break):** open `/start`, text the demo line a HARD
   question ("do you take Cigna PPO and how much is a crown?"). With the OpenAI key
   live it should answer like a real receptionist, not a generic template.
2. **Onboard-by-URL:** in the signup form, paste a real practice site → confirm the
   name/phone/services autofill.
3. **Dashboard:** open the demo dashboard link (in `TOOL-FRONTEND-HANDOFF.md`) →
   confirm the recovered-revenue number, first-win, and one-line call summaries show.
4. **Forwarding concierge:** confirm the "set it up for me" path pings you.
5. **Legal:** `/privacy` and `/terms` load.

## Step 5 — (optional) run the DB migration
If you want referrals + consent-gated reactivation live:
Supabase → SQL Editor → paste `migrations/2026-06-referral-consent.sql` → Run.
Then `/api/tool/referral?token=...` returns `enabled:true`.

## Still your paperwork (not blocking the first sells, but do soon)
- A2P 10DLC registration (so SMS delivers at scale) — the real gate.
- BAAs (Twilio/OpenAI/Supabase/SendGrid) before medical clients.

---
### What "all green + manual pass" means
The product works end-to-end: missed call → AI text-back → booking → dashboard ROI,
plus self-healing forwarding, reactivation, reviews, monthly ROI emails, referrals,
concierge setup, legal. At that point the only thing between you and revenue is
outreach + A2P approval.
