// ─── Twin Sub-Executor ──────────────────────────────────────────────────────
// Handles: ask_irene
// Called from main executor.js via delegation.

import { isOwner } from "../../utils/permissions.js";
import { log } from "../../utils/logger.js";
import { signTwinRequest } from "@defnotean/shared/twinSign";
import { resolveMember } from "../../utils/discord.js";
import config from "../../config.js";
import { PermissionFlagsBits } from "discord.js";

const HANDLED = new Set(["ask_irene"]);

const COMMAND_PERMISSIONS = new Map([
  ["announce", PermissionFlagsBits.ManageMessages],
  ["ban", PermissionFlagsBits.BanMembers],
  ["ban_user", PermissionFlagsBits.BanMembers],
  ["kick", PermissionFlagsBits.KickMembers],
  ["kick_user", PermissionFlagsBits.KickMembers],
  ["warn", PermissionFlagsBits.ModerateMembers],
  ["warn_user", PermissionFlagsBits.ModerateMembers],
  ["timeout", PermissionFlagsBits.ModerateMembers],
  ["timeout_user", PermissionFlagsBits.ModerateMembers],
  ["purge", PermissionFlagsBits.ManageMessages],
  ["purge_messages", PermissionFlagsBits.ManageMessages],
  ["lock", PermissionFlagsBits.ManageChannels],
  ["lock_channel", PermissionFlagsBits.ManageChannels],
  ["unlock", PermissionFlagsBits.ManageChannels],
  ["unlock_channel", PermissionFlagsBits.ManageChannels],
  ["slowmode", PermissionFlagsBits.ManageChannels],
  ["set_slowmode", PermissionFlagsBits.ManageChannels],
  ["set_topic", PermissionFlagsBits.ManageChannels],
  ["set_channel_topic", PermissionFlagsBits.ManageChannels],
  ["create_channel", PermissionFlagsBits.ManageChannels],
  ["delete_channel", PermissionFlagsBits.ManageChannels],
  ["nuke_channel", PermissionFlagsBits.ManageChannels],
  ["rename_channel", PermissionFlagsBits.ManageChannels],
  ["move_channel", PermissionFlagsBits.ManageChannels],
  ["set_log_channel", PermissionFlagsBits.ManageGuild],
  ["set_welcome_channel", PermissionFlagsBits.ManageGuild],
  ["setup_starboard", PermissionFlagsBits.ManageGuild],
  ["setup_reaction_roles", PermissionFlagsBits.ManageGuild],
  ["create_role", PermissionFlagsBits.ManageRoles],
  ["delete_role", PermissionFlagsBits.ManageRoles],
  ["give_role", PermissionFlagsBits.ManageRoles],
  ["remove_role", PermissionFlagsBits.ManageRoles],
  ["mass_role", PermissionFlagsBits.ManageRoles],
  ["nickname", PermissionFlagsBits.ManageNicknames],
  ["set_nickname", PermissionFlagsBits.ManageNicknames],
]);

