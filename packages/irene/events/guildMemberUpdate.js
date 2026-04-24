import { sendModLog } from "../utils/logger.js";
import { logEvent, LC } from "../utils/embeds.js";
import { EmbedBuilder } from "discord.js";

export const name = "guildMemberUpdate";

// Try to attribute a member update to the moderator who caused it, via a
// recent audit-log entry. Returns the actor user or null.
async function findActor(guild, targetId, actionType) {
  try {
    const audit = await guild.fetchAuditLogs({ type: actionType, limit: 3 });
    const entry = audit.entries.find((e) =>
      e.target?.id === targetId && Date.now() - e.createdTimestamp < 5000
    );
    return entry?.executor ?? null;
  } catch { return null; }
}

export async function execute(oldMember, newMember) {
  const guild = newMember.guild;

  if (oldMember.displayName !== newMember.displayName || oldMember.nickname !== newMember.nickname) {
    try {
      const { invalidateMemberIndex } = await import("../ai/executor.js");
      invalidateMemberIndex(guild.id);
    } catch {}
  }

  // ── Nickname Change ────────────────────────────────────────────────────────
  if (oldMember.displayName !== newMember.displayName) {
    const actor = await findActor(guild, newMember.id, 24); // MEMBER_UPDATE
    const selfChange = !actor || actor.id === newMember.id;
    await sendModLog(guild, logEvent({
      kind: "nickname",
      target: newMember.user,
      actor: selfChange ? null : actor,
      description: selfChange
        ? `<@${newMember.id}> changed their nickname.`
        : `<@${newMember.id}>'s nickname was changed by <@${actor.id}>.`,
      meta: {
        "Before": oldMember.displayName ? `\`${oldMember.displayName}\`` : "*(none)*",
        "After": newMember.displayName ? `\`${newMember.displayName}\`` : "*(none)*",
        "Raw Nickname": newMember.nickname === null ? "*(removed — using username)*" : `\`${newMember.nickname}\``,
      },
    }));
  }

  // ── Timeout Applied / Removed ──────────────────────────────────────────────
  const wasTimedOut = !!oldMember.communicationDisabledUntil;
  const isTimedOut = !!newMember.communicationDisabledUntil;
  if (!wasTimedOut && isTimedOut) {
    const until = newMember.communicationDisabledUntilTimestamp;
    const untilTs = Math.floor(until / 1000);
    const durationMs = until - Date.now();
    const durationStr = durationMs >= 86_400_000 ? `${Math.round(durationMs / 86_400_000)}d`
      : durationMs >= 3_600_000 ? `${Math.round(durationMs / 3_600_000)}h`
      : `${Math.round(durationMs / 60_000)}m`;
    const actor = await findActor(guild, newMember.id, 24);
    const reason = (await guild.fetchAuditLogs({ type: 24, limit: 3 }).catch(() => null))
      ?.entries.find((e) => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 5000)?.reason;

    await sendModLog(guild, logEvent({
      kind: "timeout",
      target: newMember.user,
      actor,
      reason: reason || undefined,
      meta: {
        "Duration": durationStr,
        "Expires": `<t:${untilTs}:F> (<t:${untilTs}:R>)`,
        "Nickname": newMember.nickname,
      },
    }));
  } else if (wasTimedOut && !isTimedOut) {
    const actor = await findActor(guild, newMember.id, 24);
    await sendModLog(guild, logEvent({
      kind: "untimeout",
      target: newMember.user,
      actor,
      meta: { "Nickname": newMember.nickname },
    }));
  }

  // ── Avatar Change — uses a rich image-forward embed since the visual IS the content ──
  if (oldMember.avatar !== newMember.avatar) {
    const oldAvatar = oldMember.avatarURL({ size: 256 }) ?? oldMember.user.displayAvatarURL({ size: 256 });
    const newAvatar = newMember.avatarURL({ size: 512 }) ?? newMember.user.displayAvatarURL({ size: 512 });

    const embed = new EmbedBuilder()
      .setColor(LC.update)
      .setAuthor({ name: `🖼️  Server Avatar Changed`, iconURL: newAvatar })
      .setDescription(`<@${newMember.id}> changed their **server avatar**.\n\n${[
        `**User** · \`${newMember.user.tag}\` · \`${newMember.id}\``,
        `**Before** · ${oldAvatar ? `[view](${oldAvatar})` : "*(none — using default/account avatar)*"}`,
        `**After** · [view](${newAvatar})`,
      ].join("\n")}`)
      .setThumbnail(oldAvatar)
      .setImage(newAvatar)
      .setTimestamp()
      .setFooter({ text: `ID: ${newMember.id} · Irene` });
    await sendModLog(guild, embed);
  }

  // ── Role Changes ───────────────────────────────────────────────────────────
  const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id) && r.id !== guild.id);
  const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id) && r.id !== guild.id);

  if (added.size || removed.size) {
    const actor = await findActor(guild, newMember.id, 25); // MEMBER_ROLE_UPDATE
    const fields = [];
    if (added.size) {
      fields.push({
        name: `✅ Roles Added (${added.size})`,
        value: added.map((r) => `<@&${r.id}> · \`${r.name}\``).join("\n").slice(0, 1024),
        inline: false,
      });
    }
    if (removed.size) {
      fields.push({
        name: `❌ Roles Removed (${removed.size})`,
        value: removed.map((r) => `<@&${r.id}> · \`${r.name}\``).join("\n").slice(0, 1024),
        inline: false,
      });
    }

    await sendModLog(guild, logEvent({
      kind: added.size && !removed.size ? "roleUpdate"
           : !added.size && removed.size ? "roleUpdate"
           : "roleUpdate",
      target: newMember.user,
      actor,
      description: `<@${newMember.id}>'s roles were updated${actor && actor.id !== newMember.id ? ` by <@${actor.id}>` : ""}.`,
      meta: {
        "Total Roles Now": `${newMember.roles.cache.size - 1}`,
        "Highest Role": newMember.roles.highest?.id !== guild.id ? `<@&${newMember.roles.highest.id}>` : null,
      },
      fields,
    }));
  }

  // ── Boost / Nitro Supporter ────────────────────────────────────────────────
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting = !!newMember.premiumSince;
  if (!wasBoosting && isBoosting) {
    await sendModLog(guild, logEvent({
      kind: "audit",
      title: "Started Boosting",
      target: newMember.user,
      description: `<@${newMember.id}> started boosting the server! 🎉`,
      meta: {
        "Boosting Since": `<t:${Math.floor(newMember.premiumSinceTimestamp / 1000)}:R>`,
        "Total Boosts": String(guild.premiumSubscriptionCount ?? "?"),
        "Boost Tier": `Level ${guild.premiumTier ?? 0}`,
      },
      color: 0xF47FFF,
    }));
  } else if (wasBoosting && !isBoosting) {
    await sendModLog(guild, logEvent({
      kind: "audit",
      title: "Stopped Boosting",
      target: newMember.user,
      description: `<@${newMember.id}> stopped boosting the server.`,
      meta: {
        "Was Boosting Since": `<t:${Math.floor(oldMember.premiumSinceTimestamp / 1000)}:R>`,
        "Duration": oldMember.premiumSinceTimestamp
          ? `${Math.floor((Date.now() - oldMember.premiumSinceTimestamp) / 86_400_000)}d`
          : "?",
        "Remaining Boosts": String(guild.premiumSubscriptionCount ?? "?"),
      },
      color: 0x6B7280,
    }));
  }
}
