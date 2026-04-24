// ─── Bump Reminder ──────────────────────────────────────────────────────────
// Watches for bump-service confirmation messages, then pings configured
// management + moderation roles after the service-specific cooldown.
//
// Supports multiple services (DISBOARD, Discadia, Disforge, DiscordServers)
// with per-service cooldowns. Each guild can enable/disable services
// independently via /bumpconfig service.
//
// The reminder itself is AI-generated in Eris's voice (seeded with time-of-day,
// streak, last bumper, mood), falling back to a canned template on failure.
// Quiet hours can suppress pings to a lighter form.
//
// Reliability:
//   - setTimeout timers restored on boot from guild settings
//   - If the bot was offline past the reminder time, a "back from offline"
//     note is prepended so it's honest
//   - No-show escalation: if nobody bumps within 15 minutes of the reminder,
//     a gentler nudge is sent once (configurable).

import { getGuildSettings, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";

// ─── Known bump services ────────────────────────────────────────────────────
// Cooldowns are in minutes. Add more here when Discord ecosystem shifts.

export const SERVICES = {
  disboard: {
    botId: "302050872383242240",
    cooldownMinutes: 120,
    // Substrings in the confirm message that signal a successful bump.
    confirmPhrases: ["bump done", "👍", "bumped"],
    name: "DISBOARD",
    slashCommand: "/bump",
    // Regex to extract bumper user mention from embed/message
    bumperMentionRx: /<@!?(\d{17,20})>/,
  },
  discadia: {
    botId: "1222663974588911719",
    cooldownMinutes: 180,
    confirmPhrases: ["successfully bumped", "bumped", "you've bumped"],
    name: "Discadia",
    slashCommand: "/bump",
    bumperMentionRx: /<@!?(\d{17,20})>/,
  },
  disforge: {
    botId: "1049350538136133702",
    cooldownMinutes: 180,
    confirmPhrases: ["successfully bumped", "bump successful"],
    name: "Disforge",
    slashCommand: "/bump",
    bumperMentionRx: /<@!?(\d{17,20})>/,
  },
  discordservers: {
    botId: "715635686252642334",
    cooldownMinutes: 360,
    confirmPhrases: ["bumped"],
    name: "DiscordServers.com",
    slashCommand: "/bump",
    bumperMentionRx: /<@!?(\d{17,20})>/,
  },
};

// Legacy export kept so imports from before the rewrite don't break.
export const DISBOARD_ID = SERVICES.disboard.botId;

// Per-guild cross-service escalation buffer. Key: `${guildId}:${serviceKey}`
// Values: { timer, channelId, scheduledAt, messageId, escalated, rank }
const _activeTimers = new Map();
const _activeEscalations = new Map(); // key → escalation timer

function keyFor(guildId, serviceKey) {
  return `${guildId}:${serviceKey}`;
}

// ─── Service detection ──────────────────────────────────────────────────────

/**
 * Given a Discord message, return the matching service key if this is a
 * bump confirmation from a supported service, or null otherwise. The match
 * is strict on bot ID AND content phrase so regular bot chatter doesn't
 * accidentally trigger a reminder.
 */
export function detectBumpService(message) {
  if (!message?.author?.bot) return null;
  const authorId = message.author.id;
  const text = ((message.content || "") + " " + (message.embeds || []).map(e => (e.description || "") + " " + (e.title || "")).join(" ")).toLowerCase();

  for (const [key, svc] of Object.entries(SERVICES)) {
    if (svc.botId !== authorId) continue;
    if (svc.confirmPhrases.some(p => text.includes(p.toLowerCase()))) return key;
  }
  return null;
}

/**
 * Parse a rank number out of a bump-service confirm message if the service
 * happens to include one in the embed/content. Returns null if absent —
 * most services don't surface this, which is fine, rank trends are only
 * populated for the services that do.
 */
export function extractRank(message) {
  const corpus = (message.content || "") + " " + (message.embeds || []).map(e => (e.description || "") + " " + (e.title || "") + " " + (e.footer?.text || "")).join(" ");
  // Common patterns: "rank #12", "position: 42", "you are ranked 7"
  const m = corpus.match(/\b(?:rank|position|ranked)\s*(?::|#)?\s*(\d{1,6})\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : null;
}

/**
 * Best-effort extraction of the user ID who bumped, from the confirm message.
 * DISBOARD and Discadia both mention the bumper via <@userId>.
 */
export function extractBumperUserId(message, serviceKey) {
  const svc = SERVICES[serviceKey];
  if (!svc) return null;
  const rx = svc.bumperMentionRx;
  if (!rx) return null;
  const corpus = (message.content || "") + " " + (message.embeds || []).map(e => (e.description || "") + " " + (e.title || "")).join(" ");
  const m = corpus.match(rx);
  return m ? m[1] : null;
}

// ─── Entry point: called from messageCreate when a bump confirms ────────────

export async function handleBumpConfirm(message, serviceKeyOverride = null) {
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  if (!guildId) return;

  const serviceKey = serviceKeyOverride || detectBumpService(message);
  if (!serviceKey) return;
  const svc = SERVICES[serviceKey];

  const settings = getGuildSettings(guildId) || {};
  // Per-service enable flag. Default to true for DISBOARD (backward compat),
  // false for others (opt-in via /bumpconfig service enable X).
  const enabledServices = settings.bump_enabled_services;
  if (Array.isArray(enabledServices) && !enabledServices.includes(serviceKey)) {
    log(`[BUMP] ${serviceKey} disabled for guild ${guildId} — skipping reminder`);
    return;
  }
  if (!Array.isArray(enabledServices) && serviceKey !== "disboard") {
    log(`[BUMP] ${serviceKey} not opted-in for guild ${guildId} (only disboard runs by default) — skipping reminder`);
    return;
  }

  // Record the bump for analytics (leaderboard/streak).
  try {
    const bumperId = extractBumperUserId(message, serviceKey);
    const rank = extractRank(message);
    if (bumperId) {
      const { recordBump } = await import("./bumpAnalytics.js");
      await recordBump({ guildId, userId: bumperId, service: serviceKey, rank, atMs: Date.now() });
      // Pay out the "first bumper after reminder" bonus if one is pending.
      // The boolean return tells the applause module whether to skip its
      // shoutout (to avoid double-messaging the same user).
      const bonusPaid = !!(await payFirstBumperBonus(guildId, serviceKey, bumperId, message.client).catch(() => false));

      // Applause — give the bumper a quick shoutout in her voice.
      // Skipped during quiet hours, when the coin bonus fired, or when the
      // guild turned applause off via /bumpconfig applause off.
      try {
        const { sendBumpApplause } = await import("./bumpApplause.js");
        const guild = message.client.guilds.cache.get(guildId);
        const member = guild?.members?.cache?.get(bumperId)
          ?? await guild?.members?.fetch?.(bumperId).catch(() => null);
        const bumperName = member?.displayName || member?.user?.username || null;
        await sendBumpApplause({
          bumpMessage: message,
          guildId,
          bumperId,
          bumperName,
          service: serviceKey,
          bumpsTable: "eris_bumps",
          botName: "eris",
          firstBumperBonusPaid: bonusPaid,
        });
      } catch (e) {
        log(`[BUMP] Applause hook failed: ${e.message}`);
      }

      // Celebration hooks — bump-a-thon goal-hit + streak milestones.
      // Failures here are non-fatal; the scheduler still runs.
      try {
        const celebrations = await import("./bumpCelebrations.js");
        // Record current streak as baseline for future streak-lost detection.
        await celebrations.recordStreakBaseline({ guildId, service: serviceKey });
        // Both celebration checks run even if one throws.
        await Promise.allSettled([
          celebrations.maybeCelebrateBumpathon(message.client, guildId, "eris_bumps"),
          celebrations.maybeCelebrateStreakMilestone(message.client, { guildId, service: serviceKey }),
        ]);
      } catch (e) {
        log(`[BUMP] Celebrations hook failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`[BUMP] Analytics hook failed: ${e.message}`);
  }

  const scheduledAt = Date.now() + svc.cooldownMinutes * 60 * 1000;

  // Persist per-service. The "primary" legacy fields stay in sync with the
  // most-recent bump so old code paths keep working.
  setGuildSetting(guildId, "bump_channel_id", channelId);
  setGuildSetting(guildId, "bump_scheduled_at", scheduledAt);
  setGuildSetting(guildId, "bump_last_service", serviceKey);

  // Per-service scheduled-at map: { [serviceKey]: { scheduledAt, channelId } }
  const perService = { ...(settings.bump_scheduled_by_service || {}) };
  perService[serviceKey] = { scheduledAt, channelId };
  setGuildSetting(guildId, "bump_scheduled_by_service", perService);

  _schedule(message.client, guildId, serviceKey, channelId, scheduledAt);
  log(`[BUMP] ${svc.name} reminder scheduled for guild ${guildId} in ${svc.cooldownMinutes}min`);

  // Post the live-updating countdown embed (fire-and-forget).
  if (settings.bump_countdown_enabled !== false) {
    postCountdownEmbed(message.client, guildId, serviceKey, channelId, scheduledAt).catch(e =>
      log(`[BUMP] Countdown post failed: ${e.message}`)
    );
  }
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

function _schedule(client, guildId, serviceKey, channelId, scheduledAt) {
  const key = keyFor(guildId, serviceKey);
  const existing = _activeTimers.get(key);
  if (existing) clearTimeout(existing.timer);

  const delay = Math.max(scheduledAt - Date.now(), 0);

  const timer = setTimeout(() => {
    _fireReminder(client, guildId, serviceKey, channelId).catch(e =>
      log(`[BUMP] Fire failed for ${guildId}/${serviceKey}: ${e.message}`)
    );
    _activeTimers.delete(key);

    // Clear the per-service scheduled-at persistence.
    try {
      const settings = getGuildSettings(guildId) || {};
      const perService = { ...(settings.bump_scheduled_by_service || {}) };
      delete perService[serviceKey];
      setGuildSetting(guildId, "bump_scheduled_by_service", perService);
      // Also clear legacy fields if this was the most recent service.
      if (settings.bump_last_service === serviceKey) {
        setGuildSetting(guildId, "bump_scheduled_at", null);
      }
    } catch (e) { log(`[BUMP] ${e.message}`); }
  }, delay);

  _activeTimers.set(key, { timer, channelId, scheduledAt, serviceKey });
}

// ─── Fire the reminder ──────────────────────────────────────────────────────

async function _fireReminder(client, guildId, serviceKey, channelId, { wasOffline = false } = {}) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const settings = getGuildSettings(guildId) || {};
  const svc = SERVICES[serviceKey];
  if (!svc) return;

  // Prefer a dedicated reminder channel if configured, else the bump channel.
  const targetChannelId = settings.bump_reminder_channel_id || channelId;
  const channel = guild.channels.cache.get(targetChannelId)
    ?? await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  // Quiet hours — if we're inside the window, soften the reminder.
  const quiet = isQuietHoursActive(settings);

  // Streak-lost detection: if a non-trivial streak broke since the last
  // bump, lead with a short acknowledgment so nobody feels gaslit.
  // Respects any guild-level streak_lost template.
  let streakLostPrefix = "";
  try {
    const { detectStreakLost, buildStreakLostLine } = await import("./bumpCelebrations.js");
    const lostLength = await detectStreakLost({ guildId, service: serviceKey });
    if (lostLength) {
      const line = buildStreakLostLine(settings, lostLength);
      if (line) streakLostPrefix = `${line}\n`;
    }
  } catch (e) { log(`[BUMP] ${e.message}`); }

  // Build role mentions (with optional rotation).
  const mentionString = await buildRoleMentions(guild, settings, quiet);

  // Generate the body: AI-voice by default, custom template if set.
  const body = await buildReminderBody({
    guild, serviceKey, settings, quiet, wasOffline,
  });

  const prefix = mentionString ? `${mentionString}\n` : "";
  const content = `${streakLostPrefix}${prefix}${body}`.slice(0, 1950);

  let sentMessage = null;
  try {
    sentMessage = await channel.send({
      content,
      allowedMentions: { parse: ["roles", "users"] },
      components: buildReminderButtons(serviceKey),
    });
  } catch (e) {
    log(`[BUMP] Send failed for ${guildId}: ${e.message}`);
    return;
  }
  log(`[BUMP] Fired ${svc.name} reminder in ${guildId}/${targetChannelId}`);

  // Schedule a no-show escalation — if nobody bumps within 15 min, we'll
  // follow up once with a gentler nudge.
  scheduleNoShowEscalation({ client, guildId, serviceKey, channelId: targetChannelId, sentAt: Date.now() });

  // Prime the first-bumper bonus window (5 min) so the very next bump
  // from this service gets the bonus in payFirstBumperBonus().
  markFirstBumperBonusWindow(guildId, serviceKey);

  // Personal DM pings — fan out to users who opted in AND are members of
  // this guild, respecting cross-server dedup so the same user doesn't get
  // pinged by 5 different Eris-servers in the same 10-minute window.
  // Gated by the admin flag bump_personal_ping_enabled (default off so we
  // don't surprise servers with DMs on first deploy).
  if (!quiet && settings.bump_personal_ping_enabled === true) {
    fanOutPersonalDms({ guild, serviceKey, svc, body }).catch(e =>
      log(`[BUMP] DM fan-out failed in ${guildId}: ${e.message}`)
    );
  }
}

async function fanOutPersonalDms({ guild, serviceKey, svc, body }) {
  try {
    const { getPersonalPingOptIns } = await import("./bumpUserPrefs.js");
    const config = (await import("../config.js")).default;
    const optIns = await getPersonalPingOptIns(config.botName || "eris");
    if (!optIns.length) return;

    // Intersect with this guild's members (cache is fine — we don't need
    // to fetch every opt-in user if most aren't even here).
    let sent = 0;
    for (const userId of optIns) {
      try {
        if (shouldSuppressDirectUserPing(userId)) continue;
        const member = guild.members.cache.get(userId);
        if (!member) continue; // Not in this guild (or not cached — that's fine, we err on the side of not DMing)
        if (member.user.bot) continue;

        const dm = await member.createDM().catch(() => null);
        if (!dm) continue;
        const line = `**${guild.name}** is bumpable again — \`${svc.slashCommand}\` when you've got a sec.\n\n-# you opted into these. turn off with /bumps dm off`;
        // We deliberately post a short, quiet line — not the full body — so
        // DM fan-out never turns into spam even if the body gets long.
        await dm.send({ content: line.slice(0, 900) }).catch(() => {});
        markDirectUserPinged(userId);
        sent++;
        if (sent >= 200) break; // hard cap per-reminder
      } catch (e) {
        log(`[BUMP] DM to ${userId} failed: ${e.message}`);
      }
    }
    if (sent) log(`[BUMP] Personal DMs sent: ${sent} for ${guild.id}/${serviceKey}`);
  } catch (e) {
    log(`[BUMP] fanOutPersonalDms: ${e.message}`);
  }
}

// ─── Reminder body generation ───────────────────────────────────────────────

async function buildReminderBody({ guild, serviceKey, settings, quiet, wasOffline }) {
  const svc = SERVICES[serviceKey];
  const customTemplate = settings.bump_template;
  if (customTemplate && typeof customTemplate === "string") {
    return renderTemplate(customTemplate, { guildName: guild.name, service: svc.name, command: svc.slashCommand });
  }

  // AI-voice generation — bounded and fall-back-safe.
  try {
    const text = await generateAiReminder({ guild, serviceKey, settings, quiet, wasOffline });
    if (text) return text;
  } catch (e) {
    log(`[BUMP] AI reminder gen failed: ${e.message}`);
  }

  // Fallback canned line — still respects quiet hours by being quieter.
  if (quiet) return `(quiet hours) ${svc.name} is bumpable again — ${svc.slashCommand} when someone's awake.`;
  if (wasOffline) return `we were offline when i was supposed to ping you, but ${svc.name} is still bumpable — ${svc.slashCommand}.`;
  return `⏰ ${svc.name} is bumpable again — ${svc.slashCommand} to push us back to the top.`;
}

async function generateAiReminder({ guild, serviceKey, settings, quiet, wasOffline }) {
  // Pull seed context: top bumper, current streak, last bumper.
  let topBumperName = null;
  let lastBumperName = null;
  let streak = 0;
  try {
    const { getBumpLeaderboard, getLastBumper } = await import("./bumpAnalytics.js");
    const leaderboard = await getBumpLeaderboard(guild.id, { limit: 1, periodDays: 7 });
    if (leaderboard?.[0]) {
      const m = guild.members.cache.get(leaderboard[0].user_id);
      topBumperName = m?.displayName || leaderboard[0].username || null;
    }
    const last = await getLastBumper(guild.id, serviceKey);
    if (last?.user_id) {
      const m = guild.members.cache.get(last.user_id);
      lastBumperName = m?.displayName || null;
    }
    streak = await (await import("./bumpAnalytics.js")).getGuildStreak(guild.id, serviceKey);
  } catch (e) { log(`[BUMP] ${e.message}`); }

  const mood = (await import("../database.js")).getMood?.() || { mood_score: 0, energy: 50 };
  const svc = SERVICES[serviceKey];

  // Pull extra personality context so reminders feel like HER voice, not a
  // generic "it's time to bump" template. Each pull is best-effort — any
  // failure just drops that slice from the prompt.
  let preoccupationLine = null;
  let catchphraseLine = null;
  try {
    const preoc = await import("./preoccupations.js");
    const current = preoc.getCurrentPreoccupation?.();
    if (current?.topic) {
      preoccupationLine = `You've been preoccupied with "${current.topic}" lately — it's fine to slip a reference if natural.`;
    }
  } catch (e) { log(`[BUMP] ${e.message}`); }
  try {
    const personality = await import("./personality.js");
    const data = await personality._getData?.();
    const catches = (data?.catchphrases || []).filter(c => (c.reactions || 0) >= 3);
    if (catches.length) {
      const pick = catches[Math.floor(Math.random() * Math.min(catches.length, 5))];
      catchphraseLine = `One of your real catchphrases: "${pick.phrase}" — okay to echo if it fits.`;
    }
  } catch (e) { log(`[BUMP] ${e.message}`); }

  // Assemble a one-shot prompt. We use the fast model and a tight token
  // budget so the reminder is snappy and cheap.
  const hour = new Date().getHours();
  const timeOfDay = hour < 5 ? "late-night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  const context = [
    `Service: ${svc.name} (${svc.slashCommand})`,
    `Guild: ${guild.name}`,
    `Time: ${timeOfDay} (${hour}:00)`,
    `Your mood: ${mood.mood_score > 30 ? "good" : mood.mood_score < -30 ? "bad" : "neutral"}`,
    topBumperName ? `This week's top bumper: ${topBumperName}` : null,
    lastBumperName ? `Last bumper: ${lastBumperName}` : null,
    streak > 1 ? `Server's current streak: ${streak} bumps in a row` : null,
    preoccupationLine,
    catchphraseLine,
    quiet ? "This is QUIET HOURS — keep it super low key, like a whispered reminder" : null,
    wasOffline ? "We were offline past the original ping time — acknowledge this honestly" : null,
  ].filter(Boolean).join("\n");

  try {
    const [{ default: config }, { getConvClientForBump }] = await Promise.all([
      import("../config.js"),
      // Prefer a fast model. Reuse the existing key pool if available.
      (async () => ({
        getConvClientForBump: async () => {
          const mod = await import("../ai/keyPool.js").catch(() => null);
          if (mod?.getGeminiClient) return mod.getGeminiClient();
          // Fallback: spin up a client from the first key.
          const cfg = await import("../config.js");
          const keys = cfg.default.geminiKeys || [];
          if (!keys.length) return null;
          const { GoogleGenAI } = await import("@google/genai");
          return new GoogleGenAI({ apiKey: keys[0] });
        },
      }))(),
    ]);
    const ai = await getConvClientForBump();
    if (!ai) return null;

    const model = config.geminiFastModel || config.geminiFallbackModel || config.geminiModel;
    const system = `You are Eris writing a short bump reminder for a Discord server. Lowercase, no periods. Under 180 characters. Do NOT include role mentions — those are prepended separately. Do NOT use markdown headers. Your line should feel like a text message, not a template. Mention the slash command (${svc.slashCommand}) so people know what to type. If you reference the top bumper or streak, keep it natural ("${topBumperName}'s streak is on the line" kind of energy), never sycophantic.`;

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: context }] }],
      config: { systemInstruction: system, maxOutputTokens: 120, temperature: 0.85 },
    });
    const parts = result.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
    if (!text) return null;
    return text.slice(0, 200);
  } catch (e) {
    log(`[BUMP] AI gen error: ${e.message}`);
    return null;
  }
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

