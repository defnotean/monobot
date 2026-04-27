-- ─── Per-Entity Persistence Tables — Phase 1 ────────────────────────────────
-- Creates one table per logical entity that currently lives inside the single
-- `bot_data` row's `data` jsonb blob. The new tables COEXIST with the old
-- single-row blob — no destructive change here. Subsequent PRs will migrate
-- read paths over and eventually drop _flushSave + the bot_data table.
--
-- Every table follows the same shape:
--   <natural_key…> + version int + data jsonb + updated_at timestamptz
-- The version column powers optimistic concurrency control in
-- packages/irene/database/perEntity.js — writes do `.eq("version", lastSeen)`
-- and bump version+1 on success; conflicts re-read and retry up to 3 times.
--
-- bot_name is the natural key for "global" tables (mood, relationships,
-- global_state) so multiple bots running against the same Supabase project
-- (e.g. Irene + a future Eris cutover) don't collide. Defaults to the value
-- of config.botName ('irene' by default).
--
-- DO NOT APPLY YET — this file is committed for review. The dual-write flag
-- in config.js stays OFF until the schema is applied in production.

-- ─── Per-guild tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS irene_guild_settings (
  guild_id    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS irene_custom_commands (
  guild_id    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS irene_scrim_stats (
  guild_id    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS irene_starboard_entries (
  guild_id    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS irene_saved_queue (
  guild_id    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- ─── Global / per-bot tables ────────────────────────────────────────────────
-- Keyed on bot_name so a future second bot in the same project doesn't clobber.

CREATE TABLE IF NOT EXISTS irene_mood_state (
  bot_name    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS irene_relationships (
  bot_name    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- Catch-all for cross-guild collections + counters that don't fit elsewhere:
-- _nextWarningId, _nextReminderId, _nextScheduledTaskId, dm_optout, warnings,
-- reminders, scheduled_tasks, birthdays, birthday_announced, server_whitelist,
-- giveaways, highlights, temp_vcs, conversations.
CREATE TABLE IF NOT EXISTS irene_global_state (
  bot_name    text         PRIMARY KEY,
  version     int          NOT NULL DEFAULT 1,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
