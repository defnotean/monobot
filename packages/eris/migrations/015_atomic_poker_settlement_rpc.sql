-- Settle or refund a persisted poker table in one Postgres transaction.
-- The bot_data row is the idempotency key: once a table is removed, replaying
-- the same recovery id returns alreadySettled and never credits users twice.

CREATE OR REPLACE FUNCTION public.eris_settle_poker_table(
  p_recovery_id TEXT,
  p_payouts JSONB,
  p_expected_pot BIGINT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state JSONB;
  v_table JSONB;
  v_entry JSONB;
  v_ante JSONB;
  v_user_id TEXT;
  v_amount BIGINT;
  v_pot BIGINT := 0;
  v_total BIGINT := 0;
  v_seen JSONB := '{}'::jsonb;
  v_payout_count INTEGER := 0;
  v_tables JSONB;
BEGIN
  IF p_recovery_id IS NULL OR length(p_recovery_id) < 1 OR length(p_recovery_id) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_recovery_id');
  END IF;
  IF p_reason NOT IN ('poker_win', 'poker_refund') OR jsonb_typeof(p_payouts) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_settlement');
  END IF;
  IF jsonb_array_length(p_payouts) > 6 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_payouts');
  END IF;

  SELECT b.data INTO v_state
  FROM public.bot_data b
  WHERE b.id = 'eris_poker_active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'alreadySettled', true, 'payoutCount', 0);
  END IF;

  v_tables := COALESCE(v_state->'tables', '[]'::jsonb);
  SELECT t.value INTO v_table
  FROM jsonb_array_elements(v_tables) AS t(value)
  WHERE t.value->>'recoveryId' = p_recovery_id
     OR (NOT (t.value ? 'recoveryId') AND t.value->>'channelId' = p_recovery_id)
  LIMIT 1;

  IF v_table IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'alreadySettled', true, 'payoutCount', 0);
  END IF;

  FOR v_ante IN SELECT value FROM jsonb_array_elements(COALESCE(v_table->'antes', '[]'::jsonb))
  LOOP
    IF (v_ante->>'userId') !~ '^\d{5,20}$'
       OR (v_ante->>'anted') IS NULL
       OR (v_ante->>'anted')::numeric <= 0
       OR floor((v_ante->>'anted')::numeric) <> (v_ante->>'anted')::numeric THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_persisted_ante');
    END IF;
    v_pot := v_pot + (v_ante->>'anted')::bigint;
  END LOOP;

  IF p_expected_pot IS DISTINCT FROM v_pot OR v_pot <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pot_mismatch');
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_payouts)
  LOOP
    v_user_id := v_entry->>'userId';
    IF v_user_id IS NULL OR v_user_id !~ '^\d{5,20}$' OR v_seen ? v_user_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_or_duplicate_recipient');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_table->'antes', '[]'::jsonb)) a
      WHERE a->>'userId' = v_user_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'recipient_not_participant');
    END IF;
    IF (v_entry->>'amount') IS NULL
       OR (v_entry->>'amount')::numeric < 0
       OR floor((v_entry->>'amount')::numeric) <> (v_entry->>'amount')::numeric THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payout');
    END IF;
    v_amount := (v_entry->>'amount')::bigint;
    v_total := v_total + v_amount;
    v_seen := v_seen || jsonb_build_object(v_user_id, true);
  END LOOP;

  IF (p_reason = 'poker_refund' AND v_total <> v_pot)
     OR (p_reason = 'poker_win' AND v_total <> v_pot - floor(v_pot * 0.05)::bigint) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payout_total_mismatch');
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_payouts)
  LOOP
    v_user_id := v_entry->>'userId';
    v_amount := (v_entry->>'amount')::bigint;
    INSERT INTO public.eris_economy
      (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
    VALUES (v_user_id, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.eris_economy e SET
      balance = e.balance + v_amount,
      total_earned = e.total_earned + v_amount,
      version = e.version + 1
    WHERE e.user_id = v_user_id;
    v_payout_count := v_payout_count + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(t.value), '[]'::jsonb) INTO v_tables
  FROM jsonb_array_elements(v_tables) AS t(value)
  WHERE NOT (
    t.value->>'recoveryId' = p_recovery_id
    OR (NOT (t.value ? 'recoveryId') AND t.value->>'channelId' = p_recovery_id)
  );

  v_state := jsonb_set(COALESCE(v_state, '{}'::jsonb), '{tables}', v_tables, true);
  UPDATE public.bot_data SET data = v_state WHERE id = 'eris_poker_active';

  RETURN jsonb_build_object('ok', true, 'alreadySettled', false, 'payoutCount', v_payout_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.eris_settle_poker_table(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.eris_settle_poker_table(TEXT, JSONB, BIGINT, TEXT) FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.eris_settle_poker_table(TEXT, JSONB, BIGINT, TEXT) TO service_role;
  END IF;
END $$;
