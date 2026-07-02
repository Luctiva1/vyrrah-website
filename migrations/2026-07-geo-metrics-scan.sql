-- Persist the full scorecard scan on the customer's latest geo_metrics row so the
-- trial dashboard can render it as an actionable "work plan" (the gaps become the
-- to-do list). Fail-soft: signup + dashboard both work without this column, they
-- just fall back to the score-only seed / representative view. Run in Supabase.

alter table geo_metrics add column if not exists scan jsonb;
