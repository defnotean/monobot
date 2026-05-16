// ─── Moderation Executor ────────────────────────────────────────────────────

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { addWarning, getWarnings, deleteWarning, clearWarnings, logAudit, removeTempBan, getGuildSettings } from "../../database.js";
import { sendModLog } from "../../utils/logger.js";
import { modEmbed, logEvent, buildUndoRow } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";
import { getEscalation } from "../../database.js";
import { firePunishSignal } from "../../utils/twinPunish.js";

// Prefix audit-log reason with the invoking moderator's tag so Discord's
// own audit log attributes the action to the right person (otherwise it
// just says "Irene").
function _attributedReason(actor, reason) {
  const tag = actor?.tag || actor?.username || "unknown";
  const r = reason ? String(reason).slice(0, 450) : "No reason";
  return `[${tag}] ${r}`.slice(0, 512);
}

// Check invoking member retains the needed permission (for scheduled tasks
// where the moderator may have been demoted between queue and fire).
function _memberHasPerm(member, perm, guild) {
  if (!member) return false;
  if (member.id === guild.ownerId) return true;
  try {
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return !!member.permissions?.has?.(perm);
  } catch { return false; }
}

const DURATION_MS = {
  "1m": 60_000, "5m": 300_000, "10m": 600_000, "30m": 1_800_000,
  "1h": 3_600_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "7d": 604_800_000,
};

