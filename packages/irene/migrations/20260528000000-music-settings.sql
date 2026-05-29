-- ─── Music Settings — durable per-guild music/voice config ──────────────────
-- Soundboard sounds, the DJ role, and the voice-listener wake word were all
-- in-memory-only (their init*/get*Data helpers in commands/music/soundboard.js,
-- commands/music/dj.js, and voice/listener.js were never wired to a store), so
-- they reset on every restart. This table backs music/settingsStore.js, which
-- holds the durable copy and degrades to in-memory if this migration hasn't
-- been applied.
--
-- One row per guild. Follows the same shape as the per-entity tables
-- (natural key + jsonb data + updated_at). The data blob looks like:
--   { "soundboard": { "<name>": { "url": "...", "category": null, "duration": null } },
--     "djRole": "<roleId>" | null,
--     "wakeWord": "irene" }
--
-- Safe to run before deploying the code that uses it — the store simply reads
-- and writes once the table exists; before then it stays in-memory.

CREATE TABLE IF NOT EXISTS music_settings (
  guild_id    text         PRIMARY KEY,
  data        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
