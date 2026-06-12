import { createBumpCorrelation, POST_BUMP_WINDOW_MIN, _internal } from "@defnotean/shared/bumpCorrelation";
import { getSupabase } from "../database.js";
import { log } from "../utils/logger.js";

const correlation = /** @type {any} */ (createBumpCorrelation({
  getSupabase,
  log,
  defaultBotName: "eris",
}));

export const recordJoinForCorrelation = correlation.recordJoinForCorrelation;
export const getJoinCorrelationStats = correlation.getJoinCorrelationStats;
export { POST_BUMP_WINDOW_MIN, _internal };
