# Vyrrah Lead Enricher

Bulk, cheap, no per-lead AI. CSV in → per-lead V-Rank signals + score + personalized
opener → enriched CSV split into a dial-list and an email-list, sorted by score.

## Run
```
node enricher/enrich.mjs <input.csv> [--limit N] [--concurrency 20] [--out DIR]
# example:
node enricher/enrich.mjs ~/Downloads/restoration_leads.csv --concurrency 30
```
Input just needs a website column (Company Website / Website / Domain). Everything
else (name, title, phone, email, city, Company Technologies) is auto-detected and
carried through. Works on Apollo exports and Google-Maps scrapes as-is.

## Output (in enricher/out/)
- `<name>_ENRICHED.csv` — all leads, every signal + score + CallOpener + EmailLine
- `<name>_DIAL.csv`  — sweet-spot leads that have a phone, worst-score first (dial these)
- `<name>_EMAIL.csv` — sweet-spot leads that have an email (load into Smartlead)

`Tier` column: SWEET-SPOT (work these) · SKIP (too strong, nothing to sell) · WEAK/small · BLOCKED.

## How it scores
Fetches the homepage, extracts deterministic signals (schema, LocalBusiness, content
depth, reviews, lead-capture, ad pixels, load time) and computes a V-Rank-style 0–100.
No LLM per lead — that's what makes it run at 50K for ~$0. The opener is assembled from
`templates.mjs` (edit fragments there); it only ever asserts a DETECTED signal.

## Speed / cost
~50 leads in ~18s at concurrency 20 → 50K ≈ a couple of hours, ~$0. A per-domain
`.cache.json` skips already-seen domains, so re-runs and daily incrementals are near-free.

## Optional keys (env)
- `PAGESPEED_API_KEY` — real mobile performance score, added to sweet-spot leads only.
- (phase-2 TODO) Google Places → real review counts; Meta Ad Library → live ad count/creatives.
  These turn "your reviews aren't surfaced" into "47 reviews vs their 210" — the numbers
  that make prospects say "how do you know that."

## Roadmap
1. Shared core: replace local `scoreOf/signals` with `api/_lib/vrank-core` so batch +
   the live /scorecard endpoint can't drift.
2. Phase-2 signals: Places reviews, Meta Ad Library live-ads, competitor names.
3. Push: n8n/cron → auto-run on new lists → Smartlead (email) + dialer import (calls).
