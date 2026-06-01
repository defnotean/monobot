-- Atomically consume one inventory row and return its item_type.
CREATE OR REPLACE FUNCTION public.eris_consume_inventory_item(
  p_user_id TEXT,
  p_item_name TEXT
)
RETURNS TABLE (
  item_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  SELECT id INTO v_id
  FROM eris_inventory
  WHERE user_id = p_user_id AND item_name = p_item_name
  ORDER BY acquired_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  DELETE FROM eris_inventory
  WHERE id = v_id
  RETURNING eris_inventory.item_type INTO item_type;

  RETURN NEXT;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.eris_consume_inventory_item(TEXT, TEXT) FROM anon, authenticated;
  END IF;
  REVOKE EXECUTE ON FUNCTION public.eris_consume_inventory_item(TEXT, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.eris_consume_inventory_item(TEXT, TEXT) TO service_role;
  END IF;
END $$;
