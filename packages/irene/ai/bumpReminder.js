import { createBumpReminder, detectBumpService, extractBumperUserId, extractRank, SERVICES } from "@defnotean/shared/bumpReminder";
import config from "../config.js";
import { getGuildSettings, getMood, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";

const reminder = /** @type {any} */ (createBumpReminder({
  getGuildSettings,
  setGuildSetting,
  log,
  getBumpAnalytics: () => import("./bumpAnalytics.js"),
  getBumpApplause: () => import("./bumpApplause.js"),
  getBumpCelebrations: () => import("./bumpCelebrations.js"),
  getBumpUserPrefs: () => import("./bumpUserPrefs.js"),
  getConfig: async () => config,
  getMood,
  getPreoccupations: () => import("./preoccupations.js"),
  getPersonality: () => import("./personality.js"),
  getKeyPool: () => {
    // @ts-ignore -- optional key-pool module is probed at runtime when present.
    return import("../ai/keyPool.js").catch(() => null);
  },
  getGoogleGenAI: async () => (await import("@google/genai")).GoogleGenAI,
  defaultBumpsTable: "irene_bumps",
  botName: "irene",
  logDisabledService: false,
  logSoftFailures: false,
  useLeaderboardUsernameFallback: true,
  missingBumperName: null,
}));

export { detectBumpService, extractBumperUserId, extractRank, SERVICES };
export const handleBumpConfirm = reminder.handleBumpConfirm;
export const shouldSuppressDirectUserPing = reminder.shouldSuppressDirectUserPing;
export const markDirectUserPinged = reminder.markDirectUserPinged;
export const cancelEscalation = reminder.cancelEscalation;
export const isQuietHoursActive = reminder.isQuietHoursActive;
export const restoreBumpTimers = reminder.restoreBumpTimers;
export const snoozeReminder = reminder.snoozeReminder;
export const muteTonight = reminder.muteTonight;
export const _internal = reminder._internal;
