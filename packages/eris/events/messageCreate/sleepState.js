// ─── packages/eris/events/messageCreate/sleepState.js ───────────────────────
// Sleep / Nap state machine. Module-scoped `_sleepUntil` is intentional —
// every messageCreate handler instance shares the same wall-clock sleep
// window. Re-exported from messageCreate.js so external callers (and tests)
// can keep importing from the same path.

import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { NAP_DURATION_MS, SLEEP_DURATION_MS } from "./constants.js";

const _sleepUntil = { ts: 0, isNap: false };

export function triggerSleep(isNap = false) {
  const dur = isNap ? NAP_DURATION_MS : SLEEP_DURATION_MS;
  _sleepUntil.ts = Date.now() + dur;
  _sleepUntil.isNap = isNap;
  // Naps boost energy and mood immediately
  if (isNap) {
    db.shiftMood(15, 35);  // happy + energized on nap
    log(`[NAP] Eris is napping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+35 energy, +15 mood)`);
  } else {
    db.shiftMood(10, 50);  // full sleep = big energy restore
    log(`[SLEEP] Eris is sleeping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+50 energy, +10 mood)`);
  }
}

export function isSleeping() { return Date.now() < _sleepUntil.ts; }

export function wakeSleep() {
  const wasNap = _sleepUntil.isNap;
  _sleepUntil.ts = 0;
  _sleepUntil.isNap = false;
  log(`[SLEEP] Eris woke up from ${wasNap ? "nap" : "sleep"}`);
}
