-- Vyrrah Recaller — referral loop + reactivation consent
-- Run once in Supabase → SQL Editor. The app code is already written for these
-- columns and stays dormant/safe until they exist, so this is the only step to
-- turn both features fully on.

-- ── Referral loop (#65) ──
alter table tool_clients add column if not exists referral_code text;
alter table tool_clients add column if not exists referred_by uuid references tool_clients(id);
alter table tool_clients add column if not exists referral_credited boolean not null default false;
alter table tool_clients add column if not exists referral_credit_months integer not null default 0;
create unique index if not exists uniq_referral_code on tool_clients(referral_code) where referral_code is not null;

-- ── Reactivation TCPA consent gate (#47) ──
-- reactivationPass() will NOT send to an uploaded patient list until this is true.
alter table tool_clients add column if not exists reactivation_consent_confirmed boolean not null default false;
alter table tool_clients add column if not exists reactivation_consent_at timestamptz;

-- Reload PostgREST schema cache so the new columns are visible immediately.
notify pgrst, 'reload schema';
