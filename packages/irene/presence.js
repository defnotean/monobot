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
import { createRateLimiter } from "@defnotean/shared/rateLimit";
import { getClientIp } from "@defnotean/shared/getClientIp";
import { normalizeRequestPathname, parseRequestUrl } from "@defnotean/shared/httpRequest";

// Per-source rate limit for /api/twin/state. The endpoint is Bearer-gated, so
// "identity" reduces to source IP — anyone holding TWIN_API_SECRET can read
// mood/preoccupation snapshots, and without this a valid token could be
// replayed in a tight loop (or simply hammered) to scrape state at arbitrary
// resolution. 10/min/IP is well above any healthy poll cadence; legit twin
// awareness sync runs on much longer intervals.
const _twinStateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 128, globalLimit: 60 });
const _presenceLimiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 1000, globalLimit: 300 });
const _dashboardLimiter = createRateLimiter({ limit: 180, windowMs: 60_000, maxKeys: 500, globalLimit: 2000 });
// Dedicated per-IP limiter for the signed twin endpoints (/api/twin/*). These
// deliberately do NOT share _dashboardLimiter: that bucket is consumed by
// unauthenticated traffic before auth runs, so a public /api/health flood
// could exhaust the shared global budget and silently 429 Eris's signed
// cross-bot moderation calls. No global cap here — per-IP only — so flooded
// public buckets can never starve the twin channel.
const _twinCommandLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 256 });

function isDiscordGatewayReady(client) {
  return client?.isReady?.() === true || ((client?.ws?.status ?? null) === 0 && !!client?.user?.tag);
}

function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin, allowedOrigins) {
  const reqOrigin = normalizeOrigin(origin);
  if (!reqOrigin) return false;
  for (const allowed of allowedOrigins) {
    const allowedOrigin = normalizeOrigin(allowed);
    if (allowedOrigin && allowedOrigin === reqOrigin) return true;
  }
  return false;
}

export function isDashboardRequestAuthorized(req) {
  const remote = req.socket?.remoteAddress || "";
  const isLocalhost = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const allowLocalhostBypass = process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS === "1";
  if (isLocalhost && allowLocalhostBypass) return true;

  const authHeader = req.headers.authorization;
  const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
  const validKeys = [process.env.DASHBOARD_API_KEY, config.dashboardApiKey].filter(Boolean);
  return !!token && validKeys.some((k) => safeStringEqual(token, k));
}

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

/**
 * @type {{ status: string, activities: any[], spotify: any, active_on_desktop: boolean, active_on_mobile: boolean, active_on_web: boolean, last_updated: string | null }}
 */
let cachedPresence = {
  status: "offline",
  activities: [],
  spotify: null,
  active_on_desktop: false,
  active_on_mobile: false,
  active_on_web: false,
  last_updated: null,
};

let _lastPresenceFingerprint = "";

function cleanDashboardText(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  return lower === "undefined" || lower === "null" ? "" : text;
}

function normalizeDiscordId(value) {
  const match = cleanDashboardText(value).match(/\d{15,25}/);
  return match?.[0] || "";
}

function extractStoredMessageUsername(content) {
  const text = String(content ?? "");
  const said = text.match(/^\[([^\]\n]+?)\s+said\]/i)?.[1];
  const trustedEnvelope = text.match(/\[USER MESSAGE from ([^\]\s]+)(?:\s|])/i)?.[1];
  const userIdPrefix = text.match(/\[User ID: \d+\]\s*([^\s]+)/i)?.[1];
  return cleanDashboardText(said) || cleanDashboardText(trustedEnvelope) || cleanDashboardText(userIdPrefix);
}

function cleanStoredMessageContent(content) {
  return String(content ?? "")
    .replace(/^\[[^\]\n]+?\s+said\]\s*/i, "")
    .replace(/\[User ID: \d+\]\s*\S+\s*says:\s*/gi, "")
    .replace(/\[USER MESSAGE from \S+[^]]*\]\s*/gi, "")
    .replace(/\[END USER MESSAGE\]/gi, "")
    .replace(/<\/?data(?:\s+[^>]*)?>/gi, "")
    .replace(/\[(?:SYSTEM|CONTEXT|MOOD|RELATIONSHIP|TWIN)[^\]]*\]/gi, "")
    .trim();
}

