-- Outreach dialer hardening. Safe to re-run.
-- Run in Supabase → SQL editor, then it reloads the PostgREST schema cache.
--
-- 1) Email features write channel:'email' to sequences + sms_messages, but the
--    original schema has no `channel` column → every email enroll/process/inbound
--    insert 500s. Add it (default 'sms' so existing SMS rows stay correct).
-- 2) CSV re-imports created duplicate leads (no unique key on phone). Add a unique
--    index so the backend can upsert on conflict instead of inserting dupes.

-- ── channel column ───────────────────────────────────────────────────────────
ALTER TABLE sequences    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms';
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms';

CREATE INDEX IF NOT EXISTS idx_sequences_channel    ON sequences(channel);
CREATE INDEX IF NOT EXISTS idx_sms_messages_channel ON sms_messages(channel);

-- ── dedup leads on phone ─────────────────────────────────────────────────────
-- Collapse any pre-existing duplicate phones first (keep the oldest row) so the
-- unique index can be created. Re-pointing children is unnecessary because the
-- import upsert below only needs the constraint going forward.
WITH ranked AS (
  SELECT id, phone,
         ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at ASC, id ASC) AS rn
  FROM leads
  WHERE phone IS NOT NULL AND phone <> ''
)
DELETE FROM leads l
USING ranked r
WHERE l.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_leads_phone ON leads(phone);

-- ── reload PostgREST schema cache so the new columns are visible immediately ──
NOTIFY pgrst, 'reload schema';