// ─── Role mentions (with optional rotation) ─────────────────────────────────

async function buildRoleMentions(guild, settings, quiet) {
  if (quiet) {
    // Quiet hours: suppress pings entirely so nobody gets woken up.
    return "";
  }
  const roleIds = settings.bump_ping_roles || [];
  if (!roleIds.length) return "";

  const mode = settings.bump_rotation_mode || "all";
  if (mode === "rotate") {
    // Round-robin: pick the role after the last one used.
    const lastIdx = typeof settings.bump_rotation_index === "number" ? settings.bump_rotation_index : -1;
    const nextIdx = (lastIdx + 1) % roleIds.length;
    try { setGuildSetting(guild.id, "bump_rotation_index", nextIdx); } catch (e) { log(`[BUMP] ${e.message}`); }
    return `<@&${roleIds[nextIdx]}>`;
  }
  if (mode === "online") {
    // Filter to roles that have at least one non-idle/non-offline member.
    try {
      await guild.members.fetch({ withPresences: true }).catch(() => null);
      const activeRoleIds = roleIds.filter(rid => {
        const role = guild.roles.cache.get(rid);
        if (!role) return false;
        return role.members.some(m => {
          const status = m.presence?.status;
          return status === "online" || status === "idle" || status === "dnd";
        });
      });
      if (activeRoleIds.length) return activeRoleIds.map(id => `<@&${id}>`).join(" ");
    } catch (e) { log(`[BUMP] ${e.message}`); }
    // If nothing active or presence unavailable, fall through to pinging all.
  }
  return roleIds.map(id => `<@&${id}>`).join(" ");
}

