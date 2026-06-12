// ─── Auto-AFK Voice Move ─────────────────────────────────────────────────────
// Tracks voice inactivity (no state changes for X mins, or alone in VC).
// After the timeout, DMs the user asking if they're still there.
// If they reply → reset timer. If no reply in 5 mins → move to AFK channel.

import { getGuildSettings, isDmOptout, getVcTemplate, getVcDefaultLimit, saveTempVc, deleteTempVc, addVoiceTime, getVerificationRole } from "../database.js";
import { log, sendModLog } from "../utils/logger.js";
import { logEmbed, LC, logEvent } from "../utils/embeds.js";
import { EmbedBuilder, ChannelType, PermissionFlagsBits } from "discord.js";
import { tempChannels, pendingCreateVcUsers, tempTextChannels, tempVcSeq, renameTimers, tempControlPanels, tempVcCreatedAt, tempVcMembers, ownerGraceTimers, guildVcSeqCounters, manualRenames, TEMP_VC_OWNER_ALLOW, TEMP_VC_OWNER_OVERWRITE } from "../utils/tempvc.js";
import { applyVcTemplate, queueRename, initRenameTimer } from "../utils/vcrenamer.js";
import { createControlPanel, updateControlPanel } from "../utils/vcpanel.js";
import { getQueue, handleVoiceMembershipChange } from "../music/player.js";

// ─── VC History: format duration ─────────────────────────────────────────────
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Ownership transfer helper ────────────────────────────────────────────────
export async function transferOwnership(channel, guild) {
  const nonBots = channel.members.filter((m) => !m.user.bot);
  if (nonBots.size === 0) {
    // Channel will auto-delete in main loop — nothing to do here
    return;
  }
  const newOwner = nonBots.first();
  try {
    await channel.permissionOverwrites.edit(newOwner, {
      ...TEMP_VC_OWNER_OVERWRITE,
    });
    tempChannels.set(channel.id, newOwner.id);
    manualRenames.delete(channel.id); // new owner — auto-renamer should pick up their game
    const seq = tempVcSeq.get(channel.id) || 1;
    const textChannelId = tempTextChannels.get(channel.id) || null;
    saveTempVc(channel.id, { ownerId: newOwner.id, guildId: guild.id, seq, textChannelId });
    log(`[TempVC] Transferred ownership of "${channel.name}" to ${newOwner.user.tag}`);
    
    // Trigger rename so the channel updates to show the NEW owner's name instead of the old one
    queueRename(channel, guild);
    updateControlPanel(channel.id, guild).catch(() => {});
  } catch (err) {
    log(`[TempVC] Failed to transfer ownership of "${channel.name}" to ${newOwner.user.tag}: ${err.message} — keeping previous owner`);
    // Don't update in-memory state if Discord API call failed
  }
}

// ─── Voice Activity Tracking ─────────────────────────────────────────────────
// Tracks when users join/leave voice to accumulate total time per user.
// key: "guildId-userId" -> { userId, guildId, joinedAt }
const voiceSessions = new Map();

// Prune sessions older than 24h — catches orphans from restarts or missed leave events
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [key, session] of voiceSessions) {
    if (session.joinedAt < cutoff) voiceSessions.delete(key);
  }
}, 3600_000); // runs every hour

// key: "guildId-userId" -> { checkTimer, guildId, userId, client }
const tracked = new Map();

// Active DM collectors waiting for AFK reply: key -> collector
const afkCollectors = new Map();

function clearTracking(key) {
  const data = tracked.get(key);
  if (data?.checkTimer) clearTimeout(data.checkTimer);
  tracked.delete(key);
  // Cancel any pending DM collector so it doesn't fire after member left voice
  if (afkCollectors.has(key)) {
    afkCollectors.get(key).stop();
    afkCollectors.delete(key);
  }
}

function startTracking(key, guild, userId, timeoutMs) {
  // Clear any existing timer
  const prev = tracked.get(key);
  if (prev?.checkTimer) clearTimeout(prev.checkTimer);

  const checkTimer = setTimeout(() => runAfkCheck(key, guild, userId), timeoutMs);
  tracked.set(key, { checkTimer, guildId: guild.id, userId, client: guild.client });
}

