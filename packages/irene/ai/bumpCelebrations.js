import { createBumpCelebrations, _internal } from "@defnotean/shared/bumpCelebrations";
import { getGuildSettings, getSupabase, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";

const celebrations = /** @type {any} */ (createBumpCelebrations({
  getGuildSettings,
  setGuildSetting,
  getSupabase,
  getBumpAnalytics: () => import("./bumpAnalytics.js"),
  getUserPrefs: async (userId, botName) => (await import("./bumpUserPrefs.js")).getUserPrefs(userId, botName),
  log,
  defaultBumpsTable: "irene_bumps",
  defaultBotName: "irene",
}));

export const countBumpsSince = celebrations.countBumpsSince;
export const maybeCelebrateBumpathon = celebrations.maybeCelebrateBumpathon;
export const startBumpathonWatcher = celebrations.startBumpathonWatcher;
export const maybeCelebrateStreakMilestone = celebrations.maybeCelebrateStreakMilestone;
export const recordStreakBaseline = celebrations.recordStreakBaseline;
export const detectStreakLost = celebrations.detectStreakLost;
export const getBestRankInPeriod = celebrations.getBestRankInPeriod;
export const buildStreakLostLine = celebrations.buildStreakLostLine;
export const runWeeklyMvpTick = celebrations.runWeeklyMvpTick;
export const startWeeklyMvpScheduler = celebrations.startWeeklyMvpScheduler;
export { _internal };