// ─── Cross-server dedup ─────────────────────────────────────────────────────
// A user who's in 5 Eris-enabled servers shouldn't get 5 bump pings at once.
// We track "this user was pinged for a bump in the last N minutes" globally
// and suppress their personal @ when they're in the cooldown window. Role
// mentions are still fired so server mods still get notified — we only
// suppress DIRECT @user pings that would stack.
//
// NOTE: Currently the reminder doesn't @ individual users directly — only
// roles. This hook is a no-op placeholder for when direct-user pings get
// added (e.g. an opt-in "ping me personally" feature). The machinery is
// here so that when we do add it, the suppression already works.

const CROSS_SERVER_DEDUP_MS = 10 * 60 * 1000;
const _userLastPinged = new Map(); // userId → lastPingAtMs

export function shouldSuppressDirectUserPing(userId) {
  if (!userId) return false;
  const last = _userLastPinged.get(userId);
  if (!last) return false;
  return Date.now() - last < CROSS_SERVER_DEDUP_MS;
}

export function markDirectUserPinged(userId) {
  if (!userId) return;
  _userLastPinged.set(userId, Date.now());
  // Prune opportunistically to avoid unbounded growth.
  if (_userLastPinged.size > 10_000) {
    const cutoff = Date.now() - CROSS_SERVER_DEDUP_MS * 2;
    for (const [uid, ts] of _userLastPinged) {
      if (ts < cutoff) _userLastPinged.delete(uid);
    }
  }
}

