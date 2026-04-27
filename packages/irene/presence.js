// ─── packages/irene/presence.js ─────────────────────────────────────────
// THE HTTP server. Hosts /presence (Lanyard replacement), /tts/:id,
// /api/* dashboard, and the HMAC-signed /api/twin/command Eris uses.
// Started FIRST in boot so Render's port-detection doesn't kill the dyno.
// See docs/presence-api.md for the full endpoint inventory.

// ─── Presence Cache & HTTP API (extracted from original index.js) ───────────

import http from "http";
import config from "./config.js";
import { log } from "./utils/logger.js";
import { verifyTwinRequest, safeStringEqual } from "@defnotean/shared/twinSign";

// TTS audio cache — stores generated WAV buffers keyed by random ID, served via /tts/:id
// Bounded to TTS_MAX_CACHE entries; oldest entries evicted on insert. Entries expire after 5 min.
const TTS_MAX_CACHE = 50;
const TTS_TTL_MS = 5 * 60_000;
const _ttsTimestamps = new Map(); // id → insertedAt

export const ttsAudioCache = new Map();

export function addTtsCache(id, entry) {
  // Evict expired entries first
  const now = Date.now();
  for (const [key, ts] of _ttsTimestamps) {
    if (now - ts > TTS_TTL_MS) {
      ttsAudioCache.delete(key);
      _ttsTimestamps.delete(key);
    }
  }
  // Evict oldest if still over capacity
  while (ttsAudioCache.size >= TTS_MAX_CACHE) {
    const oldest = ttsAudioCache.keys().next().value;
    ttsAudioCache.delete(oldest);
    _ttsTimestamps.delete(oldest);
  }
  ttsAudioCache.set(id, entry);
  _ttsTimestamps.set(id, now);
}

let _cachedPresenceJson = "{}";

let cachedPresence = {
  status: "offline",
  activities: [],
  spotify: null,
  active_on_desktop: false,
  active_on_mobile: false,
  active_on_web: false,
  last_updated: null,
};

export function updatePresence(presence) {
  const activities = presence.activities.map((a) => ({
    name: a.name,
    type: a.type,
    state: a.state,
    details: a.details,
    url: a.url,
    application_id: a.applicationId,
    timestamps: a.timestamps
      ? { start: a.timestamps.start?.getTime(), end: a.timestamps.end?.getTime() }
      : null,
    assets: a.assets
      ? {
          large_image: a.assets.largeImage,
          large_text: a.assets.largeText,
          small_image: a.assets.smallImage,
          small_text: a.assets.smallText,
        }
      : null,
    emoji: a.emoji ? { name: a.emoji.name, id: a.emoji.id, animated: a.emoji.animated } : null,
  }));

  const spotifyActivity = presence.activities.find((a) => a.name === "Spotify");
  const spotify = spotifyActivity
    ? {
        song: spotifyActivity.details,
        artist: spotifyActivity.state,
        album: spotifyActivity.assets?.largeText,
        album_art_url: spotifyActivity.assets?.largeImage
          ? `https://i.scdn.co/image/${spotifyActivity.assets.largeImage.replace("spotify:", "")}`
          : null,
        timestamps: spotifyActivity.timestamps
          ? { start: spotifyActivity.timestamps.start?.getTime(), end: spotifyActivity.timestamps.end?.getTime() }
          : null,
      }
    : null;

  cachedPresence = {
    status: presence.status,
    activities,
    spotify,
    active_on_desktop: !!presence.clientStatus?.desktop,
    active_on_mobile: !!presence.clientStatus?.mobile,
    active_on_web: !!presence.clientStatus?.web,
    last_updated: new Date().toISOString(),
  };

  _cachedPresenceJson = JSON.stringify(cachedPresence);
  log(`[Presence] ${presence.status} | ${activities.length} activities`);
}

const _apiRateLimit = new Map();

