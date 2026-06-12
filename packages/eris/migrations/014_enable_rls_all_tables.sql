-- Enable Row Level Security + revoke client-role grants on EVERY table the
-- Monobot twins (Eris + Irene) touch, and give local_commands an explicit
-- CREATE TABLE + lockdown (it previously only ever existed implicitly).
--
-- Why: before this migration the only protected table was
-- eris_stock_portfolios (migration 012 revoked its client grants — but even it
-- never enabled RLS). Every other table rode Supabase's default posture:
-- anon + authenticated hold full SELECT/INSERT/UPDATE/DELETE, so a leaked
-- anon/publishable key meant full read/write of balances, PII memory facts,
-- the server whitelist, the mod audit trail — and, worst, INSERT into
-- local_commands, whose rows get exec()'d on the owner's machine by the
-- agent-ui poller.
--
-- After this migration the posture is deny-by-default:
--   * RLS enabled on every table, with NO policies (deny-all for any role
--     that is subject to RLS).
--   * All table privileges revoked from anon, authenticated and PUBLIC.
--   * service_role keeps explicit grants and, on Supabase, carries BYPASSRLS —
--     the bots keep working unchanged IF they connect with the service-role
--     key (see the critical caveat below).
--
-- local_commands defense-in-depth: the agent-ui poller already verifies an
-- app-layer HMAC on every row (verifyLocalCommand in
-- packages/eris/agent-ui/main.js — sig = HMAC_SHA256(TWIN_API_SECRET,
-- `${requested_by}.${command}.${ts}`), fail-closed). That HMAC stays in place
-- as the SECOND factor; this migration makes "can INSERT a row at all" the
-- first factor instead of the only barrier being the HMAC.
--
-- ─── CRITICAL CAVEAT: THE BOTS MUST USE THE SERVICE-ROLE KEY ─────────────────
--
-- This lockdown assumes both bots connect with the service_role key.
-- docs/CONFIGURATION.md historically allowed `SUPABASE_KEY` to be the
-- "Service-role or anon key". If your deployment currently sets SUPABASE_KEY
-- to the anon (or publishable) key, the bots LOSE ALL DATABASE ACCESS the
-- moment this migration is applied — switch SUPABASE_KEY to the service-role
-- key (Supabase -> Project Settings -> API: legacy JWT whose payload contains
-- "role":"service_role", or a new-style `sb_secret_...` key) BEFORE applying.
-- The anon / `sb_publishable_...` key must be treated as compromised-by-design
-- and must never again be able to reach these tables.
--
-- Plain Postgres + PostgREST deployments (docs/PERSISTENCE.md): the role
-- guards below are no-ops if `anon`/`authenticated`/`service_role` don't
-- exist. Make sure the role PostgREST authenticates the bots as either owns
-- the tables, or has explicit grants plus BYPASSRLS (or add policies for it) —
-- otherwise the bots are locked out the same way.
--
-- Idempotent and resilient: every table is processed inside a DO block that
-- skips names that don't exist yet (several tables are created lazily or by
-- hand per module-header docs, e.g. eris_bump_joins). Re-run this migration
-- after creating any new table so it inherits the same lockdown.
--
-- ─── RPC GRANT AUDIT (every CREATE FUNCTION in migrations 001–013) ──────────
--
--   002 eris_add_balance ............................ revoke present (ok)
--   003 eris_claim_reward ........................... revoke present (ok)
--   007 bot_whitelist_add / bot_whitelist_remove .... revoke present (ok)
--   009 eris_add_bank_balance ....................... revoke present (ok)
--   010 eris_consume_inventory_item ................. revoke present (ok)
--   011 eris_damage_boss ............................ revoke present (ok —
--       lowercase SQL; easy to miss in a case-sensitive grep)
--   012 eris_buy_stock_shares / eris_sell_stock_shares  revoke present (ok)
--   013 eris_buy_lottery_ticket / eris_claim_lottery_draw  revoke present (ok)
--   search_memories ................................. no revoke anywhere in
--       the repo: defined OUTSIDE it (operator-created pgvector RPC, see
--       docs/PERSISTENCE.md) — revoked below for every overload that exists.
--   match_injection_patterns ........................ same situation: called
--       via supabase.rpc() from packages/shared/src/ai/firewall.js with no
--       in-repo DDL (operator-created pgvector match function) — revoked
--       below for every overload that exists.
--
-- Run against your Supabase project (apply to EVERY project either bot points
-- at — both bots normally share one):
--   psql $DATABASE_URL -f packages/eris/migrations/014_enable_rls_all_tables.sql
-- Or paste into the Supabase SQL Editor.

-- ─── 1. local_commands: explicit table definition ───────────────────────────
-- No migration ever created this table (004 only ALTERs it). Column set is
-- inferred from every reader/writer:
--   packages/eris/database/userContent.js queueLocalCommand inserts
--     command, channel_id, requested_by, status, sig, ts;
--   packages/eris/agent-ui/main.js pollCommands selects status='pending'
--     ordered by created_at, reads id/command/confirm/channel_id/sig/ts/
--     requested_by, and updates status + result.