// ─── Quick-action buttons ───────────────────────────────────────────────────

function buildReminderButtons(serviceKey) {
  // Lazy-import discord.js so tests that don't need it stay light.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bump_snooze_15_${serviceKey}`).setLabel("Snooze 15m").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bump_mute_tonight_${serviceKey}`).setLabel("Mute tonight").setStyle(ButtonStyle.Secondary),
    );
    return [row];
  } catch {
    return [];
  }
}

// ─── No-show escalation ────────────────────────────────────────────────────

function scheduleNoShowEscalation({ client, guildId, serviceKey, channelId, sentAt }) {
  const key = keyFor(guildId, serviceKey);
  const existing = _activeEscalations.get(key);
  if (existing) clearTimeout(existing);

  const settings = getGuildSettings(guildId) || {};
  if (settings.bump_no_show_escalate === false) return;

  const delay = 15 * 60 * 1000;
  const timer = setTimeout(async () => {
    _activeEscalations.delete(key);
    try {
      // Did anyone bump the same service since we fired?
      const { getLastBumper } = await import("./bumpAnalytics.js");
      const last = await getLastBumper(guildId, serviceKey);
      if (last?.bumped_at && new Date(last.bumped_at).getTime() >= sentAt) return;

      // Still no bump. Send a gentler nudge.
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const svc = SERVICES[serviceKey];
      await channel.send({
        content: `still waiting on that ${svc.slashCommand} ... no pressure but 👀`,
        allowedMentions: { parse: [] },
      });
      log(`[BUMP] No-show escalation for ${guildId}/${serviceKey}`);
    } catch (e) {
      log(`[BUMP] Escalation failed: ${e.message}`);
    }
  }, delay);
  _activeEscalations.set(key, timer);
}

