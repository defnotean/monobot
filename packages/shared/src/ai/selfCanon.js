// ─── Personal Canon ─────────────────────────────────────────────────────────
// Her own identity facts — favorite color, foods she likes, nicknames she goes
// by, personal quirks. Different from opinions (opinions are positions on
// external topics; canon is about HER).
//
// Stored in the personality_learning row under `self_facts`, alongside the
// opinions array. Tiny footprint — we inject all of them into the system
// prompt since there's never more than a few dozen and they define identity.
//
// The personality store is bot-local (per-bot Supabase row + cache), so this
// module takes its dependencies as a factory argument:
//
//   const selfCanon = createSelfCanon({ getData, markOpinionsDirty });
//   await selfCanon.recordSelfFact({ fact: "..." });
//
//   getData()              — async, returns the personality data record
//                            (must have a mutable `self_facts` array on it).
//   markOpinionsDirty()    — optional sync, signals the store to flush.

const MAX_FACTS = 40;
const DEDUPE_OVERLAP_THRESHOLD = 0.65;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","so","is","are","was","were","be","my","i",
  "me","im","i'm","have","has","had","it","to","of","in","on","at","for","with",
]);

function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
  );
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / Math.max(a.size, b.size);
}

/**
 * Build a self-canon module bound to a specific personality store.
 *
 * @param {object} deps
 * @param {() => Promise<object | null>} deps.getData
 *   Async getter for the bot's personality record. Must return an object whose
 *   `self_facts` array we can mutate, or null/undefined if unavailable.
 * @param {() => void} [deps.markOpinionsDirty]
 *   Optional flush-trigger. Called after any mutation; if omitted, the caller
 *   is responsible for persisting `data.self_facts` themselves.
 */
export function createSelfCanon({ getData, markOpinionsDirty } = {}) {
  if (typeof getData !== "function") {
    throw new Error("createSelfCanon: getData function is required");
  }
  const markDirty = typeof markOpinionsDirty === "function" ? markOpinionsDirty : null;

  /**
   * Store a fact about the bot itself.
   * @param {object} input
   * @param {string} input.fact  Short declarative statement ("my favorite color is teal").
   * @param {string} [input.category]  Optional tag: "taste", "identity", "quirk", "preference".
   */
  async function recordSelfFact({ fact, category = "misc" } = {}) {
    if (!fact || typeof fact !== "string") return { ok: false, error: "fact required" };
    const trimmed = fact.trim().slice(0, 160);
    if (!trimmed) return { ok: false, error: "fact is empty" };

    const data = await getData();
    if (!data) return { ok: false, error: "personality data unavailable" };
    if (!Array.isArray(data.self_facts)) data.self_facts = [];

    const newWords = tokenize(trimmed);
    if (newWords.size === 0) return { ok: false, error: "fact has no meaningful words" };

    // Dedupe — if a substantially similar fact already exists, update it
    // rather than duplicating. Real people don't re-assert the same thing
    // five times in five different phrasings.
    let existingIdx = -1;
    for (let i = 0; i < data.self_facts.length; i++) {
      const existWords = tokenize(data.self_facts[i].fact);
      if (overlapRatio(newWords, existWords) >= DEDUPE_OVERLAP_THRESHOLD) {
        existingIdx = i;
        break;
      }
    }

    const now = new Date().toISOString();
    if (existingIdx >= 0) {
      data.self_facts[existingIdx] = {
        ...data.self_facts[existingIdx],
        fact: trimmed,
        category: category || data.self_facts[existingIdx].category,
        updatedAt: now,
      };
    } else {
      data.self_facts.unshift({
        fact: trimmed,
        category: category || "misc",
        createdAt: now,
        updatedAt: now,
      });
      if (data.self_facts.length > MAX_FACTS) data.self_facts.length = MAX_FACTS;
    }

    markDirty?.();
    return { ok: true, updated: existingIdx >= 0 };
  }

  /**
   * Return all stored self-facts, newest first. Optionally filtered by category.
   */
  async function listSelfFacts({ category = null, limit = MAX_FACTS } = {}) {
    const data = await getData();
    const facts = Array.isArray(data?.self_facts) ? data.self_facts : [];
    const filtered = category ? facts.filter(f => f.category === category) : facts;
    return filtered.slice(0, limit);
  }

  /**
   * Delete a fact by keyword search. Returns the deleted fact or null.
   */
  async function forgetSelfFact(search) {
    if (!search) return null;
    const data = await getData();
    if (!Array.isArray(data?.self_facts)) return null;
    const searchWords = tokenize(search);
    if (!searchWords.size) return null;

    // A "keyword search" on a fact should succeed if any meaningful keyword
    // matches — the user doesn't want to provide 40% of the words, they want
    // to say "forget the pineapple one" and have it work. So we match if the
    // search share is high relative to the SEARCH side, not the stored fact.
    const idx = data.self_facts.findIndex(f => {
      const factWords = tokenize(f.fact);
      if (!factWords.size) return false;
      let hits = 0;
      for (const w of searchWords) if (factWords.has(w)) hits++;
      return hits / searchWords.size >= 0.5;
    });
    if (idx < 0) return null;
    const removed = data.self_facts.splice(idx, 1)[0];
    markDirty?.();
    return removed;
  }

  /**
   * Build the personal-canon prompt fragment. Small and always-on so she
   * never contradicts her own identity. Capped by `limit` to prevent prompt
   * bloat if the list grows.
   */
  async function buildSelfCanonContext({ limit = 15 } = {}) {
    const facts = await listSelfFacts({ limit });
    if (!facts.length) return "";
    const lines = facts.map(f => `  - ${f.fact}`);
    return `[YOUR OWN CANON — things about you that stay true. don't contradict these:\n${lines.join("\n")}]`;
  }

  return {
    recordSelfFact,
    listSelfFacts,
    forgetSelfFact,
    buildSelfCanonContext,
  };
}

// Testing helpers
export const _internal = { tokenize, overlapRatio };
