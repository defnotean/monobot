import { createPreoccupations } from "@defnotean/shared/preoccupations";

const FALLBACK_TOPICS = [
  { topic: "music", flavor: "been on a playlist kick — one song on repeat for days" },
  { topic: "anime", flavor: "been watching a new show and keeps thinking about it" },
  { topic: "studying", flavor: "been chipping away at something she's learning" },
  { topic: "art", flavor: "been sketching / scrolling art lately" },
  { topic: "memes", flavor: "been deep in the meme archive" },
  { topic: "coding", flavor: "been messing with a side project" },
  { topic: "food", flavor: "been thinking about a specific food way too much" },
  { topic: "sleep", flavor: "been running on bad sleep — it's a whole thing" },
];

const preoccupations = /** @type {any} */ (createPreoccupations(/** @type {any} */ ({
  tableName: "irene_personality_learning",
  defaultBotId: "irene",
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
