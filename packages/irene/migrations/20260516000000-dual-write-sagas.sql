-- ─── Dual-Write Saga Log — drift recovery for per-entity fanout ─────────────
-- Each dual-write (legacy bot_data blob + per-entity tables) creates a saga
-- row: pending → applied/failed per leg. A reconciler scans for rows where
-- primary_status='applied' AND secondary_status='failed' AND attempts < 5,
-- retries the secondary write, and stamps replayed_at on success.
--
-- Without this, a primary success + secondary failure leaves the two stores
-- silently drifted. The saga log is the audit trail that lets us catch and
-- repair that drift.
--
-- Apply order: this migration must run BEFORE setting DUAL_WRITE_PERSISTENCE=1
-- in production. Safe to run with the flag off — the table just stays empty.

CREATE TABLE IF NOT EXISTS dual_write_sagas (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  entity_type       text          NOT NULL,
  entity_id         text          NOT NULL,
  payload           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  primary_status    text          NOT NULL DEFAULT 'pending'
    CHECK (primary_status IN ('pending', 'applied', 'failed')),
  secondary_status  text          NOT NULL DEFAULT 'pending'
    CHECK (secondary_status IN ('pending', 'applied', 'failed', 'permanent')),
  replayed_at       timestamptz   NULL,
  attempts          int           NOT NULL DEFAULT 0,
  last_error        text          NULL
);

-- Hot-path index — the reconciler queries on (primary_status, secondary_status,
-- attempts) every 5 minutes. Without an index this scans the whole table.
CREATE INDEX IF NOT EXISTS dual_write_sagas_replay_candidates
  ON dual_write_sagas (secondary_status, attempts, created_at)
  WHERE primary_status = 'applied' AND secondary_status = 'failed';

-- Optional retention pruning is left to the operator — successful sagas with
-- replayed_at or both legs 'applied' can be aged out by a cron after N days.
