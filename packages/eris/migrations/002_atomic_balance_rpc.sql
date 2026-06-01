-- Atomic balance mutation via a single round-trip RPC.
--
-- Why: the prior `_updateBalanceUnsafe` path uses an optimistic-concurrency
-- loop (read row → compute → UPDATE WHERE version = N → retry on miss).
-- That works, but every retry is two network hops and the in-process
-- `withEconLock` mutex is the only thing keeping co-located callers in line.
-- A `UPDATE … SET balance = balance + delta` happens inside one Postgres
-- transaction, so two parallel callers — even from two different processes
-- (autoscaled workers) — can't both read the same balance and each write +N.
--
-- Behavior: increments the running tallies the same way the JS path did so
-- the cache/DB shape stays identical. Refuses the update and returns NULL
-- when the resulting balance would go negative (caller maps NULL → throw
-- insufficient_balance, matching the existing error path).
--
-- Run against your Supabase project:
--   psql $DATABASE_URL -f packages/eris/migrations/002_atomic_balance_rpc.sql
-- Or paste into the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.eris_add_balance(
  p_user_id    TEXT,
  p_delta      BIGINT,
  p_type       TEXT DEFAULT 'other',
  p_details    TEXT DEFAULT ''
)
RETURNS TABLE (
  user_id           TEXT,
  balance           BIGINT,
  total_earned      BIGINT,
  total_lost        BIGINT,
  total_gambled     BIGINT,
  total_stolen      BIGINT,
  total_stolen_from BIGINT,
  version           INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row eris_economy%ROWTYPE;
BEGIN
  -- Lock the row for the duration of this transaction so concurrent callers
  -- serialize on it. SELECT … FOR UPDATE is the minimum guarantee here.
  SELECT * INTO v_row FROM eris_economy WHERE eris_economy.user_id = p_user_id FOR UPDATE;

  -- Initialize the user if they don't exist yet (matches getBalance defaults).
  IF NOT FOUND THEN
    INSERT INTO eris_economy (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
    VALUES (p_user_id, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
    RETURNING * INTO v_row;
  END IF;

  -- Refuse the mutation when it would drive balance negative. Caller turns
  -- a NULL return into the same `insufficient_balance` error the JS path raises.
  IF (v_row.balance + p_delta) < 0 THEN
    RETURN;  -- empty result set → caller treats as insufficient
  END IF;

  -- Apply the delta + tally updates in one UPDATE. Mirrors the JS bookkeeping:
  --   delta > 0 → total_earned += delta
  --   delta < 0 (except prestige) → total_lost += |delta|
  --   type starts with "gamble" → total_gambled += |delta|
  --   type == "rob_success" → total_stolen += delta
  --   type == "rob_victim"  → total_stolen_from += |delta|
  UPDATE eris_economy SET
    balance           = balance + p_delta,
    total_earned      = total_earned      + CASE WHEN p_delta > 0 THEN p_delta ELSE 0 END,
    total_lost        = total_lost        + CASE WHEN p_delta < 0 AND p_type <> 'prestige' THEN ABS(p_delta) ELSE 0 END,
    total_gambled     = total_gambled     + CASE WHEN p_type LIKE 'gamble%' THEN ABS(p_delta) ELSE 0 END,
    total_stolen      = total_stolen      + CASE WHEN p_type = 'rob_success' THEN p_delta ELSE 0 END,
    total_stolen_from = total_stolen_from + CASE WHEN p_type = 'rob_victim'  THEN ABS(p_delta) ELSE 0 END,
    version           = version + 1
  WHERE eris_economy.user_id = p_user_id
  RETURNING
    eris_economy.user_id,
    eris_economy.balance,
    eris_economy.total_earned,
    eris_economy.total_lost,
    eris_economy.total_gambled,
    eris_economy.total_stolen,
    eris_economy.total_stolen_from,
    eris_economy.version
  INTO STRICT user_id, balance, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, version;

  RETURN NEXT;
END;
$$;

-- The bot connects with the service_role key; client API roles must not be able
-- to mint or burn balances directly.
REVOKE EXECUTE ON FUNCTION public.eris_add_balance(TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.eris_add_balance(TEXT, BIGINT, TEXT, TEXT) FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.eris_add_balance(TEXT, BIGINT, TEXT, TEXT) TO service_role;
  END IF;
END $$;
