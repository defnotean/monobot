// ─── Anti-Nuke Protection ───────────────────────────────────────────────────

import { log, sendModLog } from "./logger.js";
import { warnEmbed } from "./embeds.js";
import { PermissionFlagsBits } from "discord.js";
import config from "../config.js";

// ─── Action tracking: guildId → userId → { channel_delete, role_delete, ban, kick } ──
const actionTracking = new Map();

// ─── Anti-nuke settings per guild ────────────────────────────────────────────
const antiNukeSettings = new Map();

// ─── Anti-nuke event logs: guildId → [{ timestamp, userId, action, count, severity }, ...] ──
const antiNukeLogs = new Map();

// ─── Whitelisted users/bots (won't trigger anti-nuke) ────────────────────────
const whitelist = new Map(); // guildId → Set of userIds

// ─── Default thresholds ─────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: true,
  threshold: 3,      // actions to trigger
  timeWindowSec: 60, // time window
  warningThreshold: 1,  // warn after N actions
  stripThreshold: 2,    // strip roles after N actions
  banThreshold: 3,      // ban after N actions
  // Flip to true to also enforce against users with Administrator perm.
  // Default false because legitimate admin cleanup (deleting a few old
  // channels, bulk-removing roles) constantly trips the thresholds
  // otherwise. Only useful when you're specifically worried about
  // compromised admin accounts.
  track_admins: false,
};

/**
 * Check whether a user is protected from anti-nuke enforcement in this
 * guild. Returns null if the user is fair game, or a string reason label
 * if they're exempt. Used both at track-time (skip counting entirely)
 * and response-time (refuse to strip/ban even if something else miscounts).
 */
async function _exemptReason(guild, userId, settings) {
  // Guild owner — ALWAYS exempt, non-negotiable. Stripping the owner's
  // roles is a catastrophic false positive and the very scenario the
  // user hit that led to this fix.
  if (guild && userId === guild.ownerId) return "guild_owner";
  // Bot owner (the person running Irene). They run
  // maintenance across servers they own and shouldn't get flagged.
  if (config?.ownerId && userId === String(config.ownerId)) return "bot_owner";
  // Explicit allowlist set via addToWhitelist.
  const guildWhitelist = whitelist.get(guild?.id) || new Set();
  if (guildWhitelist.has(userId)) return "whitelist";
  // Admins — exempt by default. Flip settings.track_admins to change.
  if (guild && !settings.track_admins) {
    const member = await guild.members.fetch(userId).catch(() => null);
    try {
      if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return "admin";
    } catch { /* perm check failed — treat as not exempt */ }
  }
  return null;
}

/**
 * Track a destructive action and check if it triggers nuke protection.
 * @param {string} guildId
 * @param {string} userId
 * @param {string} actionType - "channel_delete" | "role_delete" | "ban" | "kick"
 * @param {import("discord.js").Guild} [guild] - the Discord.js Guild object.
 *   Needed to check ownerId and Administrator perm so the server owner /
 *   admins don't get stripped for doing legitimate cleanup.
 * @returns {Promise<{ triggered: boolean, count: number, action: string, severity: string, exempt?: string }>}
 */
export async function trackAction(guildId, userId, actionType, guild) {
  const now = Date.now();
  const settings = getAntiNukeSettings(guildId);

  if (!settings.enabled) {
    return { triggered: false, count: 0, action: actionType, severity: "none" };
  }

  // Exemptions — checked BEFORE counting so protected users don't even
  // accumulate state toward the thresholds.
  const exempt = await _exemptReason(guild, userId, settings);
  if (exempt) {
    return { triggered: false, count: 0, action: actionType, severity: "none", exempt };
  }

  // Initialize user tracking if needed
  if (!actionTracking.has(guildId)) {
    actionTracking.set(guildId, new Map());
  }

  const guildActions = actionTracking.get(guildId);
  if (!guildActions.has(userId)) {
    guildActions.set(userId, {});
  }

  const userActions = guildActions.get(userId);

  // Initialize action type tracking if needed
  if (!userActions[actionType]) {
    userActions[actionType] = [];
  }

  // Add this action
  userActions[actionType].push(now);

  // Clean up old actions outside the window
  const windowStart = now - (settings.timeWindowSec * 1000);
  userActions[actionType] = userActions[actionType].filter((t) => t >= windowStart);

  const count = userActions[actionType].length;

  // Determine severity level
  let severity = "none";
  if (count >= settings.banThreshold) severity = "ban";
  else if (count >= settings.stripThreshold) severity = "strip";
  else if (count >= settings.warningThreshold) severity = "warn";

  const triggered = count >= settings.threshold;

  if (triggered || severity !== "none") {
    executeNukeResponse(guildId, userId, actionType, count, severity, settings, guild);
  }

  return { triggered, count, action: actionType, severity };
}

/**
 * Execute the nuke response — based on severity level.
 * @param {import("discord.js").Guild} [guildParam] - passed from trackAction;
 *   falls back to importing the client if not supplied (legacy call paths).
 */
