-- One-time MERGE of Irene's legacy server whitelist into the SHARED canonical
-- store (bot_data row id='main', data.server_whitelist).
--
-- Why: the two twins used to drift. Eris read/wrote the shared bot_data:main
-- row (data.server_whitelist), while Irene bundled its OWN server_whitelist
-- into its whole-blob row id='irene'. We've now repointed Irene's whitelist
-- helpers at bot_data:main (see packages/irene/database.js), so the id='irene'
-- copy is dead. This migration folds any entries that only ever lived in the
-- id='irene' copy into id='main' so nothing is lost on the cutover.
--
-- Semantics:
--   - UNION the two maps. Existing id='main' entries are AUTHORITATIVE and are
--     NEVER overwritten — only keys present solely in id='irene' get copied in.
--     (jsonb `a || b` lets the RIGHT operand win, so irene_wl || main_wl keeps
--      main's value for any key in both.)
--   - Idempotent: re-running is a no-op once main already holds the union (the
--     UPDATE just rewrites the same value). Safe to apply more than once.
--   - Does NOT delete the id='irene' copy — the application simply stops
--     reading/writing it; leaving the row avoids touching unrelated Irene data
--     that shares that blob.
--
-- Run against your DB:
--   psql $DATABASE_URL -f packages/eris/migrations/008_unify_whitelist.sql

DO $$
DECLARE
  v_irene_wl JSONB;
  v_main_data JSONB;
  v_main_wl JSONB;
  v_merged_wl JSONB;
BEGIN
  -- Pull Irene's legacy whitelist (defaults to {} when the row / key is absent).
  SELECT COALESCE(data -> 'server_whitelist', '{}'::jsonb)
    INTO v_irene_wl
    FROM bot_data
    WHERE id = 'irene';

  -- Nothing to merge — Irene row missing or had no entries.
  IF v_irene_wl IS NULL OR v_irene_wl = '{}'::jsonb THEN
    RAISE NOTICE 'No Irene server_whitelist entries to merge — skipping.';
    RETURN;
  END IF;

  -- Current shared whitelist (defaults to {} when the row / key is absent).
  SELECT COALESCE(data, '{}'::jsonb), COALESCE(data -> 'server_whitelist', '{}'::jsonb)
    INTO v_main_data, v_main_wl
    FROM bot_data
    WHERE id = 'main';

  IF v_main_data IS NULL THEN
    v_main_data := '{}'::jsonb;
    v_main_wl := '{}'::jsonb;
  END IF;

  -- UNION with main winning on conflicting keys (right operand wins in ||).
  v_merged_wl := v_irene_wl || v_main_wl;

  -- Write the merged map back under data.server_whitelist on id='main',
  -- preserving every other key in main's blob.
  INSERT INTO bot_data (id, data)
    VALUES ('main', jsonb_set(v_main_data, '{server_whitelist}', v_merged_wl, true))
  ON CONFLICT (id) DO UPDATE
    SET data = jsonb_set(
      COALESCE(bot_data.data, '{}'::jsonb),
      '{server_whitelist}',
      v_merged_wl,
      true
    );

  RAISE NOTICE 'Merged % Irene whitelist entr(ies) into bot_data:main (main entries preserved).',
    (SELECT count(*) FROM jsonb_object_keys(v_irene_wl));
END $$;
