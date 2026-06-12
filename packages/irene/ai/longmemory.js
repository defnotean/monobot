import { createLongMemory } from "@defnotean/shared/longmemory";
import { log } from "../utils/logger.js";

const getConfig = async () => (await import("../config.js")).default;

const memory = createLongMemory({
  longMemoryRowId: "irene_long_memory",
  consciousnessRowId: "irene_consciousness",
  defaultBotId: "irene",
  defaultBotName: "Irene",
  getDatabase: () => import("../database.js"),
  getSemantic: () => import("./semantic.js"),
  getConfig,
  getPersonality: () => import("./personality.js"),
  getGeminiModel: async () => "gemini-2.5-flash",
  moodCache: { strategy: "fifo", limit: 50 },
  capMoodOnInfer: false,
  thoughtDedupeMode: "prefix",
  thoughtExtractionMode: "anywhere",
  semanticLogging: "log",
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
