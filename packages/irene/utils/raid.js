// ─── Anti-Raid Detection and Response ────────────────────────────────────────

import { log } from "./logger.js";
import { warnEmbed, logEmbed, LC } from "./embeds.js";

// ─── Join tracking: guildId → [{ timestamp, userId }, ...] ──────────────────
const joinTracking = new Map();

// ─── Raid settings per guild ─────────────────────────────────────────────────
const raidSettings = new Map();

// ─── Raid event logs: guildId → [{ timestamp, joinCount, action }, ...] ──────
const raidLogs = new Map();

// ─── Auto-unlock timers: guildId → timeoutId ────────────────────────────────
const unlockTimers = new Map();

// ─── Account age whitelist: accounts older than X days bypass raid detection ──
const TRUSTED_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Default thresholds ─────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: true,
  threshold: 10,           // joins to trigger
  timeWindowSec: 30,       // time window
  action: "lockdown",      // "lockdown" | "kick" | "ban"
  notifyChannelId: null,   // where to send alerts
  autoUnlockMs: 10 * 60 * 1000, // auto-unlock after 10 minutes
};

/**
 * Check if a new member join triggers a raid
 * @returns {{ isRaid: boolean, joinCount: number, timeWindow: number, trusted?: boolean }}
 */
export function checkRaid(guild, member) {
  const guildId = guild.id;
  const now = Date.now();

  // Check if account is trusted (older than threshold)
  const accountAge = now - member.user.createdTimestamp;
  if (accountAge > TRUSTED_ACCOUNT_AGE_MS) {
    return { isRaid: false, joinCount: 0, timeWindow: 0, trusted: true };
  }

  // Initialize tracking array if needed
  if (!joinTracking.has(guildId)) {
    joinTracking.set(guildId, []);
  }

  const joins = joinTracking.get(guildId);
  joins.push({ timestamp: now, userId: member.id });

  // Get settings
  const settings = getRaidSettings(guildId);
  if (!settings.enabled) {
    return { isRaid: false, joinCount: 0, timeWindow: settings.timeWindowSec };
  }

  // Clean up old joins outside the window
  const windowStart = now - (settings.timeWindowSec * 1000);
  const recentJoins = joins.filter((j) => j.timestamp >= windowStart);
  joinTracking.set(guildId, recentJoins);

  const joinCount = recentJoins.length;
  const isRaid = joinCount >= settings.threshold;

  if (isRaid) {
    // Raid detected — execute action
    executeRaidAction(guild, settings, joinCount, recentJoins);
  }

  return { isRaid, joinCount, timeWindow: settings.timeWindowSec };
}

/**
 * Execute the configured action for raid detection
 */
async function executeRaidAction(guild, settings, joinCount, recentJoins) {
  try {
    const now = Date.now();
    const guildId = guild.id;

    // Log raid event
    if (!raidLogs.has(guildId)) {
      raidLogs.set(guildId, []);
    }
    raidLogs.get(guildId).push({
      timestamp: new Date().toISOString(),
      joinCount,
      timeWindow: settings.timeWindowSec,
      action: settings.action,
      userIds: recentJoins.map((j) => j.userId),
    });

    if (settings.action === "lockdown") {
      await lockdownServer(guild);
      log(`[Raid] Lockdown triggered on ${guild.name} (${joinCount} joins in ${settings.timeWindowSec}s)`);

      // Schedule auto-unlock if configured
      if (settings.autoUnlockMs > 0) {
        // Cancel existing timer if any
        if (unlockTimers.has(guildId)) {
          clearTimeout(unlockTimers.get(guildId));
        }

        const timer = setTimeout(async () => {
          try {
            await unlockServer(guild);
            log(`[Raid] Auto-unlocked ${guild.name} after ${settings.autoUnlockMs}ms`);
            unlockTimers.delete(guildId);
          } catch (err) {
            log(`[Raid] Error auto-unlocking: ${err.message}`);
          }
        }, settings.autoUnlockMs);

        unlockTimers.set(guildId, timer);
      }
    } else if (settings.action === "kick") {
      const usersKicked = [];
      for (const join of recentJoins) {
        try {
          const member = await guild.members.fetch(join.userId).catch(() => null);
          if (member) {
            await member.kick("Raid detection");
            usersKicked.push(join.userId);
          }
        } catch {}
      }
      log(`[Raid] Kicked ${usersKicked.length} users on ${guild.name}`);
    } else if (settings.action === "ban") {
      const usersBanned = [];
      for (const join of recentJoins) {
        try {
          await guild.bans.create(join.userId, { reason: "Raid detection" });
          usersBanned.push(join.userId);
        } catch {}
      }
      log(`[Raid] Banned ${usersBanned.length} users on ${guild.name}`);
    }

    // Notify channel if configured
    if (settings.notifyChannelId) {
      const channel = guild.channels.cache.get(settings.notifyChannelId);
      if (channel && channel.isTextBased()) {
        try {
          await channel.send({
            embeds: [
              warnEmbed("Raid Detected!", `Detected ${joinCount} joins in ${settings.timeWindowSec}s.\nAction: **${settings.action}**`)
            ]
          });
        } catch {}
      }
    }
  } catch (error) {
    log(`[Raid] Error executing action: ${error.message}`);
  }
}

/**
 * Lock down the server — deny @everyone Send Messages in all channels
 */
export async function lockdownServer(guild) {
  const everyoneRole = guild.roles.everyone;

  for (const channel of guild.channels.cache.values()) {
    if (channel.isTextBased() || channel.isVoiceBased()) {
      try {
        await channel.permissionOverwrites.edit(everyoneRole, {
          SendMessages: false,
          Connect: false,
        }).catch(() => {});
      } catch {}
    }
  }
}

/**
 * Unlock the server — remove the lockdown
 */
export async function unlockServer(guild) {
  const everyoneRole = guild.roles.everyone;

  for (const channel of guild.channels.cache.values()) {
    if (channel.isTextBased() || channel.isVoiceBased()) {
      try {
        const overwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);
        if (overwrite) {
          await channel.permissionOverwrites.delete(everyoneRole).catch(() => {});
        }
      } catch {}
    }
  }
}

/**
 * Get raid settings for a guild
 */
export function getRaidSettings(guildId) {
  return raidSettings.get(guildId) ?? { ...DEFAULT_SETTINGS };
}

/**
 * Set raid settings for a guild
 */
export function setRaidSettings(guildId, settings) {
  raidSettings.set(guildId, { ...DEFAULT_SETTINGS, ...settings });
  log(`[Raid] Updated settings for ${guildId}`);
}

/**
 * Get raid event log for a guild
 */
export function getRaidLog(guildId, limit = 50) {
  const logs = raidLogs.get(guildId) || [];
  return logs.slice(-limit); // Return most recent
}

/**
 * Clear raid logs for a guild
 */
export function clearRaidLog(guildId) {
  raidLogs.delete(guildId);
}

/**
 * Initialize raid data from database
 */
export function initRaidData(loaded) {
  if (loaded?.raid_settings) {
    for (const [guildId, settings] of Object.entries(loaded.raid_settings)) {
      raidSettings.set(guildId, settings);
    }
    log(`[Raid] Loaded settings for ${raidSettings.size} guilds`);
  }
}

/**
 * Get all raid data for database persistence
 */
export function getRaidData() {
  const obj = {};
  for (const [guildId, settings] of raidSettings) {
    obj[guildId] = settings;
  }
  return { raid_settings: obj };
}