async function runAfkCheck(key, guild, userId) {
  tracked.delete(key); // remove so we don't double-fire

  const settings = getGuildSettings(guild.id);
  if (!settings?.afk_channel_id) return;

  const afkChannelId = settings.afk_channel_id;
  // Clamp to sane range — 0 would fire instantly, huge values would never fire
  const timeoutMins = Math.max(1, Math.min(1440, settings.afk_timeout_minutes ?? 30));

  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    return; // member left server
  }

  if (!member.voice?.channel) return;
  if (member.voice.channel.id === afkChannelId) return;

  const channelName = member.voice.channel.name;
  const isAlone = member.voice.channel.members.filter((m) => !m.user.bot).size === 1;
  const aloneNote = isAlone ? " (you're alone in there btw)" : "";

  // Skip DM check if user opted out — move them directly when timer fires
  if (isDmOptout(member.id)) {
    await moveToAfk(member, guild, afkChannelId);
    return;
  }

  // Try to DM them
  let dmChannel;
  let checkMsg;
  try {
    dmChannel = await member.user.createDM();
    checkMsg = await dmChannel.send(
      `hey — you've been quiet in **${channelName}** for ${timeoutMins} min${timeoutMins !== 1 ? "s" : ""}${aloneNote}. still there? ` +
      `reply anything and i'll leave you alone for another ${timeoutMins} mins. ` +
      `if i don't hear back in 5 mins i'll move you to AFK.`
    );
    log(`[AFK] Sent check to ${member.user.tag} in ${guild.name}`);
  } catch {
    // DMs are closed — move them directly
    await moveToAfk(member, guild, afkChannelId);
    return;
  }

  // Collect any reply within 5 minutes
  const collector = dmChannel.createMessageCollector({ max: 1, time: 5 * 60 * 1000 });
  afkCollectors.set(key, collector);

  // Flag prevents the race where collect fires async and end fires simultaneously
  // with collected.size === 0 before the collect handler increments the collection.
  let _responded = false;

  collector.on("collect", async (replyMsg) => {
    _responded = true;
    afkCollectors.delete(key);
    log(`[AFK] ${member.user.tag} responded — resetting timer`);
    startTracking(key, guild, userId, timeoutMins * 60 * 1000);
    await Promise.all([checkMsg.delete().catch(() => {}), replyMsg.delete().catch(() => {})]);
  });

  collector.on("end", async (collected) => {
    afkCollectors.delete(key);
    if (_responded || collected.size > 0) return; // they responded, already handled above

    // No reply — delete the check message then move to AFK
    await checkMsg.delete().catch(() => {});
    try {
      const freshMember = await guild.members.fetch(userId).catch(() => null);
      if (!freshMember?.voice?.channel) return;
      if (freshMember.voice.channel.id === afkChannelId) return;
      await moveToAfk(freshMember, guild, afkChannelId);
    } catch (err) {
      log(`[AFK] Move error: ${err.message}`);
    }
  });
}

async function moveToAfk(member, guild, afkChannelId) {
  const afkChannel = guild.channels.cache.get(afkChannelId);
  if (!afkChannel) return;
  try {
    await member.voice.setChannel(afkChannel, "Auto-AFK: inactive in voice");
    log(`[AFK] Moved ${member.user.tag} to "${afkChannel.name}" in ${guild.name}`);
  } catch (err) {
    log(`[AFK] Could not move ${member.user.tag}: ${err.message}`);
  }
}

// ─── Voice Logging ────────────────────────────────────────────────────────────

// Track when each member joined voice so we can report session duration on leave.
// Keyed by `guildId:userId`. Survives re-joins within the same process.
const _voiceJoinedAt = new Map();
function _markJoined(guildId, userId) { _voiceJoinedAt.set(`${guildId}:${userId}`, Date.now()); }
function _popJoined(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const ts = _voiceJoinedAt.get(key);
  _voiceJoinedAt.delete(key);
  return ts;
}

