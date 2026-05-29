-- ─── Moderation Audit Trail — durable record of every mod action ────────────
-- The mod audit was a 100-entry in-memory ring (database.js#logAudit, stored in
-- guild_settings.audit_log) that's wiped on every restart and never recorded
-- several destructive AI-tool actions (timeout, lockdown, unlock, ...). This
-- table is a durable, append-only sink for every moderation action so "ban the
-- spammer" is auditable against who it resolved to and who confirmed it.
--
-- One row per action. Indexed on (guild_id, ts DESC) for the common
-- "show this guild's recent mod actions" query. Columns:
--   guild_id   — the server the action happened in
--   actor_id   — the HUMAN who is accountable. For slash / inline tool calls
--                that's the invoking mod; for an AI action gated behind a
--                Confirm button it's the mod who CLICKED Confirm (NOT the AI,
--                NOT the requester who asked the AI).
--   target_id  — the user/object acted on (user id, warning id, "N messages"…)
--   action     — ban | unban | kick | timeout | untimeout | tempban | warn |
--                purge | lockdown | unlock | unmute | remove_warning |
--                clear_warnings (free-text; not constrained so new tools don't
--                need a migration)
--   reason     — the moderation reason
--   source     — 'slash' | 'ai-tool' | 'ai-tool-confirmed' | 'auto-mod' | 'twin'
--   instruction— the ORIGINAL natural-language instruction when the action came
--                from the AI path (e.g. "ban the spammer"), else null
--   ts         — when it happened
--
-- Best-effort sink: moderationExecutor.js writes here fire-and-forget and
-- catches every failure. If this migration hasn't been applied (or Supabase
-- isn't configured) the executor degrades to the existing in-memory ring and
-- logs once. Safe to apply before deploying the code — the table just fills up
-- once the code that writes to it ships.

CREATE TABLE IF NOT EXISTS irene_mod_audit (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id     text          NOT NULL,
  actor_id     text          NULL,
  target_id    text          NULL,
  action       text          NOT NULL,
  reason       text          NULL,
  source       text          NOT NULL DEFAULT 'ai-tool',
  instruction  text          NULL,
  ts           timestamptz   NOT NULL DEFAULT now()
);

-- Hot-path index — "recent mod actions for this guild, newest first".
CREATE INDEX IF NOT EXISTS irene_mod_audit_guild_ts
  ON irene_mod_audit (guild_id, ts DESC);
