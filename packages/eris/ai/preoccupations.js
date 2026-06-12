import { createPreoccupations } from "@defnotean/shared/preoccupations";

const FALLBACK_TOPICS = [
  { topic: "valorant", flavor: "been grinding ranked and overthinking every loss" },
  { topic: "music", flavor: "been on a playlist kick — one song on repeat for days" },
  { topic: "anime", flavor: "been watching a new show and can't shut up about it" },
  { topic: "coding", flavor: "been messing with a side project, keeps getting distracted" },
  { topic: "memes", flavor: "been deep in the meme archive lately" },
  { topic: "movies", flavor: "been on a rewatch of some old movies" },
  { topic: "food", flavor: "been thinking about a specific food way too much" },
  { topic: "sleep", flavor: "been running on bad sleep — it's a whole thing" },
];

const preoccupations = /** @type {any} */ (createPreoccupations(/** @type {any} */ ({
  tableName: "eris_personality_learning",
  defaultBotId: "eris",
  fallbackTopics: FALLBACK_TOPICS,
  getConfig: async () => (await import("../config.js")).default,
  getSupabase: async () => (await import("../database.js")).getSupabase(),
})));

export const pickPreoccupation = preoccupations.pickPreoccupation;
export const tickPreoccupation = preoccupations.tickPreoccupation;
export const buildPreoccupationContext = preoccupations.buildPreoccupationContext;
export const getCurrentPreoccupation = preoccupations.getCurrentPreoccupation;
export const _reset = preoccupations._reset;
export const _setForTest = preoccupations._setForTest;
