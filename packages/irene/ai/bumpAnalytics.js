import { createBumpAnalytics } from "@defnotean/shared/bumpAnalytics";
import { getSupabase } from "../database.js";
import { log } from "../utils/logger.js";

const analytics = /** @type {any} */ (createBumpAnalytics({
  getSupabase,
  log,
  bumpsTable: "irene_bumps",
}));

export const recordBump = analytics.recordBump;
export const getBumpLeaderboard = analytics.getBumpLeaderboard;
export const getLastBumper = analytics.getLastBumper;
export const getGuildStreak = analytics.getGuildStreak;
export const getUserStreak = analytics.getUserStreak;
export const getBumpCount = analytics.getBumpCount;
export const getBumpsPerDay = analytics.getBumpsPerDay;