export function cancelEscalation(guildId, serviceKey) {
  const key = keyFor(guildId, serviceKey);
  const t = _activeEscalations.get(key);
  if (t) { clearTimeout(t); _activeEscalations.delete(key); }
}

// ─── First-bumper-after-reminder bonus ─────────────────────────────────────

const FIRST_BUMPER_WINDOW_MS = 5 * 60 * 1000;
const FIRST_BUMPER_BONUS_COINS = 50;
const _firstBumperWindows = new Map(); // key → expiresAt

function markFirstBumperBonusWindow(guildId, serviceKey) {
  _firstBumperWindows.set(keyFor(guildId, serviceKey), Date.now() + FIRST_BUMPER_WINDOW_MS);
}

async function payFirstBumperBonus(guildId, serviceKey, userId, client) {
  const key = keyFor(guildId, serviceKey);
  const expires = _firstBumperWindows.get(key);
  if (!expires || Date.now() > expires) return false;
  _firstBumperWindows.delete(key);

  // Only Eris has the economy. Call the balance function if it exists.
  try {
    const db = await import("../database.js");
    if (typeof db.updateBalance !== "function") return false;
    await db.updateBalance(userId, FIRST_BUMPER_BONUS_COINS, "bump_first_bonus", serviceKey);

    const guild = client?.guilds?.cache?.get(guildId);
    const settings = getGuildSettings(guildId) || {};
    const channelId = settings.bump_reminder_channel_id || settings.bump_channel_id;
    const channel = channelId ? (guild?.channels?.cache?.get(channelId) ?? await guild?.channels?.fetch?.(channelId).catch(() => null)) : null;
    if (channel?.isTextBased()) {
      channel.send({ content: `<@${userId}> first bump of the window — +${FIRST_BUMPER_BONUS_COINS} coins 🪙`, allowedMentions: { parse: ["users"] } }).catch(() => {});
    }
    return true;
  } catch (e) {
    log(`[BUMP] First-bumper bonus failed: ${e.message}`);
    return false;
  }
}

