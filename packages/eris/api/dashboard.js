import * as db from "../database.js";
import config from "../config.js";
import { log } from "../utils/logger.js";
import { verifyTwinRequest, safeStringEqual } from "@defnotean/shared/twinSign";
import { createRateLimiter } from "@defnotean/shared/rateLimit";
import { getClientIp } from "@defnotean/shared/getClientIp";

// Per-source rate limit for /api/twin/state. The endpoint is Bearer-gated, so
// "identity" reduces to source IP — anyone holding TWIN_API_SECRET can read
// mood/preoccupation snapshots, and without this a valid token could be
// replayed in a tight loop (or simply hammered) to scrape state at arbitrary
// resolution. 10/min/IP is well above any healthy poll cadence; legit twin
// awareness sync runs on much longer intervals.
const _twinStateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 128, globalLimit: 60 });
const _dashboardLimiter = createRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 500, globalLimit: 600 });

function moodLabel(score) {
  if (score >= 60) return "ecstatic";
  if (score >= 30) return "happy";
  if (score >= 10) return "chill";
  if (score >= -10) return "neutral";
  if (score >= -30) return "annoyed";
  if (score >= -60) return "pissed";
  return "furious";
}

// Parse an origin/URL string into its canonical "scheme://host:port" form. A
// prior version used `origin.startsWith(allowed)`, which let attackers register
// `evil.com.attacker.com` and match an allowlist entry of `https://evil.com`.
// Returning `null` for unparseable input means the caller treats it as a miss.
function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const u = new URL(value);
    // URL.origin already collapses default ports to the empty string, so
    // "https://x" and "https://x:443" compare equal — exactly what we want.
    return u.origin;
  } catch {
    return null;
  }
}

// Exact-origin allowlist check. Both sides are normalized through the URL
// parser so that a request from `https://evil.com.attacker.com` can never
// satisfy an allowlist entry of `https://evil.com`, regardless of trailing
// slashes or whitespace in the configured value.
export function isOriginAllowed(origin, allowedOrigins) {
  const reqOrigin = normalizeOrigin(origin);
  if (!reqOrigin) return false;
  for (const allowed of allowedOrigins) {
    const allowedOrigin = normalizeOrigin(allowed);
    if (allowedOrigin && allowedOrigin === reqOrigin) return true;
  }
  return false;
}

