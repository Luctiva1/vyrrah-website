-- Client-portal login passwords (bcrypt hashes). Safe to re-run.
-- Run in Supabase → SQL editor. Until this runs, password login is dormant
-- (the email-link login + magic_token still work; signup just won't store a password).
ALTER TABLE tool_clients ADD COLUMN IF NOT EXISTS password_hash text;
