import { ActivityType } from "discord.js";
import { updatePresence } from "../presence.js";
import { checkBirthdays } from "../utils/birthday.js";
import { checkFeeds } from "../utils/patchbot.js";
import { checkStreams } from "../utils/twitch.js";
import config from "../config.js";
import { log } from "../utils/logger.js";
import { setBotIcon } from "../utils/embeds.js";
import { getGuildSettings, setLogChannel, setWelcomeChannel, getReminders, removeReminder, getServerPersona, isWhitelisted, addToWhitelist, getAllTempVcs, deleteTempVc, getLockdown, clearLockdown, getAutoSlowmodes, clearSlowmode, getGiveawayDb, getHighlightDb, getSupabase, getMood } from "../database.js";
import { cacheInvites } from "../utils/invites.js";
import { updateStatsChannels } from "../utils/stats.js";

// Exported so executor.js can cancel timers when a reminder is cancelled
export const reminderTimers = new Map();

const LOG_CHANNEL_NAMES = [
  "mod-log", "mod-logs", "modlog", "modlogs",
  "audit-log", "audit-logs", "auditlog", "auditlogs",
  "bot-log", "bot-logs", "server-log", "server-logs", "logs",
];
const WELCOME_CHANNEL_NAMES = [
  "welcome", "welcomes", "welcome-chat", "welcome-mat",
  "welcome-channel", "greetings", "introductions",
];

function activeProviderNeedsGeminiClient() {
  const provider = String(config.aiProvider || "gemini").toLowerCase();
  return provider === "gemini" || provider === "google";
}

function extractGeminiText(response) {
  return response?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join("")
    .trim() || "";
}

async function generateAutonomousText({ prompt, systemInstruction, maxOutputTokens }) {
  if (activeProviderNeedsGeminiClient()) {
    if (!config.geminiKeys?.[0]) return null;
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
    const response = await ai.models.generateContent({
      model: config.geminiFastModel || "gemini-2.5-flash",
      contents: [{ parts: [{ text: prompt }] }],
      config: { systemInstruction, maxOutputTokens },
    });
    return extractGeminiText(response) || null;
  }

  const { quickReply } = await import("../ai/providers/index.js");
  const text = await quickReply(
    null,
    `${systemInstruction}\n\nReturn only the requested inner text. Do not explain the format.`,
    prompt,
    null,
  );
  return text?.trim() || null;
}

function autoDetectGuildChannels(guild) {
  const settings = getGuildSettings(guild.id);

  if (!settings?.log_channel) {
    const found = guild.channels.cache.find(
      (c) => c.isTextBased() && LOG_CHANNEL_NAMES.includes(c.name.toLowerCase())
    );
    if (found) {
      setLogChannel(guild.id, found.id);
      log(`[AutoSetup] "${guild.name}": log channel → #${found.name}`);
    }
  }

  if (!settings?.welcome_channel) {
    const found = guild.channels.cache.find(
      (c) => c.isTextBased() && WELCOME_CHANNEL_NAMES.includes(c.name.toLowerCase())
    );
    if (found) {
      setWelcomeChannel(guild.id, found.id, null);
      log(`[AutoSetup] "${guild.name}": welcome channel → #${found.name}`);
    }
  }
}

export const name = "clientReady";
export const once = true;

