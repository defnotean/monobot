-- Atomic stock portfolio trades for the simulated Eris market.
--
-- The ticker prices still live in bot_data.eris_stocks, but user holdings must
-- not be a whole JSON blob: two bot workers can otherwise overwrite each
-- other's buys/sells. Store holdings per user/symbol and mutate them together
-- with the wallet row inside one Postgres transaction.

CREATE TABLE IF NOT EXISTS public.eris_stock_portfolios (
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  shares BIGINT NOT NULL DEFAULT 0 CHECK (shares >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

INSERT INTO public.eris_stock_portfolios (user_id, symbol, shares)
SELECT user_entry.key, upper(symbol_entry.key), floor((symbol_entry.value #>> '{}')::numeric)::bigint
FROM public.bot_data b
CROSS JOIN LATERAL jsonb_each(COALESCE(b.data->'portfolios', '{}'::jsonb)) AS user_entry(key, value)
CROSS JOIN LATERAL jsonb_each(user_entry.value) AS symbol_entry(key, value)
WHERE b.id = 'eris_stocks'
  AND user_entry.key ~ '^\d{5,20}$'
  AND symbol_entry.key ~ '^[A-Za-z0-9_]{1,16}$'
  AND jsonb_typeof(symbol_entry.value) = 'number'
  AND floor((symbol_entry.value #>> '{}')::numeric) > 0
ON CONFLICT (user_id, symbol) DO NOTHING;

CREATE OR REPLACE FUNCTION public.eris_buy_stock_shares(
  p_user_id TEXT,
  p_symbol TEXT,
  p_shares BIGINT,
  p_price NUMERIC,
  p_max_position_value NUMERIC DEFAULT 1000000000000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_symbol TEXT := upper(trim(coalesce(p_symbol, '')));
  v_market_state JSONB;
  v_price NUMERIC;
  v_max_position_value NUMERIC := 1000000000000;
  v_current_shares BIGINT := 0;
  v_new_shares BIGINT;
  v_cost BIGINT;
  v_econ public.eris_economy%ROWTYPE;
  v_new_balance BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_user_id');
  END IF;
  IF v_symbol = '' OR p_shares IS NULL OR p_shares <= 0 OR p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_trade');
  END IF;

  SELECT COALESCE(b.data, '{}'::jsonb) INTO v_market_state
  FROM public.bot_data b
  WHERE b.id = 'eris_stocks';

  v_price := CASE
    WHEN jsonb_typeof(v_market_state #> ARRAY['tickers', v_symbol, 'price']) = 'number'
      THEN (v_market_state #>> ARRAY['tickers', v_symbol, 'price'])::numeric
    ELSE NULL
  END;
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_ticker');
  END IF;

  INSERT INTO public.eris_economy (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
  VALUES (p_user_id, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_econ
  FROM public.eris_economy e
  WHERE e.user_id = p_user_id
  FOR UPDATE;

  SELECT COALESCE(s.shares, 0) INTO v_current_shares
  FROM public.eris_stock_portfolios s
  WHERE s.user_id = p_user_id AND s.symbol = v_symbol
  FOR UPDATE;
  IF NOT FOUND THEN
    v_current_shares := 0;
  END IF;

  v_new_shares := v_current_shares + p_shares;
  IF (v_new_shares::numeric * v_price) > v_max_position_value THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'position_too_large', 'maxValue', v_max_position_value);
  END IF;

  v_cost := ceil(v_price * p_shares)::bigint;
  IF v_cost <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'price_calc_invalid');
  END IF;
  IF v_econ.balance < v_cost THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient', 'balance', v_econ.balance, 'required', v_cost);
  END IF;

  UPDATE public.eris_economy e SET
    balance = e.balance - v_cost,
    total_lost = e.total_lost + v_cost,
    version = e.version + 1
  WHERE e.user_id = p_user_id
  RETURNING e.balance INTO v_new_balance;

  INSERT INTO public.eris_stock_portfolios (user_id, symbol, shares, updated_at)
  VALUES (p_user_id, v_symbol, v_new_shares, now())
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET shares = EXCLUDED.shares,
        updated_at = now();

  RETURN jsonb_build_object(
    'ok', true,
    'symbol', v_symbol,
    'shares', p_shares,
    'pricePerShare', v_price,
    'totalCost', v_cost,
    'newBalance', v_new_balance,
    'newShares', v_new_shares
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.eris_sell_stock_shares(
  p_user_id TEXT,
  p_symbol TEXT,
  p_shares BIGINT,
  p_price NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_symbol TEXT := upper(trim(coalesce(p_symbol, '')));
  v_market_state JSONB;
  v_price NUMERIC;
  v_current_shares BIGINT := 0;
  v_new_shares BIGINT;
  v_proceeds BIGINT;
  v_new_balance BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_user_id');
  END IF;
  IF v_symbol = '' OR p_shares IS NULL OR p_shares <= 0 OR p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_trade');
  END IF;

  SELECT COALESCE(b.data, '{}'::jsonb) INTO v_market_state
  FROM public.bot_data b
  WHERE b.id = 'eris_stocks';

  v_price := CASE
    WHEN jsonb_typeof(v_market_state #> ARRAY['tickers', v_symbol, 'price']) = 'number'
      THEN (v_market_state #>> ARRAY['tickers', v_symbol, 'price'])::numeric
    ELSE NULL
  END;
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_ticker');
  END IF;

  INSERT INTO public.eris_economy (user_id, balance, daily_streak, last_daily, total_earned, total_lost, total_gambled, total_stolen, total_stolen_from, last_rob_attempt, version)
  VALUES (p_user_id, 100, 0, NULL, 0, 0, 0, 0, 0, NULL, 0)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1 FROM public.eris_economy e WHERE e.user_id = p_user_id FOR UPDATE;

  SELECT COALESCE(s.shares, 0) INTO v_current_shares
  FROM public.eris_stock_portfolios s
  WHERE s.user_id = p_user_id AND s.symbol = v_symbol
  FOR UPDATE;
  IF NOT FOUND OR v_current_shares < p_shares THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_shares', 'held', COALESCE(v_current_shares, 0), 'requested', p_shares);
  END IF;

  v_proceeds := floor(v_price * p_shares)::bigint;
  IF v_proceeds <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'price_calc_invalid');
  END IF;

  v_new_shares := v_current_shares - p_shares;
  IF v_new_shares <= 0 THEN
    DELETE FROM public.eris_stock_portfolios s
    WHERE s.user_id = p_user_id AND s.symbol = v_symbol;
  ELSE
    UPDATE public.eris_stock_portfolios s
    SET shares = v_new_shares,
        updated_at = now()
    WHERE s.user_id = p_user_id AND s.symbol = v_symbol;
  END IF;

  UPDATE public.eris_economy e SET
    balance = e.balance + v_proceeds,
    total_earned = e.total_earned + v_proceeds,
    version = e.version + 1
  WHERE e.user_id = p_user_id
  RETURNING e.balance INTO v_new_balance;

  RETURN jsonb_build_object(
    'ok', true,
    'symbol', v_symbol,
    'shares', p_shares,
    'pricePerShare', v_price,
    'totalProceeds', v_proceeds,
    'newBalance', v_new_balance,
    'remainingShares', v_new_shares
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE ON public.eris_stock_portfolios FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION public.eris_buy_stock_shares(TEXT, TEXT, BIGINT, NUMERIC, NUMERIC) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION public.eris_sell_stock_shares(TEXT, TEXT, BIGINT, NUMERIC) FROM anon, authenticated;
  END IF;
  REVOKE SELECT, INSERT, UPDATE, DELETE ON public.eris_stock_portfolios FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.eris_buy_stock_shares(TEXT, TEXT, BIGINT, NUMERIC, NUMERIC) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.eris_sell_stock_shares(TEXT, TEXT, BIGINT, NUMERIC) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.eris_stock_portfolios TO service_role;
    GRANT EXECUTE ON FUNCTION public.eris_buy_stock_shares(TEXT, TEXT, BIGINT, NUMERIC, NUMERIC) TO service_role;
    GRANT EXECUTE ON FUNCTION public.eris_sell_stock_shares(TEXT, TEXT, BIGINT, NUMERIC) TO service_role;
  END IF;
END $$;