const HANDLED = new Set([
  "ban_user", "kick_user", "warn_user", "timeout_user",
  "untimeout_user", "unban_user", "unmute_user",
  "remove_warning", "clear_warnings",
  "lockdown_server", "unlock_server", "purge_messages",
  "find_message", "snipe", "editsnipe", "tempban",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, by, findChannel, findMember, checkHierarchy } = ctx;

  switch (toolName) {
    case "ban_user": {
      // Permission re-check runs FIRST — before findMember, hierarchy check,
      // any DB write, or Discord API call — so a caller without BanMembers
      // can't probe membership or trigger lookups via this tool.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't ban users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      if (member.id === message.client.user.id) return "I can't ban myself lol";
      const banHierErr = checkHierarchy(message.member, member, guild);
      if (banHierErr) return banHierErr;
      const reason = input.reason || "No reason";
      await member.ban({ deleteMessageDays: input.delete_messages || 0, reason: _attributedReason(message.author, reason) });
      // Fire cross-bot punish signal — Eris will apply economy consequences
      // (zero the balance) if the guild has opted in via cross_bot_punish.
      firePunishSignal({ guildId: guild.id, userId: member.id, action: "ban", reason }).catch(() => {});
      await sendModLog(guild, {
        embed: logEvent({
          kind: "ban",
          target: member.user,
          actor: message.author,
          reason,
          meta: {
            "Nickname": member.nickname,
            "Joined": member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : null,
            "Account Created": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
            "Delete Messages": input.delete_messages ? `${input.delete_messages}d` : null,
            "Prior Warnings": String(getWarnings(guild.id, member.id).length),
            "Invoked Via": "AI tool",
          },
        }),
        components: [buildUndoRow("ban", member.id)].filter(Boolean),
      });
      logAudit(guild.id, "ban", message.author.id, input.username);
      return `Banned ${member.user.tag}. Reason: ${reason}`;
    }

    case "kick_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.KickMembers, guild))
        return "You can't kick users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const kickHierErr = checkHierarchy(message.member, member, guild);
      if (kickHierErr) return kickHierErr;
      const reason = input.reason || "No reason";
      await member.kick(_attributedReason(message.author, reason));
      firePunishSignal({ guildId: guild.id, userId: member.id, action: "kick", reason }).catch(() => {});
      await sendModLog(guild, logEvent({
        kind: "kick",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Joined": member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : null,
          "Account Created": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
          "Prior Warnings": String(getWarnings(guild.id, member.id).length),
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "kick", message.author.id, input.username);
      return `Kicked ${member.user.tag}. Reason: ${reason}`;
    }

    case "warn_user": {
      // Match the /warn slash-command gate: ModerateMembers is the canonical
      // permission for warn (the slash command sets it as defaultMemberPerms
      // and re-checks via requirePermission). Without this gate, the
      // upstream ADMIN_TOOLS check is the only barrier — and a stale
      // trusted_users entry can let a now-non-mod issue warnings + trigger
      // auto-escalation bans.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't warn users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const warnHierErr = checkHierarchy(message.member, member, guild);
      if (warnHierErr) return warnHierErr;
      const newWarn = addWarning(guild.id, member.id, message.author.id, input.reason);
      const warnings = getWarnings(guild.id, member.id);
      await sendModLog(guild, {
        embed: logEvent({
          kind: "warn",
          target: member.user,
          actor: message.author,
          reason: input.reason,
          meta: {
            "Warning ID": `#${newWarn?.id ?? "?"}`,
            "Total Warnings": `${warnings.length}`,
            "Nickname": member.nickname,
            "Invoked Via": "AI tool",
          },
        }),
        components: newWarn?.id
          ? [buildUndoRow("warn", member.id, newWarn.id)].filter(Boolean)
          : [],
      });

      // Feature 13: DM the warned user
      const warnDmEmbed = new EmbedBuilder()
        .setTitle("⚠️ Warning Received")
        .setColor(0xfee75c)
        .addFields(
          { name: "Server", value: guild.name, inline: true },
          { name: "Reason", value: input.reason || "No reason provided", inline: false },
          { name: "Total Warnings", value: String(warnings.length), inline: true },
          { name: "Note", value: "Contact a moderator if you think this is a mistake", inline: false },
        )
        .setTimestamp();
      await member.send({ embeds: [warnDmEmbed] }).catch(() => {});

      // Feature 14: Auto-escalation — AI-PATH CAP
      //
      // AUDIT (docs/audits/AUDIT-irene-moderation.md, risk #4):
      //   A single LLM hallucination producing `warn_user` on a user
      //   already at `ban_at - 1` would silently auto-ban with no
      //   confirmation. Per the council convergence in
      //   ai/rulesEscalation.js ("No auto-ban. Bans are mod-only.") and
      //   the audit's risk-#4 remediation, the AI tool path must NEVER
      //   auto-ban or auto-kick.
      //
      // Policy: AI-initiated warns cap escalation at TIMEOUT (24h max).
      // BAN and KICK on warn-threshold are slash-command-only — a mod
      // running `/warn add` makes that choice consciously. The AI path
      // can warn, time out (up to 24h), and surface the would-be action
      // in mod-log so a human can run `/ban` or `/kick` themselves.
      const escalation = getEscalation(guild.id);
      const count = warnings.length;
      let escalationNote = "";

      // Determine the highest configured tier the user has crossed.
      let crossedTier = null;
      if (escalation.ban_at && count >= escalation.ban_at) crossedTier = "ban";
      else if (escalation.kick_at && count >= escalation.kick_at) crossedTier = "kick";
      else if (escalation.mute_at && count >= escalation.mute_at) crossedTier = "mute";

      if (crossedTier === "ban" || crossedTier === "kick") {
        // AI path CAPs at 24h timeout. Surface the would-be action in
        // mod-log so a human can run `/ban` or `/kick` consciously.
        try {
          const capMs = 24 * 60 * 60_000; // 24h max
          await member.timeout(capMs, _attributedReason(message.author, `AI-path cap: ${count} warnings (would have ${crossedTier}ed under server policy)`));
          await sendModLog(guild, logEvent({
            kind: "timeout",
            target: member.user,
            reason: `AI-path cap: ${count} warnings`,
            meta: {
              "Duration": "24h",
              "Until": `<t:${Math.floor((Date.now() + capMs) / 1000)}:R>`,
              "Trigger": "auto-escalation (capped)",
              "Warning Count": `${count}`,
              "Configured Action": crossedTier,
              "Policy Note": `AI path caps at 24h timeout; ${crossedTier} requires mod slash-command`,
              "Invoked Via": "AI tool (automatic, capped)",
            },
          }));
          escalationNote = ` — auto-timed out 24h (would-be ${crossedTier} requires mod action)`;
        } catch {}
      } else if (crossedTier === "mute") {
        try {
          await member.timeout(10 * 60 * 1000, _attributedReason(message.author, `Auto-escalation: ${count} warnings`)); // 10 min timeout
          await sendModLog(guild, logEvent({
            kind: "timeout",
            target: member.user,
            reason: `Auto-escalation: ${count} warnings`,
            meta: {
              "Duration": "10m",
              "Until": `<t:${Math.floor((Date.now() + 10 * 60_000) / 1000)}:R>`,
              "Trigger": "auto-escalation",
              "Warning Count": `${count}`,
              "Mute Threshold": `${escalation.mute_at}`,
              "Invoked Via": "AI tool (automatic)",
            },
          }));
          escalationNote = ` — auto-timed out (${count} warnings)`;
        } catch {}
      }

      return `Warned ${member.user.tag} (${warnings.length} total). Reason: ${input.reason}${escalationNote}`;
    }

    case "timeout_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't timeout users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const timeoutHierErr = checkHierarchy(message.member, member, guild);
      if (timeoutHierErr) return timeoutHierErr;
      const ms = DURATION_MS[input.duration];
      if (!ms) return `Invalid duration: ${input.duration}`;
      await member.timeout(ms, _attributedReason(message.author, input.reason || "No reason"));
      await sendModLog(guild, {
        embed: logEvent({
          kind: "timeout",
          target: member.user,
          actor: message.author,
          reason: input.reason || "No reason provided",
          meta: {
            "Duration": input.duration,
            "Until": `<t:${Math.floor((Date.now() + ms) / 1000)}:F> (<t:${Math.floor((Date.now() + ms) / 1000)}:R>)`,
            "Nickname": member.nickname,
            "Invoked Via": "AI tool",
          },
        }),
        components: [buildUndoRow("timeout", member.id)].filter(Boolean),
      });
      return `Timed out ${member.user.tag} for ${input.duration}`;
    }

    case "untimeout_user": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't untimeout users.";
      if (!member.isCommunicationDisabled()) return `${member.user.tag} isn't timed out.`;
      const reason = input.reason || "No reason";
      try {
        await member.timeout(null, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to remove timeout: ${err.message}`;
      }
      await sendModLog(guild, logEvent({
        kind: "untimeout",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "untimeout", message.author.id, input.username);
      return `Removed timeout from ${member.user.tag}. Reason: ${reason}`;
    }

    case "unban_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't unban users.";
      const reason = input.reason || "No reason";
      let targetId = input.user_id?.trim();

      // Resolve by username/tag via ban list if no ID given
      if (!targetId) {
        if (!input.username) return "Need a user_id or username to unban.";
        try {
          const bans = await guild.bans.fetch();
          const lower = input.username.toLowerCase().replace(/^@/, "");
          const hit = bans.find(
            (b) =>
              b.user.tag.toLowerCase() === lower ||
              b.user.username.toLowerCase() === lower ||
              b.user.id === input.username
          );
          if (!hit) return `Couldn't find a banned user matching "${input.username}".`;
          targetId = hit.user.id;
        } catch (err) {
          return `Failed to look up bans: ${err.message}`;
        }
      }

      if (!/^\d{17,20}$/.test(targetId)) return `"${targetId}" doesn't look like a valid user ID.`;

      let ban;
      try {
        ban = await guild.bans.fetch(targetId);
      } catch (err) {
        if (err.code === 10026) return `User ${targetId} isn't banned.`;
        return `Failed to fetch ban: ${err.message}`;
      }

      try {
        await guild.members.unban(targetId, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to unban: ${err.message}`;
      }

      removeTempBan(guild.id, targetId);

      await sendModLog(guild, logEvent({
        kind: "unban",
        target: ban.user,
        actor: message.author,
        reason,
        meta: {
          "User ID": `\`${targetId}\``,
          "Original Ban Reason": ban.reason || "*(none recorded)*",
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "unban", message.author.id, ban.user.tag);
      return `Unbanned ${ban.user.tag}. Reason: ${reason}`;
    }

    case "unmute_user": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageRoles, guild))
        return "You can't unmute users.";
      // Look up configured mute role first; fall back to any role whose name
      // matches "muted" case-insensitively so we don't fail on servers that
      // use "Silenced", "muted", etc.
      const gs = getGuildSettings(guild.id) || {};
      let muteRole = gs.mute_role_id ? guild.roles.cache.get(gs.mute_role_id) : null;
      if (!muteRole) muteRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "muted");
      if (!muteRole) return "No mute role configured (set one via /setup or name a role 'Muted').";
      if (!member.roles.cache.has(muteRole.id)) return `${member.user.tag} isn't muted.`;
      const reason = input.reason || "No reason";
      try {
        await member.roles.remove(muteRole, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to remove mute: ${err.message}`;
      }
      await sendModLog(guild, logEvent({
        kind: "unmute",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "unmute", message.author.id, input.username);
      return `Unmuted ${member.user.tag}. Reason: ${reason}`;
    }

    case "remove_warning": {
      const id = Number(input.warning_id);
      if (!Number.isInteger(id) || id <= 0) return "warning_id must be a positive integer.";
      const result = deleteWarning(id, guild.id);
      if (!result.changes) return `No warning with ID ${id} found in this server.`;
      const reason = input.reason || "No reason";
      await sendModLog(guild, logEvent({
        kind: "warnRemoved",
        actor: message.author,
        reason,
        meta: {
          "Warning ID": `#${id}`,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "remove_warning", message.author.id, String(id));
      return `Removed warning #${id}.`;
    }

    case "clear_warnings": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      const before = getWarnings(guild.id, member.id).length;
      if (!before) return `${member.user.tag} has no warnings to clear.`;
      const result = clearWarnings(guild.id, member.id);
      const reason = input.reason || "No reason";
      await sendModLog(guild, logEvent({
        kind: "warnsCleared",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Warnings Cleared": `${result.changes}`,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "clear_warnings", message.author.id, input.username);
      return `Cleared ${result.changes} warning${result.changes === 1 ? "" : "s"} from ${member.user.tag}.`;
    }

    case "lockdown_server": {
      const { activateLockdown } = await import("../../utils/safety.js");
      const ok = await activateLockdown(guild, input.reason || "manual lockdown by admin");
      return ok ? "server locked down — all text channels restricted to admins only" : "server is already in lockdown";
    }

    case "unlock_server": {
      const { deactivateLockdown } = await import("../../utils/safety.js");
      const ok = await deactivateLockdown(guild, input.reason || "manual unlock by admin");
      return ok ? "lockdown lifted — channels restored to normal" : "server wasn't in lockdown";
    }

    case "find_message": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const maxScan = Math.min(Math.max(input.limit || 200, 1), 500);
      const wantFirst = (input.position ?? "first") === "first";

      // Resolve target user if provided
      let targetUserId = null;
      if (input.from_user) {
        const member = findMember(guild, input.from_user);
        if (!member) return `Couldn't find user "${input.from_user}"`;
        targetUserId = member.id;
      }

      const searchLower = input.contains?.toLowerCase() ?? null;

      // Fetch in batches
      const matches = [];
      let lastId = undefined;
      let scanned = 0;
      while (scanned < maxScan) {
        const batchSize = Math.min(100, maxScan - scanned);
        const opts = { limit: batchSize };
        if (lastId) opts.before = lastId;
        const batch = await ch.messages.fetch(opts);
        if (batch.size === 0) break;
        for (const m of batch.values()) {
          let ok = true;
          if (targetUserId && m.author.id !== targetUserId) ok = false;
          if (searchLower && !m.content.toLowerCase().includes(searchLower)) ok = false;
          if (ok) matches.push(m);
        }
        scanned += batch.size;
        lastId = batch.last()?.id;
      }

      if (!matches.length) return "No matching messages found.";

      // matches are newest→oldest (Discord fetch order). "first" = oldest = last in array
      const pick = wantFirst ? matches[matches.length - 1] : matches[0];
      const preview = pick.content.slice(0, 80) || "(no text content)";
      const ts = `<t:${Math.floor(pick.createdTimestamp / 1000)}:R>`;

      return [
        `Found message from **${pick.author.username}** ${ts}`,
        `ID: \`${pick.id}\``,
        `Preview: "${preview}"`,
        `Scanned ${scanned} messages, ${matches.length} matched.`,
      ].join("\n");
    }

    case "purge_messages": {
      // Match /purge slash-command gate (ManageMessages). Audit flagged this
      // as HIGH severity — previously relied on the upstream ADMIN_TOOLS
      // gate alone, so a stale trusted_users entry could drive a 500-message
      // delete with no per-perm re-check.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageMessages, guild))
        return "You can't purge messages.";
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const maxScan = Math.min(Math.max(input.count || 100, 1), 500);

      // ── Fetch messages in batches of 100 ────────────────────────────
      const allMessages = [];
      let lastId = input.before_message_id ?? undefined;
      while (allMessages.length < maxScan) {
        const batchSize = Math.min(100, maxScan - allMessages.length);
        const opts = { limit: batchSize };
        if (lastId) opts.before = lastId;
        const batch = await ch.messages.fetch(opts);
        if (batch.size === 0) break;
        for (const m of batch.values()) allMessages.push(m);
        lastId = batch.last()?.id;
      }

      if (!allMessages.length) return "No messages found.";

      // ── Apply filters ────────────────────────────────────────────────
      const hasMedia = (m) =>
        m.attachments.size > 0 ||
        m.embeds.some((e) => ["image","video","gifv"].includes(e.type) || e.image || e.video);
      const urlRe = /https?:\/\/\S+/i;

      let filtered = allMessages;

      // Position filters
      if (input.after_message_id) {
        const afterId = BigInt(input.after_message_id);
        filtered = filtered.filter((m) => BigInt(m.id) > afterId);
      }

      // Date filters
      if (input.before_date) {
        const beforeTs = new Date(input.before_date).getTime();
        if (!isNaN(beforeTs)) filtered = filtered.filter((m) => m.createdTimestamp < beforeTs);
      }
      if (input.after_date) {
        const afterTs = new Date(input.after_date).getTime();
        if (!isNaN(afterTs)) filtered = filtered.filter((m) => m.createdTimestamp > afterTs);
      }

      // User filters — fail loud when a name can't be resolved. Previously
      // these silently no-op'd, so "delete bob's spam" with an unresolvable
      // bob purged the last N messages from EVERYONE in the channel.
      if (input.from_user) {
        const member = findMember(guild, input.from_user);
        if (!member) return `Couldn't find user "${input.from_user}" — refusing to purge without the from_user filter. Use @mention or user ID.`;
        filtered = filtered.filter((m) => m.author.id === member.id);
      }
      if (input.exclude_user) {
        const member = findMember(guild, input.exclude_user);
        if (!member) return `Couldn't find user "${input.exclude_user}" — refusing to purge without the exclude_user filter.`;
        filtered = filtered.filter((m) => m.author.id !== member.id);
      }
      if (input.only_keep_media_from_user) {
        const member = findMember(guild, input.only_keep_media_from_user);
        if (!member) return `Couldn't find user "${input.only_keep_media_from_user}".`;
        filtered = filtered.filter((m) => !(m.author.id === member.id && hasMedia(m)));
      }

      // Content type
      if (input.content_type === "media") filtered = filtered.filter((m) => hasMedia(m));
      else if (input.content_type === "text") filtered = filtered.filter((m) => !hasMedia(m));

      // Text content filters
      if (input.contains) {
        const lower = input.contains.toLowerCase();
        filtered = filtered.filter((m) => m.content.toLowerCase().includes(lower));
      }
      if (input.not_contains) {
        const lower = input.not_contains.toLowerCase();
        filtered = filtered.filter((m) => !m.content.toLowerCase().includes(lower));
      }

      // Link filter
      if (input.has_links === true) filtered = filtered.filter((m) => urlRe.test(m.content));
      else if (input.has_links === false) filtered = filtered.filter((m) => !urlRe.test(m.content));

      // Always skip pinned messages unless explicitly asked to include them
      if (input.is_pinned === true) filtered = filtered.filter((m) => m.pinned);
      else filtered = filtered.filter((m) => !m.pinned);

      if (!filtered.length) return "No messages matched those filters.";

      // ── Split into bulk-deletable (< 14 days) and old (>= 14 days) ────
      const fourteenDaysMs = 14 * 24 * 60 * 60_000;
      const cutoff = Date.now() - fourteenDaysMs + 60_000; // 1 min buffer
      const recent = filtered.filter((m) => m.createdTimestamp >= cutoff);
      const old    = filtered.filter((m) => m.createdTimestamp < cutoff);

      let totalDeleted = 0;

      // Bulk delete recent messages in chunks of 100
      for (let i = 0; i < recent.length; i += 100) {
        const chunk = recent.slice(i, i + 100);
        try {
          const deleted = await ch.bulkDelete(chunk, true);
          totalDeleted += deleted.size;
        } catch (err) {
          log(`[Purge] Bulk batch error: ${err.message}`);
        }
      }

      // Delete old messages in parallel batches of 5 with rate limit spacing
      let oldDeleted = 0;
      for (let i = 0; i < old.length; i += 5) {
        const batch = old.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map((m) => m.delete()));
        oldDeleted += results.filter((r) => r.status === "fulfilled").length;
        if (i + 5 < old.length) await new Promise((r) => setTimeout(r, 1100));
      }
      totalDeleted += oldDeleted;

      logAudit(guild.id, "purge", message.author.id, `${totalDeleted} messages`);
      const parts = [`Deleted ${totalDeleted} messages from #${ch.name}`];
      if (recent.length > 0) parts.push(`${recent.length} bulk-deleted (recent)`);
      if (oldDeleted > 0)    parts.push(`${oldDeleted} individually deleted (older than 14 days)`);
      if (old.length - oldDeleted > 0) parts.push(`${old.length - oldDeleted} failed to delete`);
      return parts.join(" — ");
    }

    case "snipe": {
      const { getSnipedMessage, getSnipeCount } = await import("../../utils/snipe.js");
      const index = Math.max(0, (input.index || 1) - 1); // 1-based to 0-based
      const sniped = getSnipedMessage(message.channel.id, index);
      if (!sniped) return "nothing to snipe — no recently deleted messages in this channel (messages expire after 30 min)";
      const counts = getSnipeCount(message.channel.id);
      const elapsed = Math.floor((Date.now() - sniped.deletedAt) / 1000);
      const timeStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`;
      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setAuthor({ name: sniped.author, iconURL: sniped.avatar || undefined })
        .setDescription(sniped.content || "(no text)")
        .setFooter({ text: `deleted ${timeStr} • ${index + 1}/${counts.deletes} sniped messages` })
        .setTimestamp(sniped.deletedAt);
      if (sniped.attachments?.length) embed.setImage(sniped.attachments[0].url || sniped.attachments[0]);
      if (sniped.stickers?.length) embed.addFields({ name: "Stickers", value: sniped.stickers.join(", "), inline: true });
      await message.channel.send({ embeds: [embed] });
      return `sniped message ${index + 1}/${counts.deletes} — by ${sniped.author}`;
    }

    case "editsnipe": {
      const { getEditSnipe, getSnipeCount } = await import("../../utils/snipe.js");
      const index = Math.max(0, (input.index || 1) - 1);
      const edit = getEditSnipe(message.channel.id, index);
      if (!edit) return "nothing to editsnipe — no recently edited messages in this channel (edits expire after 30 min)";
      const counts = getSnipeCount(message.channel.id);
      const elapsed = Math.floor((Date.now() - edit.editedAt) / 1000);
      const timeStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`;
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setAuthor({ name: edit.author, iconURL: edit.avatar || undefined })
        .addFields(
          { name: "Before", value: edit.before.slice(0, 1024) || "(empty)" },
          { name: "After", value: edit.after.slice(0, 1024) || "(empty)" },
        )
        .setFooter({ text: `edited ${timeStr} • ${index + 1}/${counts.edits} edit-sniped` })
        .setTimestamp(edit.editedAt);
      if (edit.messageUrl) embed.setURL(edit.messageUrl);
      await message.channel.send({ embeds: [embed] });
      return `edit-sniped message ${index + 1}/${counts.edits} — by ${edit.author}`;
    }

    case "tempban": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't tempban users.";
      const target = findMember(guild, input.username);
      if (!target) return `Couldn't find user "${input.username}"`;
      if (target.id === message.client.user.id) return "I can't ban myself lol";
      const hierErr = checkHierarchy(message.member, target, guild);
      if (hierErr) return hierErr;
      if (!target.bannable) return `I can't ban ${target.user.tag} — they have higher permissions than me`;

      const durationStr = input.duration || "1h";
      const match = durationStr.match(/^(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?$/i);
      if (!match) return "Invalid duration — use formats like: 30m, 2h, 1d, 1w";

      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const multipliers = { m: 60000, min: 60000, h: 3600000, hr: 3600000, hour: 3600000, d: 86400000, day: 86400000, w: 604800000, week: 604800000 };
      const durationMs = num * (multipliers[unit] || 3600000);

      const reason = input.reason || "No reason provided";

      const { addTempBan } = await import("../../database.js");
      addTempBan(guild.id, target.id, target.user.tag, durationMs, reason, message.author.id);

      await target.ban({ reason: _attributedReason(message.author, `[TEMP ${durationStr}] ${reason}`) });
      // Send "ban" to Eris rather than "tempban" — Eris doesn't distinguish
      // sub-types of ban for economy enforcement, only that the user was
      // banned. Keeping tempban as a separate signal would silently no-op on
      // Eris's side. See dashboard.js for the punish action vocabulary.
      firePunishSignal({ guildId: guild.id, userId: target.id, action: "ban", reason }).catch(() => {});
      return `Temp-banned ${target.user.tag} for ${durationStr} — reason: ${reason}. They'll be automatically unbanned.`;
    }
  }
}
