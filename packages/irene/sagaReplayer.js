// ─── Dual-Write Saga Replayer ───────────────────────────────────────────────
//
// Closes the drift hole in database.js's dual-write fanout. When
// DUAL_WRITE_PERSISTENCE=1, every flush writes to BOTH the legacy bot_data
// blob (primary) AND the per-entity tables (secondary). If the primary
// succeeds and the secondary fails, the two stores drift permanently — there
// is no in-process retry that survives a restart.
//
// The saga log fixes that. The write path is:
//
//   1. createSaga(entityType, entityId, payload)  → inserts a row with both
//      legs = 'pending', returns sagaId.
//   2. Primary write runs → markSagaLeg(sagaId, 'primary', 'applied'|'failed').
//   3. Secondary write runs → markSagaLeg(sagaId, 'secondary', 'applied'|'failed').
//
// Every 5 minutes the reconciler queries:
//
//   SELECT * FROM dual_write_sagas
//   WHERE primary_status = 'applied'
//     AND secondary_status = 'failed'
//     AND attempts < MAX_ATTEMPTS;
//
// For each row it retries the secondary write (via the same perEntity helpers
// the original fanout used) and either:
//   - On success → stamps replayed_at + secondary_status = 'applied'.
//   - On failure → increments attempts. After MAX_ATTEMPTS it stamps
//     secondary_status = 'permanent' and logs LOUDLY so a human can
//     investigate. The row stays in the table as an audit record.
//
// Notes:
//   - The "secondary" store today is the per-entity tables in perEntity.js.
//     The saga shape is generic so a future swap (e.g. a remote analytics
//     warehouse) doesn't require changing the saga API.
//   - If config.dualWritePersistence is false, the reconciler is a no-op.
//     The boot wiring in index.js only starts it when the flag is on.
//   - Errors thrown by saga writes themselves are swallowed and logged. The
//     saga log existing to prevent drift would defeat itself if a saga write
//     failure killed the primary path.

import { getSupabase } from "./database.js";
import config from "./config.js";
import { log } from "./utils/logger.js";

const MAX_ATTEMPTS = 5;
const RECONCILE_INTERVAL_MS = 5 * 60_000; // 5 minutes
const RECONCILE_BATCH_SIZE = 50;

// Lazy-imported to avoid circular load with database.js.
let _perEntityModule = null;
async function _getPerEntity() {
  if (!_perEntityModule) _perEntityModule = await import("./database/perEntity.js");
  return _perEntityModule;
}

let _reconcilerTimer = null;

// ─── Saga lifecycle — create + leg-status updates ────────────────────────────

/**
 * Inserts a saga row in 'pending'/'pending' state.
 *
 * @param {string} entityType — logical bucket name (e.g. "fanout-snapshot").
 *   For the current single-snapshot fanout we use one type; future per-key
 *   sagas could split this further.
 * @param {string} entityId — natural key for the entity. For the snapshot
 *   fanout this is just "snapshot" since there's one global blob.
 * @param {object} payload — opaque jsonb the replayer can use to re-run the
 *   secondary write. For the snapshot fanout this is the sanitized blob.
 * @returns {Promise<string|null>} sagaId, or null if Supabase is unavailable
 *   or the insert failed. Callers should handle a null return as "proceed
 *   without saga tracking" — the legacy write still runs.
 */