async function readJsonBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        tooLarge = true;
        req.destroy();
        resolve({ tooLarge: true, body: null });
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve({ tooLarge: false, body: JSON.parse(data || "{}") }); }
      catch { resolve({ tooLarge: false, body: null }); }
    });
    req.on("error", () => resolve({ tooLarge: false, body: null }));
  });
}

function summarizeGuild(guild) {
  return {
    guild_id: guild.id,
    id: guild.id,
    name: cleanDashboardText(guild.name) || `Guild ${guild.id}`,
    member_count: guild.memberCount ?? guild.members?.cache?.size ?? null,
    icon_url: typeof guild.iconURL === "function" ? guild.iconURL({ size: 64 }) : null,
  };
}

function summarizeMember(member, userId) {
  const user = member?.user;
  const id = normalizeDiscordId(userId || member?.id || user?.id);
  const username =
    cleanDashboardText(member?.displayName) ||
    cleanDashboardText(member?.nickname) ||
    cleanDashboardText(user?.globalName) ||
    cleanDashboardText(user?.username) ||
    (id ? `User ${id}` : "Unknown user");
  return {
    user_id: id,
    id,
    username,
    tag: cleanDashboardText(user?.tag) || null,
  };
}

async function resolveGuildMember(guild, input) {
  const raw = cleanDashboardText(input);
  if (!guild || !raw) return null;
  const id = normalizeDiscordId(raw);
  if (id) {
    const cached = guild.members?.cache?.get(id);
    if (cached) return cached;
    return guild.members?.fetch?.(id).catch(() => null) || null;
  }

  const needle = raw.replace(/^@/, "").toLowerCase();
  const cached = [...(guild.members?.cache?.values?.() || [])].filter((member) => {
    const user = member.user;
    return [
      member.displayName,
      member.nickname,
      user?.globalName,
      user?.username,
      user?.tag,
    ].some((value) => cleanDashboardText(value).toLowerCase() === needle);
  });
  if (cached.length === 1) return cached[0];

  const loose = [...(guild.members?.cache?.values?.() || [])].filter((member) => {
    const user = member.user;
    return [
      member.displayName,
      member.nickname,
      user?.globalName,
      user?.username,
      user?.tag,
    ].some((value) => cleanDashboardText(value).toLowerCase().includes(needle));
  });
  if (loose.length === 1) return loose[0];

  try {
    const fetched = await guild.members?.fetch?.({ query: needle, limit: 5 });
    const matches = [...(fetched?.values?.() || [])];
    if (matches.length === 1) return matches[0];
  } catch {}
  return null;
}

function trustedRowsForGuild(guild, db) {
  const ids = db.getTrustedUsers(guild.id) || [];
  return ids.map((id) => {
    const member = guild.members?.cache?.get(id);
    const user = member?.user || guild.client?.users?.cache?.get(id);
    return summarizeMember(member || { id, user }, id);
  });
}

