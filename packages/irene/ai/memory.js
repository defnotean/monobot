// ─── Irene's Persistent Memory System ────────────────────────────────────────
// Stores facts about users for context injection into the AI system prompt

// Structure: Map<guildId, Map<userId, Array<{fact, addedAt, addedBy}>>>
const memoryStore = new Map();

const MAX_MEMORIES_PER_USER = 20;
const MAX_MEMORIES_PER_GUILD = 500;
const MAX_FACT_LENGTH = 200;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function addMemory(guildId, userId, fact, importance = "normal") {
  if (!memoryStore.has(guildId)) memoryStore.set(guildId, new Map());
  const guildMemories = memoryStore.get(guildId);

  if (!guildMemories.has(userId)) guildMemories.set(userId, []);
  const userMemories = guildMemories.get(userId);

  const trimmedFact = fact.trim();

  // Validate fact length
  if (trimmedFact.length > MAX_FACT_LENGTH) {
    return {
      success: false,
      message: `fact too long (max ${MAX_FACT_LENGTH} characters, you provided ${trimmedFact.length})`,
    };
  }

  // Check for duplicates (case-insensitive fuzzy match)
  const lowerFact = trimmedFact.toLowerCase();
  if (userMemories.some((m) => m.fact.toLowerCase() === lowerFact)) {
    return {
      success: false,
      message: `this fact is already stored`,
    };
  }

  // Check user memory limit
  if (userMemories.length >= MAX_MEMORIES_PER_USER) {
    return {
      success: false,
      message: `max 20 memories per user (you already have ${userMemories.length})`,
    };
  }

  // Check guild memory limit
  const totalGuildMemories = Array.from(guildMemories.values()).reduce((sum, arr) => sum + arr.length, 0);
  if (totalGuildMemories >= MAX_MEMORIES_PER_GUILD) {
    return {
      success: false,
      message: `guild memory limit reached (500 total)`,
    };
  }

  const memory = {
    fact: trimmedFact,
    addedAt: new Date().toISOString(),
    addedBy: userId,
  };

  userMemories.push(memory);

  // Throttle cleanup to once per hour per guild instead of every addMemory call
  const _lastCleanup = cleanupOldMemories._lastRun ?? (cleanupOldMemories._lastRun = new Map());
  const lastRun = _lastCleanup.get(guildId) ?? 0;
  if (Date.now() - lastRun > 60 * 60_000) {
    cleanupOldMemories(guildId);
    _lastCleanup.set(guildId, Date.now());
  }

  return { success: true };
}

/**
 * Remove memories older than 90 days
 */
function cleanupOldMemories(guildId) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return;

  const now = Date.now();
  for (const [userId, memories] of guildMemories.entries()) {
    const filtered = memories.filter((m) => {
      const age = now - new Date(m.addedAt).getTime();
      return age < MAX_AGE_MS;
    });

    if (filtered.length !== memories.length) {
      if (filtered.length === 0) {
        guildMemories.delete(userId);
      } else {
        guildMemories.set(userId, filtered);
      }
    }
  }
}

export function getMemories(guildId, userId) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return [];
  return guildMemories.get(userId) || [];
}

export function getAllMemories(guildId) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return new Map();

  const result = new Map();
  for (const [userId, memories] of guildMemories.entries()) {
    if (memories.length > 0) result.set(userId, memories);
  }
  return result;
}

export function removeMemory(guildId, userId, index) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return { success: false, message: "no memories found for this guild" };

  const userMemories = guildMemories.get(userId);
  if (!userMemories || index < 0 || index >= userMemories.length) {
    return { success: false, message: "memory index out of range" };
  }

  userMemories.splice(index, 1);
  return { success: true };
}

export function clearMemories(guildId, userId) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return { success: false };
  guildMemories.delete(userId);
  return { success: true };
}

export function searchMemories(guildId, query) {
  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return [];

  const results = [];
  const lowerQuery = query.toLowerCase();

  for (const [userId, memories] of guildMemories.entries()) {
    for (const memory of memories) {
      const lowerFact = memory.fact.toLowerCase();
      // Check for exact match or partial match
      if (lowerFact === lowerQuery) {
        results.push({ userId, memory, relevance: 2 }); // exact match
      } else if (lowerFact.includes(lowerQuery)) {
        results.push({ userId, memory, relevance: 1 }); // partial match
      }
    }
  }

  // Sort by relevance (exact matches first, then partial)
  results.sort((a, b) => b.relevance - a.relevance);

  // Remove relevance field from result
  return results.map((r) => ({ userId: r.userId, memory: r.memory }));
}

export function initMemoryData(loaded) {
  // Clear and reinitialize from external data source (e.g., database)
  memoryStore.clear();
  if (loaded && typeof loaded === "object") {
    for (const [guildId, guildData] of Object.entries(loaded)) {
      const guildMap = new Map();
      for (const [userId, memories] of Object.entries(guildData)) {
        guildMap.set(userId, Array.isArray(memories) ? memories : []);
      }
      memoryStore.set(guildId, guildMap);
    }
  }
}

export function getMemoryData() {
  // Export all memory data for database persistence
  const result = {};
  for (const [guildId, guildMemories] of memoryStore.entries()) {
    result[guildId] = Object.fromEntries(guildMemories);
  }
  return result;
}

export function buildMemoryContext(guildId, userIds) {
  // Build formatted string for AI system prompt injection
  // Takes array of user IDs mentioned in conversation, returns context string
  if (!Array.isArray(userIds) || userIds.length === 0) return "";

  const guildMemories = memoryStore.get(guildId);
  if (!guildMemories) return "";

  const lines = [];
  for (const userId of userIds) {
    const memories = guildMemories.get(userId);
    if (memories && memories.length > 0) {
      const facts = memories.map((m) => m.fact).join(", ");
      lines.push(`What I remember about <@${userId}>: ${facts}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}
