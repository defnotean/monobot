// ─── Server Management Executor ─────────────────────────────────────────────

import { AuditLogEvent } from "discord.js";
import { log } from "../../utils/logger.js";

import { getInviteHistory, getInviteLeaderboard, getInvitesBy } from "../../database.js";

const HANDLED = new Set([
  "list_invites", "delete_invite", "invite_stats", "set_server_settings",
  "set_server_icon", "view_audit_log", "list_members", "create_invite",
]);

const VERIFICATION_LEVELS = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 };
const NOTIFICATION_LEVELS = { all_messages: 0, only_mentions: 1 };
const CONTENT_FILTER_LEVELS = { disabled: 0, members_without_roles: 1, all_members: 2 };
const VALID_AFK_TIMEOUTS = [60, 300, 900, 1800, 3600];

const AUDIT_LOG_TYPES = {
  guild_update: AuditLogEvent.GuildUpdate,
  channel_create: AuditLogEvent.ChannelCreate,
  channel_update: AuditLogEvent.ChannelUpdate,
  channel_delete: AuditLogEvent.ChannelDelete,
  channel_overwrite_create: AuditLogEvent.ChannelOverwriteCreate,
  channel_overwrite_update: AuditLogEvent.ChannelOverwriteUpdate,
  channel_overwrite_delete: AuditLogEvent.ChannelOverwriteDelete,
  member_kick: AuditLogEvent.MemberKick,
  member_prune: AuditLogEvent.MemberPrune,
  member_ban_add: AuditLogEvent.MemberBanAdd,
  member_ban_remove: AuditLogEvent.MemberBanRemove,
  member_update: AuditLogEvent.MemberUpdate,
  member_role_update: AuditLogEvent.MemberRoleUpdate,
  member_move: AuditLogEvent.MemberMove,
  member_disconnect: AuditLogEvent.MemberDisconnect,
  bot_add: AuditLogEvent.BotAdd,
  role_create: AuditLogEvent.RoleCreate,
  role_update: AuditLogEvent.RoleUpdate,
  role_delete: AuditLogEvent.RoleDelete,
  invite_create: AuditLogEvent.InviteCreate,
  invite_update: AuditLogEvent.InviteUpdate,
  invite_delete: AuditLogEvent.InviteDelete,
  webhook_create: AuditLogEvent.WebhookCreate,
  webhook_update: AuditLogEvent.WebhookUpdate,
  webhook_delete: AuditLogEvent.WebhookDelete,
  emoji_create: AuditLogEvent.EmojiCreate,
  emoji_update: AuditLogEvent.EmojiUpdate,
  emoji_delete: AuditLogEvent.EmojiDelete,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  message_pin: AuditLogEvent.MessagePin,
  message_unpin: AuditLogEvent.MessageUnpin,
};

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, by } = ctx;

  switch (toolName) {
    // ── Create Invite ─────────────────────────────────────────────────────────
    case "create_invite": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const invite = await ch.createInvite({
        maxUses: input.max_uses || 0,
        maxAge: input.max_age ?? 0,
        temporary: input.temporary || false,
        reason: `Created ${by}`,
      });
      return `Created invite: https://discord.gg/${invite.code}${input.max_uses ? ` (${input.max_uses} uses)` : ""}${input.max_age ? ` (expires in ${input.max_age}s)` : " (never expires)"}`;
    }

    // ── List Invites ──────────────────────────────────────────────────────────
    case "list_invites": {
      try {
        const invites = await guild.invites.fetch();
        if (invites.size === 0) return "No active invites found.";

        const lines = invites.map((inv) => {
          const channel = inv.channel?.name || "unknown";
          const inviter = inv.inviter?.tag || "unknown";
          const maxUses = inv.maxUses === 0 ? "unlimited" : inv.maxUses;
          const temporary = inv.temporary ? "yes" : "no";
          const expiresAt = inv.expiresAt ? inv.expiresAt.toISOString() : "never";
          return `\`${inv.code}\` — #${channel} — by ${inviter} — ${inv.uses}/${maxUses} uses — temp: ${temporary} — expires: ${expiresAt}`;
        });

        return `**Active Invites (${invites.size}):**\n${lines.join("\n")}`;
      } catch (err) {
        log(`[SERVER] list_invites failed: ${err.message}`);
        return `Failed to fetch invites: ${err.message}`;
      }
    }

    // ── Delete Invite ─────────────────────────────────────────────────────────
    case "delete_invite": {
      try {
        const code = input.code?.trim();
        if (!code) return "No invite code provided.";

        const invites = await guild.invites.fetch();
        const invite = invites.find((inv) => inv.code === code);
        if (!invite) return `Invite with code \`${code}\` not found.`;

        await invite.delete();
        return `Deleted invite \`${code}\`.`;
      } catch (err) {
        log(`[SERVER] delete_invite failed: ${err.message}`);
        return `Failed to delete invite: ${err.message}`;
      }
    }

    // ── Invite Stats ─────────────────────────────────────────────────────────
    case "invite_stats": {
      const action = input.action || "leaderboard";
      const count = Math.min(Math.max(input.count || 10, 1), 50);

      if (action === "leaderboard") {
        const lb = getInviteLeaderboard(guild.id);
        if (!lb.length) return "No invite data tracked yet — invites are recorded when new members join.";
        const lines = lb.slice(0, count).map((e, i) => {
          const stayRate = e.total > 0 ? Math.round((e.stayed / e.total) * 100) : 0;
          return `${i + 1}. ${e.tag || `<@${e.userId}>`} — ${e.total} invites (${e.stayed} stayed, ${e.left} left, ${stayRate}% retention)`;
        });
        return `Invite Leaderboard:\n${lines.join("\n")}`;
      }

      if (action === "history") {
        const history = getInviteHistory(guild.id, count);
        if (!history.length) return "No invite join history recorded yet.";
        const lines = history.map(e => {
          const status = e.left ? "❌ left" : "✅ stayed";
          const inviter = e.inviterTag ? ` (invited by ${e.inviterTag})` : "";
          return `${e.username} — code \`${e.inviteCode}\`${inviter} — ${status} — <t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:R>`;
        });
        return `Recent joins:\n${lines.join("\n")}`;
      }

      if (action === "user") {
        if (!input.username) return "Need a username to look up.";
        const { findMember } = ctx;
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        const invites = getInvitesBy(guild.id, target.id);
        if (!invites.length) return `${target.user.tag} hasn't invited anyone (that we tracked).`;
        const stayed = invites.filter(e => !e.left).length;
        const left = invites.filter(e => e.left).length;
        const lines = invites.slice(-count).map(e => {
          const status = e.left ? "❌ left" : "✅ stayed";
          return `${e.username} — ${status} — <t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:R>`;
        });
        return `${target.user.tag} invited ${invites.length} people (${stayed} stayed, ${left} left):\n${lines.join("\n")}`;
      }

      return "Unknown action — use 'leaderboard', 'history', or 'user'.";
    }

    // ── Set Server Settings ───────────────────────────────────────────────────
    case "set_server_settings": {
      try {
        const edits = {};
        const applied = [];

        if (input.name) {
          edits.name = input.name;
          applied.push(`name → ${input.name}`);
        }

        if (input.description !== undefined) {
          edits.description = input.description;
          applied.push(`description → ${input.description || "(cleared)"}`);
        }

        if (input.verification_level !== undefined) {
          const level = VERIFICATION_LEVELS[input.verification_level];
          if (level === undefined) return `Invalid verification level "${input.verification_level}". Use: ${Object.keys(VERIFICATION_LEVELS).join(", ")}`;
          edits.verificationLevel = level;
          applied.push(`verification_level → ${input.verification_level}`);
        }

        if (input.default_notifications !== undefined) {
          const level = NOTIFICATION_LEVELS[input.default_notifications];
          if (level === undefined) return `Invalid notification level "${input.default_notifications}". Use: ${Object.keys(NOTIFICATION_LEVELS).join(", ")}`;
          edits.defaultMessageNotifications = level;
          applied.push(`default_notifications → ${input.default_notifications}`);
        }

        if (input.content_filter !== undefined) {
          const level = CONTENT_FILTER_LEVELS[input.content_filter];
          if (level === undefined) return `Invalid content filter "${input.content_filter}". Use: ${Object.keys(CONTENT_FILTER_LEVELS).join(", ")}`;
          edits.explicitContentFilter = level;
          applied.push(`content_filter → ${input.content_filter}`);
        }

        if (input.afk_timeout != null) {
          const timeout = parseInt(input.afk_timeout, 10);
          if (!VALID_AFK_TIMEOUTS.includes(timeout)) return `Invalid AFK timeout. Must be one of: ${VALID_AFK_TIMEOUTS.join(", ")} (seconds).`;
          edits.afkTimeout = timeout;
          applied.push(`afk_timeout → ${timeout}s`);
        }

        if (input.system_channel !== undefined) {
          const ch = findChannel(guild, input.system_channel);
          if (!ch) return `Couldn't find system channel "${input.system_channel}".`;
          edits.systemChannelId = ch.id;
          applied.push(`system_channel → #${ch.name}`);
        }

        if (input.rules_channel !== undefined) {
          const ch = findChannel(guild, input.rules_channel);
          if (!ch) return `Couldn't find rules channel "${input.rules_channel}".`;
          edits.rulesChannelId = ch.id;
          applied.push(`rules_channel → #${ch.name}`);
        }

        if (applied.length === 0) return "No valid settings provided to change.";

        await guild.edit(edits);
        return `Updated server settings:\n${applied.map((a) => `- ${a}`).join("\n")}`;
      } catch (err) {
        log(`[SERVER] set_server_settings failed: ${err.message}`);
        return `Failed to update server settings: ${err.message}`;
      }
    }

    // ── Set Server Icon ───────────────────────────────────────────────────────
    case "set_server_icon": {
      try {
        const url = input.url?.trim();
        if (!url) return "No image URL provided.";

        const response = await fetch(url);
        if (!response.ok) return `Failed to fetch image: HTTP ${response.status}`;

        const contentType = response.headers.get("content-type") || "image/png";
        const buffer = Buffer.from(await response.arrayBuffer());
        const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;

        await guild.setIcon(dataUri);
        return "Server icon updated successfully.";
      } catch (err) {
        log(`[SERVER] set_server_icon failed: ${err.message}`);
        return `Failed to set server icon: ${err.message}`;
      }
    }

    // ── View Audit Log ────────────────────────────────────────────────────────
    case "view_audit_log": {
      try {
        const limit = Math.min(input.count || input.limit || 10, 50);
        const opts = { limit };

        if (input.action_type || input.type) {
          const raw = (input.action_type || input.type).toLowerCase();
          const actionType = AUDIT_LOG_TYPES[raw];
          if (actionType === undefined) return `Unknown audit log type "${input.type}". Available: ${Object.keys(AUDIT_LOG_TYPES).join(", ")}`;
          opts.type = actionType;
        }

        const logs = await guild.fetchAuditLogs(opts);
        if (logs.entries.size === 0) return "No audit log entries found.";

        const lines = logs.entries.map((entry) => {
          const action = entry.action;
          const actionName = Object.entries(AUDIT_LOG_TYPES).find(([, v]) => v === action)?.[0] || `action_${action}`;
          const executor = entry.executor?.tag || "unknown";
          const target = entry.target?.tag || entry.target?.name || entry.target?.id || "unknown";
          const reason = entry.reason || "no reason";
          return `**${actionName}** by ${executor} — target: ${target} — reason: ${reason}`;
        });

        return `**Audit Log (${logs.entries.size} entries):**\n${lines.join("\n")}`;
      } catch (err) {
        log(`[SERVER] view_audit_log failed: ${err.message}`);
        return `Failed to fetch audit log: ${err.message}`;
      }
    }

    // ── List Members ──────────────────────────────────────────────────────────
    case "list_members": {
      try {
        const limit = Math.min(input.limit || 20, 100);
        const members = await guild.members.fetch({ limit });

        if (members.size === 0) return "No members found.";

        const lines = members.map((m) => {
          const roles = m.roles.cache
            .filter((r) => r.id !== guild.id)
            .map((r) => r.name)
            .join(", ") || "none";
          const joined = m.joinedAt ? m.joinedAt.toISOString().split("T")[0] : "unknown";
          return `**${m.user.username}** (${m.displayName}) — roles: ${roles} — joined: ${joined}`;
        });

        return `**Members (${members.size}):**\n${lines.join("\n")}`;
      } catch (err) {
        log(`[SERVER] list_members failed: ${err.message}`);
        return `Failed to fetch members: ${err.message}`;
      }
    }

    default:
      return undefined;
  }
}