// Track recent server-level kick/ban events so a voice disconnect fired right
// after one can be attributed to "kicked from server" / "banned" correctly
// rather than being reported as a plain self-leave.
// Keyed by `guildId:userId` → { kind: "kick"|"ban", actor, reason, ts }.
const _recentServerRemovals = new Map();
const _SERVER_REMOVAL_TTL = 30_000; // wider window — Discord API can lag under load
export function recordServerRemoval(guildId, userId, kind, actor, reason) {
  const key = `${guildId}:${userId}`;
  const existing = _recentServerRemovals.get(key);
  // "ban" beats "kick" within the same window — both events fire for a ban
  // but the ban classification is the one we want to report.
  if (existing?.kind === "ban" && kind !== "ban") return;
  _recentServerRemovals.set(key, { kind, actor, reason, ts: Date.now() });
  setTimeout(() => _recentServerRemovals.delete(key), _SERVER_REMOVAL_TTL);
}
function _consumeServerRemoval(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const hit = _recentServerRemovals.get(key);
  if (hit && Date.now() - hit.ts < _SERVER_REMOVAL_TTL) {
    _recentServerRemovals.delete(key);
    return hit;
  }
  return null;
}

// Track guilds we've already warned about missing ViewAuditLog — one warning
// per guild instead of flooding logs every event.
const _missingAuditPermWarned = new Set();

// Audit-log cache — TTL'd, includes room for up to 20 recent entries so we can
// MATCH BY TARGET instead of blindly trusting the first row. Previously, if two
// voice events fired back-to-back we'd attribute both to the same audit entry.
const _auditLogCache = new Map();
const AUDIT_CACHE_TTL = 1500;

async function fetchRecentAuditEntries(guild, type) {
  const key = `${guild.id}:${type}`;
  const cached = _auditLogCache.get(key);
  if (cached && Date.now() - cached.timestamp < AUDIT_CACHE_TTL) return cached.entries;
  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 20 });
    const entries = [...audit.entries.values()];
    _auditLogCache.set(key, { timestamp: Date.now(), entries });
    return entries;
  } catch (err) {
    if (err?.code === 50013 && !_missingAuditPermWarned.has(guild.id)) {
      _missingAuditPermWarned.add(guild.id);
      try { const { log } = await import("../utils/logger.js"); log(`[ModLog] Missing View Audit Log permission in "${guild.name}" — mod events will show as "(unknown)"`); } catch {}
    }
    return [];
  }
}

// Find the most-recent audit entry matching a target user, within a time window.
// Retries once with a short delay — Discord's audit log is eventually consistent
// (~500ms-2s lag), so immediate fetches after an event often miss.
async function findTargetedAudit(guild, type, targetId, windowMs = 8000) {
  let entries = await fetchRecentAuditEntries(guild, type);
  const match = (list) => {
    const now = Date.now();
    for (const e of list) {
      if (e.target?.id !== targetId) continue;
      if (now - e.createdTimestamp > windowMs) continue;
      return e;
    }
    return null;
  };
  let hit = match(entries);
  if (hit) return hit;
  // Retry once after 1.2s — gives Discord time to index the entry.
  await new Promise(r => setTimeout(r, 1200));
  _auditLogCache.delete(`${guild.id}:${type}`);
  entries = await fetchRecentAuditEntries(guild, type);
  return match(entries);
}

// Human-friendly actor label — flags bots explicitly so mod embeds distinguish
// "disconnected by moderator" vs "disconnected by [bot]".
function describeActor(user) {
  if (!user) return null;
  return user.bot
    ? `<@${user.id}> · \`${user.tag}\` 🤖 *(bot)*`
    : `<@${user.id}> · \`${user.tag}\``;
}

