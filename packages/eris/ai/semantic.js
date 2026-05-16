// ─── Semantic Memory Search ──────────────────────────────────────────────────
// Uses Voyage AI embeddings + Supabase pgvector for similarity search.
// When a user mentions "Val" or "banned", this finds the episode where
// she joked about them being "sus" for getting accused of cheating —
// even though those exact words aren't in the current conversation.

import { createHash } from "node:crypto";
import config from "../config.js";
import { log } from "../utils/logger.js";

let _voyage = null;

function getVoyage() {
  if (!_voyage && config.voyageApiKey) {
    try {
      // Dynamic import for Voyage SDK
      _voyage = { apiKey: config.voyageApiKey };
    } catch {}
  }
  return _voyage;
}

// Voyage rate limiter: max 1 call per 2 seconds to avoid 429s
const _voyageLastCall = { ts: 0 };
const _VOYAGE_MIN_GAP = 5000;
const _searchCache = new Map();
const _SEARCH_CACHE_TTL = 60000;
function canCallVoyage() { const n = Date.now(); if (n - _voyageLastCall.ts < _VOYAGE_MIN_GAP) return false; _voyageLastCall.ts = n; return true; }
// Cache-key hash. Prior implementation was a 32-bit DJB2-style int (~4B keyspace)
// over the first 100 chars — that hits the birthday-paradox collision wall around
// ~65k distinct messages, which is well within reach for any long-running channel.
// SHA-256 truncated to 16 hex chars (64 bits) gives a ~5B collision floor, which
// is overkill for a 60s LRU cache but cheap and removes the entire collision class.
// Hashing the full message (not just the first 100 chars) eliminates cases where
// two messages share a 100-char prefix but diverge later.
function msgHash(t) { return createHash("sha256").update((t || "").toLowerCase()).digest("hex").slice(0, 16); }

// ─── Generate Embedding ─────────────────────────────────────────────────────

/**
 * Generate a vector embedding for text using Voyage AI.
 * Returns a 1024-dim float array, or null on failure.
 */
export async function generateEmbedding(text) {
  if (!config.voyageApiKey || !text) return null;
  if (!canCallVoyage()) { log("[Semantic] Voyage rate-limited, skipping"); return null; }

  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-3-lite",  // Fast + cheap, 512 dims
        input: [text.substring(0, 500)],  // Truncate long text
        input_type: "document",
      }),
    });

    if (!res.ok) {
      if (res.status === 429) {
        // Back off for 30 seconds on rate limit
        _voyageLastCall.ts = Date.now() + 25_000;
        log(`[Semantic] Voyage rate-limited (429), backing off 30s`);
      } else {
        log(`[Semantic] Voyage API error: ${res.status}`);
      }
      return null;
    }

    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch (e) {
    log(`[Semantic] Embedding failed: ${e.message}`);
    return null;
  }
}

/**
 * Generate embedding for a search query (uses different input_type).
 */
