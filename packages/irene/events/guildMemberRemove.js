import { sendModLog } from "../utils/logger.js";
import { logEmbed, LC, logEvent } from "../utils/embeds.js";
import { EmbedBuilder } from "discord.js";
import { getLeaveSettings, setLeaveChannel, deleteTempVc, markInviteLeave } from "../database.js";
import { log } from "../utils/logger.js";
import { updateStatsChannels } from "../utils/stats.js";
import { tempChannels, tempTextChannels, tempVcSeq, tempControlPanels, renameTimers, manualRenames, ownerGraceTimers, tempVcCreatedAt, tempVcMembers } from "../utils/tempvc.js";
import { transferOwnership, recordServerRemoval } from "./voiceStateUpdate.js";
import { getEvidence, formatEvidence } from "../utils/messageEvidence.js";

const LEAVE_CHANNEL_NAMES = ["goodbye", "farewell", "leave", "departures", "bye"];

export const name = "guildMemberRemove";

export async function execute(member) {
  try {
    const { invalidateMemberIndex } = await import("../ai/executor.js");
    invalidateMemberIndex(member.guild.id);
  } catch {}

  // Mark this member's invite history entry as "left"
  markInviteLeave(member.guild.id, member.id);

  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .map((r) => r.name)
    .join(", ") || "none";

  const joinedMs = member.joinedAt ? member.joinedAt.getTime() : null;
  const timeInServer = joinedMs != null
    ? Math.max(0, Math.floor((Date.now() - joinedMs) / 86_400_000))
    : null;

  let moderator = null;
  let kickReason = null;
  let wasBan = false;

  // Scan both kick (20) AND ban (22) recent audit entries. A ban causes a
  // guildMemberRemove *before* guildBanAdd fires, so we need to detect it
  // here to classify correctly for the voice handler.
  const _scan = async (type) => {
    try {
      const audit = await member.guild.fetchAuditLogs({ type, limit: 20 });
      const now = Date.now();
      for (const e of audit.entries.values()) {
        if (e.target?.id !== member.id) continue;
        if (now - e.createdTimestamp > 15_000) continue;
        return e;
      }
    } catch {}
    return null;
  };
  let kickEntry = await _scan(20);
  let banEntry = await _scan(22);
  if (!kickEntry && !banEntry) {
    // Retry once after a short delay for audit-log consistency lag.
    await new Promise(r => setTimeout(r, 1200));
    kickEntry = await _scan(20);
    banEntry = await _scan(22);
  }
  if (banEntry) {
    moderator = banEntry.executor;
    kickReason = banEntry.reason;
    wasBan = true;
  } else if (kickEntry) {
    moderator = kickEntry.executor;
    kickReason = kickEntry.reason;
  }

  // Always flag for the voice handler so a concurrent voice-disconnect can
  // be attributed correctly — even if we couldn't resolve the moderator.
  recordServerRemoval(
    member.guild.id,
    member.id,
    wasBan ? "ban" : moderator ? "kick" : "leave",
    moderator,
    kickReason,
  );

  // Classify — ban fires a separate guildBanAdd embed so we suppress the
  // kick/leave embed here to avoid double-logging.
  const kind = wasBan ? null : moderator ? "kick" : "leave";
  if (!kind) {
    // Ban — skip the mod-log embed here; guildBanAdd handles it.
    // Still run temp-VC + leave-message + stats cleanup below.
  } else {
    const createdTs = member.user.createdTimestamp || null;

    const fields = [];
    if (roles !== "none") {
      fields.push({ name: "Roles", value: roles.slice(0, 1000), inline: false });
    }

    // Attach recent-messages evidence ONLY on kicks (mod action), not on
    // voluntary leaves. Evidence is pulled from the in-memory buffer; if the
    // user hadn't said anything recently (or the bot was restarted), skip.
    if (kind === "kick") {
      const evidence = getEvidence(member.guild.id, member.id);
      if (evidence.length > 0) {
        const full = formatEvidence(evidence);
        let value = full;
        if (value.length > 1024) {
          const lines = full.split("\n");
          while (lines.length > 1 && lines.join("\n").length > 1020) lines.shift();
          value = (full.split("\n").length > lines.length ? "… (older trimmed) …\n" : "") + lines.join("\n");
          if (value.length > 1024) value = value.slice(0, 1021) + "…";
        }
        fields.push({
          name: `Recent messages before kick (${evidence.length})`,
          value,
          inline: false,
        });
      }
    }

    const embed = logEvent({
      kind,
      target: member.user,
      actor: moderator,
      reason: moderator ? (kickReason || "no reason provided") : undefined,
      meta: {
        "Joined": joinedMs ? `<t:${Math.floor(joinedMs / 1000)}:R>` : "unknown",
        "Time in Server": timeInServer !== null ? `${timeInServer}d` : "unknown",
        "Account Created": createdTs ? `<t:${Math.floor(createdTs / 1000)}:R>` : "unknown",
      },
      fields: fields.length > 0 ? fields : undefined,
    });

    await sendModLog(member.guild, embed);
  }

  // ── Leave Message (Feature 8) ────────────────────────────────────────────
  const leaveSettings = getLeaveSettings(member.guild.id);
  let leaveChannelId = leaveSettings.channelId;

  // Auto-detect if not configured
  if (!leaveChannelId) {
    const found = member.guild.channels.cache.find(
      (c) => c.isTextBased() && LEAVE_CHANNEL_NAMES.includes(c.name.toLowerCase())
    );
    if (found) {
      leaveChannelId = found.id;
      setLeaveChannel(member.guild.id, found.id, null);
      log(`[AutoSetup] "${member.guild.name}": auto-detected leave channel #${found.name}`);
    }
  }

  if (leaveChannelId) {
    const leaveCh = member.guild.channels.cache.get(leaveChannelId);
    if (leaveCh) {
      const leaveMsg = leaveSettings.message
        .replace(/{username}/g, member.user.username)
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{server}/g, member.guild.name)
        .replace(/{membercount}/g, member.guild.memberCount);

      const leaveEmbed = new EmbedBuilder()
        .setColor(LC.leave)
        .setDescription(leaveMsg)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setTimestamp()
        .setFooter({ text: `Members: ${member.guild.memberCount}` });

      try {
        await leaveCh.send({ embeds: [leaveEmbed] });
      } catch (err) {
        log(`[Leave] Failed to send leave msg in ${member.guild.name}: ${err.message}`);
      }
    }
  }

  // ── Temp VC cleanup — owner left server ─────────────────────────────────
  // voiceStateUpdate fires on disconnect but NOT on server leave/kick.
  // Without this, the channel persists forever with no one able to manage it.
  // Collect owned VC IDs first so we don't mutate tempChannels during iteration
  const ownedVcIds = [];
  for (const [vcId, ownerId] of tempChannels.entries()) {
    if (ownerId === member.id) ownedVcIds.push(vcId);
  }
  for (const vcId of ownedVcIds) {

    const channel = member.guild.channels.cache.get(vcId);
    if (!channel) {
      // Channel already gone — just clean up state
      tempChannels.delete(vcId);
      tempTextChannels.delete(vcId);
      tempVcSeq.delete(vcId);
      tempControlPanels.delete(vcId);
      manualRenames.delete(vcId);
      const rt = renameTimers.get(vcId);
      if (rt?.timer) clearTimeout(rt.timer);
      renameTimers.delete(vcId);
      // Cancel any pending grace timer
      const grace = ownerGraceTimers.get(vcId);
      if (grace?.timer) clearTimeout(grace.timer);
      ownerGraceTimers.delete(vcId);
      tempVcCreatedAt.delete(vcId);
      tempVcMembers.delete(vcId);
      deleteTempVc(vcId);
      continue;
    }

    // Cancel any pending grace timer — owner left the server, the grace period is void
    const grace = ownerGraceTimers.get(vcId);
    if (grace?.timer) clearTimeout(grace.timer);
    ownerGraceTimers.delete(vcId);

    const nonBots = channel.members.filter((m) => !m.user.bot);
    if (nonBots.size > 0) {
      // Others are still in the channel — hand ownership to the next person.
      // Guard against a race where the grace timer already queued a transfer before
      // this event fired (e.g. owner was voice-disconnected then immediately kicked).
      log(`[TempVC] Owner ${member.user.tag} left server — transferring "${channel.name}"`);
      await transferOwnership(channel, member.guild).catch((err) => {
        log(`[TempVC] Failed to transfer on member leave: ${err.message}`);
      });
    } else {
      // Channel is empty — delete it cleanly
      log(`[TempVC] Owner ${member.user.tag} left server and channel is empty — deleting "${channel.name}"`);
      const textChId = tempTextChannels.get(vcId);
      tempChannels.delete(vcId);
      tempTextChannels.delete(vcId);
      tempVcSeq.delete(vcId);
      tempControlPanels.delete(vcId);
      manualRenames.delete(vcId);
      const rt = renameTimers.get(vcId);
      if (rt?.timer) clearTimeout(rt.timer);
      renameTimers.delete(vcId);
      tempVcCreatedAt.delete(vcId);
      tempVcMembers.delete(vcId);
      deleteTempVc(vcId);
      if (textChId && textChId !== vcId) {
        await member.guild.channels.cache.get(textChId)?.delete("Owner left server").catch(() => {});
      }
      await channel.delete("Owner left server — temp VC auto-deleted").catch((err) => {
        log(`[TempVC] Failed to delete "${channel.name}" after owner leave: ${err.message}`);
      });
    }
  }

  // ── Update stats channels (Feature 17) ──────────────────────────────────
  await updateStatsChannels(member.guild).catch(() => {});
}
