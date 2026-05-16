// ─── Bump Applause (per-bot binding) ───────────────────────────────────────
// Thin shim around @defnotean/shared/bumpApplause that wires Irene's
// database, quiet-hours check, analytics lookups, and logger.

import {
  createBumpApplause,
  pickApplauseLine,
  ERIS_APPLAUSE,
  IRENE_APPLAUSE,
  GOOD_BOY_CHANCE,
  TOP_BUMPER_RANK_THRESHOLD,
  STREAK_FLAVOR_MIN,
  FIRST_OF_DAY_CHANCE,
  CONTEXTUAL_FLAVOR_CHANCE,
  _internal,
} from "@defnotean/shared/bumpApplause";
import { getGuildSettings, getSupabase } from "../database.js";
import { log } from "../utils/logger.js";
import { isQuietHoursActive } from "./bumpReminder.js";

// bumpAnalytics is dynamically imported so this shim doesn't pull in the
// whole analytics graph at load time (it also avoids a circular import with
// bumpReminder, which is mid-load when this module first runs).
async function getUserStreak(userId, guildId, service) {
  const mod = await import("./bumpAnalytics.js");
  return mod.getUserStreak(userId, guildId, service);
}
async function getBumpLeaderboard(guildId, opts) {
  const mod = await import("./bumpAnalytics.js");
  return mod.getBumpLeaderboard(guildId, opts);
}

const applause = createBumpApplause({
  getGuildSettings,
  isQuietHoursActive,
  getSupabase,
  getUserStreak,
  getBumpLeaderboard,
  log,
});

export const sendBumpApplause = applause.sendBumpApplause;

// Re-export pickers + constants for callers + tests.
export {
  pickApplauseLine,
  ERIS_APPLAUSE,
  IRENE_APPLAUSE,
  GOOD_BOY_CHANCE,
  TOP_BUMPER_RANK_THRESHOLD,
  STREAK_FLAVOR_MIN,
  FIRST_OF_DAY_CHANCE,
  CONTEXTUAL_FLAVOR_CHANCE,
  _internal,
};