export async function generateQueryEmbedding(text) {
  if (!config.voyageApiKey || !text) return null;
  if (!canCallVoyage()) return null;

  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-3-lite",
        input: [text.substring(0, 200)],
        input_type: "query",
      }),
    });

    if (!res.ok) {
      if (res.status === 429) _voyageLastCall.ts = Date.now() + 25_000;
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

// ─── Store Episode with Embedding ───────────────────────────────────────────

// Dedupe threshold: if a new memory has cosine-similarity >= this to an existing
// recent memory for the same (bot_id, user_id), treat them as the same event —
// bump the existing row's `created_at` forward (freshness signal) instead of
// inserting a duplicate. Tunable for tests; default chosen so paraphrases of the
// same thing collapse but distinct events stay distinct.
export const DEDUPE_SIMILARITY_THRESHOLD = 0.95;

// How many recent memories we scan when doing dedupe lookups. Bounded so the
// pre-insert scan stays O(N) on a small slice instead of touching the full table.
const DEDUPE_SCAN_LIMIT = 20;

// Cosine similarity for two equal-length float arrays. Returns NaN-safe 0 when
// either vector is the zero vector (shouldn't happen for real embeddings).
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Find the most-similar existing memory for (bot_id, user_id). Returns
 * { row, similarity } when one beats the dedupe threshold, else null.
 * Falls back to exact content-match when embeddings aren't available.
 */
export async function findDuplicateMemory(supabase, botId, userId, content, embedding) {
  try {
    const query = supabase
      .from("eris_episodic_memories")
      .select("id, content, embedding, created_at")
      .eq("bot_id", botId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(DEDUPE_SCAN_LIMIT);
    const { data } = await query;
    if (!data?.length) return null;

    // Embedding-aware path: compare against stored vectors.
    if (Array.isArray(embedding) && embedding.length) {
      let best = null;
      for (const row of data) {
        let stored = row.embedding;
        if (typeof stored === "string") {
          try { stored = JSON.parse(stored); } catch { stored = null; }
        }
        if (!Array.isArray(stored) || stored.length !== embedding.length) continue;
        const sim = cosineSimilarity(embedding, stored);
        if (!best || sim > best.similarity) best = { row, similarity: sim };
      }
      if (best && best.similarity >= DEDUPE_SIMILARITY_THRESHOLD) return best;
    }

    // Fallback: exact-substring match on truncated content. Catches the
    // case where embeddings are off (no Voyage key) and someone repeats
    // themselves verbatim, which is otherwise a guaranteed duplicate.
    const trimmed = (content || "").substring(0, 500).trim().toLowerCase();
    if (trimmed.length >= 8) {
      const hit = data.find(r => (r.content || "").trim().toLowerCase() === trimmed);
      if (hit) return { row: hit, similarity: 1 };
    }
  } catch {
    // Table may not exist on a fresh install; treat as "no duplicate".
  }
  return null;
}

/**
 * Bump an existing memory forward (recency signal) instead of inserting a
 * duplicate. Updates `created_at` to now so it'll outlive the next prune sweep.
 */
export async function bumpExistingMemory(supabase, memoryId) {
  try {
    await supabase
      .from("eris_episodic_memories")
      .update({ created_at: new Date().toISOString() })
      .eq("id", memoryId);
  } catch (e) {
    log(`[Semantic] Bump failed: ${e.message}`);
  }
}

/**
 * Store an episodic memory with its vector embedding for later retrieval.
 * If an existing memory is near-identical (cosine >= DEDUPE_SIMILARITY_THRESHOLD,
 * or exact content match when embeddings are missing), bump the existing row
 * instead of inserting — keeps the table from filling with paraphrases of the
 * same event.
 */
export async function storeEpisode(botId, userId, channelId, guildId, type, content) {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;

    // Generate embedding
    const embedding = await generateEmbedding(content);

    // Dedupe: if this is near-identical to a recent memory, bump it instead of
    // inserting. Skipped when neither embedding nor exact-match could find a
    // duplicate.
    const dup = await findDuplicateMemory(supabase, botId, userId, content, embedding);
    if (dup?.row?.id) {
      await bumpExistingMemory(supabase, dup.row.id);
      return { deduped: true, id: dup.row.id, similarity: dup.similarity };
    }

    // Extract keywords for fallback text search
    const keywords = content.toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 10);

    const row = {
      bot_id: botId,
      user_id: userId,
      channel_id: channelId,
      guild_id: guildId,
      type,
      content: content.substring(0, 500),
      keywords,
    };

    // Only include embedding if we got one
    if (embedding) row.embedding = JSON.stringify(embedding);

    try {
      await supabase.from("eris_episodic_memories").insert(row);
      return { deduped: false };
    } catch (e) {
      // Table might not exist yet — silently fail
      if (!e.message?.includes("does not exist")) {
        log(`[Semantic] Store failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`[Semantic] Store error: ${e.message}`);
  }
}

// ─── Search Memories by Similarity ──────────────────────────────────────────

/**
 * Find relevant memories for the current message using vector similarity.
 * Falls back to keyword matching if embeddings aren't available.
 */
export async function searchRelevantMemories(botId, userId, messageText, limit = 3) {
  const _ck = botId+":"+userId+":"+msgHash(messageText); const _cc = _searchCache.get(_ck); if (_cc && Date.now()-_cc.ts < _SEARCH_CACHE_TTL) return _cc.results;
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return [];

    // Try vector similarity search first
    if (config.voyageApiKey) {
      const queryEmb = await generateQueryEmbedding(messageText);
      if (queryEmb) {
        try {
          const { data, error } = await supabase.rpc("search_memories", {
            query_embedding: JSON.stringify(queryEmb),
            match_bot: botId,
            match_user: userId,
            match_threshold: 0.3,
            match_count: limit,
          });
          if (data?.length) {
            return data.map(d => ({
              type: d.type,
              content: d.content,
              similarity: d.similarity,
            }));
          }
        } catch {
          // RPC might not exist yet — fall through to keyword search
        }
      }
    }

    // Fallback: keyword-based search
    const keywords = messageText.toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    if (!keywords.length) return [];

    try {
      const { data } = await supabase
        .from("eris_episodic_memories")
        .select("type, content")
        .eq("bot_id", botId)
        .eq("user_id", userId)
        .overlaps("keywords", keywords)
        .order("created_at", { ascending: false })
        .limit(limit);

      return (data || []).map(d => ({ type: d.type, content: d.content, similarity: 0.5 }));
    } catch {
      return [];
    }
  } catch (e) {
    log(`[Semantic] Search error: ${e.message}`);
    return [];
  }
}

// ─── Memory Maintenance (Prune + Consolidate + Dedupe) ────────────────────
// Episodic memory grows unboundedly without active maintenance: cold memories
// accumulate, embedding similarity gets noisier, query latency creeps up.
// This layer caps growth without losing the emotionally-significant stuff:
//   - prune-by-age: drop "exchange"-type memories older than the retention
//     window. Emotionally-loaded types (bond, tension, venting, opinion, etc.)
//     are exempt — those are the load-bearing ones humans actually carry.
//   - dedupe-on-insert: lives in storeEpisode (above), bumps existing rows
//     instead of stacking paraphrases.
//   - consolidate: TODO — when a user is over MEMORY_CONSOLIDATE_LIMIT (default
//     500) memories, the oldest ~100 should be LLM-summarized into one
//     consolidated row and the originals deleted. Deferred: an LLM round-trip
//     per overflowing user is a non-trivial cost surface and wants a separate
//     pass with per-provider budgeting + a way to flag the summary so it isn't
//     re-summarized. Prune + dedupe alone bound growth in practice.

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Prune episodic memories older than `maxAgeDays`. Emotionally-significant
 * types are exempt by default — only generic "exchange" rows get dropped.
 *
 * Options:
 *   - botId: scope deletion to this bot (recommended)
 *   - userId: further scope to a single user (optional)
 *   - maxAgeDays: override MEMORY_RETENTION_DAYS env (default 30)
 *   - pruneType: which `type` column value to prune (default "exchange")
 *
 * Returns: { deleted: number } best-effort count if Supabase reports it.
 */
export async function pruneMemories(opts = {}) {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return { deleted: 0 };

    const maxAgeDays = opts.maxAgeDays ?? envInt("MEMORY_RETENTION_DAYS", 30);
    const cutoffIso = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    // Default: only prune "exchange" rows (generic chatter). Tests/callers can
    // pass a custom prune type set, but the default is the conservative one
    // that preserves bond/tension/venting/opinion/running-bit memories forever.
    const pruneType = opts.pruneType ?? "exchange";

    let query = supabase
      .from("eris_episodic_memories")
      .delete()
      .eq("type", pruneType)
      .lt("created_at", cutoffIso);

    if (opts.botId) query = query.eq("bot_id", opts.botId);
    if (opts.userId) query = query.eq("user_id", opts.userId);

    const result = await query;
    if (result?.error) {
      log(`[Semantic] Prune error: ${result.error.message}`);
      return { deleted: 0 };
    }
    return { deleted: result?.count ?? 0 };
  } catch (e) {
    log(`[Semantic] Prune failed: ${e.message}`);
    return { deleted: 0 };
  }
}

/**
 * Consolidate the oldest memories for a given (bot_id, user_id) when they
 * exceed the per-user cap. PLACEHOLDER: the actual LLM-summarization step is
 * deferred — see the module-level note above. For now this no-ops and returns
 * a structured result so the scheduler can call it safely.
 *
 * TODO: when implemented, the flow is:
 *   1. count memories for (botId, userId)
 *   2. if > MEMORY_CONSOLIDATE_LIMIT (default 500): pull oldest ~100, summarize
 *      them via the configured LLM provider into a single "consolidated_summary"
 *      typed row, then delete the originals in a single statement.
 *   3. cap consolidations to N per maintenance cycle to bound cost.
 */
export async function consolidateMemories(_botId, _userId, _opts = {}) {
  // No-op pending LLM consolidation pass.
  return { consolidated: false, reason: "not-implemented" };
}

/**
 * One full maintenance cycle: prune-by-age across all users for this bot.
 * Scheduled to run on a 6h interval from events/ready.js. Safe to call when
 * Supabase is not configured (no-ops).
 */
export async function runMemoryMaintenance(opts = {}) {
  const result = await pruneMemories(opts);
  // Consolidation is opt-in until the LLM path lands — see consolidateMemories.
  return { pruned: result.deleted };
}

/**
 * Backwards-compatible alias. Older call sites import cleanupTrivialMemories;
 * route them through the new prune path so nothing else has to change.
 */
export async function cleanupTrivialMemories() {
  const { deleted } = await pruneMemories();
  return deleted;
}
