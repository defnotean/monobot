-- Add HMAC signature + timestamp columns to local_commands.
--
-- Why: the PC-agent poller executes machine-level commands enqueued in
-- local_commands. To stop a forged row from driving owner-only execution, the
-- bot now signs each enqueue with HMAC_SHA256(secret, `${requested_by}.${command}.${ts}`)
-- where secret = config.twinApiSecret (TWIN_API_SECRET), falling back to
-- pcAgentSecret if present. The poller verifies sig against ts + requested_by +
-- command and rejects unsigned / mismatched rows.
--
-- Both columns are nullable so the JS degrades safely before this migration is
-- applied: queueLocalCommand still inserts requested_by, and rows enqueued
-- without a configured secret carry no sig (the poller rejects those by policy,
-- not by a NOT NULL violation).
--
-- Run against your Supabase project:
--   psql $DATABASE_URL -f packages/eris/migrations/004_local_commands_signature.sql
-- Or paste into the Supabase SQL Editor.

ALTER TABLE local_commands
  ADD COLUMN IF NOT EXISTS sig TEXT,
  ADD COLUMN IF NOT EXISTS ts  BIGINT;
