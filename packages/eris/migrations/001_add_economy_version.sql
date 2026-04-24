-- Add version column for optimistic locking on economy operations.
-- This prevents race conditions where two concurrent writes both read
-- the same balance and overwrite each other's changes.
--
-- Run this against your Supabase project:
--   psql $DATABASE_URL -f migrations/001_add_economy_version.sql
-- Or paste into the Supabase SQL Editor.

ALTER TABLE irene_economy
ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 0;

-- Backfill existing rows
UPDATE irene_economy SET version = 0 WHERE version IS NULL;
