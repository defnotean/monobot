// ─── Semantic Memory Search ──────────────────────────────────────────────────
// Uses Voyage AI embeddings + Supabase pgvector for similarity search.
// When a user mentions "Val" or "banned", this finds the episode where
// she joked about them being "sus" for getting accused of cheating —
// even though those exact words aren't in the current conversation.

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

// Voyage rate limiter — separate trackers for store vs search so they don't block each other
// Voyage allows ~3 req/sec on free tier; we space calls 2s apart per-function
const _voyageStore = { ts: 0 };
const _voyageSearch = { ts: 0 };
const _VOYAGE_MIN_GAP = 2000;
// Cache capped — previously unbounded and would grow once per unique message.
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 500;
const _SEARCH_CACHE_TTL = 60000;
function canCallVoyage(type = "store") { const tracker = type === "search" ? _voyageSearch : _voyageStore; const n = Date.now(); if (n - tracker.ts < _VOYAGE_MIN_GAP) return false; tracker.ts = n; return true; }
// Include message length in the key so two messages that share the first 100
// chars but differ later don't alias to the same cached result. The substring
// cap is kept for the hash input so the hash cost stays bounded.
function msgHash(t) {
  const s = (t || "").toLowerCase();
  const head = s.substring(0, 100);
  let h = 0;
  for (let i = 0; i < head.length; i++) h = ((h << 5) - h + head.charCodeAt(i)) | 0;
  return `${s.length}_${h.toString(36)}`;
}

// ─── Generate Embedding ─────────────────────────────────────────────────────

/**
 * Generate a vector embedding for text using Voyage AI.
 * Returns a 1024-dim float array, or null on failure.
 */
export async function generateEmbedding(text) {
  if (!config.voyageApiKey || !text) return null;
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
      log(`[Semantic] Voyage API error: ${res.status}`);
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

    if (!res.ok) return null;
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
      await supabase.from("irene_episodic_memories").insert(row);
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
function _cachePut(key, results) {
  if (_searchCache.size >= _SEARCH_CACHE_MAX) {
    // Cheap FIFO drop — oldest insertion first
    const firstKey = _searchCache.keys().next().value;
    if (firstKey !== undefined) _searchCache.delete(firstKey);
  }
  _searchCache.set(key, { ts: Date.now(), results });
}

export async function searchRelevantMemories(botId, userId, messageText, limit = 3) {
  const cacheKey = `${botId}:${userId}:${msgHash(messageText)}`;
  const cached = _searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < _SEARCH_CACHE_TTL) return cached.results;

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
            _cachePut(cacheKey, results);
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
        .from("irene_episodic_memories")
        .select("type, content")
        .eq("bot_id", botId)
        .eq("user_id", userId)
        .gt("expires_at", new Date().toISOString())
        .overlaps("keywords", keywords)
        .order("created_at", { ascending: false })
        .limit(limit);

      const results = (data || []).map(d => ({ type: d.type, content: d.content, similarity: 0.5 }));
      _cachePut(cacheKey, results);
      return results;
    } catch {
      return [];
    }
  } catch (e) {
    log(`[Semantic] Search error: ${e.message}`);
    return [];
  }
}

// ─── Cleanup Expired Memories ───────────────────────────────────────────────

export async function cleanupExpiredMemories() {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from("irene_episodic_memories").delete().lt("expires_at", new Date().toISOString());
  } catch {}
}