CREATE TABLE IF NOT EXISTS public.local_commands (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  channel_id TEXT,
  requested_by TEXT,
  confirm BOOLEAN NOT NULL DEFAULT FALSE,
  sig TEXT,
  ts BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Converge hand-created tables that predate this migration: add any column
-- the code touches that is missing (sig/ts repeat migration 004 — harmless).
ALTER TABLE public.local_commands
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS result TEXT,
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS requested_by TEXT,
  ADD COLUMN IF NOT EXISTS confirm BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sig TEXT,
  ADD COLUMN IF NOT EXISTS ts BIGINT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The poller polls `status = 'pending' ORDER BY created_at` every cycle.
CREATE INDEX IF NOT EXISTS local_commands_status_created_at_idx
  ON public.local_commands (status, created_at);

-- ─── 2. RLS + client-grant revoke on every table ─────────────────────────────
-- Deny-by-default: RLS with zero policies blocks anon/authenticated even if a
-- future grant slips back in; the revokes close the current grants. Tables
-- that don't exist (lazily-created, optional integrations, legacy names) are
-- skipped — re-run after creating them.

DO $$
DECLARE
  t TEXT;
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- Shared infrastructure (both bots / packages/shared)
    'bot_data',                    -- guild settings, server whitelist, personas, stocks blob
    'dual_write_sagas',            -- irene/migrations/20260516000000
    'local_commands',              -- host command queue (created above)
    'music_settings',              -- irene/music/settingsStore.js
    'injection_patterns',          -- shared/src/ai/firewall.js (operator-created)
    'injection_log',               -- shared/src/ai/firewall.js (operator-created)
    -- Eris
    'eris_achievements', 'eris_analytics', 'eris_auctions', 'eris_bank',
    'eris_boss_battles', 'eris_bounties', 'eris_bumps', 'eris_bump_joins',
    'eris_bump_user_prefs', 'eris_confessions', 'eris_daily_challenges',
    'eris_deploy_watches', 'eris_dreams', 'eris_economy',
    'eris_episodic_memories', 'eris_facts', 'eris_game_stats', 'eris_heists',
    'eris_inventory', 'eris_loans', 'eris_marriages', 'eris_memories',
    'eris_mood', 'eris_news_watches', 'eris_notes', 'eris_pc_audit',
    'eris_personality', 'eris_personality_learning', 'eris_pets',
    'eris_price_watches', 'eris_recipes', 'eris_relationships',
    'eris_reminders', 'eris_roast_battles', 'eris_shop_items',
    'eris_snippets',
    -- eris_stock_portfolios: 012 revoked its client grants but never enabled
    -- RLS — the ENABLE below is the missing half (revokes repeat harmlessly).
    'eris_stock_portfolios',
    'eris_territories', 'eris_transactions', 'eris_trivia',
    'eris_user_preferences',
    -- Last.fm integration (operator-created)
    'fm_crowns', 'fm_user_albums', 'fm_user_artists', 'fm_user_tracks',
    'fm_users',
    -- Irene
    'irene_bumps', 'irene_bump_joins', 'irene_bump_user_prefs',
    'irene_custom_commands', 'irene_episodic_memories', 'irene_global_state',
    'irene_guild_settings', 'irene_mod_audit', 'irene_mood_state',
    'irene_personality', 'irene_personality_learning', 'irene_relationships',
    'irene_saved_queue', 'irene_scrim_stats', 'irene_starboard_entries',
    -- Legacy / possibly-present names: irene_economy is ALTERed by migration
    -- 001; the rest appear in the eris query_database allowlist or stale
    -- module docs and may exist on older deployments. All skipped if absent.
    'irene_economy', 'eris_portfolios', 'eris_stocks', 'eris_games',
    'eris_cooldowns', 'eris_prestige', 'eris_shop', 'eris_boss'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    IF has_anon THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    END IF;
    IF has_service_role THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

-- Identity sequence for local_commands: keep nextval() away from client roles,
-- make sure service_role can insert (plain-Postgres setups have no default
-- privileges doing this for them).
DO $$
DECLARE
  seq TEXT := pg_get_serial_sequence('public.local_commands', 'id');
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  IF seq IS NULL THEN
    RETURN; -- pre-existing table with a non-identity id column
  END IF;
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', seq);
  IF has_anon THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon', seq);
  END IF;
  IF has_authenticated THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM authenticated', seq);
  END IF;
  IF has_service_role THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
  END IF;
END $$;

-- ─── 3. RPCs missing their client-grant revoke ───────────────────────────────
-- Every in-repo RPC migration (002–013) already revokes client execution; the
-- RPCs without any revoke are the two operator-created pgvector functions with
-- no in-repo DDL: search_memories (docs/PERSISTENCE.md) and
-- match_injection_patterns (shared/src/ai/firewall.js). Signatures vary per
-- deployment, so revoke every overload that exists by catalog lookup.

DO $$
DECLARE
  fn RECORD;
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOR fn IN
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('search_memories', 'match_injection_patterns')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', fn.name, fn.args);
    IF has_anon THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon', fn.name, fn.args);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM authenticated', fn.name, fn.args);
    END IF;
    IF has_service_role THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', fn.name, fn.args);
    END IF;
  END LOOP;
END $$;

-- ─── Optional follow-on hardening (NOT applied — uncomment deliberately) ─────
-- Supabase's default privileges grant new tables to anon/authenticated, so a
-- table created tomorrow is born open again until this migration is re-run.
-- Revoking the default privileges closes that — but it affects every future
-- table created by the role that runs this, including ones belonging to other
-- apps sharing the project. Opt in only if the bots are the project's sole
-- tenant:
--
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