async function logVoiceEvent(guild, member, oldState, newState) {
  const settings = getGuildSettings(guild.id);
  const triggerChId = settings?.create_vc_channel_id;

  // Suppress the noisy double-log from join-to-create:
  // 1. joining trigger channel (immediately moved away)
  // 2. bot-initiated move from trigger → new VC
  if (triggerChId) {
    if (newState.channel?.id === triggerChId) return;
    if (oldState.channel?.id === triggerChId && newState.channel) return;
  }

  const oldCh = oldState.channel;
  const newCh = newState.channel;

  // ─── Joined voice ──────────────────────────────────────────────────────────
  if (!oldCh && newCh) {
    _markJoined(guild.id, member.id);
    const humanCount = newCh.members.filter((m) => !m.user.bot).size;
    await sendModLog(guild, logEvent({
      kind: "voiceJoin",
      target: member.user,
      description: `<@${member.id}> joined <#${newCh.id}>.`,
      meta: {
        "Channel": `<#${newCh.id}> · \`${newCh.name}\``,
        "Occupancy": `${humanCount}/${newCh.userLimit || "∞"}`,
        "Bitrate": newCh.bitrate ? `${Math.round(newCh.bitrate / 1000)}kbps` : null,
        "Self-Muted": newState.selfMute ? "yes" : null,
        "Self-Deafened": newState.selfDeaf ? "yes" : null,
        "Streaming": newState.streaming ? "yes 📹" : null,
        "Camera On": newState.selfVideo ? "yes 📷" : null,
      },
    }));
    return;
  }

  // ─── Left voice (or was disconnected) ──────────────────────────────────────
  if (oldCh && !newCh) {
    const joinedAt = _popJoined(guild.id, member.id);
    const durationStr = joinedAt ? formatDuration(Date.now() - joinedAt) : null;

    // Layered cause detection — most specific wins:
    //   1. Server kick/ban recorded seconds ago → kicked-from-server
    //   2. VOICE_DISCONNECT audit entry targeting this user → forced disconnect
    //   3. Otherwise → self-disconnect or natural (network) cause
    const serverRemoval = _consumeServerRemoval(guild.id, member.id);
    const disconnectEntry = serverRemoval
      ? null
      : await findTargetedAudit(guild, 27, member.id); // MEMBER_DISCONNECT

    let kind = "voiceLeave";
    let descriptionPrefix;
    let causeLine;
    let actor = null;
    let reason = null;
    let color;

    if (serverRemoval) {
      actor = serverRemoval.actor;
      reason = serverRemoval.reason;
      descriptionPrefix = serverRemoval.kind === "ban"
        ? `<@${member.id}> was removed from <#${oldCh.id}> because they were **banned from the server**`
        : `<@${member.id}> was removed from <#${oldCh.id}> because they were **kicked from the server**`;
      causeLine = serverRemoval.kind === "ban" ? "banned from server" : "kicked from server";
      color = 0xed4245; // danger
    } else if (disconnectEntry && disconnectEntry.executor) {
      actor = disconnectEntry.executor;
      reason = disconnectEntry.reason;
      const selfInitiated = disconnectEntry.executor.id === member.id;
      if (selfInitiated) {
        descriptionPrefix = `<@${member.id}> left <#${oldCh.id}>`;
        causeLine = "self-initiated (via Discord UI)";
        color = 0x95a5a6; // gray
      } else if (disconnectEntry.executor.bot) {
        descriptionPrefix = `<@${member.id}> was disconnected from <#${oldCh.id}> by bot <@${disconnectEntry.executor.id}>`;
        causeLine = "bot-initiated";
        color = 0xed4245;
      } else {
        descriptionPrefix = `<@${member.id}> was disconnected from <#${oldCh.id}> by <@${disconnectEntry.executor.id}>`;
        causeLine = "moderator disconnect";
        color = 0xed4245;
      }
    } else {
      // No audit entry and no server-level event recorded. This is either a
      // self-disconnect OR a network drop / Discord outage — the two are
      // genuinely indistinguishable from the bot's perspective.
      descriptionPrefix = `<@${member.id}> left <#${oldCh.id}>`;
      causeLine = "self-left or network drop";
      color = 0x95a5a6;
    }

    await sendModLog(guild, logEvent({
      kind,
      target: member.user,
      actor,
      reason: reason || undefined,
      description: `${descriptionPrefix}.`,
      meta: {
        "Channel": `<#${oldCh.id}> · \`${oldCh.name}\``,
        "Cause": causeLine,
        "Moderator": actor ? describeActor(actor) : null,
        "Session Duration": durationStr,
        "Was Streaming": oldState.streaming ? "yes" : null,
        "Was on Camera": oldState.selfVideo ? "yes" : null,
        "Was Muted": oldState.mute ? (oldState.serverMute ? "yes (server)" : "yes (self)") : null,
        "Was Deafened": oldState.deaf ? (oldState.serverDeaf ? "yes (server)" : "yes (self)") : null,
      },
      color,
    }));
    return;
  }

  // ─── Switched / was moved between channels ─────────────────────────────────
  if (oldCh && newCh && oldCh.id !== newCh.id) {
    const moveEntry = await findTargetedAudit(guild, 26, member.id); // MEMBER_MOVE
    let actor = null;
    let reason = null;
    let causeLine;
    if (moveEntry && moveEntry.executor && moveEntry.executor.id !== member.id) {
      actor = moveEntry.executor;
      reason = moveEntry.reason;
      causeLine = actor.bot ? "moved by bot" : "moved by moderator";
    } else {
      causeLine = "self-moved";
    }

    const humanNew = newCh.members.filter((m) => !m.user.bot).size;
    const humanOld = oldCh.members.filter((m) => !m.user.bot).size;

    await sendModLog(guild, logEvent({
      kind: "voiceMove",
      target: member.user,
      actor,
      reason: reason || undefined,
      description: actor
        ? `<@${member.id}> was moved from <#${oldCh.id}> to <#${newCh.id}> by ${actor.bot ? "bot " : ""}<@${actor.id}>.`
        : `<@${member.id}> switched from <#${oldCh.id}> to <#${newCh.id}>.`,
      meta: {
        "From": `<#${oldCh.id}> · ${humanOld}/${oldCh.userLimit || "∞"}`,
        "To": `<#${newCh.id}> · ${humanNew}/${newCh.userLimit || "∞"}`,
        "Cause": causeLine,
        "Moderator": actor ? describeActor(actor) : null,
      },
    }));
    return;
  }

  // ─── State change within same channel (server mute/deafen) ────────────────
  const changes = [];
  if (!oldState.serverMute && newState.serverMute) changes.push("🔇 Server Muted");
  if (oldState.serverMute && !newState.serverMute) changes.push("🔊 Server Unmuted");
  if (!oldState.serverDeaf && newState.serverDeaf) changes.push("🙉 Server Deafened");
  if (oldState.serverDeaf && !newState.serverDeaf) changes.push("🙈 Server Undeafened");
  if (!changes.length) return;

  const muteEntry = await findTargetedAudit(guild, 24, member.id); // MEMBER_UPDATE
  let actor = null;
  let reason = null;
  if (muteEntry && muteEntry.executor && muteEntry.executor.id !== member.id) {
    actor = muteEntry.executor;
    reason = muteEntry.reason;
  }

  await sendModLog(guild, logEvent({
    kind: "audit",
    title: "Voice State Changed",
    target: member.user,
    actor,
    reason: reason || undefined,
    description: actor
      ? `<@${member.id}>'s voice state was changed by ${actor.bot ? "bot " : ""}<@${actor.id}>.`
      : `<@${member.id}>'s voice state changed.`,
    meta: {
      "Channel": (newCh ?? oldCh) ? `<#${(newCh ?? oldCh).id}>` : "*(unknown)*",
      "Action": changes.join(", "),
      "By": actor ? describeActor(actor) : "*(self or Discord)*",
    },
    color: 0xfee75c,
  }));
}