// ─── Quiet hours ───────────────────────────────────────────────────────────

/**
 * Quiet hours are stored as { start: 0-23, end: 0-23, tz: "UTC" }.
 * Cross-midnight ranges (e.g. 22→07) are supported.
 */
export function isQuietHoursActive(settings, now = new Date()) {
  const qh = settings?.bump_quiet_hours;
  if (!qh || typeof qh.start !== "number" || typeof qh.end !== "number") return false;
  const hour = hourInTimezone(now, qh.tz || "UTC");
  const { start, end } = qh;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // Wraps midnight: e.g. 22–07 means 22,23,0,1,...,6.
  return hour >= start || hour < end;
}

function hourInTimezone(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz });
    const parts = fmt.formatToParts(date);
    const hour = parts.find(p => p.type === "hour")?.value;
    // Intl returns "24" for midnight in some implementations; normalize.
    const h = Number(hour);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

// ─── Restore on bot restart ────────────────────────────────────────────────

export function restoreBumpTimers(client) {
  let restored = 0;
  let fireNowCount = 0;

  for (const guild of client.guilds.cache.values()) {
    const settings = getGuildSettings(guild.id) || {};
    const perService = settings.bump_scheduled_by_service || {};

    // Per-service scheduled-at map (preferred).
    for (const [serviceKey, row] of Object.entries(perService)) {
      if (!row?.scheduledAt || !row?.channelId) continue;
      const now = Date.now();
      if (row.scheduledAt <= now) {
        // Past due — fire immediately with wasOffline flag.
        _fireReminder(client, guild.id, serviceKey, row.channelId, { wasOffline: true }).catch(e => log(`[BUMP] Past-due fire failed: ${e.message}`));
        fireNowCount++;
        // Clear persisted entry.
        const fresh = { ...(getGuildSettings(guild.id) || {}).bump_scheduled_by_service || {} };
        delete fresh[serviceKey];
        setGuildSetting(guild.id, "bump_scheduled_by_service", fresh);
      } else {
        _schedule(client, guild.id, serviceKey, row.channelId, row.scheduledAt);
        restored++;
      }
    }

    // Legacy single-service fields — honor them if per-service is empty.
    if (!Object.keys(perService).length && settings.bump_scheduled_at && settings.bump_channel_id) {
      const legacyService = settings.bump_last_service || "disboard";
      if (settings.bump_scheduled_at <= Date.now()) {
        _fireReminder(client, guild.id, legacyService, settings.bump_channel_id, { wasOffline: true }).catch(() => {});
        fireNowCount++;
        setGuildSetting(guild.id, "bump_scheduled_at", null);
      } else {
        _schedule(client, guild.id, legacyService, settings.bump_channel_id, settings.bump_scheduled_at);
        restored++;
      }
    }
  }

  if (restored || fireNowCount) {
    log(`[BUMP] Restored ${restored} timers, fired ${fireNowCount} past-due`);
  }
}