async function executeNukeResponse(guildId, userId, actionType, count, severity, settings, guildParam) {
  let guild = guildParam;
  if (!guild) {
    const { client } = await import("../index.js");
    guild = client?.guilds.cache.get(guildId);
  }
  if (!guild) return;

  // Defense-in-depth re-check. If something bypassed the exempt check in
  // trackAction (thresholds changed mid-flight, a caller invoked this
  // directly, etc.), STILL refuse to strip or ban a protected user.
  // Warnings are fine to log even for exempt users.
  if (severity === "strip" || severity === "ban") {
    const exempt = await _exemptReason(guild, userId, settings);
    if (exempt) {
      log(`[AntiNuke] REFUSED to ${severity} ${userId} in ${guild.name} — user is exempt (${exempt})`);
      return;
    }
  }

  try {
    // Log the event
    if (!antiNukeLogs.has(guildId)) {
      antiNukeLogs.set(guildId, []);
    }
    antiNukeLogs.get(guildId).push({
      timestamp: new Date().toISOString(),
      userId,
      actionType,
      count,
      severity,
    });

    const member = await guild.members.fetch(userId).catch(() => null);

    // Execute response based on severity
    if (severity === "warn") {
      log(`[AntiNuke] Warned ${member?.user.tag || userId} in ${guild.name} for ${actionType} (${count}/${settings.stripThreshold})`);
    } else if (severity === "strip") {
      if (member) {
        // Strip every role EXCEPT @everyone and @managed-by-integration
        // (bot roles etc. — removing them would just error). Use .remove()
        // with the full array so it's one API call instead of N, and
        // more atomic under rate limits.
        const rolesToRemove = member.roles.cache
          .filter((r) => r.id !== guild.id && !r.managed)
          .map((r) => r.id);

        if (rolesToRemove.length) {
          try {
            await member.roles.remove(rolesToRemove, `Anti-Nuke: ${actionType} (${count} in ${settings.timeWindowSec}s)`);
            log(`[AntiNuke] Stripped ${rolesToRemove.length} roles from ${member.user.tag} in ${guild.name} for ${actionType} (${count}/${settings.banThreshold})`);
          } catch (err) {
            log(`[AntiNuke] Role strip failed for ${member.user.tag}: ${err?.message || err}`);
          }
        }
      }
    } else if (severity === "ban") {
      try {
        await guild.bans.create(userId, { reason: `Anti-Nuke: ${actionType}` });
        log(`[AntiNuke] Banned ${member?.user.tag || userId} from ${guild.name} for ${actionType}`);
      } catch {}
    }

    // Alert server owner via DM
    try {
      const owner = await guild.fetchOwner();
      const severityLabel = severity.toUpperCase();
      await owner.send({
        embeds: [
          warnEmbed(`Anti-Nuke Alert [${severityLabel}]`,
            `A member performed ${count} ${actionType} actions in ${settings.timeWindowSec}s.\n` +
            `**User:** <@${userId}>\n` +
            `**Action:** ${actionType}\n` +
            `**Response:** ${severity}`
          )
        ]
      }).catch(() => {});
    } catch {}

    // Alert in configured log channel (respects set_log_channel)
    try {
      const severityLabel = severity.toUpperCase();
      await sendModLog(guild,
        warnEmbed(`Anti-Nuke Triggered [${severityLabel}]`,
          `Detected nuke activity from <@${userId}>.\n` +
          `**Action:** ${actionType} (${count} times)\n` +
          `**Response:** ${severity}`
        )
      );
    } catch {}
  } catch (error) {
    log(`[AntiNuke] Error executing response: ${error.message}`);
  }
}

/**
 * Get anti-nuke settings for a guild
 */
export function getAntiNukeSettings(guildId) {
  return antiNukeSettings.get(guildId) ?? { ...DEFAULT_SETTINGS };
}

/**
 * Set anti-nuke settings for a guild
 */
export function setAntiNukeSettings(guildId, settings) {
  antiNukeSettings.set(guildId, { ...DEFAULT_SETTINGS, ...settings });
  log(`[AntiNuke] Updated settings for ${guildId}`);
}

/**
 * Add a user to the whitelist (won't trigger anti-nuke)
 */
export function addToWhitelist(guildId, userId) {
  if (!whitelist.has(guildId)) {
    whitelist.set(guildId, new Set());
  }
  whitelist.get(guildId).add(userId);
  log(`[AntiNuke] Added ${userId} to whitelist for ${guildId}`);
}

/**
 * Remove a user from the whitelist
 */
export function removeFromWhitelist(guildId, userId) {
  const guildWhitelist = whitelist.get(guildId);
  if (guildWhitelist) {
    guildWhitelist.delete(userId);
  }
  log(`[AntiNuke] Removed ${userId} from whitelist for ${guildId}`);
}

/**
 * Get whitelist for a guild
 */
export function getWhitelist(guildId) {
  return Array.from(whitelist.get(guildId) || new Set());
}

/**
 * Get anti-nuke event log for a guild
 */
export function getAntiNukeLog(guildId, limit = 50) {
  const logs = antiNukeLogs.get(guildId) || [];
  return logs.slice(-limit); // Return most recent
}

/**
 * Initialize anti-nuke data from database
 */
export function initAntiNukeData(loaded) {
  if (loaded?.antinuke_settings) {
    for (const [guildId, settings] of Object.entries(loaded.antinuke_settings)) {
      antiNukeSettings.set(guildId, settings);
    }
    log(`[AntiNuke] Loaded settings for ${antiNukeSettings.size} guilds`);
  }
  if (loaded?.antinuke_whitelist) {
    for (const [guildId, userIds] of Object.entries(loaded.antinuke_whitelist)) {
      whitelist.set(guildId, new Set(userIds));
    }
  }
}

/**
 * Get all anti-nuke data for database persistence
 */
export function getAntiNukeData() {
  const obj = {
    antinuke_settings: {},
    antinuke_whitelist: {},
  };
  for (const [guildId, settings] of antiNukeSettings) {
    obj.antinuke_settings[guildId] = settings;
  }
  for (const [guildId, userSet] of whitelist) {
    obj.antinuke_whitelist[guildId] = Array.from(userSet);
  }
  return obj;
}
