-- Atomic daily/weekly/monthly claim — credit + cooldown stamp in ONE transaction.
--
-- Why: claimDaily/claimWeekly/claimMonthly stamp the cooldown (last_* + streak)
-- and credit the coins as two separate writes. The JS now stamps BEFORE
-- crediting so a crash leaves the cooldown set and coins un-credited
-- (fail-closed), but that's still two round-trips and the in-process
-- withEconLock is the only thing serializing co-located callers. This RPC does
-- the cooldown re-check, the stamp, and the credit inside a single Postgres
-- transaction with SELECT … FOR UPDATE, so even two processes can't both pass
-- the cooldown check and each credit.
--
-- p_kind is 'daily' | 'weekly' | 'monthly'. The cooldown window + streak-reset
-- window + reward formula are passed in by the caller so the economics stay
-- defined in JS (this function only enforces atomicity). Returns the new
-- balance + streak on success; empty result set when still on cooldown (caller
-- maps that to { success: false, hoursLeft } the same way the JS path does).
--
-- Run against your Supabase project:
--   psql $DATABASE_URL -f packages/eris/migrations/003_atomic_claim_rpc.sql
-- Or paste into the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.eris_claim_reward(
  p_user_id        TEXT,
  p_kind           TEXT,      -- 'daily' | 'weekly' | 'monthly'
  p_coins          BIGINT,    -- reward amount the caller computed
  p_streak         INTEGER,   -- new streak the caller computed
  p_cooldown_secs  BIGINT,    -- minimum seconds between claims
  p_now            TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  balance BIGINT,
  streak  INTEGER
)
LANGUAGE plpgsql
AS $$
-- The OUT columns (balance, streak) share a name with eris_economy.balance, so
-- an unqualified `balance` inside the UPDATE SET would be ambiguous. Tell
-- PL/pgSQL to resolve such collisions to the COLUMN (the values we're updating);
-- the OUT params are only ever assigned via RETURNING ... INTO, which is exempt.
#variable_conflict use_column
DECLARE
  v_row     eris_economy%ROWTYPE;
  v_last    TIMESTAMPTZ;
BEGIN
  IF p_kind NOT IN ('daily', 'weekly', 'monthly') THEN
    RAISE EXCEPTION 'eris_claim_reward: unknown kind %', p_kind;
  END IF;

  -- Lock the row so concurrent claims serialize on it.
  SELECT * INTO v_row FROM eris_economy WHERE eris_economy.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO eris_economy (user_id, balance, daily_streak, total_earned, version)
    VALUES (p_user_id, 100, 0, 0, 0)
    RETURNING * INTO v_row;
  END IF;

  -- Cooldown re-check INSIDE the lock — the authoritative gate.
  v_last := CASE p_kind
    WHEN 'daily'   THEN v_row.last_daily
    WHEN 'weekly'  THEN v_row.last_weekly
    WHEN 'monthly' THEN v_row.last_monthly
  END;
  IF v_last IS NOT NULL AND (p_now - v_last) < make_interval(secs => p_cooldown_secs) THEN
    RETURN;  -- still on cooldown → empty result set
  END IF;

  -- Stamp the cooldown + streak AND credit in one UPDATE. Atomic: either both
  -- land or neither does, so there is no double-claim window at all.
  IF p_kind = 'daily' THEN
    UPDATE eris_economy SET
      balance      = balance + p_coins,
      total_earned = total_earned + p_coins,
      version      = version + 1,
      last_daily   = p_now,
      daily_streak = p_streak
    WHERE eris_economy.user_id = p_user_id
    RETURNING eris_economy.balance, eris_economy.daily_streak INTO balance, streak;
  ELSIF p_kind = 'weekly' THEN
    UPDATE eris_economy SET
      balance       = balance + p_coins,
      total_earned  = total_earned + p_coins,
      version       = version + 1,
      last_weekly   = p_now,
      weekly_streak = p_streak
    WHERE eris_economy.user_id = p_user_id
    RETURNING eris_economy.balance, eris_economy.weekly_streak INTO balance, streak;
  ELSE
    UPDATE eris_economy SET
      balance        = balance + p_coins,
      total_earned   = total_earned + p_coins,
      version        = version + 1,
      last_monthly   = p_now,
      monthly_streak = p_streak
    WHERE eris_economy.user_id = p_user_id
    RETURNING eris_economy.balance, eris_economy.monthly_streak INTO balance, streak;
  END IF;

  RETURN NEXT;
END;
$$;

-- Reward claim economics are bot-controlled. Revoke default/client execution
-- and leave this callable only through the backend service role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.eris_claim_reward(TEXT, TEXT, BIGINT, INTEGER, BIGINT, TIMESTAMPTZ) FROM anon, authenticated;
  END IF;
  REVOKE EXECUTE ON FUNCTION public.eris_claim_reward(TEXT, TEXT, BIGINT, INTEGER, BIGINT, TIMESTAMPTZ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.eris_claim_reward(TEXT, TEXT, BIGINT, INTEGER, BIGINT, TIMESTAMPTZ) TO service_role;
  END IF;
END $$;
