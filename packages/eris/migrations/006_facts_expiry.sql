-- Optional time-to-live for sensitive-tier user facts.
--
-- Why: "sensitive"-tier facts (and incidental sensitive disclosures) otherwise
-- live forever. When the operator sets SENSITIVE_FACT_TTL_DAYS to a positive
-- integer, saveFact stamps `expires_at` on new sensitive-tier rows; getFacts /
-- getFactsGlobal hide already-expired rows at read time (_filterExpiredFacts),
-- and purgeExpiredFacts hard-deletes them. "secret"-tier facts are deliberately
-- NOT given a TTL (the user asked to keep them; they stay until forget_all).
--
-- The column is nullable so the JS degrades safely before this migration is
-- applied: saveFact first attempts the insert WITH expires_at and, if PostgREST
-- rejects the unknown column, flips an internal latch and retries without it
-- (no-expiry inserts); the read-time filter treats a missing column as "no
-- expiry" and keeps the row. No NOT NULL violation either way. With the column
-- present but SENSITIVE_FACT_TTL_DAYS unset/0, expires_at is simply never set,
-- so behavior is identical to today until an operator opts in.
--
-- The partial index keeps purgeExpiredFacts' "expires_at < now()" sweep cheap
-- without indexing the (vast majority) of rows that have no expiry.
--
-- Run against your Supabase project:
--   psql $DATABASE_URL -f packages/eris/migrations/006_facts_expiry.sql
-- Or paste into the Supabase SQL Editor.

ALTER TABLE eris_facts
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS eris_facts_expires_at_idx
  ON eris_facts (expires_at)
  WHERE expires_at IS NOT NULL;
