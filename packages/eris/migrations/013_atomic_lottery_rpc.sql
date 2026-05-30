-- Atomic lottery ticket purchase and draw settlement.
--
-- Lottery state is one JSON bot_data row, so all money-changing operations
-- must lock that row while mutating tickets/pot and the relevant wallet row.

CREATE OR REPLACE FUNCTION public.eris_buy_lottery_ticket(
  p_user_id TEXT,
  p_count INTEGER,
  p_ticket_price INTEGER DEFAULT 100,
  p_house_seed INTEGER DEFAULT 500,
  p_day_ms BIGINT DEFAULT 86400000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state JSONB;
  v_now_ms BIGINT := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_draw_at BIGINT;
  v_existing INTEGER;
  v_cost BIGINT;
  v_pot BIGINT;
  v_econ public.eris_economy%ROWTYPE;
  v_new_balance BIGINT;
  v_tickets JSONB;
BEGIN
  IF p_user_id IS NULL OR p_user_id !~ '^\d{5,20}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_user_id');
  END IF;
  IF p_count IS NULL OR p_count <= 0 OR p_count > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_count');
  END IF;

  INSERT INTO public.bot_data (id, data)
  VALUES ('eris_lottery', jsonb_build_object('drawAt', v_now_ms + p_day_ms, 'pot', p_house_seed, 'tickets', '{}'::jsonb, 'history', '[]'::jsonb))
  ON CONFLICT (id) DO NOTHING;

  SELECT COALESCE(b.data, '{}'::jsonb) INTO v_state
  FROM public.bot_data b
  WHERE b.id = 'eris_lottery'
  FOR UPDATE;

  v_draw_at := COALESCE((v_state->>'drawAt')::bigint, v_now_ms + p_day_ms);
  IF v_now_ms >= v_draw_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'draw_pending');
  END IF;

  v_existing := COALESCE((v_state #>> ARRAY['tickets', p_user_id])::integer, 0);
  IF v_existing + p_count > 999000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ticket_cap', 'held', v_existing, 'max', 999000);
  END IF;

  v_cost := p_count::bigint * p_ticket_price;
  INSERT INTO public.eris_economy (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
  VALUES (p_user_id, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_econ
  FROM public.eris_economy e
  WHERE e.user_id = p_user_id
  FOR UPDATE;

  IF v_econ.balance < v_cost THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient', 'balance', v_econ.balance, 'required', v_cost);
  END IF;

  UPDATE public.eris_economy e SET
    balance = e.balance - v_cost,
    total_lost = e.total_lost + v_cost,
    version = e.version + 1
  WHERE e.user_id = p_user_id
  RETURNING e.balance INTO v_new_balance;

  v_pot := COALESCE((v_state->>'pot')::bigint, p_house_seed) + v_cost;
  v_tickets := COALESCE(v_state->'tickets', '{}'::jsonb);
  v_tickets := jsonb_set(v_tickets, ARRAY[p_user_id], to_jsonb(v_existing + p_count), true);
  v_state := jsonb_set(v_state, '{drawAt}', to_jsonb(v_draw_at), true);
  v_state := jsonb_set(v_state, '{pot}', to_jsonb(v_pot), true);
  v_state := jsonb_set(v_state, '{tickets}', v_tickets, true);
  v_state := jsonb_set(v_state, '{history}', COALESCE(v_state->'history', '[]'::jsonb), true);

  UPDATE public.bot_data SET data = v_state WHERE id = 'eris_lottery';

  RETURN jsonb_build_object('ok', true, 'tickets', p_count, 'cost', v_cost, 'pot', v_pot, 'newBalance', v_new_balance, 'userTotal', v_existing + p_count, 'state', v_state);
END;
$$;

CREATE OR REPLACE FUNCTION public.eris_claim_lottery_draw(
  p_roll NUMERIC DEFAULT NULL,
  p_house_seed INTEGER DEFAULT 500,
  p_day_ms BIGINT DEFAULT 86400000,
  p_rollover_fraction NUMERIC DEFAULT 0.30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state JSONB;
  v_now_ms BIGINT := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_draw_at BIGINT;
  v_pot BIGINT;
  v_history JSONB;
  v_tickets JSONB;
  v_total BIGINT := 0;
  v_roll BIGINT;
  v_seen BIGINT := 0;
  v_winner TEXT := NULL;
  v_winning_count BIGINT := 0;
  v_entry RECORD;
  v_rollover BIGINT;
  v_prize BIGINT;
  v_new_state JSONB;
  v_new_balance BIGINT;
BEGIN
  INSERT INTO public.bot_data (id, data)
  VALUES ('eris_lottery', jsonb_build_object('drawAt', v_now_ms + p_day_ms, 'pot', p_house_seed, 'tickets', '{}'::jsonb, 'history', '[]'::jsonb))
  ON CONFLICT (id) DO NOTHING;

  SELECT COALESCE(b.data, '{}'::jsonb) INTO v_state
  FROM public.bot_data b
  WHERE b.id = 'eris_lottery'
  FOR UPDATE;

  v_draw_at := COALESCE((v_state->>'drawAt')::bigint, v_now_ms + p_day_ms);
  IF v_now_ms < v_draw_at THEN
    RETURN jsonb_build_object('drawFired', false, 'reason', 'not_due');
  END IF;

  v_pot := GREATEST(0, COALESCE((v_state->>'pot')::bigint, p_house_seed));
  v_history := COALESCE(v_state->'history', '[]'::jsonb);
  v_tickets := COALESCE(v_state->'tickets', '{}'::jsonb);

  FOR v_entry IN
    SELECT key AS user_id, floor((value #>> '{}')::numeric)::bigint AS tickets
    FROM jsonb_each(v_tickets)
    WHERE key ~ '^\d{5,20}$'
      AND jsonb_typeof(value) = 'number'
      AND floor((value #>> '{}')::numeric) > 0
    ORDER BY key
  LOOP
    v_total := v_total + v_entry.tickets;
  END LOOP;

  IF v_total <= 0 THEN
    v_new_state := jsonb_build_object(
      'drawAt', v_now_ms + p_day_ms,
      'pot', v_pot,
      'tickets', '{}'::jsonb,
      'history', jsonb_build_array(jsonb_build_object('at', v_now_ms, 'winner', NULL, 'pot', v_pot, 'tickets', 0, 'note', 'no buyers - rolled over')) || v_history
    );
    v_new_state := jsonb_set(v_new_state, '{history}', (SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(v_new_state->'history') WITH ORDINALITY AS h(value, ord) ORDER BY ord LIMIT 30) h), true);
    UPDATE public.bot_data SET data = v_new_state WHERE id = 'eris_lottery';
    RETURN jsonb_build_object('drawFired', true, 'noBuyers', true, 'pot', v_pot, 'state', v_new_state);
  END IF;

  v_roll := floor(COALESCE(p_roll, random()) * v_total)::bigint + 1;
  IF v_roll < 1 THEN v_roll := 1; END IF;
  IF v_roll > v_total THEN v_roll := v_total; END IF;

  FOR v_entry IN
    SELECT key AS user_id, floor((value #>> '{}')::numeric)::bigint AS tickets
    FROM jsonb_each(v_tickets)
    WHERE key ~ '^\d{5,20}$'
      AND jsonb_typeof(value) = 'number'
      AND floor((value #>> '{}')::numeric) > 0
    ORDER BY key
  LOOP
    v_seen := v_seen + v_entry.tickets;
    IF v_seen >= v_roll THEN
      v_winner := v_entry.user_id;
      v_winning_count := v_entry.tickets;
      EXIT;
    END IF;
  END LOOP;

  IF v_winner IS NULL THEN
    RETURN jsonb_build_object('drawFired', false, 'payoutFailed', true, 'reason', 'no_winner_selected');
  END IF;

  v_rollover := floor(v_pot * p_rollover_fraction)::bigint;
  v_prize := v_pot - v_rollover;

  INSERT INTO public.eris_economy (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
  VALUES (v_winner, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1 FROM public.eris_economy e WHERE e.user_id = v_winner FOR UPDATE;
  UPDATE public.eris_economy e SET
    balance = e.balance + v_prize,
    total_earned = e.total_earned + v_prize,
    version = e.version + 1
  WHERE e.user_id = v_winner
  RETURNING e.balance INTO v_new_balance;

  v_new_state := jsonb_build_object(
    'drawAt', v_now_ms + p_day_ms,
    'pot', v_rollover + p_house_seed,
    'tickets', '{}'::jsonb,
    'history', jsonb_build_array(jsonb_build_object(
      'at', v_now_ms,
      'winner', v_winner,
      'pot', v_pot,
      'prize', v_prize,
      'tickets', v_winning_count,
      'totalTickets', v_total
    )) || v_history
  );
  v_new_state := jsonb_set(v_new_state, '{history}', (SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(v_new_state->'history') WITH ORDINALITY AS h(value, ord) ORDER BY ord LIMIT 30) h), true);

  UPDATE public.bot_data SET data = v_new_state WHERE id = 'eris_lottery';

  RETURN jsonb_build_object(
    'drawFired', true,
    'winnerId', v_winner,
    'prize', v_prize,
    'winningCount', v_winning_count,
    'totalTickets', v_total,
    'potBefore', v_pot,
    'rollover', v_rollover,
    'newBalance', v_new_balance,
    'state', v_new_state
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION public.eris_buy_lottery_ticket(TEXT, INTEGER, INTEGER, INTEGER, BIGINT) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.eris_claim_lottery_draw(NUMERIC, INTEGER, BIGINT, NUMERIC) TO anon, authenticated, service_role;
  END IF;
END $$;