export function updatePresence(presence) {
  const sourceActivities = Array.isArray(presence?.activities) ? presence.activities : [];
  const activities = sourceActivities.map((a) => ({
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

  const spotifyActivity = sourceActivities.find((a) => a.name === "Spotify");
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

  const nextPresence = {
    status: presence?.status ?? "offline",
    activities,
    spotify,
    active_on_desktop: !!presence?.clientStatus?.desktop,
    active_on_mobile: !!presence?.clientStatus?.mobile,
    active_on_web: !!presence?.clientStatus?.web,
  };
  const nextFingerprint = JSON.stringify(nextPresence);
  if (nextFingerprint === _lastPresenceFingerprint) return false;

  cachedPresence = {
    ...nextPresence,
    last_updated: new Date().toISOString(),
  };

  _lastPresenceFingerprint = nextFingerprint;
  _cachedPresenceJson = JSON.stringify(cachedPresence);
  log(`[Presence] ${cachedPresence.status} | ${activities.length} activities`);
  return true;
}

// ─── Twin command vocabulary (Eris → Irene relay) ──────────────────────────
// Map Eris's short command names → Irene's actual tool names.
// Direction matters: the KEY is what arrives, the VALUE is the tool Irene
// actually registers.
export const TWIN_ALIASES = {
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

// Server-side allowlist of the RESOLVED tool names the twin relay path is
// actually meant to drive — defense in depth. Irene's executor exposes 150+
// tools; the twin path is only ever supposed to relay the moderation / channel
// / role / setup actions that Eris's `ask_irene` executor builds. Trusting only
// Eris's own permission check meant a compromised or buggy Eris could POST any
// signed command and drive arbitrary Irene tools. We reject anything outside
// this set BEFORE executeTool.
//
// Contents = every value TWIN_ALIASES resolves to, PLUS the admin/staff
// commands Eris sends 1:1 (passed through as `TWIN_ALIASES[cmd] || cmd`).
// Keep in sync with eris/ai/executors/twinExecutor.js's command vocabulary.
export const TWIN_COMMAND_ALLOWLIST = new Set([
  ...Object.values(TWIN_ALIASES),
  // Admin/staff commands Eris forwards under their real tool name (unaliased).
  "create_role",
  "delete_role",
  "set_log_channel",
  "set_welcome_channel",
  "setup_starboard",
  "setup_reaction_roles",
  "nuke_channel",
  "lockdown_server",
  "give_role",
  "remove_role",
  "mass_role",
  "rename_channel",
  "move_channel",
]);

// Resolve an incoming twin command to Irene's real tool name and check it
// against the allowlist. Returns the resolved tool name if permitted, or null
// if the command is outside the relay vocabulary. Exported for unit testing.
export function resolveTwinCommand(command) {
  const resolved = TWIN_ALIASES[command] || command;
  return TWIN_COMMAND_ALLOWLIST.has(resolved) ? resolved : null;
}

export function startPresenceAPI(client) {
  const server = http.createServer(async (req, res) => {
    // Normalize only the path component; query values may legitimately contain
    // `https://...` or duplicate slashes and must not be rewritten.
    const requestUrl = parseRequestUrl(req.url, `http://localhost:${config.port}`);
    const pathname = normalizeRequestPathname(requestUrl.pathname);

    // Only apply IP rate limiting to the public presence API.
    // We MUST exempt /tts/ because Lavalink makes a rapid HEAD request followed instantly by a GET request to play the audio.
    if (pathname === `/presence/${config.ownerId}` || pathname === "/presence") {
      // getClientIp (X-Forwarded-For aware): behind Render's proxy the socket
      // peer is always the proxy, so keying on remoteAddress would lump every
      // visitor into one bucket and let one client lock everyone out.
      const clientIP = getClientIp(req);
      if (!_presenceLimiter.allow(clientIP)) { res.writeHead(429); return res.end('{"error":"rate limited"}'); }
    }

    const origin = req.headers.origin;
    const selfUrl = process.env.EXTERNAL_URL || process.env.RENDER_EXTERNAL_URL;
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

    if (pathname === `/presence/${config.ownerId}` || pathname === "/presence") {
      res.writeHead(200);
      res.end(_cachedPresenceJson);
    } else if (pathname === "/healthz" || pathname === "/readyz") {
      // /healthz is process liveness for uptime monitors and should stay 200
      // during Discord's normal reconnect churn. /readyz is the stricter
      // Discord-gateway readiness probe for dashboards/automation.
      const ready = isDiscordGatewayReady(client);
      const liveness = pathname === "/healthz";
      res.writeHead(liveness || ready ? 200 : 503);
      res.end(JSON.stringify({
        ok: liveness ? true : ready,
        discord: ready ? "ready" : "disconnected",
        ws_status: client?.ws?.status ?? null,
        bot: client?.user?.tag || "connecting...",
        uptime: process.uptime(),
      }));
    } else if (pathname === "/health") {
      // NOTE: unauthenticated — never include identifying config here. This
      // response used to leak the owner's Discord ID in a `user` field.
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, bot: client.user?.tag || "connecting...", uptime: process.uptime() }));
    } else if (pathname.startsWith("/tts/")) {
      // Serve generated TTS audio files
      const id = (pathname.split("/tts/")[1] || "").replace(/\/$/, "");
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
    } else if (pathname.startsWith("/api/")) {
      // Restricted CORS — only allow same-origin and configured dashboard domains
      const apiOrigin = req.headers.origin;
      const selfUrl = process.env.EXTERNAL_URL || process.env.RENDER_EXTERNAL_URL;
      const allowedOrigins = [selfUrl, process.env.DASHBOARD_URL].filter(Boolean);
      if (apiOrigin && isOriginAllowed(apiOrigin, allowedOrigins)) {
        res.setHeader("Access-Control-Allow-Origin", apiOrigin);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      res.setHeader("Content-Type", "application/json");

      const db = await import("./database.js");
      const mem = await import("./ai/memory.js");
      const url = requestUrl;
      const path = pathname;
      const j = (code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); };

      // ── Rate limiting for API endpoints (per-IP, dashboard-safe).
      // Twin endpoints get a DEDICATED bucket — the shared dashboard bucket is
      // consumed by unauthenticated traffic before auth runs, so a public
      // /api/health flood could starve Eris's signed twin commands.
      const isTwinPath = path.startsWith("/api/twin/");
      const apiIP = getClientIp(req);
      const apiLimiter = isTwinPath ? _twinCommandLimiter : _dashboardLimiter;
      if (!apiLimiter.allow(apiIP)) { j(429, { error: "rate limited" }); return; }

      // ── Auth check — accept DASHBOARD_API_KEY.
      // Localhost bypass is disabled by default; explicitly opt in with
      // DASHBOARD_ALLOW_LOCALHOST_BYPASS=1 for trusted single-user machines.
      if (!isTwinPath && path !== "/api/health" && !isDashboardRequestAuthorized(req)) {
        j(401, { error: "unauthorized" });
        return;
      }

      // ── Health
      if (path === "/api/health") {
        j(200, { ok: true });

      // ── Stats
      } else if (path === "/api/stats") {
        const mood = db.getMood();
        const convData = db.getConversationsData();
        const totalMsgs = Object.values(convData).reduce((sum, h) => sum + h.length, 0);
        const uniqueUsers = new Set(Object.values(convData).flatMap(h => h.filter(m => m.role === "user").map(() => "user"))).size;
        j(200, { status: "online", uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), messages: totalMsgs, users: client.users?.cache.size || 0, commands: 0, servers: client.guilds?.cache.size || 0, mood_score: mood.mood_score, energy: mood.energy, mood_label: db.moodLabel(mood.mood_score), current_mood: db.moodLabel(mood.mood_score) });

      // ── Guild list for dashboard selectors
      } else if (path === "/api/guilds" && req.method === "GET") {
        const guilds = [...(client.guilds?.cache?.values?.() || [])]
          .map(summarizeGuild)
          .sort((a, b) => a.name.localeCompare(b.name));
        j(200, { rows: guilds, guilds });

      // ── Trusted users (guild-scoped admin bypass list)
      } else if (path === "/api/trusted-users" && req.method === "GET") {
        const guildId = normalizeDiscordId(url.searchParams.get("guild_id") || url.searchParams.get("guild"));
        if (guildId) {
          const guild = client.guilds?.cache?.get(guildId);
          if (!guild) { j(404, { error: "guild_not_found" }); return; }
          j(200, { guild: summarizeGuild(guild), rows: trustedRowsForGuild(guild, db) });
          return;
        }
        const rows = [...(client.guilds?.cache?.values?.() || [])]
          .map((guild) => ({ ...summarizeGuild(guild), trusted_users: trustedRowsForGuild(guild, db) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        j(200, { rows });

      } else if (path === "/api/trusted-users" && (req.method === "POST" || req.method === "PATCH")) {
        const parsed = await readJsonBody(req);
        if (parsed.tooLarge) { j(413, { error: "payload too large" }); return; }
        const body = parsed.body || {};
        const guildId = normalizeDiscordId(body.guild_id || body.guildId || body.guild);
        const userInput = cleanDashboardText(body.user_id || body.userId || body.user || body.username);
        if (!guildId || !userInput) { j(400, { error: "guild_id and user_id required" }); return; }
        const guild = client.guilds?.cache?.get(guildId);
        if (!guild) { j(404, { error: "guild_not_found" }); return; }
        const member = await resolveGuildMember(guild, userInput);
        if (!member) { j(404, { error: "user_not_found_or_ambiguous" }); return; }
        db.addTrustedUser(guild.id, member.id);
        j(200, { ok: true, guild: summarizeGuild(guild), user: summarizeMember(member, member.id), rows: trustedRowsForGuild(guild, db) });

      } else if (path === "/api/trusted-users" && req.method === "DELETE") {
        const guildId = normalizeDiscordId(url.searchParams.get("guild_id") || url.searchParams.get("guild"));
        const userId = normalizeDiscordId(url.searchParams.get("user_id") || url.searchParams.get("user"));
        if (!guildId || !userId) { j(400, { error: "guild_id and user_id required" }); return; }
        const guild = client.guilds?.cache?.get(guildId);
        if (!guild) { j(404, { error: "guild_not_found" }); return; }
        db.removeTrustedUser(guild.id, userId);
        j(200, { ok: true, guild: summarizeGuild(guild), rows: trustedRowsForGuild(guild, db) });

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
        const rels = /** @type {any[]} */ (db.getAllRelationships())
          .filter((r) => normalizeDiscordId(r?.user_id || r?.id))
          .map((r) => ({ ...r, user_id: normalizeDiscordId(r.user_id || r.id) }));
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
          // Extract user ID and username from message content. Newer stored
          // turns use "[name said]" wrappers; older turns used explicit ID
          // prefixes or the untrusted-input envelope.
          let userId = null, username = null;
          for (const m of [...userMsgs].reverse()) {
            const text = typeof m.content === "string" ? m.content : m.content?.[0]?.text || "";
            const idMatch = text.match(/\[User ID: (\d+)\]\s*(\S+)/);
            if (idMatch) { userId = idMatch[1]; username = idMatch[2]; break; }
            const storedName = extractStoredMessageUsername(text);
            if (storedName) { username = storedName; break; }
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
          lastText = cleanStoredMessageContent(lastText).substring(0, 100);
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
          const storedName = extractStoredMessageUsername(text);
          const uname = msg.role === "assistant" ? "Irene" : (storedName || umMatch?.[1] || userMatch?.[1] || "User");
          const cleanText = cleanStoredMessageContent(text);
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
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10)));
        const allMem = mem.getMemoryData();
        const facts = [];
        const usernameFor = (uid) => {
          const id = normalizeDiscordId(uid);
          const user = id ? client.users?.cache.get(id) : null;
          return user?.username || (id ? `User ${id}` : cleanDashboardText(uid) || "Unknown user");
        };
        const toIso = (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
          const d = new Date(value || Date.now());
          return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
        };
        for (const [guildId, users] of Object.entries(allMem)) {
          for (const [uid, memories] of Object.entries(users)) {
            if (userId && uid !== userId) continue;
            for (const m of Array.isArray(memories) ? memories : []) {
              const obj = m && typeof m === "object" ? m : {};
              const factText = typeof m === "string" ? m : obj.fact || obj.text || JSON.stringify(m);
              facts.push({
                id: facts.length,
                user_id: uid,
                username: usernameFor(uid),
                fact_text: factText,
                sensitivity: obj.sensitivity || obj.importance || "normal",
                created_at: obj.created_at || obj.timestamp || obj.addedAt || new Date().toISOString(),
                source: "fact",
                deletable: true,
              });
            }
          }
        }

        try {
          const longMemory = await import("./ai/longmemory.js");
          for (const [uid, episodes] of longMemory.getEpisodes?.() || []) {
            if (userId && uid !== userId) continue;
            for (const [idx, episode] of (episodes || []).entries()) {
              facts.push({
                id: `episode:${uid}:${idx}`,
                user_id: uid,
                username: usernameFor(uid),
                fact_text: episode.content || JSON.stringify(episode),
                sensitivity: episode.type || "episode",
                created_at: toIso(episode.at || episode.lastUsed),
                source: "episode",
                deletable: false,
              });
            }
          }
          if (!userId) {
            for (const [channelId, episodes] of longMemory.getChannelEpisodes?.() || []) {
              for (const [idx, episode] of (episodes || []).entries()) {
                const uid = normalizeDiscordId(episode.userId);
                facts.push({
                  id: `channel_episode:${channelId}:${idx}`,
                  user_id: uid || `channel:${channelId}`,
                  username: uid ? usernameFor(uid) : `Channel ${String(channelId).slice(0, 8)}`,
                  fact_text: episode.content || JSON.stringify(episode),
                  sensitivity: episode.type || "channel_episode",
                  created_at: toIso(episode.at || episode.lastUsed),
                  source: "channel_episode",
                  deletable: false,
                });
              }
            }
            for (const [idx, thought] of (longMemory.getMonologue?.() || []).entries()) {
              facts.push({
                id: `thought:${idx}`,
                user_id: "irene",
                username: "Irene",
                fact_text: thought.thought || JSON.stringify(thought),
                sensitivity: "inner_thought",
                created_at: toIso(thought.at),
                source: "monologue",
                deletable: false,
              });
            }
          }
        } catch (e) {
          log(`[Dashboard] Long-memory export failed: ${e.message}`);
        }

        facts.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const limitedFacts = facts.slice(0, limit);
        if (userId) {
          j(200, { facts: limitedFacts, user_id: userId });
        } else {
          j(200, { facts: limitedFacts });
        }

      // ── Personality (read from Supabase if available, write via PUT/PATCH)
      } else if (path === "/api/personality" && req.method === "GET") {
        const custom = await db.getPersonality();
        j(200, { personality: custom || config.botPersonality });
      } else if (path === "/api/personality" && (req.method === "PUT" || req.method === "PATCH")) {
        let personalityTooLarge = false;
        const body = await new Promise(resolve => {
          let d = "";
          req.on("data", c => {
            d += c;
            // Cap accumulation at ~1MB — a personality instructions payload is
            // never this big, so anything past it is a memory-exhaustion
            // attempt. Destroy the socket (mirrors the 10KB twin-command cap).
            if (d.length > 1_048_576) { personalityTooLarge = true; req.destroy(); resolve(null); }
          });
          req.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        if (personalityTooLarge) { j(413, { error: "payload too large" }); return; }
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
      // Rate-limited per-IP because a valid token can otherwise be replayed
      // or hammered to scrape mood state at arbitrary resolution. The bearer
      // is one shared secret, so IP is the only identity signal we have.
      } else if (path === "/api/twin/state" && req.method === "GET") {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace("Bearer ", "");
        if (!token || !safeStringEqual(token, config.twinApiSecret)) {
          return j(403, { error: "twin state requires Bearer TWIN_API_SECRET" });
        }
        const ipKey = getClientIp(req);
        if (!_twinStateLimiter.allow(ipKey)) {
          res.setHeader("Retry-After", "60");
          return j(429, { error: "twin state rate limit (10/min)" });
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

            let parsedBody;
            try {
              parsedBody = JSON.parse(body);
            } catch {
              return j(400, { success: false, error: "invalid JSON" });
            }
            const { requester_id, guild_id, channel_id, command, args } = parsedBody;

            // 2. Verify requester is owner or trusted. Guard against an unset
            // ownerId (DISCORD_USER_ID absent → config.ownerId === ""): a body
            // with requester_id "" must NOT satisfy the owner check (fail
            // closed, mirrors antinuke.js's `config?.ownerId &&` guard).
            const isOwner = Boolean(config.ownerId) && requester_id === config.ownerId;
            const trustedList = db.getTrustedUsers(guild_id);
            const isTrusted = Array.isArray(trustedList) && trustedList.includes(requester_id);
            if (!isOwner && !isTrusted) {
              return j(403, { success: false, error: "requester not authorized (must be owner or trusted)" });
            }

            // 3. Resolve Eris's command to Irene's real tool name and enforce a
            // SERVER-SIDE allowlist of the relay vocabulary (defense in depth).
            // Eris verifies permissions on her side, but trusting only that
            // meant a compromised or buggy Eris could drive any of Irene's 150+
            // tools with a valid HMAC. resolveTwinCommand returns null for
            // anything outside the moderation/channel/role/setup relay set.
            const resolvedCommand = resolveTwinCommand(command);
            if (!resolvedCommand) {
              log(`[Twin] Rejected command outside relay allowlist: ${command}`);
              return j(403, { success: false, error: "command not permitted via twin relay" });
            }

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
            // Build the synthetic message context with the REAL requester's
            // identity. Hardcoding "twin-relay" used to leak into audit logs,
            // moderation reasons, and embed footers — making it look like a
            // user named "twin-relay" had taken the action.
            const requesterUsername = requesterMember?.user?.username || "user";
            const requesterDisplayName = requesterMember?.displayName || requesterMember?.nickname || requesterUsername;
            const fakeMessage = {
              guild, channel, client,
              author: { id: requester_id, username: requesterUsername, displayName: requesterDisplayName },
              member: requesterMember,
              reply: async (content) => channel.send(typeof content === "string" ? content : content.content).catch(() => {}),
            };

            // 6. Command already resolved to Irene's real tool name and
            // allowlist-checked in step 3 (resolveTwinCommand) — see the
            // module-level TWIN_ALIASES / TWIN_COMMAND_ALLOWLIST.

            // 7. Execute the tool directly. aiInitiated:true engages
            // moderationExecutor's destructive-action confirm gate — a relayed
            // ban/kick/purge is AI-initiated on Eris's side, so it must defer
            // to the same human Confirm button instead of firing immediately.
            const { executeTool, postDeferralIfNeeded } = await import("./ai/executor.js");
            const rawResult = await executeTool(resolvedCommand, args || {}, fakeMessage, { aiInitiated: true });
            // A deferred destructive action comes back as a confirm-prompt
            // OBJECT, not a string — post the Confirm/Cancel buttons into the
            // resolved channel (same render bridge the AI tool loop uses) and
            // report the pending notice back to Eris instead.
            const result = await postDeferralIfNeeded(rawResult, channel);
            log(`[Twin] Executed ${command}${resolvedCommand !== command ? ` (→ ${resolvedCommand})` : ""}: ${String(result).slice(0, 100)}`);

            // 8. Push a synthetic history note so Irene's next AI turn in this
            // channel knows the twin action happened. Without it she'll claim
            // "i can't do that" right after she just did, because the twin
            // path executes a tool without ever touching messageCreate's
            // conversation tracking.
            //
            // Push as `assistant` (was `user`) — pushing as user caused the
            // next human message to be misattributed: Gemini saw the twin
            // note as if the latest human said it, so the bot would try to
            // address the action's content to that user.
            try {
              const channelKey = `ch-${channel_id}`;
              const argsStr = args && Object.keys(args).length
                ? ` ${JSON.stringify(args).slice(0, 150)}`
                : "";
              const note = `[Irene said] (twin action — eris asked) ${command}${argsStr} — done: ${String(result).slice(0, 200)}`;
              const { getConversations } = await import("./events/messageCreate.js");
              const convMap = getConversations();
              const history = convMap.get(channelKey) || [];
              history.push({ role: "assistant", content: note });
              if (history.length > 30) history.splice(0, history.length - 30);
              convMap.set(channelKey, history);
              db.saveConversation(channelKey, history);
            } catch (twinHistoryErr) {
              log(`[Twin] Could not inject history note: ${twinHistoryErr.message}`);
            }

            return j(200, { success: true, result: String(result).substring(0, 500) });
          } catch (e) {
            let commandForLog = "(unparsed)";
            try { commandForLog = JSON.parse(body)?.command || commandForLog; } catch {}
            log(`[Twin] Command error for "${commandForLog}": ${e.message}`);
            j(500, { success: false, error: "internal server error" }); // Never expose internals
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

  // ─── Slowloris / slow-body hardening ───
  // The /tts and /presence endpoints take genuine but tiny request bodies and
  // respond fast; nothing legitimate dribbles bytes for seconds. Cap the full
  // request, the header phase, idle keep-alive, and per-socket inactivity so a
  // client can't pin sockets open by sending data one byte at a time. Tuned
  // well above real twin/presence latency (sub-second).
  server.requestTimeout = 15000;   // 15s for the full request (headers + body)
  server.headersTimeout = 10000;   // 10s to finish sending headers
  server.keepAliveTimeout = 5000;  // 5s idle before closing keep-alive sockets
  server.setTimeout(20000);        // per-socket inactivity timeout

  // A bind failure (e.g. EADDRINUSE from a stale instance) must not crash-loop
  // the bot — uncaughtException now fail-fast exits(1), so handle it locally:
  // log and keep running (Discord/music/core still work; only the presence/
  // dashboard HTTP surface is down until the port frees and the process restarts).
  server.on("error", (/** @type {NodeJS.ErrnoException} */ e) => {
    if (e.code === "EADDRINUSE") {
      log(`⚠ Presence API port ${config.port} already in use — a stale instance may still be bound. Continuing WITHOUT the HTTP server (presence/health/tts/dashboard/twin unavailable). Free the port and restart to restore them.`);
    } else {
      log(`⚠ Presence API server error: ${e.message}`);
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