// ─── Snooze / mute controls (called from button interactions) ──────────────

export function snoozeReminder(guildId, serviceKey, minutes = 15, client = null) {
  const key = keyFor(guildId, serviceKey);
  const existing = _activeTimers.get(key);
  const settings = getGuildSettings(guildId) || {};
  const channelId = settings.bump_reminder_channel_id || settings.bump_channel_id;

  const newAt = Date.now() + minutes * 60 * 1000;
  setGuildSetting(guildId, "bump_scheduled_at", newAt);
  const perService = { ...(settings.bump_scheduled_by_service || {}) };
  perService[serviceKey] = { scheduledAt: newAt, channelId };
  setGuildSetting(guildId, "bump_scheduled_by_service", perService);

  if (existing) clearTimeout(existing.timer);
  if (client && channelId) _schedule(client, guildId, serviceKey, channelId, newAt);
  return newAt;
}

export function muteTonight(guildId) {
  // Set a one-off quiet window from now until 8am in the guild's tz (or UTC).
  const settings = getGuildSettings(guildId) || {};
  const tz = settings.bump_quiet_hours?.tz || "UTC";
  const hour = hourInTimezone(new Date(), tz);
  const quiet = {
    start: hour,
    end: 8,
    tz,
  };
  setGuildSetting(guildId, "bump_quiet_hours", quiet);
  setGuildSetting(guildId, "bump_quiet_until", Date.now() + 12 * 60 * 60 * 1000);
  return quiet;
}

