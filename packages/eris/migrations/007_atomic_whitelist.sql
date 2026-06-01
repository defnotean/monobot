-- Atomic add/remove for the SHARED server whitelist (bot_data row id='main').
--
-- Why: addToWhitelist used to read the whole bot_data.data blob, mutate
-- data.server_whitelist[guildId] in JS, and upsert the whole blob back. Both
-- twins (Eris AND Irene) write this same row on every boot (auto-track) and on
-- whitelist_server calls — so two concurrent read-modify-write cycles clobber
-- each other (lost update). A manually-whitelisted server could vanish under
-- the other bot's next auto-track upsert, so the gatekeep would then evict the
-- bot on invite. These functions mutate a SINGLE jsonb path atomically in one
-- statement, so concurrent writers can't lose each other's entries.
--
-- Run against your DB:
--   psql $DATABASE_URL -f packages/eris/migrations/007_atomic_whitelist.sql

CREATE OR REPLACE FUNCTION public.bot_whitelist_add(p_guild_id TEXT, p_info JSONB)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO bot_data (id, data)
    VALUES ('main', jsonb_build_object('server_whitelist', jsonb_build_object(p_guild_id, p_info)))
  ON CONFLICT (id) DO UPDATE
    SET data = jsonb_set(
      -- ensure server_whitelist exists without dropping other keys in data
      CASE WHEN bot_data.data ? 'server_whitelist' THEN bot_data.data
           ELSE jsonb_set(COALESCE(bot_data.data, '{}'::jsonb), '{server_whitelist}', '{}'::jsonb) END,
      ARRAY['server_whitelist', p_guild_id], p_info, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_whitelist_remove(p_guild_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE bot_data
    SET data = data #- ARRAY['server_whitelist', p_guild_id]
    WHERE id = 'main';
END;
$$;

-- Whitelist mutation is owner-gated in the bot and must not be directly
-- callable through client API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.bot_whitelist_add(TEXT, JSONB) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION public.bot_whitelist_remove(TEXT) FROM anon, authenticated;
  END IF;
  REVOKE EXECUTE ON FUNCTION public.bot_whitelist_add(TEXT, JSONB) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.bot_whitelist_remove(TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.bot_whitelist_add(TEXT, JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION public.bot_whitelist_remove(TEXT) TO service_role;
  END IF;
END $$;
