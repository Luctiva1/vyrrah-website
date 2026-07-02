-- geo_events: the funnel instrument. One row per meaningful step so we can actually
-- measure the AARRR targets (scan -> gen -> signup -> checkout -> paid -> return ->
-- referral) instead of guessing, and so the trial nurture cron can dedupe which
-- touches it has already sent (touch_day1 / touch_day4 / touch_day6). Fail-soft:
-- everything works without it, we just fly blind. Run in the Supabase SQL editor.

create table if not exists geo_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  type        text not null,   -- scan|email_capture|signup|gen|checkout_started|paid|dashboard_return|referral_sent|touch_day1|touch_day4|touch_day6|close_shown
  client_id   text,
  lead_id     text,
  meta        jsonb
);

create index if not exists geo_events_type_idx    on geo_events (type, created_at desc);
create index if not exists geo_events_client_idx  on geo_events (client_id, type);
create index if not exists geo_events_created_idx  on geo_events (created_at desc);
