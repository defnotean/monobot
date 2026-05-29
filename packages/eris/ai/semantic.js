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

// Voyage rate limiter — separate trackers for store vs search so a per-message
// search and a per-message store don't mutually block each other (a single
// shared 5s gate silently degraded recall to keyword-only). Each function gets
// its own 2s gap, matching Irene's split design.
const _voyageStore = { ts: 0 };
const _voyageSearch = { ts: 0 };
const _VOYAGE_MIN_GAP = 2000;
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 500;
const _SEARCH_CACHE_TTL = 60000;
function canCallVoyage(type = "store") { const tracker = type === "search" ? _voyageSearch : _voyageStore; const n = Date.now(); if (n - tracker.ts < _VOYAGE_MIN_GAP) return false; tracker.ts = n; return true; }

// Local-Ollama embedding fallback. Activated by config.local.ollamaEmbedUrl
// (env OLLAMA_EMBED_URL). When set, Voyage is bypassed entirely.
async function _ollamaEmbed(text, maxLen) {
  try {
    const res = await fetch(`${config.local?.ollamaEmbedUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.local?.ollamaEmbedModel || "nomic-embed-text", prompt: text.substring(0, maxLen) }),
    });
    if (!res.ok) { log(`[Semantic] Ollama embed error: ${res.status}`); return null; }
    const data = await res.json();
    return data?.embedding || null;
  } catch (e) {
    log(`[Semantic] Ollama embed failed: ${e.message}`);
    return null;
  }
}
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
  if (!text) return null;
  if (config.local?.ollamaEmbedUrl) return _ollamaEmbed(text,500);
  if (!config.voyageApiKey) return null;
  if (!canCallVoyage("store")) { log("[Semantic] Voyage rate-limited, skipping"); return null; }

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
        _voyageStore.ts = Date.now() + 25_000;
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
  if (!text) return null;
  if (config.local?.ollamaEmbedUrl) return _ollamaEmbed(text,200);
  if (!config.voyageApiKey) return null;
  if (!canCallVoyage("search")) return null;

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
      if (res.status === 429) _voyageSearch.ts = Date.now() + 25_000;
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
 *
 * PRIVACY: pass `opts.sensitivity = "secret"` for content derived from a
 * secret-tier disclosure. Secret content is NEVER embedded or written to the
 * searchable semantic store — once it's in the access-gated facts table that's
 * the only place it lives. Default ("normal"/"sensitive") preserves the prior
 * always-store behavior so existing callers are unaffected.
 */
export async function storeEpisode(botId, userId, channelId, guildId, type, content, opts = {}) {
  // Secret-tier guard: a "forget everything" disclosure or a fact the user
  // locked away as a secret must not leak into the searchable episodic store
  // where it would be retrievable by similarity/keyword forever with no
  // access gate. Skip the embedding + insert entirely.
  if (opts && opts.sensitivity === "secret") {
    return { skipped: true, reason: "secret-tier-not-embedded" };
  }
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
// Note: empty/zero-hit results are now cached for the full _SEARCH_CACHE_TTL too
// (the cache was previously read but never written, so every call recomputed).
// A memory stored within the TTL window after an empty search for a colliding
// key will be missed until the entry expires — bounded, and matches Irene's
// port which also caches empties.
function _cachePut(key, results) {
  if (_searchCache.size >= _SEARCH_CACHE_MAX) {
    // Cheap FIFO drop — oldest insertion first. Bounds a previously-unbounded
    // Map that would grow once per unique message on a long-running channel.
    const firstKey = _searchCache.keys().next().value;
    if (firstKey !== undefined) _searchCache.delete(firstKey);
  }
  _searchCache.set(key, { ts: Date.now(), results });
}

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
            const results = data.map(d => ({
              type: d.type,
              content: d.content,
              similarity: d.similarity,
            }));
            _cachePut(_ck, results);
            return results;
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

      const results = (data || []).map(d => ({ type: d.type, content: d.content, similarity: 0.5 }));
      _cachePut(_ck, results);
      return results;
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
//   - consolidate: when a user has > MEMORY_CONSOLIDATION_THRESHOLD generic
//     "exchange" memories, the oldest ~100 are LLM-summarized into a single
//     "consolidated" row and the originals deleted. The LLM call uses the
//     active provider's fast/cheap model. A per-process daily counter caps the
//     spend; when the cap is hit we skip and try next cycle. On LLM failure
//     the originals are NOT deleted — the cycle retries on the next pass.

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Types that consolidation is allowed to touch. Mirrors the pruneType default:
// emotionally-significant memories (bond, tension, venting, opinion, etc.)
// are exempt — they're load-bearing and must never collapse into a summary.
export const CONSOLIDATABLE_TYPE = "exchange";
// Type written for the synthesized summary row. Distinct so future passes
// don't re-summarize a summary (and so callers can filter it out of retrieval
// if they want only raw episodes).
export const CONSOLIDATED_TYPE = "consolidated";

// ─── Daily cost cap ────────────────────────────────────────────────────────
// Process-local counter — max LLM consolidation calls per rolling 24h window.
// Counter resets when the window expires (lazy: checked on each call). Exposed
// for tests via __setConsolidationBudget / __getConsolidationBudget.
const _budget = { used: 0, windowStartedAt: Date.now() };
const ONE_DAY_MS = 24 * 3600_000;

function ensureBudgetWindow() {
  if (Date.now() - _budget.windowStartedAt >= ONE_DAY_MS) {
    _budget.used = 0;
    _budget.windowStartedAt = Date.now();
  }
}

function consolidationBudgetExhausted() {
  ensureBudgetWindow();
  const max = envInt("MEMORY_CONSOLIDATION_MAX_PER_DAY", 50);
  return _budget.used >= max;
}

function consumeConsolidationBudget() {
  ensureBudgetWindow();
  _budget.used += 1;
}

// Test hooks — keep the budget controllable from outside without exposing
// the closure variable directly.
export function __setConsolidationBudget(used, windowStartedAt = Date.now()) {
  _budget.used = used;
  _budget.windowStartedAt = windowStartedAt;
}
export function __getConsolidationBudget() {
  return { used: _budget.used, windowStartedAt: _budget.windowStartedAt };
}

/**
 * RIGHT TO BE FORGOTTEN — hard-delete ALL episodic memories for a single user.
 *
 * Unlike pruneMemories (age-bounded, type-exempt), this deletes every row for
 * (botId, userId) regardless of type or age — bond/tension/venting/opinion
 * included. This is the destructive companion to clearAllFacts: when a user
 * says "forget everything about me", their facts AND their episodic store must
 * both go, or the same emotional disclosures survive in the searchable vector
 * store forever.
 *
 * Returns { ok: boolean, deleted: number, error?: string }. `ok` is false on a
 * reported delete error so the caller can surface a partial-erasure warning
 * instead of falsely claiming a clean wipe. Missing table / no Supabase are
 * treated as ok:true (nothing to delete) so a fresh install degrades cleanly.
 */
export async function deleteEpisodicMemoriesForUser(botId, userId) {
  if (!userId) return { ok: false, deleted: 0, error: "missing-user" };
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return { ok: true, deleted: 0 };

    let query = supabase
      .from("eris_episodic_memories")
      .delete()
      .eq("user_id", userId);
    // Scope to this bot when known so a shared table isn't over-deleted, but
    // still wipe userId-only when botId is absent (right-to-be-forgotten must
    // not silently leave rows behind because the caller didn't pass botId).
    if (botId) query = query.eq("bot_id", botId);

    const result = await query;
    if (result?.error) {
      // A missing table on a fresh install is not a failure — there's nothing
      // to erase. Any other error IS a failure: report it so the caller
      // doesn't claim a full wipe.
      if (/does not exist/i.test(result.error.message || "")) {
        return { ok: true, deleted: 0 };
      }
      log(`[Semantic] forget-user delete error: ${result.error.message}`);
      return { ok: false, deleted: 0, error: result.error.message };
    }
    return { ok: true, deleted: result?.count ?? 0 };
  } catch (e) {
    if (/does not exist/i.test(e.message || "")) return { ok: true, deleted: 0 };
    log(`[Semantic] forget-user delete failed: ${e.message}`);
    return { ok: false, deleted: 0, error: e.message };
  }
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

// Default LLM summarizer: uses the active provider's quickReply path (fast/cheap
// model — Gemini Flash, NVIDIA fast, OpenAI-compat fast, etc.). Returns null
// on any failure so the caller treats it as a soft failure and keeps the
// originals. Imported lazily so semantic.js doesn't pull the entire provider
// graph at module load.
async function defaultSummarizer(fragments) {
  try {
    const { quickReply } = await import("./providers/index.js");
    const sys = "Summarize the following 100 memory fragments into one paragraph capturing the through-line. Preserve dates and proper nouns when they matter. Reply with the paragraph only, no preamble.";
    const numbered = fragments
      .map((f, i) => `${i + 1}. ${f}`)
      .join("\n")
      .slice(0, 8000);
    // quickReply takes (client, sysInstr, userText, context). The Gemini path
    // ignores `client` because it constructs its own; other providers also
    // accept null. We pass null and let the provider build its own client.
    const text = await quickReply(null, sys, numbered, null);
    return (typeof text === "string" && text.trim()) ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Consolidate the oldest generic memories for (botId, userId) when they exceed
 * MEMORY_CONSOLIDATION_THRESHOLD (default 300). Flow:
 *
 *   1. Count "exchange"-type rows for (botId, userId).
 *   2. If <= threshold → no-op, return { consolidated: false, reason }.
 *   3. Fetch the oldest 100 rows.
 *   4. Call the LLM to summarize → if it fails or returns empty, RETURN early
 *      WITHOUT deleting (soft retry on next cycle).
 *   5. Insert a single "consolidated"-type row with the summary.
 *   6. Delete the 100 originals by id.
 *   7. Increment the per-process daily budget counter.
 *
 * Options:
 *   - threshold: override MEMORY_CONSOLIDATION_THRESHOLD env (default 300)
 *   - batchSize: how many of the oldest to fold into one summary (default 100)
 *   - summarize(fragments): inject a custom summarizer (used by tests). Must
 *     return a string or null. Defaults to the active provider's quickReply.
 *   - dryRun: when true, log what WOULD happen but don't write or delete.
 *     Useful when the LLM dispatch path is too coupled or unavailable in a
 *     given environment.
 *
 * Returns: { consolidated: boolean, reason?: string, inserted?: boolean,
 *   deleted?: number, dryRun?: boolean }
 */
export async function consolidateMemories(botId, userId, opts = {}) {
  if (!botId || !userId) {
    return { consolidated: false, reason: "missing-identifiers" };
  }

  if (consolidationBudgetExhausted()) {
    return { consolidated: false, reason: "budget-exhausted" };
  }

  let supabase;
  try {
    const { getSupabase } = await import("../database.js");
    supabase = getSupabase();
  } catch {
    return { consolidated: false, reason: "no-supabase" };
  }
  if (!supabase) return { consolidated: false, reason: "no-supabase" };

  const threshold = opts.threshold ?? envInt("MEMORY_CONSOLIDATION_THRESHOLD", 300);
  const batchSize = opts.batchSize ?? 100;
  const dryRun = !!opts.dryRun;
  const summarize = typeof opts.summarize === "function" ? opts.summarize : defaultSummarizer;

  // A single select has to answer two questions:
  //   1. is this user strictly OVER the threshold (so consolidation kicks in)?
  //   2. fetch the oldest `batchSize` rows to fold into one summary.
  // Limit must therefore be at least max(threshold + 1, batchSize). The +1 is
  // the cheap way to confirm "count > threshold" without a separate count()
  // round-trip — if the select returns at least threshold+1 rows we know there
  // are more than threshold without needing the exact total.
  const selectLimit = Math.max(threshold + 1, batchSize);
  let candidates;
  try {
    const { data, error } = await supabase
      .from("eris_episodic_memories")
      .select("id, content, created_at")
      .eq("bot_id", botId)
      .eq("user_id", userId)
      .eq("type", CONSOLIDATABLE_TYPE)
      .order("created_at", { ascending: true })
      .limit(selectLimit);
    if (error) return { consolidated: false, reason: "select-error" };
    candidates = data || [];
  } catch {
    return { consolidated: false, reason: "select-error" };
  }

  // Under threshold → no-op. We need strictly more than the threshold for
  // consolidation to kick in (so a user sitting AT the threshold doesn't get
  // their oldest 100 erased every 6h).
  if (candidates.length <= threshold) {
    return { consolidated: false, reason: "under-threshold", count: candidates.length };
  }

  // Not enough rows for a full batch — e.g. threshold=10 but only 11 rows
  // exist; we'd rather wait until the user has 100+ overflow than synthesize a
  // 1-row "summary". Bail rather than form a thin batch.
  if (candidates.length < batchSize) {
    return { consolidated: false, reason: "insufficient-batch", count: candidates.length };
  }

  const toFold = candidates.slice(0, batchSize);

  if (dryRun) {
    log(`[Memory] consolidation dry-run: would fold ${toFold.length} memories for ${botId}/${userId}`);
    return { consolidated: false, reason: "dry-run", dryRun: true, count: toFold.length };
  }

  // LLM summarization — soft failure: if the model returns null/empty, we
  // keep the originals and try again next cycle. The budget is consumed
  // BEFORE the call so a repeatedly-failing provider doesn't burn through
  // the daily budget; the increment is conservative and bounds the worst
  // case to MEMORY_CONSOLIDATION_MAX_PER_DAY failed attempts per day.
  consumeConsolidationBudget();

  const fragments = toFold.map(r => r.content || "").filter(Boolean);
  let summary;
  try {
    summary = await summarize(fragments);
  } catch (e) {
    log(`[Memory] consolidation summarize threw: ${e.message}`);
    return { consolidated: false, reason: "llm-error" };
  }

  if (!summary || typeof summary !== "string" || !summary.trim()) {
    return { consolidated: false, reason: "llm-empty" };
  }

  // Insert the consolidated summary first. Only delete the originals AFTER
  // the insert succeeds — if the insert fails we'd otherwise lose data with
  // no record of what was consolidated.
  const oldestAt = toFold[0]?.created_at;
  const newestAt = toFold[toFold.length - 1]?.created_at;

  // Extract keywords from the summary so the keyword-overlap fallback can find
  // this row — same shape as storeEpisode. Without this the consolidated row is
  // invisible to .overlaps("keywords", ...) and recall silently drops it.
  const keywords = summary.toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 10);

  const consolidatedRow = {
    bot_id: botId,
    user_id: userId,
    channel_id: null,
    guild_id: null,
    type: CONSOLIDATED_TYPE,
    content: `[consolidated ${toFold.length} memories ${oldestAt || ""}→${newestAt || ""}] ${summary}`.slice(0, 500),
    keywords,
  };

  // Embed the summary so the vector search RPC can surface this row. Without an
  // embedding the consolidated memory is excluded from similarity search forever
  // and the 100 originals it replaced are already deleted below.
  const consolidatedEmbedding = await generateEmbedding(summary);
  if (consolidatedEmbedding) consolidatedRow.embedding = JSON.stringify(consolidatedEmbedding);

  try {
    const { error: insertErr } = await supabase
      .from("eris_episodic_memories")
      .insert(consolidatedRow);
    if (insertErr) {
      log(`[Memory] consolidation insert failed: ${insertErr.message}`);
      return { consolidated: false, reason: "insert-error" };
    }
  } catch (e) {
    log(`[Memory] consolidation insert threw: ${e.message}`);
    return { consolidated: false, reason: "insert-error" };
  }

  // Delete the originals. If this fails (partial delete is possible), we've
  // double-counted a few exchanges in the consolidated row + the leftover
  // originals, but no data has been lost — much better than the reverse.
  let deleted = 0;
  try {
    const ids = toFold.map(r => r.id).filter(Boolean);
    let deleteQ = supabase
      .from("eris_episodic_memories")
      .delete()
      .eq("bot_id", botId)
      .eq("user_id", userId)
      .eq("type", CONSOLIDATABLE_TYPE);
    // Prefer .in() when the fake/real supabase supports it; fall back to
    // per-id .eq() deletes through the chain otherwise. The chainable fake
    // in tests only supports .eq(), so we expose both code paths.
    if (typeof deleteQ.in === "function") {
      deleteQ = deleteQ.in("id", ids);
      const result = await deleteQ;
      deleted = result?.count ?? ids.length;
    } else {
      // Sequential per-id delete — slower but works against the eq-only fake.
      for (const id of ids) {
        const r = await supabase
          .from("eris_episodic_memories")
          .delete()
          .eq("bot_id", botId)
          .eq("user_id", userId)
          .eq("id", id);
        if (!r?.error) deleted += r?.count ?? 1;
      }
    }
  } catch (e) {
    log(`[Memory] consolidation delete partial: ${e.message}`);
  }

  log(`[Memory] consolidated ${toFold.length} memories for ${botId}/${userId} → 1 summary (deleted ${deleted})`);
  return { consolidated: true, inserted: true, deleted, count: toFold.length };
}

/**
 * Run consolidation across every user that's over the threshold for this bot.
 * Iterates users in batches, calling consolidateMemories per-user. Stops early
 * when the daily budget is exhausted. Safe to call when Supabase is missing.
 */
export async function consolidateAllOverThreshold(opts = {}) {
  const result = { users: 0, consolidated: 0, skipped: 0 };
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return result;
    if (!opts.botId) return result;

    const threshold = opts.threshold ?? envInt("MEMORY_CONSOLIDATION_THRESHOLD", 300);

    // Find candidate users via an aggregate query. Many supabase setups don't
    // expose a clean GROUP BY through PostgREST so we fall back to fetching
    // distinct user_ids the cheap way: a select with the type filter, then
    // tally in memory. Capped at a generous upper bound so a huge table
    // doesn't OOM the worker.
    let rows;
    try {
      const { data } = await supabase
        .from("eris_episodic_memories")
        .select("user_id")
        .eq("bot_id", opts.botId)
        .eq("type", CONSOLIDATABLE_TYPE)
        .limit(50_000);
      rows = data || [];
    } catch {
      return result;
    }

    const counts = new Map();
    for (const r of rows) {
      const u = r.user_id;
      if (!u) continue;
      counts.set(u, (counts.get(u) || 0) + 1);
    }
    const over = [...counts.entries()].filter(([, n]) => n > threshold).map(([u]) => u);

    for (const userId of over) {
      if (consolidationBudgetExhausted()) {
        result.skipped += 1;
        continue;
      }
      const r = await consolidateMemories(opts.botId, userId, opts);
      result.users += 1;
      if (r?.consolidated) result.consolidated += 1;
      else if (r?.reason === "budget-exhausted") result.skipped += 1;
    }
  } catch (e) {
    log(`[Memory] consolidateAllOverThreshold failed: ${e.message}`);
  }
  return result;
}

/**
 * One full maintenance cycle: prune-by-age, then consolidate users over the
 * threshold. Scheduled to run on a 6h interval from events/ready.js. Safe to
 * call when Supabase is not configured (no-ops).
 */
export async function runMemoryMaintenance(opts = {}) {
  const pruneResult = await pruneMemories(opts);

  // Sweep expired sensitive-tier facts (TTL). Best-effort + degrades to a no-op
  // when the expires_at column / TTL aren't configured, so this never affects
  // the green baseline. Imported lazily so semantic.js doesn't hard-depend on
  // the facts table existing.
  let expiredFacts = 0;
  try {
    const { pruneExpiredFacts } = await import("../database.js");
    if (typeof pruneExpiredFacts === "function") {
      const r = await pruneExpiredFacts();
      expiredFacts = r?.deleted ?? 0;
    }
  } catch (e) {
    log(`[Memory] pruneExpiredFacts skipped: ${e.message}`);
  }

  // Consolidation only runs when botId is provided — we need to scope the
  // candidate-user scan. The 6h scheduler in events/ready.js passes botId.
  let consolidationResult = { users: 0, consolidated: 0, skipped: 0 };
  if (opts.botId) {
    consolidationResult = await consolidateAllOverThreshold(opts);
  }
  return {
    pruned: pruneResult.deleted,
    expiredFacts,
    consolidatedUsers: consolidationResult.consolidated,
    consolidationSkipped: consolidationResult.skipped,
  };
}

/**
 * Backwards-compatible alias. Older call sites import cleanupTrivialMemories;
 * route them through the new prune path so nothing else has to change.
 */
export async function cleanupTrivialMemories() {
  const { deleted } = await pruneMemories();
  return deleted;
}