export async function handleApiRequest(req, res) {
  // CORS — only allow same-origin and configured dashboard domains
  const allowedOrigins = [process.env.EXTERNAL_URL, process.env.RENDER_EXTERNAL_URL, config.twinApiUrl, process.env.DASHBOARD_URL].filter(Boolean);
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // No wildcard CORS — if origin doesn't match, no CORS header is set (browser blocks it)
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  res.setHeader("Content-Type", "application/json");

  // ── Rate limiting (per-IP, 30 req/min) ──────────────────────────────────
  // Use getClientIp (X-Forwarded-For aware): behind Render's proxy every
  // request shares one socket peer, so keying on remoteAddress would collapse
  // all visitors into a single bucket.
  const clientIP = getClientIp(req);
  if (!_dashboardLimiter.allow(clientIP)) {
    json(res, 429, { error: "rate limited" }); return;
  }

  const url0 = new URL(req.url, `http://localhost:${config.port}`);
  const isTwinPath = url0.pathname.startsWith("/api/twin/");

  // Twin API — require TWIN_API_SECRET (same as Irene)
  if (isTwinPath) {
    // Body parsing for POST twin requests
    if (req.method === "POST") {
      // Secret is validated inside the individual twin handlers below
      // Just let it through to the path matching
    } else {
      // GET twin endpoints (mood, status) — no secret needed, limited data
    }
  } else {
    // Dashboard API — accept DASHBOARD_API_KEY or TWIN_API_SECRET. Using a
    // truncated Discord bot token as a fallback API key was a credential-
    // reuse footgun: if the token leaked anywhere (logs, git, a compromised
    // dep), the first 20 chars would double as a dashboard credential.
    // Removed — callers must use an explicit API key env var.
    //
    // Localhost bypass: requests from 127.0.0.1 / ::1 skip the token check.
    // The admin panel is served from the same process at /admin, so any
    // browser tab on this machine (or an SSH-tunneled session) is trusted.
    // Anyone with shell access to this user already owns the bots.
    const remote = req.socket?.remoteAddress || "";
    const isLocalhost = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLocalhost) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");
      const validKeys = [process.env.DASHBOARD_API_KEY, process.env.TWIN_API_SECRET].filter(Boolean);
      // Constant-time compare via safeStringEqual (crypto.timingSafeEqual over
      // length-equalized buffers). Array.includes uses === under the hood, which
      // short-circuits on the first mismatched byte and leaks the secret one byte
      // at a time through response-time deltas.
      const tokenOk = !!token && validKeys.some((k) => safeStringEqual(token, k));
      if (!tokenOk) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
    }
  }

  try {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const path = url.pathname;

    let body = null;
    let rawBody = "";
    let bodyTooLarge = false;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const parsed = await new Promise(resolve => {
        let d = "";
        req.on("data", c => {
          d += c;
          // Cap accumulation at ~1MB — a dashboard JSON payload is never this
          // big, so anything past it is a memory-exhaustion attempt. Destroy
          // the socket (mirrors the 10KB twin-command cap in presence.js).
          if (d.length > 1_048_576) {
            bodyTooLarge = true;
            req.destroy();
            resolve(null);
          }
        });
        req.on("end", () => {
          rawBody = d;
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      });
      body = parsed;
    }
    if (bodyTooLarge) {
      json(res, 413, { error: "payload too large" });
      return;
    }

    if (path === "/api/health") {
      json(res, 200, { status: "online", uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), db_connected: !!db.getSupabase() });
      return;
    }

    if (path === "/api/stats") {
      const stats = await db.getDashboardStats();
      const mood = db.getMood();
      json(res, 200, { status: "online", uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), ...stats, mood_score: mood.mood_score, energy: mood.energy, mood_label: moodLabel(mood.mood_score), current_mood: moodLabel(mood.mood_score) });
      return;
    }

    if (path === "/api/mood" && req.method === "GET") {
      const mood = db.getMood();
      const ml = moodLabel(mood.mood_score);
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

      json(res, 200, { mood_score: s, energy: e, mood_label: ml, current_mood: ml, stability: 100 - Math.abs(s), mood_summary: moodSummary, energy_summary: energySummary, summary: `${moodSummary}. ${energySummary}` });
      return;
    }

    if (path === "/api/mood" && req.method === "PATCH") {
      if (body?.mood_score !== undefined) db.updateMood(body.mood_score, body.energy ?? 50);
      json(res, 200, db.getMood());
      return;
    }

    if (path === "/api/relationships" && req.method === "PATCH") {
      if (!body?.user_id) { json(res, 400, { error: "user_id required" }); return; }
      if (body.affinity_score !== undefined) {
        const current = db.getRelationship(body.user_id);
        const delta = body.affinity_score - current.affinity_score;
        db.updateRelationship(body.user_id, delta);
      }
      json(res, 200, db.getRelationship(body.user_id));
      return;
    }

    if ((path === "/api/memories" || path === "/api/memory") && req.method === "GET") {
      const userId = url.searchParams.get("user_id");
      const supabase = db.getSupabase();
      if (userId) {
        const facts = await db.getFacts(userId, 50);
        json(res, 200, { facts, user_id: userId });
      } else if (supabase) {
        // Return all users' facts grouped by user for the memory browser
        const { data: rows } = await supabase.from("eris_facts").select("id, user_id, fact_text, sensitivity, created_at").order("created_at", { ascending: false }).limit(200);
        // Also resolve usernames from eris_memories
        const userIds = [...new Set((rows || []).map(r => r.user_id))];
        const usernames = {};
        for (const uid of userIds) {
          const { data: row } = await supabase.from("eris_memories").select("username").eq("user_id", uid).eq("is_bot", false).limit(1).single();
          usernames[uid] = row?.username || `User ${uid}`;
        }
        const facts = (rows || []).map(r => ({ ...r, username: usernames[r.user_id] || `User ${r.user_id}` }));
        json(res, 200, { facts });
      } else {
        json(res, 200, { facts: [] });
      }
      return;
    }

    if ((path.startsWith("/api/memory/") || path.startsWith("/api/memories/")) && req.method === "DELETE") {
      const factId = path.split("/").pop();
      const userId = url.searchParams.get("user_id") || config.ownerId;
      const ok = await db.deleteFact(userId, parseInt(factId));
      json(res, 200, { success: ok });
      return;
    }

    if (path === "/api/conversations" && req.method === "GET") {
      const channelId = url.searchParams.get("channel_id");
      if (channelId) {
        const history = await db.getRecentHistory(channelId, 50);
        json(res, 200, { messages: history });
        return;
      }
      const supabase = db.getSupabase();
      if (supabase) {
        const { data: rows } = await supabase.from("eris_memories").select("id, channel_id, user_id, username, content, is_bot, created_at").order("created_at", { ascending: false }).limit(300);
        // Group by human user_id only — skip bot messages as separate entries
        // Bot replies will show up when you click into a conversation (same channel)
        const byUser = {};
        for (const msg of (rows || [])) {
          if (msg.is_bot) continue; // Don't create separate entries for bot replies
          const key = msg.user_id;
          if (!byUser[key]) byUser[key] = { id: key, username: msg.username || "Unknown", user_id: msg.user_id, channel_ids: [], last_message: msg.content, last_at: msg.created_at, count: 0 };
          if (!byUser[key].channel_ids.includes(msg.channel_id)) byUser[key].channel_ids.push(msg.channel_id);
          byUser[key].count++;
        }
        json(res, 200, { conversations: Object.values(byUser) });
      } else {
        json(res, 200, { conversations: [] });
      }
      return;
    }

    // GET /api/conversations/:id — fetch messages by user_id, channel_id, or username
    if (path.startsWith("/api/conversations/") && req.method === "GET") {
      const id = decodeURIComponent(path.replace("/api/conversations/", ""));
      if (id) {
        const supabase = db.getSupabase();
        if (supabase) {
          // Find which channels this user has talked in
          const { data: userMsgs } = await supabase.from("eris_memories").select("channel_id").eq("user_id", id).eq("is_bot", false);
          const channelIds = [...new Set((userMsgs || []).map(m => m.channel_id))];

          let msgs = [];
          if (channelIds.length) {
            // Load most recent messages (user + bot replies) from those channels, then reverse for chronological display
            const { data: allMsgs } = await supabase.from("eris_memories").select("*").in("channel_id", channelIds).order("created_at", { ascending: false }).limit(100);
            msgs = (allMsgs || []).reverse();
          } else {
            // Fallback: try as channel_id directly
            const { data: chanMsgs } = await supabase.from("eris_memories").select("*").eq("channel_id", id).order("created_at", { ascending: false }).limit(100);
            msgs = (chanMsgs || []).reverse();
          }
          json(res, 200, { messages: msgs });
        } else {
          json(res, 200, { messages: [] });
        }
        return;
      }
    }

    // DELETE /api/conversations/:id — delete all messages for a user
    if (path.startsWith("/api/conversations/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.replace("/api/conversations/", ""));
      const supabase = db.getSupabase();
      if (supabase && id) {
        // Delete by user_id first
        const { error: e1 } = await supabase.from("eris_memories").delete().eq("user_id", id);
        // Also delete by channel_id in case the id is a channel
        const { error: e2 } = await supabase.from("eris_memories").delete().eq("channel_id", id);
        // Also try by username
        const { error: e3 } = await supabase.from("eris_memories").delete().eq("username", id);
        const success = !e1 || !e2 || !e3;
        json(res, 200, { success, deleted: id });
      } else {
        json(res, 400, { error: "invalid id" });
      }
      return;
    }

    // DELETE /api/messages/:id — delete a single message
    if (path.startsWith("/api/messages/") && req.method === "DELETE") {
      const msgId = path.replace("/api/messages/", "");
      const supabase = db.getSupabase();
      if (supabase && msgId) {
        await supabase.from("eris_memories").delete().eq("id", parseInt(msgId));
        json(res, 200, { success: true });
      } else {
        json(res, 400, { error: "invalid id" });
      }
      return;
    }

    // ─── INTER-BOT API (Irene ↔ Eris twin communication) ───
    // Legacy body.secret gate for twin POSTs. HMAC-signed requests skip this
    // and are verified downstream in their specific handler — without the
    // skip, HMAC-only callers (which carry no body.secret) get 403'd here
    // before their specific handler ever runs.
    if (path.startsWith("/api/twin/") && req.method === "POST") {
      const hasHmacHeaders = !!(req.headers["x-twin-timestamp"] && req.headers["x-twin-signature"]);
      if (!hasHmacHeaders) {
        const twinSecret = process.env.TWIN_API_SECRET;
        if (twinSecret && !safeStringEqual(body?.secret, twinSecret)) {
          json(res, 403, { error: "invalid twin secret" }); return;
        }
      }
    }

    if (path === "/api/twin/remind" && req.method === "POST") {
      if (!body?.user_id || !body?.reminder_text || !body?.remind_at) {
        json(res, 400, { error: "user_id, reminder_text, remind_at required" }); return;
      }
      const ok = await db.saveReminder(body.user_id, body.channel_id || "", body.reminder_text, body.remind_at);
      json(res, ok ? 201 : 500, { success: ok, from: "eris", message: "reminder set by your twin sister irene" });
      return;
    }

    if (path === "/api/twin/note" && req.method === "POST") {
      if (!body?.user_id || !body?.title || !body?.content) {
        json(res, 400, { error: "user_id, title, content required" }); return;
      }
      const ok = await db.saveNote(body.user_id, body.title, body.content);
      json(res, ok ? 201 : 500, { success: ok, from: "eris" });
      return;
    }

    if (path === "/api/twin/fact" && req.method === "POST") {
      if (!body?.user_id || !body?.fact) {
        json(res, 400, { error: "user_id, fact required" }); return;
      }
      const ok = await db.saveFact(body.user_id, body.fact);
      json(res, ok ? 201 : 500, { success: ok, from: "eris" });
      return;
    }

    if (path === "/api/twin/mood" && req.method === "GET") {
      const mood = db.getMood();
      json(res, 200, { mood_score: mood.mood_score, energy: mood.energy, from: "eris" });
      return;
    }

    // ── Cross-bot: Irene notifies Eris of a ban/kick so Eris can apply
    // economy consequences (e.g. zero the user's balance if the guild has
    // opted in via the `cross_bot_punish` setting).
    //
    // Authenticated with HMAC (X-Twin-Timestamp + X-Twin-Signature). The
    // legacy `body.secret` fallback was removed — every caller (Irene,
    // dashboard, scripts) must sign the request through shared/twinSign.
    if (path === "/api/twin/punish" && req.method === "POST") {
      const twinSecret = process.env.TWIN_API_SECRET;
      if (!twinSecret) { json(res, 500, { error: "twin secret not configured on server" }); return; }

      // HMAC-only. A request without signed headers is rejected outright;
      // body.secret used to be accepted as a fallback but the wire-leak
      // and lack of replay protection made it not worth the back-compat.
      const hasHmacHeaders = !!(req.headers["x-twin-timestamp"] && req.headers["x-twin-signature"]);
      if (!hasHmacHeaders) {
        json(res, 401, { error: "twin auth required (missing HMAC headers)" });
        return;
      }
      const v = verifyTwinRequest(req.headers, rawBody, twinSecret);
      if (!v.ok) { json(res, 401, { error: `twin auth: ${v.reason}` }); return; }

      // Schema validation — reject malformed inputs BEFORE touching balances.
      if (!body?.user_id || typeof body.user_id !== "string" || !/^\d{5,20}$/.test(body.user_id)) {
        json(res, 400, { error: "invalid user_id" }); return;
      }
      if (!body?.guild_id || typeof body.guild_id !== "string" || !/^\d{5,20}$/.test(body.guild_id)) {
        json(res, 400, { error: "invalid guild_id" }); return;
      }
      if (!body?.action || typeof body.action !== "string") {
        json(res, 400, { error: "action required" }); return;
      }

      try {
        const gs = db.getGuildSettings(body.guild_id);
        if (!gs?.cross_bot_punish) {
          json(res, 200, { applied: false, reason: "guild has not opted in" });
          return;
        }
        // ── Punish action vocabulary ────────────────────────────────────
        // Irene can send any of these; Eris treats them all as "the user got
        // moderated, apply economy consequences." We don't distinguish ban
        // vs tempban vs timeout for confiscation purposes — any of them
        // counts as a punish event. New sub-types (mute, etc.) should be
        // added here so Irene's caller doesn't silently no-op.
        //
        // Irene's recommended vocabulary (see moderationExecutor.js):
        //   ban     — permanent ban (also sent for tempban — sub-type
        //             distinction isn't economically meaningful)
        //   kick    — kick from server
        //   tempban — temporary ban (currently re-mapped to "ban" on Irene's
        //             side, but accepted here for forward-compat / older
        //             Irene builds)
        //   timeout — Discord timeout / mute
        const action = String(body.action);
        if (!["ban", "kick", "tempban", "timeout"].includes(action)) {
          json(res, 200, { applied: false, reason: "action not punishable" });
          return;
        }
        const before = await db.getBalance(body.user_id);
        const confiscated = Number.isFinite(before?.balance) && before.balance > 0 ? Math.floor(before.balance) : 0;
        if (confiscated > 0) {
          try {
            // Standard locking updateBalance — no outer user lock held.
            await db.updateBalance(body.user_id, -confiscated, `irene_${action}`, (body.reason || "cross-bot punishment").slice(0, 200));
          } catch (err) {
            log(`[Twin] punish updateBalance failed for ${body.user_id}: ${err.message}`);
            json(res, 500, { error: "confiscation failed", message: err.message });
            return;
          }
        }
        json(res, 200, {
          applied: true,
          action,
          user_id: body.user_id,
          confiscated,
          reason: body.reason || null,
          from: "eris",
        });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    if (path === "/api/twin/status" && req.method === "GET") {
      json(res, 200, { status: "online", uptime: Math.round(process.uptime()), from: "eris", message: "hey sis im here" });
      return;
    }

    // Read-only state snapshot for cross-bot awareness. Gated by a Bearer
    // token carrying the shared TWIN_API_SECRET — no HMAC needed for a
    // side-effect-free endpoint, and it plays nicely with the already-parsed
    // request body elsewhere in this handler. Rate-limited per-IP because a
    // valid token can otherwise be replayed or hammered to scrape mood state
    // at arbitrary resolution. The bearer is one shared secret, so IP is the
    // only identity signal we have.
    if (path === "/api/twin/state" && req.method === "GET") {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");
      if (!token || !safeStringEqual(token, config.twinApiSecret)) {
        json(res, 403, { error: "twin state requires Bearer TWIN_API_SECRET" });
        return;
      }
      const ipKey = getClientIp(req);
      if (!_twinStateLimiter.allow(ipKey)) {
        res.setHeader("Retry-After", "60");
        json(res, 429, { error: "twin state rate limit (10/min)" });
        return;
      }
      try {
        const mood = db.getMood?.() || {};
        let preoccupation = null;
        try {
          const preoc = await import("../ai/preoccupations.js");
          preoccupation = preoc.getCurrentPreoccupation?.() || null;
        } catch {}

        json(res, 200, {
          bot: config.botName || "eris",
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
        json(res, 500, { error: "internal" });
      }
      return;
    }

    if (path === "/api/personality" && req.method === "GET") {
      const custom = await db.getPersonality();
      json(res, 200, { personality: custom || config.botPersonality });
      return;
    }
    if (path === "/api/personality" && (req.method === "PUT" || req.method === "PATCH")) {
      if (!body?.instructions) { json(res, 400, { error: "instructions required" }); return; }
      json(res, 200, { success: await db.updatePersonality(body.instructions) });
      return;
    }

    if (path === "/api/analytics") {
      const days = parseInt(url.searchParams.get("days") || "7");
      const data = await db.getAnalytics(days);
      const byTool = {};
      for (const e of data) byTool[e.tool_name] = (byTool[e.tool_name] || 0) + 1;
      json(res, 200, { total: data.length, by_tool: byTool, raw: data.slice(0, 100) });
      return;
    }

    if (path === "/api/relationships") {
      const rels = await db.getAllRelationships();
      const supabase = db.getSupabase();
      if (supabase && rels.length) {
        for (const r of rels) {
          const { data: row } = await supabase.from("eris_memories").select("username").eq("user_id", r.user_id).eq("is_bot", false).limit(1).single();
          r.username = row?.username || `User ${r.user_id}`;
        }
      }
      // Add human-readable summaries
      for (const r of rels) {
        const a = r.affinity_score;
        const i = r.interactions_count;

        // Feeling summary based on affinity
        if (a >= 80) r.feeling = "absolutely adores this person — would do anything for them";
        else if (a >= 50) r.feeling = "really likes this person — warm, trusting, comfortable";
        else if (a >= 25) r.feeling = "getting along well — friendly and positive vibes";
        else if (a >= 10) r.feeling = "thinks they're pretty cool — casual friendliness";
        else if (a >= 0) r.feeling = "neutral — no strong feelings either way";
        else if (a >= -15) r.feeling = "slightly annoyed — something rubbed them the wrong way";
        else if (a >= -30) r.feeling = "not a fan — actively avoids being nice to them";
        else if (a >= -60) r.feeling = "genuinely dislikes this person — cold and dismissive";
        else r.feeling = "can't stand them — maximum hostility";

        // Familiarity based on interaction count
        if (i >= 100) r.familiarity = "deeply familiar — long history together";
        else if (i >= 50) r.familiarity = "well known — talks to them regularly";
        else if (i >= 20) r.familiarity = "getting to know them — had several conversations";
        else if (i >= 5) r.familiarity = "somewhat familiar — chatted a few times";
        else r.familiarity = "barely knows them — just met";

        // One-line summary (the only field the dashboard should show)
        r.summary = `${r.feeling}. ${r.familiarity}`;
        // Remove redundant fields so dashboard doesn't double-display
        delete r.feeling;
        delete r.familiarity;
      }
      json(res, 200, { relationships: rels });
      return;
    }
    if (path === "/api/notes" && req.method === "GET") { json(res, 200, { notes: await db.getNotes(url.searchParams.get("user_id") || config.ownerId, 50) }); return; }
    if (path === "/api/notes" && req.method === "POST") {
      if (!body?.title || !body?.content) { json(res, 400, { error: "title and content required" }); return; }
      json(res, 201, { success: await db.saveNote(body.user_id || config.ownerId, body.title, body.content) });
      return;
    }
    if (path === "/api/reminders" && req.method === "GET") { json(res, 200, { reminders: await db.getUserReminders(url.searchParams.get("user_id") || config.ownerId) }); return; }
    if (path === "/api/reminders" && req.method === "POST") {
      if (!body?.reminder_text || !body?.remind_at) { json(res, 400, { error: "reminder_text and remind_at required" }); return; }
      json(res, 201, { success: await db.saveReminder(body.user_id || config.ownerId, body.channel_id || "", body.reminder_text, body.remind_at) });
      return;
    }

    // ── Twin Dashboard Endpoints (monologue, humanity, episodes) ──────────
    if (path === "/api/monologue" && req.method === "GET") {
      const { getMonologue, getMoodNarrative } = await import("../ai/longmemory.js");
      json(res, 200, {
        thoughts: getMonologue(),
        mood_narrative: getMoodNarrative(),
      });
      return;
    }

    if (path === "/api/humanity" && req.method === "GET") {
      const { serialize } = await import("../ai/humanity.js");
      const data = serialize();
      json(res, 200, {
        relationships: data.relationships || {},
        inner_state: {
          energy: data.currentEnergy,
          is_bad_day: data.isBadDay,
          carried_mood: data.carriedMood,
          recent_thoughts: data.recentThoughts || [],
        },
      });
      return;
    }

    if (path === "/api/episodes" && req.method === "GET") {
      const { getEpisodes, getChannelEpisodes } = await import("../ai/longmemory.js");
      json(res, 200, {
        user_episodes: Object.fromEntries(getEpisodes?.() || []),
        channel_episodes: Object.fromEntries(getChannelEpisodes?.() || []),
      });
      return;
    }

    // ─── Economy / inventory / transactions ────────────────────────────────
    // All economy data lives in Supabase tables (eris_economy, eris_inventory,
    // eris_transactions, eris_bank). The admin panel reads via these endpoints;
    // mutations go through /api/economy/adjust so they leave an audit trail.
    const sb = db.getSupabase();

    if (path === "/api/economy/top" && req.method === "GET") {
      if (!sb) { json(res, 503, { error: "supabase_not_configured" }); return; }
      const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "25", 10));
      const { data, error } = await sb
        .from("eris_economy")
        .select("user_id, balance, daily_streak, total_earned, total_lost, total_gambled, prestige_level, updated_at")
        .order("balance", { ascending: false })
        .limit(limit);
      if (error) { json(res, 500, { error: error.message }); return; }
      const rows = data || [];
      // Resolve display names from eris_memories (the same per-user lookup
      // /api/relationships uses). Deliberately NOT a .in() batch: the local
      // PostgREST proxy doesn't reliably forward supabase-js's quoted in.(...)
      // lists, so a batch silently returns no names. Top-N is small (<=100).
      for (const r of rows) {
        if (!r.user_id) continue;
        const { data: m } = await sb
          .from("eris_memories")
          .select("username")
          .eq("user_id", r.user_id)
          .eq("is_bot", false)
          .limit(1)
          .maybeSingle();
        r.username = m?.username || null;
      }
      json(res, 200, { rows, limit });
      return;
    }

    if (path?.startsWith("/api/economy/user/") && req.method === "GET") {
      if (!sb) { json(res, 503, { error: "supabase_not_configured" }); return; }
      const uid = decodeURIComponent(path.replace("/api/economy/user/", ""));
      const [econ, bank, inv] = await Promise.all([
        sb.from("eris_economy").select("*").eq("user_id", uid).maybeSingle(),
        sb.from("eris_bank").select("*").eq("user_id", uid).maybeSingle(),
        sb.from("eris_inventory").select("*").eq("user_id", uid).order("acquired_at", { ascending: false }),
      ]);
      json(res, 200, {
        user_id: uid,
        economy: econ.data || null,
        bank: bank.data || null,
        inventory: inv.data || [],
      });
      return;
    }

    if (path === "/api/economy/adjust" && req.method === "POST") {
      if (!sb) { json(res, 503, { error: "supabase_not_configured" }); return; }
      if (!body?.user_id || typeof body?.delta !== "number") {
        json(res, 400, { error: "user_id and delta (number) required" }); return;
      }
      const reason = String(body.reason || "admin_adjust").slice(0, 64);
      // Best-effort: try the project's updateBalance helper first; fall back to
      // raw upsert so the admin panel still works if the helper signature drifts.
      try {
        if (typeof db.updateBalance === "function") {
          await db.updateBalance(body.user_id, body.delta, reason, `admin via /api`);
        } else {
          const { data: existing } = await sb.from("eris_economy").select("balance").eq("user_id", body.user_id).maybeSingle();
          const newBal = (existing?.balance ?? 0) + body.delta;
          await sb.from("eris_economy").upsert({ user_id: body.user_id, balance: newBal, updated_at: new Date().toISOString() });
        }
      } catch (e) { json(res, 500, { error: e.message }); return; }
      const { data: row } = await sb.from("eris_economy").select("user_id, balance").eq("user_id", body.user_id).maybeSingle();
      log(`[API] economy adjust: ${body.user_id} ${body.delta >= 0 ? "+" : ""}${body.delta} (${reason})`);
      json(res, 200, { ok: true, user_id: body.user_id, new_balance: row?.balance ?? null });
      return;
    }

    if (path === "/api/transactions" && req.method === "GET") {
      if (!sb) { json(res, 503, { error: "supabase_not_configured" }); return; }
      const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10));
      let q = sb.from("eris_transactions").select("*").order("created_at", { ascending: false }).limit(limit);
      const uid = url.searchParams.get("user_id");
      if (uid) q = q.eq("user_id", uid);
      const { data, error } = await q;
      if (error) { json(res, 500, { error: error.message }); return; }
      json(res, 200, { rows: data || [], limit });
      return;
    }

    if (path === "/api/inventory" && req.method === "GET") {
      if (!sb) { json(res, 503, { error: "supabase_not_configured" }); return; }
      const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "200", 10));
      let q = sb.from("eris_inventory").select("*").order("acquired_at", { ascending: false }).limit(limit);
      const uid = url.searchParams.get("user_id");
      if (uid) q = q.eq("user_id", uid);
      const { data, error } = await q;
      if (error) { json(res, 500, { error: error.message }); return; }
      json(res, 200, { rows: data || [], limit });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    log(`[API] ${req.url}: ${e.message}`);
    log(`[API] Error: ${e.message}`);
    json(res, 500, { error: "internal server error" }); // Never expose internals
  }
}

function json(res, status, data) { res.writeHead(status); res.end(JSON.stringify(data)); }