export async function execute(client) {
  log(`[Bot] Online as ${client.user.tag}`);
  setBotIcon(client.user.displayAvatarURL({ size: 64 }));
  log(`[Bot] Serving ${client.guilds.cache.size} servers`);
  log(`[Bot] ${client.commands.size} commands loaded`);

  // Bump reminder system DISABLED — Eris handles all bump-related features.
  // Irene no longer schedules bump reminders, applauds bumps, or runs bumpathons.

  // Admin invite URL (permissions=8 = Administrator)
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
  log(`[Bot] Admin invite URL: ${inviteUrl}`);

  // Set bot status
  client.user.setActivity("/ commands | All-in-One Bot", { type: ActivityType.Listening });

  // ── Ensure creator always has max affinity ───
  const { getRelationship, updateRelationship } = await import("../database.js");
  const creatorRel = getRelationship(config.ownerId);
  if (creatorRel.affinity_score < 100) {
    updateRelationship(config.ownerId, 100 - creatorRel.affinity_score);
    log(`[Bot] Creator affinity set to 100`);
  }

  // ── Gatekeep sweep: leave any unauthorized servers on startup ──────────
  // Catches servers the bot was added to before the gatekeep existed,
  // or servers that were un-whitelisted while the bot was offline.
  log(`[WHITELIST] startup sweep — ${client.guilds.cache.size} guilds in cache`);
  for (const guild of client.guilds.cache.values()) {
    const ownerIsGuildOwner = guild.ownerId === config.ownerId;
    const whitelisted       = isWhitelisted(guild.id);
    // Fetch bot owner member to check if they're in this guild
    const ownerMember       = guild.members.cache.get(config.ownerId)
      ?? await guild.members.fetch(config.ownerId).catch(() => null);

    if (!ownerIsGuildOwner && !whitelisted && !ownerMember) {
      log(`[GATEKEEP] Startup sweep — leaving unauthorized server "${guild.name}" (${guild.id})`);
      await guild.leave().catch((err) => log(`[GATEKEEP] Failed to leave "${guild.name}": ${err.message}`));
      continue;
    }
    // Backfill — boss wants the whitelist to track every server the bot is
    // currently in, including ones grandfathered in via boss-as-member.
    if (!whitelisted) {
      addToWhitelist(guild.id, {
        name:       guild.name,
        icon_url:   guild.iconURL?.({ size: 128 }) ?? null,
        members:    guild.memberCount ?? null,
        invited_by: "auto-tracked-on-startup",
      });
      log(`[WHITELIST] auto-tracked "${guild.name}" (${guild.id}) on startup`);
    }
  }

  log(`[Bot] Authorized in ${client.guilds.cache.size} servers after gatekeep sweep`);

  // Warm channel + role caches for every guild so welcome messages, mod logs,
  // and voice features work immediately after a restart without needing cache hits.
  const warmResults = await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      try {
        await Promise.all([
          guild.channels.fetch(),
          guild.roles.fetch(),
        ]);
        log(`[Ready] Cached ${guild.channels.cache.size} channels, ${guild.roles.cache.size} roles for "${guild.name}"`);
        autoDetectGuildChannels(guild);
      } catch (err) {
        log(`[Ready] Failed to warm cache for "${guild.name}": ${err.message}`);
        throw err;
      }

      const persona = getServerPersona(guild.id);
      const targetNick = persona?.name ?? "Irene";
      const me = guild.members.cache.get(client.user.id) ?? await guild.members.fetchMe().catch(() => null);

      await Promise.allSettled([
        (me && me.nickname !== targetNick) ? me.setNickname(targetNick).catch(() => {}) : null,
        cacheInvites(guild),
        updateStatsChannels(guild),
      ]);
    })
  );

  // Surface partial-failure rates so silent degradation doesn't go unnoticed.
  // If > 30% of guilds failed to warm, that probably means a Discord API
  // incident or a cold-start network issue worth looking into.
  const warmFailures = warmResults.filter((r) => r.status === "rejected").length;
  const warmTotal = warmResults.length;
  if (warmTotal > 0 && warmFailures / warmTotal > 0.3) {
    log(`[Ready] WARNING: ${warmFailures}/${warmTotal} guilds failed cache warming (${Math.round(warmFailures / warmTotal * 100)}%)`);
  } else if (warmFailures > 0) {
    log(`[Ready] ${warmFailures}/${warmTotal} guilds failed cache warming (within tolerance)`);
  }

  // ── Restore temp VC state from database ────────────────────────────────────
  // Persisted in real-time unconditionally, survive restarts and crashes
  const savedVcs = getAllTempVcs();
  let restoredVcs = 0;
  // Hoist all dynamic imports outside the loop — ES modules are cached after the first
  // import so there's no performance cost, but doing it inside a loop on every iteration
  // is unnecessarily noisy and causes await overhead on each channel.
  const { tempChannels, tempTextChannels, tempVcSeq, guildVcSeqCounters, tempControlPanels, tempVcCreatedAt, tempVcMembers } = await import("../utils/tempvc.js");
  const { createControlPanel, updateControlPanel } = await import("../utils/vcpanel.js");
  const { transferOwnership } = await import("./voiceStateUpdate.js");
  const { PermissionFlagsBits } = await import("discord.js");
  const { saveTempVc } = await import("../database.js");
  for (const [channelId, vcData] of Object.entries(savedVcs)) {
    const guild = client.guilds.cache.get(vcData.guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (channel) {
      // Verify someone is still in the VC — if empty, delete the channel
      const nonBots = channel.members?.filter((m) => !m.user.bot);
      if (nonBots?.size > 0) {
        // ── Owner verification ────────────────────────────────────────────────
        // The DB's stored ownerId is the source of truth. This VC was
        // created by that user and remains theirs until they leave the
        // guild (handled by the transferOwnership check below).
        //
        // Previous versions of this logic tried to "correct" the owner
        // by scanning permission overwrites for anyone with ManageChannels.
        // Cache iteration order is arbitrary, so a co-host who was briefly
        // given perms — or anyone who still had lingering overwrites —
        // could silently hijack ownership on every redeploy. Don't do
        // that. Trust the DB.
        //
        // If the stored owner has lost ManageChannels somehow (permissions
        // drift, overwrite wiped, etc.) re-grant it so they can actually
        // use the panel. Being owner without perms is useless UX.
        const resolvedOwnerId = vcData.ownerId;
        if (resolvedOwnerId) {
          const storedOverwrite = channel.permissionOverwrites.cache.get(resolvedOwnerId);
          const storedHasManage = storedOverwrite?.allow.has(PermissionFlagsBits.ManageChannels) ?? false;
          if (!storedHasManage) {
            try {
              await channel.permissionOverwrites.edit(resolvedOwnerId, {
                ManageChannels: true,
                MuteMembers: true,
                DeafenMembers: true,
                MoveMembers: true,
              }, { reason: "Restoring temp VC owner perms after restart" });
              log(`[Ready] Re-granted owner perms for ${resolvedOwnerId} on "${channel.name}"`);
            } catch (err) {
              log(`[Ready] Failed to re-grant owner perms on "${channel.name}": ${err.message}`);
            }
          }
        }

        tempChannels.set(channelId, resolvedOwnerId);
        tempVcSeq.set(channelId, vcData.seq || 1);
        if (vcData.textChannelId) tempTextChannels.set(channelId, vcData.textChannelId);
        // Seed per-guild seq counter so new VCs start above restored ones
        const prevSeq = guildVcSeqCounters.get(vcData.guildId) ?? 0;
        if ((vcData.seq || 1) > prevSeq) guildVcSeqCounters.set(vcData.guildId, vcData.seq || 1);
        // Seed VC history maps — without this, the VC close log in voiceStateUpdate
        // has no creation time or member list after a restart.
        if (!tempVcCreatedAt.has(channelId)) tempVcCreatedAt.set(channelId, new Date());
        if (!tempVcMembers.has(channelId)) {
          // Seed with current members — anyone who joined before the restart
          const currentMembers = new Set(
            [...channel.members.values()]
              .filter((m) => !m.user.bot)
              .map((m) => m.id)
          );
          tempVcMembers.set(channelId, currentMembers);
        }
        restoredVcs++;

        // Verify owner is still in the guild (may have left while bot was offline —
        // voiceStateUpdate never fires for server leaves/kicks).
        if (resolvedOwnerId) {
          const ownerMember = guild.members.cache.get(resolvedOwnerId)
            ?? await guild.members.fetch(resolvedOwnerId).catch(() => null);
          if (!ownerMember) {
            log(`[Ready] Owner ${resolvedOwnerId} for "${channel.name}" is no longer in guild — scheduling transfer`);
            // Defer by one tick so panel/state setup finishes first
            setImmediate(() => transferOwnership(channel, guild).catch((err) => {
              log(`[Ready] Transfer after stale-owner detection failed: ${err.message}`);
            }));
          }
        }

        // Restore control panel — use persisted message ID first, fall back to pin search
        const textChId = vcData.textChannelId;
        if (textChId) {
          const textCh = guild.channels.cache.get(textChId);
          if (textCh) {
            try {
              let panelMsg = null;

              // Try persisted panel message ID first (fast, no pin search needed)
              if (vcData.panelMessageId) {
                panelMsg = await textCh.messages.fetch(vcData.panelMessageId).catch(() => null);
              }

              // Fall back to pin search if persisted ID is stale
              if (!panelMsg) {
                const pinned = await textCh.messages.fetchPins?.().catch(() => null)
                  ?? await textCh.messages.fetchPinned?.().catch(() => null);
                // fetchPins returns a Collection, not an array — use .find() on it
                panelMsg = (pinned?.find ? pinned : [...(pinned?.values?.() ?? [])])?.find(
                  (m) => m.author.id === client.user.id &&
                         m.components?.length > 0 &&
                         m.components[0]?.components?.[0]?.customId?.startsWith("vc_panel:")
                );
              }

              if (panelMsg) {
                tempControlPanels.set(channelId, { messageId: panelMsg.id, textChannelId: textChId });
                updateControlPanel(channelId, guild).catch(() => {});
                log(`[Ready] Restored control panel for VC "${channel.name}"`);
              } else {
                createControlPanel(channel, textCh, guild).catch(() => {});
                log(`[Ready] Re-created missing control panel for VC "${channel.name}"`);
              }
            } catch (err) {
              log(`[Ready] Failed to restore panel for "${channel.name}": ${err.message}`);
            }
          }
        }
      } else {
        // VC is empty — clean up channel + paired text channel
        try {
          if (vcData.textChannelId) {
            const textCh = guild.channels.cache.get(vcData.textChannelId);
            if (textCh) await textCh.delete("Temp VC empty after restart").catch(() => {});
          }
          await channel.delete("Temp VC empty after restart").catch(() => {});
        } catch {}
        deleteTempVc(channelId);
      }
    } else {
      // Channel no longer exists in Discord — clear DB entirely
      deleteTempVc(channelId);
    }
  }
  if (restoredVcs > 0) log(`[Ready] Restored ${restoredVcs} temp VC(s)`);

  // ── Periodic empty temp VC sweep (every 2 min) ─────────────────────────────
  // Safety net for cases where voiceStateUpdate missed the delete trigger
  // (cache race condition, shard reconnect, Discord event drop). Scans every
  // tracked temp VC and deletes any that have been empty for 60+ seconds.
  const { deleteTempVc: deleteTempVcDb } = await import("../database.js");
  const _emptyVcTracker = new Map(); // channelId → firstSeenEmptyAt
  setInterval(async () => {
    for (const [channelId, ownerId] of tempChannels.entries()) {
      try {
        // Find the guild this VC belongs to
        let channel = null;
        for (const g of client.guilds.cache.values()) {
          channel = g.channels.cache.get(channelId);
          if (channel) break;
        }
        if (!channel) {
          // Channel was deleted out from under us — clean up state
          log(`[TempVC-Sweep] Channel ${channelId} no longer exists — clearing state`);
          tempChannels.delete(channelId);
          tempTextChannels.delete(channelId);
          tempVcSeq.delete(channelId);
          tempControlPanels.delete(channelId);
          _emptyVcTracker.delete(channelId);
          deleteTempVcDb(channelId);
          continue;
        }
        const nonBots = channel.members?.filter(m => !m.user.bot).size ?? 0;
        if (nonBots === 0) {
          const firstSeen = _emptyVcTracker.get(channelId);
          if (!firstSeen) {
            _emptyVcTracker.set(channelId, Date.now());
          } else if (Date.now() - firstSeen > 60_000) {
            log(`[TempVC-Sweep] Deleting "${channel.name}" — empty for 60+ seconds`);
            const textChId = tempTextChannels.get(channelId);
            tempChannels.delete(channelId);
            tempTextChannels.delete(channelId);
            tempVcSeq.delete(channelId);
            tempControlPanels.delete(channelId);
            _emptyVcTracker.delete(channelId);
            deleteTempVcDb(channelId);
            if (textChId && textChId !== channelId) {
              await channel.guild.channels.cache.get(textChId)?.delete("Empty temp VC sweep").catch(() => {});
            }
            await channel.delete("Empty temp VC sweep").catch((e) => log(`[TempVC-Sweep] Delete failed: ${e.message}`));
          }
        } else {
          // Has members — clear empty tracker
          _emptyVcTracker.delete(channelId);
        }
      } catch (e) {
        log(`[TempVC-Sweep] Error for ${channelId}: ${e.message}`);
      }
    }
  }, 120_000);

  // ── Restore giveaway state from database ───────────────────────────────────
  try {
    const { initGiveawayData } = await import("../commands/fun/giveaway.js");
    initGiveawayData(getGiveawayDb());
    log(`[Ready] Restored giveaway data`);
  } catch (e) { log(`[Ready] Giveaway restore failed: ${e.message}`); }

  // ── Restore highlight state from database ──────────────────────────────────
  try {
    const { initHighlightData } = await import("../commands/utility/highlight.js");
    initHighlightData(getHighlightDb());
    log(`[Ready] Restored highlight data`);
  } catch (e) { log(`[Ready] Highlight restore failed: ${e.message}`); }

  // ── Restore lockdown state ──────────────────────────────────────────────────
  for (const guild of client.guilds.cache.values()) {
    const lockdownExpires = getLockdown(guild.id);
    if (lockdownExpires) {
      const remaining = lockdownExpires - Date.now();
      if (remaining > 0) {
        const { restoreLockdownState } = await import("../utils/safety.js");
        restoreLockdownState(guild.id);
        log(`[Ready] Guild "${guild.name}" was in lockdown — ${Math.round(remaining / 60_000)}min remaining`);
        setTimeout(async () => {
          const { deactivateLockdown } = await import("../utils/safety.js");
          await deactivateLockdown(guild, "auto-unlock after restart recovery");
        }, remaining);
      } else {
        // Lockdown expired while bot was down — unlock now
        const { deactivateLockdown } = await import("../utils/safety.js");
        await deactivateLockdown(guild, "lockdown expired during restart");
      }
    }

    // Restore auto-slowmode
    const slowmodes = getAutoSlowmodes(guild.id);
    for (const [channelId, expiresAt] of Object.entries(slowmodes)) {
      const remaining = expiresAt - Date.now();
      const ch = guild.channels.cache.get(channelId);
      if (!ch) { clearSlowmode(channelId, guild.id); continue; }
      if (remaining > 0) {
        setTimeout(async () => {
          try { await ch.setRateLimitPerUser(0, "Auto-mod: slowmode expired (post-restart)"); } catch {}
          clearSlowmode(channelId, guild.id);
        }, remaining);
      } else {
        try { await ch.setRateLimitPerUser(0, "Auto-mod: slowmode expired during restart"); } catch {}
        clearSlowmode(channelId, guild.id);
      }
    }
  }

  // Stats channels: update every 5 minutes — all guilds in parallel (Feature 17)
  setInterval(() => {
    Promise.allSettled([...client.guilds.cache.values()].map((g) => updateStatsChannels(g)));
  }, 5 * 60_000);

  // Birthday check — run at startup then every hour
  checkBirthdays(client).catch(() => {});
  setInterval(() => checkBirthdays(client).catch(() => {}), 60 * 60_000);

  // ── Weekly server digest (Sunday 12:00 local) ──────────────────────────
  setInterval(async () => {
    try {
      const { weeklyDigestTick } = await import("../ai/weeklyDigest.js");
      await weeklyDigestTick(client);
    } catch (e) { log(`[Digest] Tick error: ${e.message}`); }
  }, 15 * 60_000);

  // ── Seasonal color rotation — check every hour ────────────────────────────
  const runSeasonalCheck = async () => {
    try {
      const { getCurrentPalette, rotateSeasonalColors } = await import("../utils/seasonalColors.js");
      const { getColorRoles, getSeasonalColors, getLastSeasonalPalette, setLastSeasonalPalette } = await import("../database.js");
      const palette = getCurrentPalette();

      for (const guild of client.guilds.cache.values()) {
        if (!getSeasonalColors(guild.id)) continue; // Not enabled for this guild
        const colorRoleIds = getColorRoles(guild.id);
        if (!colorRoleIds.length) continue;

        // Only rotate if palette changed since last check
        const lastPalette = getLastSeasonalPalette(guild.id);
        if (lastPalette === palette.name) continue;

        const result = await rotateSeasonalColors(guild, colorRoleIds);
        if (result.updated > 0) {
          log(`[Seasonal] ${guild.name}: rotated ${result.updated} colors to "${result.season}" ${result.emoji}`);
          setLastSeasonalPalette(guild.id, palette.name);

          // Announce the palette change in mod log
          const { sendModLog } = await import("../utils/logger.js");
          const { logEmbed, LC } = await import("../utils/embeds.js");
          const embed = logEmbed(`${result.emoji} Seasonal Colors: ${result.season}`, LC.role)
            .setDescription(`Color roles have been updated to the **${result.season}** palette!\n\n${palette.colors.map((c, i) => `\`${c.hex}\` ${c.name}`).join("\n")}`);
          await sendModLog(guild, embed);
        }
      }
    } catch (err) {
      log(`[Seasonal] Error: ${err.message}`);
    }
  };
  runSeasonalCheck(); // Run at startup
  setInterval(runSeasonalCheck, 60 * 60_000); // Then every hour
  log("[Seasonal] Color rotation checker started (hourly)");

  // ── Patch news — check every hour ──────────────────────────────────────────
  // One lightweight HTTP request per feed per hour — negligible load.
  // Persisted in DB so restarts don't cause duplicate posts.
  checkFeeds(client).catch(() => {});
  setInterval(() => checkFeeds(client).catch(() => {}), 60 * 60_000); // every hour
  log("[PatchBot] Checking every hour");

  // Load long-term conversational memory
  try {
    const { loadLongMemory } = await import("../ai/longmemory.js");
    await loadLongMemory();
  } catch (e) { log(`[LongMemory] Init failed: ${e.message}`); }

  // Load humanity/relationship data from Supabase
  try {
    const { deserialize: deserializeHumanity } = await import("../ai/humanity.js");
    const sb = getSupabase();
    if (sb) {
      const { data: row } = await sb.from("bot_data").select("data").eq("id", "irene_humanity").single();
      if (row?.data) {
        deserializeHumanity(row.data);
        log(`[Humanity] Loaded from Supabase`);
      }
    }
  } catch (e) { log(`[Humanity] Init failed: ${e.message}`); }

  // Save humanity data periodically (every 5 min)
  setInterval(async () => {
    try {
      const { serialize: getHumanityData } = await import("../ai/humanity.js");
      const sb = getSupabase();
      if (sb) {
        await sb.from("bot_data").upsert({ id: "irene_humanity", data: getHumanityData() });
      }
    } catch {}
  }, 300_000);

  // ── Twitch live check — every 3 minutes ──────────────────────────────────
  // Twitch needs frequent polling to catch stream start quickly,
  // but 2min was a bit aggressive. 3min is a good balance.
  checkStreams(client).catch(() => {});
  setInterval(() => checkStreams(client).catch(() => {}), 3 * 60_000);

  // Load and schedule pending reminders (Feature 19)
  const reminders = getReminders();
  const now = Date.now();
  for (const reminder of reminders) {
    const delay = reminder.fireAt - now;
    const fire = async () => {
      reminderTimers.delete(reminder.id);
      try {
        const guild = client.guilds.cache.get(reminder.guildId);
        const channel = guild?.channels.cache.get(reminder.channelId);
        if (channel) {
          await channel.send(`<@${reminder.userId}> ⏰ Reminder: ${reminder.message}`);
        } else {
          // Try DM
          const user = await client.users.fetch(reminder.userId).catch(() => null);
          if (user) await user.send(`⏰ Reminder: ${reminder.message}`).catch(() => {});
        }
      } catch {}
      removeReminder(reminder.id);
    };
    if (delay <= 0) {
      // Already passed — fire immediately
      fire().catch((e) => log(`[Reminder] Failed to deliver: ${e.message}`));
    } else {
      const timerId = setTimeout(() => {
        reminderTimers.delete(reminder.id);
        fire().catch((e) => log(`[Reminder] Failed: ${e.message}`));
      }, delay);
      reminderTimers.set(reminder.id, timerId);
    }
  }

  // ── Restore pending scheduled tasks (deferred tool calls) ─────────────────
  try {
    const { restoreScheduledTasks } = await import("../utils/scheduler.js");
    await restoreScheduledTasks(client);
  } catch (e) { log(`[Schedule] Startup restore failed: ${e.message}`); }

  // ── Personality learning — periodic trait check (every 6 hours) ───────────
  setInterval(async () => {
    try {
      const { buildPersonalityContext } = await import("../ai/personality.js");
      const ctx = await buildPersonalityContext(null, null);
      if (ctx) log(`[Personality] Periodic check — active traits:\n${ctx}`);
      else log("[Personality] Periodic check — no significant trait shifts yet");
    } catch (e) { log(`[Personality] Check failed: ${e.message}`); }
  }, 6 * 3600_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTONOMOUS CONSCIOUSNESS LOOP ("Heartbeat") — Irene
  // Runs every 15 minutes. Generates independent thoughts, goals, reflections.
  // ═══════════════════════════════════════════════════════════════════════════

  let _cumulativeImportance = 0;
  const _goals = { short: [], medium: [], long: [] };
  const _reflections = [];

  try {
    const sb = getSupabase() || null;
    if (sb) {
      const { data: row } = await sb.from("bot_data").select("data").eq("id", "irene_consciousness").single();
      if (row?.data) {
        if (row.data.goals) Object.assign(_goals, row.data.goals);
        if (row.data.reflections) _reflections.push(...row.data.reflections.slice(-10));
        if (row.data.cumulativeImportance) _cumulativeImportance = row.data.cumulativeImportance;
        log(`[CONSCIOUSNESS] Loaded ${_reflections.length} reflections, ${_goals.short.length + _goals.medium.length + _goals.long.length} goals`);
      }
    }
  } catch {}

  setInterval(async () => {
    try {
      const mood = getMood();
      const { getMonologue, getMoodNarrative, addThought } = await import("../ai/longmemory.js");

      const recentThoughts = getMonologue();
      const moodNarrative = getMoodNarrative();
      const thoughtContext = recentThoughts.slice(-5).map(t => `- "${t.thought}"`).join("\n") || "none yet";
      const goalContext = [..._goals.short.map(g => `[short] ${g}`), ..._goals.medium.map(g => `[medium] ${g}`)].join("\n") || "none yet";
      const reflectionContext = _reflections.slice(-3).map(r => `- "${r.text}"`).join("\n") || "none yet";
      const timeOfDay = new Date().getHours();
      const timeLabel = timeOfDay < 6 ? "late night" : timeOfDay < 12 ? "morning" : timeOfDay < 18 ? "afternoon" : "evening";

      const text = await generateAutonomousText({
        prompt: "heartbeat",
        systemInstruction: `You are Irene's inner consciousness — not responding to anyone, just existing. It's ${timeLabel}.
Your mood: ${mood.mood_score > 20 ? "good" : mood.mood_score < -20 ? "off" : "neutral"} (${moodNarrative || "no reason"})
Recent thoughts: ${thoughtContext}
Goals: ${goalContext}
Reflections: ${reflectionContext}

Generate 2 lines:
LINE 1: One genuine inner thought. Reference real things — people you know, server stuff, your sister Eris, or how you feel. Under 120 chars.
LINE 2: Goal update — NEW: / PROGRESS: / DONE: / DROP: or NONE. Under 100 chars.
Write as Irene thinking to herself. Lowercase.`,
        maxOutputTokens: 100,
      });

      const lines = (text || "").trim().split("\n").filter(Boolean);
      if (lines[0]?.length > 10 && lines[0].length < 200) {
        addThought(lines[0].trim());
        _cumulativeImportance += lines[0].includes("boss") || lines[0].includes("eris") ? 3 : 1;
      }
      if (lines[1] && !lines[1].startsWith("NONE")) {
        const g = lines[1].trim();
        if (g.startsWith("NEW:") && g.length > 8) { _goals.short.push(g.replace("NEW:", "").trim()); if (_goals.short.length > 5) _goals.short.shift(); }
        else if (g.startsWith("DONE:") || g.startsWith("DROP:")) {
          const t = g.replace(/^(DONE|DROP):/, "").trim().toLowerCase();
          _goals.short = _goals.short.filter(x => !x.toLowerCase().includes(t.substring(0, 20)));
        }
      }

      // Reflection when enough important things accumulated
      if (_cumulativeImportance >= 15) {
        _cumulativeImportance = 0;
        try {
          const rText = await generateAutonomousText({
            prompt: "reflect",
            systemInstruction: `You are Irene reflecting. Recent thoughts: ${thoughtContext}\nGoals: ${goalContext}\nWrite ONE self-reflection about patterns you notice in yourself. Under 150 chars. Lowercase.`,
            maxOutputTokens: 60,
          });
          if (rText?.length > 15 && rText.length < 200) {
            _reflections.push({ text: rText, at: Date.now() });
            if (_reflections.length > 10) _reflections.shift();
            addThought(`[reflection] ${rText}`);
          }
        } catch {}
      }

      // Save
      try {
        const sb = getSupabase() || null;
        if (sb) await sb.from("bot_data").upsert({ id: "irene_consciousness", data: { goals: _goals, reflections: _reflections.slice(-10), cumulativeImportance: _cumulativeImportance } });
      } catch {}
    } catch (e) { log(`[CONSCIOUSNESS] Heartbeat error: ${e.message}`); }
  }, 900_000); // Every 15 minutes

  // ── Temp-ban expiry check — every 30 seconds ────────────────────────────────
  setInterval(async () => {
    try {
      const { getExpiredTempBans, removeTempBan } = await import("../database.js");
      const expired = getExpiredTempBans();
      for (const ban of expired) {
        const guild = client.guilds.cache.get(ban.guildId);
        if (!guild) continue;
        try {
          await guild.members.unban(ban.userId, "Temp ban expired");
          log(`[TEMPBAN] Auto-unbanned ${ban.username} (${ban.userId}) from ${guild.name}`);
          // Log to mod log
          const { sendModLog } = await import("../utils/logger.js");
          const { logEmbed, LC } = await import("../utils/embeds.js");
          const embed = logEmbed("Temp Ban Expired", LC.unban)
            .addFields(
              { name: "User", value: `${ban.username} (<@${ban.userId}>)`, inline: true },
              { name: "Originally Banned", value: `<t:${Math.floor(new Date(ban.bannedAt).getTime() / 1000)}:R>`, inline: true },
              { name: "Reason", value: ban.reason || "No reason provided" },
            );
          await sendModLog(guild, embed);
        } catch (err) {
          log(`[TEMPBAN] Failed to unban ${ban.userId}: ${err.message}`);
        }
      }
    } catch {}
  }, 30_000); // Check every 30 seconds

  // Initial presence grab
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(config.ownerId);
    if (member?.presence) {
      updatePresence(member.presence);
      break;
    }
  }
}
