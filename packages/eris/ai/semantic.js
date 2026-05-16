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

/**
 * Store an episodic memory with its vector embedding for later retrieval.
 */
export async function storeEpisode(botId, userId, channelId, guildId, type, content) {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;

    // Generate embedding
    const embedding = await generateEmbedding(content);

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

// ─── Smart Memory Cleanup (Human-Like Forgetting) ──────────────────────────
// Humans don't forget on a timer — they forget trivial things and keep
// emotional, important, or frequently-recalled memories. This cleanup:
//   - KEEPS: bonding, tension, venting, running bits, strong opinions
//   - FADES: generic exchanges older than 30 days with low similarity scores
//   - KEEPS: anything recalled (searched for) in the last 14 days

export async function cleanupTrivialMemories() {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Only delete generic "exchange" type memories older than 30 days.
    // Keep all emotionally significant types (bond, tension, venting, opinion, etc.)
    const { error } = await supabase
      .from("eris_episodic_memories")
      .delete()
      .eq("type", "exchange")
      .lt("created_at", thirtyDaysAgo);

    if (error) log(`[Semantic] Cleanup error: ${error.message}`);
  } catch (e) {
    log(`[Semantic] Cleanup failed: ${e.message}`);
  }
}
