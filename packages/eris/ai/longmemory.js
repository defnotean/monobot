import { createLongMemory } from "@defnotean/shared/longmemory";
import { log } from "../utils/logger.js";

const getConfig = async () => (await import("../config.js")).default;

const memory = createLongMemory({
  longMemoryRowId: "eris_long_memory",
  consciousnessRowId: "eris_consciousness",
  defaultBotId: "eris",
  defaultBotName: "Eris",
  getDatabase: () => import("../database.js"),
  getSemantic: () => import("./semantic.js"),
  getConfig,
  getPersonality: () => import("./personality.js"),
  getGeminiModel: async () => (await getConfig()).geminiModel,
  moodCache: { strategy: "lru", limit: 100 },
  capMoodOnInfer: true,
  thoughtDedupeMode: "jaccard",
  thoughtExtractionMode: "clause",
  semanticLogging: "silent",
  log,
});

export const updateMoodNarrative = memory.updateMoodNarrative;
export const inferMoodNarrative = memory.inferMoodNarrative;
export const getMoodNarrative = memory.getMoodNarrative;
export const addThought = memory.addThought;
export const extractThoughts = memory.extractThoughts;
export const generateInnerThought = memory.generateInnerThought;
export const getMonologue = memory.getMonologue;
export const getEpisodes = memory.getEpisodes;
export const getChannelEpisodes = memory.getChannelEpisodes;
export const recordEpisode = memory.recordEpisode;
export const analyzeExchange = memory.analyzeExchange;
export const buildLongTermContext = memory.buildLongTermContext;
export const flush = memory.flush;
export const loadLongMemory = memory.loadLongMemory;
