-- Referral attribution for V-Rank. A customer's referral link carries ?ref=<their
-- client id>; a new trial that signs up through it stores referred_by = that id.
-- referral_credits banks free-month credits to apply at billing time. Both are
-- additive + fail-soft: signup and dashboard work without them. Run in Supabase.
-- NOTE: this is business-to-SaaS referral (a customer recommending a growth tool),
-- NOT a patient/client referral fee — the thing that is illegal in health/legal.

alter table tool_clients add column if not exists referred_by      text;
alter table tool_clients add column if not exists referral_credits int default 0;

create index if not exists tool_clients_referred_by_idx on tool_clients (referred_by);