export async function createSaga(entityType, entityId, payload) {
  if (!config.dualWritePersistence) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("dual_write_sagas")
      .insert({
        entity_type: entityType,
        entity_id: entityId,
        payload: payload ?? {},
        primary_status: "pending",
        secondary_status: "pending",
      })
      .select("id")
      .single();
    if (error) {
      log(`[SAGA] createSaga failed: ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    log(`[SAGA] createSaga threw: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Stamps one leg of a saga as applied or failed.
 *
 * @param {string|null} sagaId — null is a no-op (saga creation may have
 *   failed; we don't crash the write path because of it).
 * @param {"primary"|"secondary"} leg
 * @param {"applied"|"failed"} status
 * @param {string} [errorMessage] — captured on failures for the operator.
 */
export async function markSagaLeg(sagaId, leg, status, errorMessage) {
  if (!sagaId) return;
  if (!config.dualWritePersistence) return;
  const supabase = getSupabase();
  if (!supabase) return;
  const col = leg === "primary" ? "primary_status" : "secondary_status";
  const update = { [col]: status };
  if (status === "failed" && errorMessage) {
    update.last_error = String(errorMessage).slice(0, 1000);
  }
  try {
    const { error } = await supabase
      .from("dual_write_sagas")
      .update(update)
      .eq("id", sagaId);
    if (error) log(`[SAGA] markSagaLeg(${leg}=${status}) failed: ${error.message}`);
  } catch (err) {
    log(`[SAGA] markSagaLeg threw: ${err?.message ?? err}`);
  }
}

// ─── Reconciler — scan for drift, replay the secondary leg ──────────────────

/**
 * Replays the secondary write for one saga row. Returns true on success,
 * false on failure. Errors are caught + reported but don't throw.
 */
async function _replaySecondary(saga) {
  const pe = await _getPerEntity();
  const payload = saga.payload ?? {};
  const writes = [];

  // The current fanout shape (snapshot of the full sanitized blob) — mirrors
  // _dualWriteFanout in database.js. When the secondary store changes shape,
  // update both sides together.
  for (const [gid, gs] of Object.entries(payload.guild_settings || {})) {
    writes.push(pe.writeGuildSettings(gid, gs));
  }
  for (const [gid, cmds] of Object.entries(payload.custom_commands || {})) {
    writes.push(pe.writeCustomCommands(gid, cmds));
  }
  for (const [gid, stats] of Object.entries(payload.scrim_stats || {})) {
    writes.push(pe.writeScrimStats(gid, stats));
  }
  for (const [gid, entries] of Object.entries(payload.starboard_entries || {})) {
    writes.push(pe.writeStarboardEntries(gid, entries));
  }
  for (const [gid, q] of Object.entries(payload.saved_queues || {})) {
    writes.push(pe.writeSavedQueue(gid, q));
  }
  if (payload.mood) writes.push(pe.writeMoodState(payload.mood));
  if (payload.relationships) writes.push(pe.writeRelationships(payload.relationships));
  writes.push(pe.writeGlobalState({
    _nextWarningId: payload._nextWarningId,
    _nextReminderId: payload._nextReminderId,
    _nextScheduledTaskId: payload._nextScheduledTaskId,
    dm_optout: payload.dm_optout,
    warnings: payload.warnings,
    reminders: payload.reminders,
    scheduled_tasks: payload.scheduled_tasks,
    birthdays: payload.birthdays,
    birthday_announced: payload.birthday_announced,
    server_whitelist: payload.server_whitelist,
    giveaways: payload.giveaways,
    highlights: payload.highlights,
    temp_vcs: payload.temp_vcs,
    conversations: payload.conversations,
  }));

  await Promise.all(writes);
}

/**
 * One reconciler pass. Pulls up to RECONCILE_BATCH_SIZE drift rows, replays
 * each. Exported for tests + manual invocation; the periodic timer calls it.
 *
 * @returns {Promise<{processed: number, succeeded: number, failed: number, permanent: number}>}
 */
export async function runReconcilerOnce() {
  const stats = { processed: 0, succeeded: 0, failed: 0, permanent: 0 };
  if (!config.dualWritePersistence) return stats;
  const supabase = getSupabase();
  if (!supabase) return stats;

  let rows;
  try {
    const { data, error } = await supabase
      .from("dual_write_sagas")
      .select("id, entity_type, entity_id, payload, attempts")
      .eq("primary_status", "applied")
      .eq("secondary_status", "failed")
      .lt("attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(RECONCILE_BATCH_SIZE);
    if (error) {
      log(`[SAGA] reconciler query failed: ${error.message}`);
      return stats;
    }
    rows = data ?? [];
  } catch (err) {
    log(`[SAGA] reconciler query threw: ${err?.message ?? err}`);
    return stats;
  }

  for (const saga of rows) {
    stats.processed++;
    const nextAttempts = (saga.attempts ?? 0) + 1;
    try {
      await _replaySecondary(saga);
      const { error: updErr } = await supabase
        .from("dual_write_sagas")
        .update({
          secondary_status: "applied",
          replayed_at: new Date().toISOString(),
          attempts: nextAttempts,
          last_error: null,
        })
        .eq("id", saga.id);
      if (updErr) {
        log(`[SAGA] reconciler update-success failed on ${saga.id}: ${updErr.message}`);
        stats.failed++;
        continue;
      }
      stats.succeeded++;
    } catch (err) {
      const errMsg = err?.message ?? String(err);
      const willBePermanent = nextAttempts >= MAX_ATTEMPTS;
      const newStatus = willBePermanent ? "permanent" : "failed";
      try {
        await supabase
          .from("dual_write_sagas")
          .update({
            secondary_status: newStatus,
            attempts: nextAttempts,
            last_error: String(errMsg).slice(0, 1000),
          })
          .eq("id", saga.id);
      } catch (innerErr) {
        log(`[SAGA] reconciler update-failure threw on ${saga.id}: ${innerErr?.message ?? innerErr}`);
      }
      if (willBePermanent) {
        log(`[SAGA] PERMANENT FAILURE for saga ${saga.id} (entity_type=${saga.entity_type} entity_id=${saga.entity_id} after ${nextAttempts} attempts): ${errMsg}`);
        stats.permanent++;
      } else {
        log(`[SAGA] retry ${nextAttempts}/${MAX_ATTEMPTS} for ${saga.id} failed: ${errMsg}`);
        stats.failed++;
      }
    }
  }

  return stats;
}

/**
 * Starts the periodic reconciler loop. Idempotent — calling twice keeps a
 * single timer. Only schedules anything when DUAL_WRITE_PERSISTENCE is on
 * (callers in index.js already gate this, but we belt-and-suspenders here so
 * misuse doesn't burn cycles).
 */
export function startSagaReplayer() {
  if (!config.dualWritePersistence) return;
  if (_reconcilerTimer) return;
  // Stagger the first run by ~30s so boot-time noise doesn't pile on the
  // already-warm Supabase pool.
  _reconcilerTimer = setTimeout(async function tick() {
    try {
      await runReconcilerOnce();
    } catch (err) {
      log(`[SAGA] reconciler tick threw: ${err?.message ?? err}`);
    }
    _reconcilerTimer = setTimeout(tick, RECONCILE_INTERVAL_MS);
  }, 30_000);
  log("[SAGA] Replayer started — reconciling drift every 5 min");
}

export function stopSagaReplayer() {
  if (_reconcilerTimer) {
    clearTimeout(_reconcilerTimer);
    _reconcilerTimer = null;
  }
}

// ─── Test-only internals ─────────────────────────────────────────────────────
export const _internal = {
  MAX_ATTEMPTS,
  RECONCILE_INTERVAL_MS,
  RECONCILE_BATCH_SIZE,
};