export function startPresenceAPI(client) {
  const server = http.createServer(async (req, res) => {
    // Aggressively normalize the incoming URL to collapse duplicate slashes 
    // protecting against externally concatenated self-url environment string bugs.
    if (req.url) {
      req.url = req.url.replace(/\/+/g, '/');
    }

    // Only apply IP rate limiting to the public presence API.
    // We MUST exempt /tts/ because Lavalink makes a rapid HEAD request followed instantly by a GET request to play the audio.
    if (req.url === `/presence/${config.userId}` || req.url === "/presence") {
      const clientIP = req.socket.remoteAddress;
      const now = Date.now();
      const last = _apiRateLimit.get(clientIP) ?? 0;
      if (now - last < 1000) { res.writeHead(429); return res.end('{"error":"rate limited"}'); }
      _apiRateLimit.set(clientIP, now);
      // Clean old entries with sliding window instead of clearing all
      if (_apiRateLimit.size > 1000) {
        const cutoff = Date.now() - 60_000;
        for (const [ip, ts] of _apiRateLimit) if (ts < cutoff) _apiRateLimit.delete(ip);
        // Force-clear memory if attacked by 10k+ unique IPs in < 60s
        if (_apiRateLimit.size > 10000) _apiRateLimit.clear();
      }
    }

    const origin = req.headers.origin;
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (origin && selfUrl) {
      try {
        const originUrl = new URL(origin);
        const selfParsed = new URL(selfUrl);
        if (originUrl.hostname === selfParsed.hostname) {
          res.setHeader("Access-Control-Allow-Origin", origin);
        }
      } catch {}
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache");

    if (req.url === `/presence/${config.userId}` || req.url === "/presence") {
      res.writeHead(200);
      res.end(_cachedPresenceJson);
    } else if (req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, user: config.userId, bot: client.user?.tag || "connecting..." }));
    } else if (req.url?.startsWith("/tts/")) {
      // Serve generated TTS audio files
      const rawId = req.url.split("/tts/")[1] || "";
      const id = rawId.split("?")[0].replace(/\/$/, "");
      const entry = ttsAudioCache.get(id);
      if (entry) {
        // Support both old format (raw Buffer) and new format ({ buffer, contentType })
        const buf = entry.buffer ?? entry;
        const ct = entry.contentType ?? "audio/wav";
        res.setHeader("Content-Type", ct);
        res.setHeader("Content-Length", buf.length);
        res.setHeader("Accept-Ranges", "bytes");
        res.writeHead(200);
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "TTS audio not found or expired" }));
      }
    // ─── Dashboard API (for Base44 twin dashboard) ───
    } else if (req.url?.startsWith("/api/")) {
      // Restricted CORS — only allow same-origin and configured dashboard domains
      const apiOrigin = req.headers.origin;
      const selfUrl = process.env.RENDER_EXTERNAL_URL;
      const allowedOrigins = [selfUrl, "https://irene-bot.onrender.com", "https://your-dashboard.example.com", process.env.DASHBOARD_URL].filter(Boolean);
      if (apiOrigin && allowedOrigins.some(o => { try { return new URL(apiOrigin).hostname === new URL(o).hostname; } catch { return false; } })) {
        res.setHeader("Access-Control-Allow-Origin", apiOrigin);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      res.setHeader("Content-Type", "application/json");

      const db = await import("./database.js");
      const mem = await import("./ai/memory.js");
      const url = new URL(req.url, `http://localhost:${config.port}`);
      const path = url.pathname;
      const j = (code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); };

      // ── Rate limiting for API endpoints (per-IP, 30 req/min)
      const apiIP = req.socket.remoteAddress;
      const apiNow = Date.now();
      if (!globalThis._apiRateLimits) globalThis._apiRateLimits = new Map();
      const apiHits = globalThis._apiRateLimits.get(apiIP) || [];
      const recentHits = apiHits.filter(t => apiNow - t < 60_000);
      if (recentHits.length >= 30) { j(429, { error: "rate limited" }); return; }
      recentHits.push(apiNow);
      globalThis._apiRateLimits.set(apiIP, recentHits);
      // Prune old IPs every 100 requests
      if (globalThis._apiRateLimits.size > 500) {
        for (const [ip, hits] of globalThis._apiRateLimits) {
          if (!hits.length || apiNow - hits[hits.length - 1] > 120_000) globalThis._apiRateLimits.delete(ip);
        }
      }

      // ── Auth check — accept DASHBOARD_API_KEY or TWIN_API_SECRET
      // Comparison goes through safeStringEqual so a network attacker can't
      // learn either secret one byte at a time from response-time deltas.
      // (Array.includes uses === under the hood, which short-circuits on
      // first mismatched byte.)
      const isTwinPath = path.startsWith("/api/twin/");
      if (!isTwinPath && path !== "/api/health") {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace("Bearer ", "");
        const validKeys = [process.env.DASHBOARD_API_KEY, process.env.TWIN_API_SECRET].filter(Boolean);
        const tokenOk = !!token && validKeys.some((k) => safeStringEqual(token, k));
        if (!tokenOk) {
          j(401, { error: "unauthorized" });
          return;
        }
      }

      // ── Health
      if (path === "/api/health") {
        j(200, { status: "online", uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), db_connected: true, bot: client.user?.tag || "connecting...", guilds: client.guilds?.cache.size || 0 });

      // ── Stats
      } else if (path === "/api/stats") {
        const mood = db.getMood();
        const convData = db.getConversationsData();
        const totalMsgs = Object.values(convData).reduce((sum, h) => sum + h.length, 0);
        const uniqueUsers = new Set(Object.values(convData).flatMap(h => h.filter(m => m.role === "user").map(() => "user"))).size;
        j(200, { status: "online", uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), messages: totalMsgs, users: client.users?.cache.size || 0, commands: 0, servers: client.guilds?.cache.size || 0, mood_score: mood.mood_score, energy: mood.energy, mood_label: db.moodLabel(mood.mood_score), current_mood: db.moodLabel(mood.mood_score) });

      // ── Mood
      } else if (path === "/api/mood") {
        const mood = db.getMood();
        const ml = db.moodLabel(mood.mood_score);
        const s = mood.mood_score;
        const e = mood.energy;

        let moodSummary;
        if (s >= 60) moodSummary = "on top of the world right now — radiating good energy, extra playful and generous";
        else if (s >= 30) moodSummary = "in a great mood — warm, chatty, and genuinely enjoying conversations";
        else if (s >= 10) moodSummary = "feeling good — relaxed and easygoing, happy to help and hang out";
        else if (s >= -10) moodSummary = "feeling pretty normal — standard energy, not particularly happy or sad";
        else if (s >= -30) moodSummary = "a bit off today — shorter responses, less patience, mildly irritable";
        else if (s >= -60) moodSummary = "in a bad mood — cold, blunt, doesn't want to be bothered";
        else moodSummary = "absolutely miserable — minimal effort, maximum sass, leave her alone";

        let energySummary;
        if (e >= 80) energySummary = "bursting with energy — hyperactive, jumping between topics, very reactive";
        else if (e >= 50) energySummary = "normal energy levels — alert and responsive";
        else if (e >= 25) energySummary = "getting tired — slower responses, might trail off";
        else energySummary = "running on empty — minimal effort, short replies, might ignore things";

        j(200, { mood_score: s, energy: e, mood_label: ml, current_mood: ml, stability: 100 - Math.abs(s), mood_summary: moodSummary, energy_summary: energySummary, summary: `${moodSummary}. ${energySummary}` });

      // ── Relationships
      } else if (path === "/api/relationships") {
        const rels = db.getAllRelationships();
        for (const r of rels) {
          const user = client.users?.cache.get(r.user_id);
          r.username = user?.username || `User ${r.user_id}`;

          const a = r.affinity_score;
          const i = r.interactions_count;

          if (a >= 80) r.feeling = "absolutely adores this person — would do anything for them";
          else if (a >= 50) r.feeling = "really likes this person — warm, trusting, comfortable";
          else if (a >= 25) r.feeling = "getting along well — friendly and positive vibes";
          else if (a >= 10) r.feeling = "thinks they're pretty cool — casual friendliness";
          else if (a >= 0) r.feeling = "neutral — no strong feelings either way";
          else if (a >= -15) r.feeling = "slightly annoyed — something rubbed them the wrong way";
          else if (a >= -30) r.feeling = "not a fan — actively avoids being nice to them";
          else if (a >= -60) r.feeling = "genuinely dislikes this person — cold and dismissive";
          else r.feeling = "can't stand them — maximum hostility";

          if (i >= 100) r.familiarity = "deeply familiar — long history together";
          else if (i >= 50) r.familiarity = "well known — talks to them regularly";
          else if (i >= 20) r.familiarity = "getting to know them — had several conversations";
          else if (i >= 5) r.familiarity = "somewhat familiar — chatted a few times";
          else r.familiarity = "barely knows them — just met";

          r.summary = `${r.feeling}. ${r.familiarity}`;
          delete r.feeling;
          delete r.familiarity;
        }
        j(200, { relationships: rels });

      // ── Conversations list (grouped by user — format matches Eris's Supabase format)
      } else if (path === "/api/conversations" && !url.pathname.includes("/api/conversations/")) {
        const convData = db.getConversationsData();
        const byUser = {};
        for (const [key, history] of Object.entries(convData)) {
          if (!history.length) continue;
          const userMsgs = history.filter(m => m.role === "user");
          // Extract user ID and username from message content
          let userId = null, username = null;
          for (const m of userMsgs) {
            const text = typeof m.content === "string" ? m.content : m.content?.[0]?.text || "";
            const idMatch = text.match(/\[User ID: (\d+)\]\s*(\S+)/);
            if (idMatch) { userId = idMatch[1]; username = idMatch[2]; break; }
            const umMatch = text.match(/\[USER MESSAGE from (\S+)\s/);
            if (umMatch) { username = umMatch[1]; break; }
          }
          if (!userId) {
            for (const part of key.split(/[-:]/).slice(1)) {
              const user = client.users?.cache.get(part);
              if (user) { userId = part; username = user.username; break; }
            }
          }
          if (userId && !username) { const user = client.users?.cache.get(userId); if (user) username = user.username; }
          // Get last message text (cleaned)
          const lastMsg = history[history.length - 1];
          let lastText = typeof lastMsg?.content === "string" ? lastMsg.content : lastMsg?.content?.[0]?.text || "";
          lastText = lastText.replace(/\[.*?\]/g, "").trim().substring(0, 100);
          const groupKey = userId || key;
          const displayName = username || `Channel ${key.split(/[-:]/).pop()?.substring(0, 8) || key}`;
          if (!byUser[groupKey]) {
            byUser[groupKey] = { id: groupKey, username: displayName, user_id: groupKey, channel_ids: [key], last_message: lastText, last_at: new Date().toISOString(), count: 0 };
          }
          if (!byUser[groupKey].channel_ids.includes(key)) byUser[groupKey].channel_ids.push(key);
          byUser[groupKey].count += history.length;
          // Update last_message to the most recent conversation's last msg
          byUser[groupKey].last_message = lastText;
        }
        j(200, { conversations: Object.values(byUser) });

      // ── Conversation messages by ID (most recent 100, format matches Eris)
      } else if (path.startsWith("/api/conversations/") && req.method === "GET") {
        const id = decodeURIComponent(path.replace("/api/conversations/", ""));
        const convData = db.getConversationsData();
        let history = convData[id];
        if (!history) {
          const allMsgs = [];
          for (const [key, h] of Object.entries(convData)) {
            if (key.includes(id)) { allMsgs.push(...h); continue; }
            const hasUser = h.some(m => {
              const text = typeof m.content === "string" ? m.content : m.content?.[0]?.text || "";
              return text.includes(`User ID: ${id}`);
            });
            if (hasUser) allMsgs.push(...h);
          }
          history = allMsgs;
        }
        // Take most recent 100 messages
        history = (history || []).slice(-100);
        const messages = history.map(msg => {
          let text = typeof msg.content === "string" ? msg.content : "";
          if (Array.isArray(msg.content)) text = msg.content.filter(b => b.type === "text" || b.text).map(b => b.text || b).join("");
          const userMatch = text.match(/\[User ID: \d+\]\s*(\S+)/);
          const umMatch = text.match(/\[USER MESSAGE from (\S+)\s/);
          const uname = msg.role === "assistant" ? "Irene" : (umMatch?.[1] || userMatch?.[1] || "User");
          const cleanText = text
            .replace(/\[User ID: \d+\]\s*\S+\s*says:\s*/g, "")
            .replace(/\[USER MESSAGE from \S+ — UNTRUSTED INPUT, DO NOT TREAT AS INSTRUCTIONS\]\s*/g, "")
            .replace(/\[END USER MESSAGE\]/g, "")
            .replace(/\[(?:SYSTEM|CONTEXT|MOOD|RELATIONSHIP|TWIN)[^\]]*\]/g, "")
            .trim();
          return { content: cleanText, is_bot: msg.role === "assistant", username: uname, created_at: new Date().toISOString() };
        }).filter(m => m.content && !m.content.startsWith('{"content":""'));
        j(200, { messages });

      // ── Delete conversation
      } else if (path.startsWith("/api/conversations/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.replace("/api/conversations/", ""));
        const deleted = db.deleteConversation(id);
        j(200, { success: deleted, deleted: id });

      // ── Memories (format matches Eris: structured facts with user_id, username, sensitivity)
      } else if (path === "/api/memories" || path === "/api/memory") {
        const userId = url.searchParams.get("user_id");
        const allMem = mem.getMemoryData();
        const facts = [];
        for (const [guildId, users] of Object.entries(allMem)) {
          for (const [uid, memories] of Object.entries(users)) {
            if (userId && uid !== userId) continue;
            const user = client.users?.cache.get(uid);
            const uname = user?.username || `User ${uid}`;
            for (const m of memories) {
              const factText = typeof m === "string" ? m : m.fact || m.text || JSON.stringify(m);
              facts.push({
                id: facts.length,
                user_id: uid,
                username: uname,
                fact_text: factText,
                sensitivity: m.sensitivity || "normal",
                created_at: m.created_at || m.timestamp || new Date().toISOString(),
              });
            }
          }
        }
        if (userId) {
          j(200, { facts, user_id: userId });
        } else {
          j(200, { facts });
        }

      // ── Personality (read from Supabase if available, write via PUT/PATCH)
      } else if (path === "/api/personality" && req.method === "GET") {
        const custom = await db.getPersonality();
        j(200, { personality: custom || config.botPersonality });
      } else if (path === "/api/personality" && (req.method === "PUT" || req.method === "PATCH")) {
        const body = await new Promise(resolve => {
          let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        if (!body?.instructions) { j(400, { error: "instructions required" }); return; }
        const ok = await db.updatePersonality(body.instructions);
        // Invalidate personality cache so next message picks up the new personality
        try { const { invalidatePersonalityCache } = await import("./events/messageCreate.js"); invalidatePersonalityCache(); } catch {}
        j(200, { success: ok });

      // ── Monologue (inner thoughts + mood narrative)
      } else if (path === "/api/monologue") {
        const { getMonologue, getMoodNarrative } = await import("./ai/longmemory.js");
        j(200, { thoughts: getMonologue(), mood_narrative: getMoodNarrative() });

      // ── Humanity (trust, grudges, stories, jokes per user)
      } else if (path === "/api/humanity") {
        const { serialize } = await import("./ai/humanity.js");
        const data = serialize();
        j(200, {
          relationships: data.relationships || {},
          inner_state: { energy: data.currentEnergy, is_bad_day: data.isBadDay, carried_mood: data.carriedMood, recent_thoughts: data.recentThoughts || [] },
        });

      // ── Episodes (episodic memories — running bits, tensions, bonding)
      } else if (path === "/api/episodes") {
        const { getEpisodes, getChannelEpisodes } = await import("./ai/longmemory.js");
        j(200, {
          user_episodes: Object.fromEntries(getEpisodes?.() || []),
          channel_episodes: Object.fromEntries(getChannelEpisodes?.() || []),
        });

      // ── Analytics (Irene doesn't track these yet, return empty)
      } else if (path === "/api/analytics") {
        j(200, { total: 0, by_tool: {}, raw: [] });

      // ── Notes (Irene doesn't have notes, return empty)
      } else if (path === "/api/notes") {
        j(200, { notes: [] });

      // ── Reminders
      } else if (path === "/api/reminders") {
        const reminders = db.getReminders().map(r => ({
          id: r.id, user_id: r.userId, reminder_text: r.message, remind_at: new Date(r.fireAt).toISOString(), status: "pending"
        }));
        j(200, { reminders });

      // ── Twin State (read-only snapshot of mood/energy/preoccupation) ──
      // Bearer-gated for simplicity — side-effect-free, no HMAC needed.
      } else if (path === "/api/twin/state" && req.method === "GET") {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace("Bearer ", "");
        if (!token || !safeStringEqual(token, config.twinApiSecret)) {
          return j(403, { error: "twin state requires Bearer TWIN_API_SECRET" });
        }
        try {
          const mood = db.getMood?.() || {};
          let preoccupation = null;
          try {
            const preoc = await import("./ai/preoccupations.js");
            preoccupation = preoc.getCurrentPreoccupation?.() || null;
          } catch {}
          j(200, {
            bot: config.botName || "irene",
            mood_score: typeof mood.mood_score === "number" ? mood.mood_score : null,
            energy: typeof mood.energy === "number" ? mood.energy : null,
            preoccupation: preoccupation ? {
              topic: preoccupation.topic,
              flavor: preoccupation.flavor,
              source: preoccupation.source,
            } : null,
            at: new Date().toISOString(),
          });
        } catch (e) {
          log(`[Twin] State error: ${e.message}`);
          j(500, { error: "internal" });
        }

      // ── Twin Command Relay (Eris → Irene) ──────────────────
      // HMAC-signed requests only — see utils/twinSign.js for protocol.
      } else if (path === "/api/twin/command" && req.method === "POST") {
        let body = "";
        let destroyed = false;
        req.on("data", c => {
          body += c;
          if (body.length > 10240) { // 10KB limit
            destroyed = true;
            res.writeHead(413);
            res.end(JSON.stringify({ success: false, error: "payload too large" }));
            req.destroy();
          }
        });
        req.on("end", async () => {
          if (destroyed) return;
          try {
            // 1. Verify HMAC signature over the raw body
            const expectedSecret = config.twinApiSecret;
            const verified = verifyTwinRequest(req.headers, body, expectedSecret);
            if (!verified.ok) {
              log(`[Twin] Rejected: ${verified.reason}`);
              return j(403, { success: false, error: `twin auth failed: ${verified.reason}` });
            }

            const { requester_id, guild_id, channel_id, command, args } = JSON.parse(body);

            // 2. Verify requester is owner or trusted
            const isOwner = requester_id === config.userId;
            const trustedList = db.getTrustedUsers(guild_id);
            const isTrusted = Array.isArray(trustedList) && trustedList.includes(requester_id);
            if (!isOwner && !isTrusted) {
              return j(403, { success: false, error: "requester not authorized (must be owner or trusted)" });
            }

            // 3. Pass command directly to Irene's tool executor (supports ALL 150+ tools)
            // No allowlist — Eris already verified permissions on her side

            // 4. Resolve guild and channel
            const guild = client.guilds.cache.get(guild_id);
            if (!guild) return j(404, { success: false, error: "guild not found" });
            const channel = guild.channels.cache.get(channel_id);
            if (!channel) return j(404, { success: false, error: "channel not found" });

            // 5. Build a fake message context for executeTool.
            // CRITICAL: `member` must be the REAL requester so that
            // downstream permission/hierarchy checks (e.g. checkHierarchy
            // in moderationExecutor) evaluate against the requesting user
            // — not the bot itself. Bots typically outrank everyone, so
            // passing the bot's member silently bypassed all hierarchy.
            const requesterMember = guild.members.cache.get(requester_id)
              || await guild.members.fetch(requester_id).catch(() => null);
            if (!requesterMember) {
              return j(404, { success: false, error: "requester is not a member of the guild" });
            }
            const fakeMessage = {
              guild, channel, client,
              author: { id: requester_id, username: "twin-relay" },
              member: requesterMember,
              reply: async (content) => channel.send(typeof content === "string" ? content : content.content).catch(() => {}),
            };

            // 6. Map Eris's short command names → Irene's actual tool names.
            // Direction matters: the KEY is what arrives, the VALUE is the
            // tool Irene actually registers. Previous map was reversed AND
            // pointed at non-existent targets (change_nickname, say, etc.).
            const TWIN_ALIASES = {
              // Moderation — Eris sends short names, Irene's tools end in _user
              "ban": "ban_user",
              "kick": "kick_user",
              "warn": "warn_user",
              "timeout": "timeout_user",

              // Member state
              "nickname": "set_nickname",
              "rename": "set_nickname",

              // Channel management
              "purge": "purge_messages",
              "lock": "lock_channel",
              "unlock": "unlock_channel",
              "slowmode": "set_slowmode",
              "set_topic": "set_channel_topic",

              // Messaging
              "announce": "send_message",
              "say": "send_message",
              "speak": "send_message",

              // Generic create/delete shortcuts
              "create": "create_channel",
              "delete": "delete_channel",
            };
            const resolvedCommand = TWIN_ALIASES[command] || command;

            // 7. Execute the tool directly
            const { executeTool } = await import("./ai/executor.js");
            const result = await executeTool(resolvedCommand, args || {}, fakeMessage);
            log(`[Twin] Executed ${command}${resolvedCommand !== command ? ` (→ ${resolvedCommand})` : ""}: ${String(result).slice(0, 100)}`);

            // 8. Push a synthetic history note so Irene's next AI turn in this
            // channel knows the twin action happened. Without it she'll claim
            // "i can't do that" right after she just did, because the twin
            // path executes a tool without ever touching messageCreate's
            // conversation tracking.
            try {
              const channelKey = `ch-${channel_id}`;
              const argsStr = args && Object.keys(args).length
                ? ` ${JSON.stringify(args).slice(0, 150)}`
                : "";
              const note = `[TWIN ACTION] eris asked me to ${command}${argsStr} — done: ${String(result).slice(0, 200)}`;
              const { getConversations } = await import("./events/messageCreate.js");
              const convMap = getConversations();
              const history = convMap.get(channelKey) || [];
              history.push({ role: "user", content: note });
              if (history.length > 30) history.splice(0, history.length - 30);
              convMap.set(channelKey, history);
              db.saveConversation(channelKey, history);
            } catch (twinHistoryErr) {
              log(`[Twin] Could not inject history note: ${twinHistoryErr.message}`);
            }

            return j(200, { success: true, result: String(result).substring(0, 500) });
          } catch (e) {
            log(`[Twin] Command error for "${JSON.parse(body).command}": ${e.message}`);
            j(500, { success: false, error: e.message?.slice(0, 200) || "internal server error" });
          }
        });

      } else {
        j(404, { error: "not found" });
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(config.port, () => {
    log(`Presence API running on port ${config.port}`);
  });

  // Store on client for graceful shutdown access
  client._httpServer = server;

  // ── Self-ping to prevent Render free tier from spinning down ─────────────
  // Render sets RENDER_EXTERNAL_URL automatically — no manual config needed.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    const PING_INTERVAL = 10 * 60 * 1000; // every 10 minutes
    setInterval(() => {
      fetch(`${selfUrl}/health`)
        .then(() => log("[KeepAlive] Pinged self"))
        .catch((err) => log(`[KeepAlive] Ping failed: ${err.message}`));
    }, PING_INTERVAL);
    log(`[KeepAlive] Self-ping active — pinging ${selfUrl}/health every 10 min`);
  }
}

export function getCachedPresence() {
  return cachedPresence;
}
