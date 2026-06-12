import { createHumanity } from "@defnotean/shared/humanity";
import { log } from "../utils/logger.js";

const humanity = /** @type {any} */ (createHumanity({
  grudgeDecayMode: "hourly",
  streakDateStrategy: "utc-day",
  includeJudgeApi: false,
  now: () => Date.now(),
  random: () => Math.random(),
  logger: log,
}));

export const {
  trackHumanInteraction,
  recordMoment,
  recordInsideJoke,
  generateThought,
  buildHumanityContext,
  detectMoment,
  buildTwinContext,
  periodicUpdate,
  serialize,
  deserialize,
} = humanity;