// ─── Live countdown embed ──────────────────────────────────────────────────
// Posted after a bump confirms. Edits itself every ~60s with a live progress
// bar. Uses Discord's native relative-time markup for the "bumpable at" line
// so the user's client renders a localized countdown without bot work.
// On timer completion, the embed is updated to the final "bumpable now" state
// and a new action row with [Bump Now] appears.

const _activeCountdowns = new Map(); // key → { messageId, channelId, interval }

async function postCountdownEmbed(client, guildId, serviceKey, channelId, scheduledAt) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const svc = SERVICES[serviceKey];
  if (!svc) return;

  let msg;
  try {
    const [{ EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle }] = await Promise.all([
      import("discord.js"),
    ]);
    const durationMs = svc.cooldownMinutes * 60_000;
    const { embed } = buildCountdownEmbed({ svc, scheduledAt, startedAt: Date.now(), durationMs, EmbedBuilder });
    msg = await channel.send({
      embeds: [embed],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    log(`[BUMP] Countdown send failed: ${e.message}`);
    return;
  }

  const key = keyFor(guildId, serviceKey);
  // Cancel any older countdown for this key
  const prev = _activeCountdowns.get(key);
  if (prev?.interval) clearInterval(prev.interval);

  const state = { messageId: msg.id, channelId, interval: null };
  _activeCountdowns.set(key, state);

  // Edit every 60s until scheduled time; then final update.
  const durationMs = svc.cooldownMinutes * 60_000;
  const startedAt = Date.now();
  state.interval = setInterval(async () => {
    try {
      const now = Date.now();
      const remaining = scheduledAt - now;
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
      if (remaining <= 0) {
        clearInterval(state.interval);
        _activeCountdowns.delete(key);
        const { embed } = buildCountdownEmbed({ svc, scheduledAt, startedAt, durationMs, EmbedBuilder, done: true });
        const bumpNowRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel(`Run ${svc.slashCommand}`).setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guildId}/${channelId}`),
        );
        await channel.messages.edit(state.messageId, { embeds: [embed], components: [bumpNowRow] }).catch(() => {});
        return;
      }
      const { embed } = buildCountdownEmbed({ svc, scheduledAt, startedAt, durationMs, EmbedBuilder });
      await channel.messages.edit(state.messageId, { embeds: [embed] }).catch(() => {});
    } catch (e) { log(`[BUMP] ${e.message}`); }
  }, 60_000);
  // Don't let the interval keep the Node process alive on shutdown.
  state.interval.unref?.();
}

function buildCountdownEmbed({ svc, scheduledAt, startedAt, durationMs, EmbedBuilder, done = false }) {
  const now = Date.now();
  const remaining = Math.max(0, scheduledAt - now);
  const elapsed = Math.max(0, now - startedAt);
  const pct = Math.max(0, Math.min(1, elapsed / durationMs));
  const filled = Math.round(pct * 18);
  const bar = "█".repeat(filled) + "░".repeat(18 - filled);

  const color = done ? 0x10B981 : pct >= 0.9 ? 0xF1C40F : pct >= 0.5 ? 0x5865F2 : 0x2b2d31;
  const readyAtUnix = Math.floor(scheduledAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${svc.name} · auto-bump` })
    .setDescription(
      done
        ? `**bumpable now!** run \`${svc.slashCommand}\` in the bump channel.`
        : `bumpable <t:${readyAtUnix}:R> — \`${svc.slashCommand}\`\n\`${bar}\``,
    );
  if (!done) embed.setFooter({ text: `${Math.round(remaining / 60_000)}m left · auto-updates` });
  return { embed };
}

// ─── Testing helpers ───────────────────────────────────────────────────────
export const _internal = { SERVICES, keyFor, hourInTimezone, buildCountdownEmbed };