function canRelayCommand(message, command) {
  if (isOwner(message.author.id)) return true;
  const required = COMMAND_PERMISSIONS.get(command);
  if (!required) return false;
  const perms = message.member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.Administrator) || perms?.has?.(required));
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "ask_irene": {
      if (!message.guild) return "i can only ask irene to do server stuff — this only works in a server, not DMs";

      const command = (input.command || "").toLowerCase().trim();
      if (!command) return "what do you want me to tell irene to do?";

      const _sassyDeny = ["lol cute attempt", "that's adorable that you thought you could do that", "you wish bestie", "maybe in your dreams", "nah you're not built for that one", "ask someone with actual power", "that's above your clearance level sorry not sorry"][Math.floor(Math.random() * 7)];
      if (!canRelayCommand(message, command)) return _sassyDeny;

      const IRENE_API = config.twinApiUrl;
      const TWIN_SECRET = config.twinApiSecret;
      if (!TWIN_SECRET) return "twin API secret not configured — can't securely contact irene";

      // Build args based on command
      const args = {};
      if (command === "purge") args.count = Math.min(Math.max(parseInt(input.count) || 10, 1), 100);
      if (command === "slowmode") args.seconds = Math.min(Math.max(parseInt(input.seconds) || 0, 0), 21600);
      if (command === "nickname") {
        if (input.target_username && message.guild) {
          const member = await resolveMember(message.guild, input.target_username);
          if (!member) return `couldn't find user "${input.target_username}"`;
          args.target_id = member.id;
          args.username = member.id; // Irene's set_nickname reads input.username (findMember accepts bare IDs)
        }
        args.nickname = input.nickname ? input.nickname.substring(0, 32) : null;
      }
      if (command === "create_channel") {
        const chName = (input.channel_name || input.name || "").substring(0, 100);
        if (!chName) return "provide a name for the channel";
        args.name = chName;            // what the receiving channelExecutor expects
        args.channel_name = chName;    // backward compat
        args.category = input.category || null;
        args.type = input.type || "text";
        if (input.private) args.private = true;
      }
      if (command === "set_log_channel" || command === "set_welcome_channel") {
        args.channel_id = input.channel_id || message.channel.id;
        args.channel_name = args.channel_id; // Irene's setupExecutor reads input.channel_name (findChannel accepts bare IDs)
      }
      if (command === "create_role") {
        const rName = (input.role_name || input.name || "").substring(0, 100);
        if (!rName) return "provide a name for the role";
        args.name = rName;             // what the receiving roleExecutor expects
        args.role_name = rName;        // backward compat
        args.color = input.color || null;
      }
      if (command === "give_role" || command === "remove_role") {
        if (input.target_username && message.guild) {
          const member = await resolveMember(message.guild, input.target_username);
          if (!member) return `couldn't find a unique user "${input.target_username}" — try @mention or user ID instead`;
          args.target_id = member.id;
          args.username = member.id; // Irene's roleExecutor reads input.username
        }
        args.role_name = input.role_name || input.role || "";
      }
      if (command === "set_topic") {
        args.topic = (input.topic || "").substring(0, 1024);
      }
      if (command === "ban" || command === "kick" || command === "warn" || command === "timeout") {
        if (input.target_username && message.guild) {
          const member = await resolveMember(message.guild, input.target_username);
          // Refuse on ambiguity — banning the wrong user is hard to undo, so
          // the cost of "ask user to disambiguate" is much lower than the cost
          // of silently picking the wrong "alex".
          if (!member) return `couldn't find a unique user "${input.target_username}" — try @mention or user ID instead`;
          args.target_id = member.id;
          args.username = member.id; // Irene's moderationExecutor reads input.username
        }
        args.reason = input.reason || "requested via Eris";
        if (command === "timeout") args.duration = input.duration || "5m";
      }
      if (command === "announce") {
        const msg = (input.announcement || input.message || "").substring(0, 2000);
        if (!msg) return "no announcement message provided";
        args.message = msg;
      }

      try {
        const payload = JSON.stringify({
          requester_id: message.author.id,
          guild_id: message.guild?.id,
          channel_id: message.channel.id,
          command,
          args,
        });
        const signatureHeaders = signTwinRequest(payload, TWIN_SECRET);
        log(`[ASK_IRENE] Calling ${IRENE_API}/api/twin/command — command: ${command}`);
        const res = await fetch(`${IRENE_API}/api/twin/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...signatureHeaders },
          body: payload,
        });
        const data = await res.json().catch(() => ({ error: `status ${res.status}` }));
        log(`[ASK_IRENE] Response: ${res.status}`);
        if (data.success) return `told irene to ${command} and she did it: ${data.result}`;
        return `irene refused: ${data.error}`;
      } catch (e) {
        log(`[ASK_IRENE] FAILED: ${e.message}`);
        return `couldn't reach irene — ${e.message}`;
      }
    }

    default:
      return undefined;
  }
}
