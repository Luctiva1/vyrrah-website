-- geo_leads: every anonymous scorecard scan becomes a captured lead.
-- The scanned DOMAIN is a hot inbound signal (they just checked their own AI
-- visibility) even before we have an email. handleScorecard() logs a row per
-- fresh scan (source='scan'); the soft email gate logs source='email-report'
-- with an email attached. Both are fail-soft: if this table is absent the tool
-- still works, it just does not capture. Run this in the Supabase SQL editor.

create table if not exists geo_leads (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  host         text,
  url          text,
  score        int,
  vertical     text,
  ad_spend     int,
  email        text,
  source       text default 'scan',   -- 'scan' | 'email-report'
  competitor   text,
  cold_start   boolean,
  blocked      boolean,
  ip           text,
  user_agent   text,
  referer      text,
  emailed_at   timestamptz,
  status       text default 'new'     -- new | contacted | converted | dead
);

create index if not exists geo_leads_created_idx on geo_leads (created_at desc);
create index if not exists geo_leads_score_idx   on geo_leads (score);
create index if not exists geo_leads_host_idx    on geo_leads (host);
create index if not exists geo_leads_email_idx   on geo_leads (email);