// ─── Event Handler ───────────────────────────────────────────────────────────

export const name = "voiceStateUpdate";

export async function execute(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  // ── Voice-capture consent notice ──────────────────────────────────────────
  // If a /listen session is live in the channel the member just joined, give
  // them a one-time recording notice (once per member per session — tracked in
  // the listener's session state). Best-effort; never blocks the handler.
  if (newState.channel && oldState.channel?.id !== newState.channel.id) {
    try {
      const { notifyMemberJoined } = await import("../voice/listener.js");
      await notifyMemberJoined(guild.id, newState.channel.id, member);
    } catch { /* listener module unavailable — nothing to notify */ }
  }

  // Log voice events to mod log channel
  await logVoiceEvent(guild, member, oldState, newState);

  // ── Voice activity tracking ───────────────────────────────────────────────
  const vsKey = `${guild.id}-${member.id}`;
  const joinedVoice = !oldState.channel && newState.channel;
  const leftVoice = oldState.channel && !newState.channel;
  const switchedChannel = oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id;

  if (joinedVoice || (switchedChannel && !voiceSessions.has(vsKey))) {
    voiceSessions.set(vsKey, { userId: member.id, guildId: guild.id, joinedAt: Date.now() });
  }

  if (leftVoice) {
    const session = voiceSessions.get(vsKey);
    if (session) {
      const minutes = Math.round((Date.now() - session.joinedAt) / 60000);
      if (minutes > 0) addVoiceTime(guild.id, member.id, minutes);
      voiceSessions.delete(vsKey);
    }
  }

  const settings = getGuildSettings(guild.id);

  // ── Music: pause + schedule disconnect when the bot is left alone in its VC ──
  // (and resume/cancel when a human rejoins). Only react to changes touching the
  // bot's active music channel; the helper no-ops when there's no queue.
  const musicQueue = getQueue(guild.id);
  const musicVcId = musicQueue?.voiceChannel?.id;
  if (musicVcId && (oldState.channel?.id === musicVcId || newState.channel?.id === musicVcId)) {
    handleVoiceMembershipChange(guild.id);
  }

  // ── Auto-delete temp VC when it empties ──────────────────────────────────
  if (oldState.channel && tempChannels.has(oldState.channel.id)) {
    const ch = oldState.channel;
    const nonBots = ch.members.filter((m) => !m.user.bot).size;

    // Track member history (Feature 1)
    if (!tempVcMembers.has(ch.id)) tempVcMembers.set(ch.id, new Set());

    // Handle owner leave — grace period (Feature 2)
    const ownerId = tempChannels.get(ch.id);
    if (member.id === ownerId && nonBots > 0) {
      // Cancel any existing grace timer
      const existing = ownerGraceTimers.get(ch.id);
      if (existing?.timer) clearTimeout(existing.timer);

      const timer = setTimeout(async () => {
        ownerGraceTimers.delete(ch.id);
        // If channel still exists and they still haven't rejoined, transfer
        const freshCh = guild.channels.cache.get(ch.id);
        if (!freshCh || !tempChannels.has(ch.id)) return;
        if (tempChannels.get(ch.id) !== ownerId) return; // already transferred
        // Verify owner is still in the guild — they may have left while the timer was pending
        const ownerStillInGuild = guild.members.cache.has(ownerId)
          || await guild.members.fetch(ownerId).then(() => true).catch(() => false);
        if (!ownerStillInGuild) {
          log(`[TempVC] Grace timer: owner ${ownerId} left guild — forcing transfer`);
        }
        await transferOwnership(freshCh, guild);
      }, 60_000);

      ownerGraceTimers.set(ch.id, { timer, ownerId });
    }

    if (nonBots === 0) {
      // Cancel grace timer if pending
      const grace = ownerGraceTimers.get(ch.id);
      if (grace?.timer) clearTimeout(grace.timer);
      ownerGraceTimers.delete(ch.id);

      // ── VC History Log (Feature 1) ───────────────────────────────────
      const createdAt = tempVcCreatedAt.get(ch.id);
      const members = tempVcMembers.get(ch.id) ?? new Set();
      const channelOwnerId = tempChannels.get(ch.id);

      if (createdAt) {
        const duration = formatDuration(Date.now() - createdAt.getTime());
        const memberMentions = members.size > 0
          ? [...members].map((id) => `<@${id}>`).join(", ")
          : "none";

        const histEmbed = new EmbedBuilder()
          .setTitle("🔊 Temp VC Closed")
          .setColor(0x5865f2)
          .addFields(
            { name: "Channel", value: ch.name, inline: true },
            { name: "Owner", value: channelOwnerId ? `<@${channelOwnerId}>` : "unknown", inline: true },
            { name: "Duration", value: duration, inline: true },
            { name: "Members", value: memberMentions.slice(0, 1024) },
          )
          .setTimestamp();
        await sendModLog(guild, histEmbed);
      }

      // Clean up history maps
      tempVcCreatedAt.delete(ch.id);
      tempVcMembers.delete(ch.id);

      // Clean up all state for this VC
      tempChannels.delete(ch.id);
      deleteTempVc(ch.id);
      tempVcSeq.delete(ch.id);
      tempControlPanels.delete(ch.id);
      manualRenames.delete(ch.id);
      const rt = renameTimers.get(ch.id);
      if (rt?.timer) clearTimeout(rt.timer);
      renameTimers.delete(ch.id);
      // Re-check the member count right before deleting — a member could have joined
      // while we were awaiting sendModLog above, and we don't want to delete a live channel.
      const freshCh = guild.channels.cache.get(ch.id);
      if (freshCh && freshCh.members.filter((m) => !m.user.bot).size > 0) {
        log(`[TempVC] Race condition avoided — member joined "${ch.name}" while closing; aborting delete`);
        return;
      }

      // Delete paired text channel if one exists separately
      const textChId = tempTextChannels.get(ch.id);
      tempTextChannels.delete(ch.id); // always clean up, even if textChId === ch.id
      if (textChId && textChId !== ch.id) {
        await guild.channels.cache.get(textChId)?.delete("Temp VC emptied").catch(() => {});
      }
      await ch.delete("Temp VC empty — auto-deleted").catch((err) => { log(`[TempVC] Failed to delete "${ch.name}": ${err.message}`); });
      return;
    }
  }

  // ── Sync text channel access + queue rename on member join/leave temp VC ───
  const movedFrom = oldState.channel && tempChannels.has(oldState.channel.id) ? oldState.channel : null;
  const movedInto = newState.channel && tempChannels.has(newState.channel.id) ? newState.channel : null;

  if (movedFrom && movedFrom !== movedInto) {
    const textChId = tempTextChannels.get(movedFrom.id);
    if (textChId && textChId !== movedFrom.id) {
      const textCh = guild.channels.cache.get(textChId);
      await textCh?.permissionOverwrites.delete(member).catch(() => {});
    }
    // Member left a temp VC — refresh panel and queue rename
    queueRename(movedFrom, guild);
    await updateControlPanel(movedFrom.id, guild);
  }
  if (movedInto && movedInto !== movedFrom) {
    // Track member in history (Feature 1)
    if (!tempVcMembers.has(movedInto.id)) tempVcMembers.set(movedInto.id, new Set());
    tempVcMembers.get(movedInto.id).add(member.id);

    // Rejoin grace period — check if this is the grace owner rejoining (Feature 2)
    const grace = ownerGraceTimers.get(movedInto.id);
    if (grace && grace.ownerId === member.id) {
      clearTimeout(grace.timer);
      ownerGraceTimers.delete(movedInto.id);
      log(`[TempVC] Owner ${member.user.tag} rejoined "${movedInto.name}" within grace period — keeping ownership`);
    }

    const textChId = tempTextChannels.get(movedInto.id);
    if (textChId && textChId !== movedInto.id) {
      const textCh = guild.channels.cache.get(textChId);
      await textCh?.permissionOverwrites.edit(member, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
      }).catch(() => {});
    }
    // Member joined a temp VC — refresh panel and queue rename
    queueRename(movedInto, guild);
    await updateControlPanel(movedInto.id, guild);
  }

  // ── Join-to-create trigger ────────────────────────────────────────────────
  if (!newState.channel) return;
  if (!settings?.create_vc_channel_id) return;
  if (newState.channel.id !== settings.create_vc_channel_id) return;

  // User joined the trigger channel
  const createVcLockKey = `${guild.id}:${member.id}`;
  if (pendingCreateVcUsers.has(createVcLockKey)) {
    log(`[CreateVC] Ignoring duplicate create request for ${member.user.tag} — creation already in progress`);
    return;
  }

  // Check if they already own a temp VC in this server
  for (const [existingId, ownerId] of tempChannels.entries()) {
    if (ownerId === member.id) {
      const existingChannel = guild.channels.cache.get(existingId);
      if (existingChannel) {
        log(`[CreateVC] ${member.user.tag} tried to create a new VC but already owns "${existingChannel.name}" — moving them back`);
        await member.voice.setChannel(existingChannel, "Prevent duplicate VC").catch(() => {});
        return;
      }
    }
  }

  // Create their personal VC
  const category    = newState.channel.parent;
  const template    = getVcTemplate(guild.id);
  const defaultLimit = getVcDefaultLimit(guild.id);
  const channelName = applyVcTemplate(template, member);

  pendingCreateVcUsers.add(createVcLockKey);
  try {
    const newVc = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: category ?? null,
      position: newState.channel.position + 1,
      userLimit: defaultLimit > 0 ? defaultLimit : undefined,
      permissionOverwrites: (() => {
        const verRoleId = getVerificationRole(guild.id);
        /** @type {import("discord.js").OverwriteResolvable[]} */
        const overwrites = [
          // Owner — bot-side owner, no native mute/deafen/manage perms
          {
            id: member.id,
            allow: TEMP_VC_OWNER_ALLOW,
          },
          // Bot — needs to manage the channel
          {
            id: guild.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ];

        if (verRoleId) {
          // Server has verification — deny @everyone, allow verified role only
          overwrites.push({
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          });
          overwrites.push({
            id: verRoleId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          });
        } else {
          // No verification — public VC (original behavior)
          overwrites.push({
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          });
        }

        return overwrites;
      })(),
    });

    // Move the user into the new VC BEFORE committing state.
    // If setChannel throws (e.g. member left voice between trigger and creation),
    // the channel would be orphaned on Discord -- delete it and bail without polluting state.
    try {
      await member.voice.setChannel(newVc);
    } catch (moveErr) {
      log(`[CreateVC] Failed to move ${member.user.tag} to new VC -- deleting it: ${moveErr.message}`);
      await newVc.delete("Failed to move member into new VC").catch(() => {});
      return;
    }

    log(`[CreateVC] Made "${channelName}" for ${member.user.tag} in ${guild.name}`);

    // Member is in the channel -- now commit state
    const seq = (guildVcSeqCounters.get(guild.id) ?? 0) + 1;
    guildVcSeqCounters.set(guild.id, seq);
    tempChannels.set(newVc.id, member.id);
    tempVcSeq.set(newVc.id, seq);
    // Set textChannelId = VC ID upfront so a crash before the panel is created never
    // leaves the DB with textChannelId: null, which would orphan the text channel on restart
    tempTextChannels.set(newVc.id, newVc.id);
    saveTempVc(newVc.id, { ownerId: member.id, guildId: guild.id, seq, textChannelId: newVc.id });
    initRenameTimer(newVc.id);
    // Track creation time and initial member (Feature 1)
    tempVcCreatedAt.set(newVc.id, new Date());
    tempVcMembers.set(newVc.id, new Set([member.id]));

    // Render control panel async (non-blocking -- user is already in the VC)
    createControlPanel(newVc, newVc, guild).catch(err => {
      log(`[CreateVC] Failed to create control panel: ${err.message}`);
    });
  } catch (err) {
    log(`[CreateVC] Failed to create VC for ${member.user.tag}: ${err.message}`);
  } finally {
    pendingCreateVcUsers.delete(createVcLockKey);
  }

  // ── AFK tracking ─────────────────────────────────────────────────────────
  if (!settings?.afk_channel_id) return;

  const afkChannelId = settings.afk_channel_id;
  const timeoutMs = (settings.afk_timeout_minutes ?? 30) * 60 * 1000;
  const key = `${guild.id}-${member.id}`;

  // Left voice entirely — stop tracking
  if (!newState.channel) {
    clearTracking(key);
    return;
  }

  // Moved into AFK channel — stop tracking
  if (newState.channel.id === afkChannelId) {
    clearTracking(key);
    return;
  }

  // Any voice state change counts as activity — reset the inactivity timer.
  // This covers: joining, moving channels, muting/unmuting, deafening/undeafening.
  startTracking(key, guild, member.id, timeoutMs);
}
