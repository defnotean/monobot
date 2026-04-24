// ─── Twin Sub-Executor ──────────────────────────────────────────────────────
// Handles: ask_irene
// Called from main executor.js via delegation.

import { isOwner, isTrusted } from "../../utils/permissions.js";
import { log } from "../../utils/logger.js";
import { signTwinRequest } from "../../utils/twinSign.js";
import { resolveMember } from "../../utils/discord.js";
import config from "../../config.js";

const HANDLED = new Set(["ask_irene"]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "ask_irene": {
      if (!message.guild) return "i can only ask irene to do server stuff — this only works in a server, not DMs";

      const command = (input.command || "").toLowerCase().trim();
      if (!command) return "what do you want me to tell irene to do?";

      // Role-based permission check — mirrors Irene's own permission system
      const _memberPerms = message.member?.permissions;
      const _userIsAdmin = isOwner(message.author.id) || isTrusted(message.author.id) || _memberPerms?.has?.("Administrator");
      const _userIsMod = _userIsAdmin || _memberPerms?.has?.("ModerateMembers") || _memberPerms?.has?.("KickMembers") || _memberPerms?.has?.("BanMembers");
      const _userIsStaff = _userIsMod || _memberPerms?.has?.("ManageChannels") || _memberPerms?.has?.("ManageRoles");

      const _ADMIN_CMDS = ["create_channel", "delete_channel", "create_role", "delete_role", "set_log_channel", "set_welcome_channel", "setup_starboard", "setup_reaction_roles", "nuke_channel", "lockdown_server"];
      const _MOD_CMDS = ["ban", "ban_user", "kick", "kick_user", "warn", "warn_user", "timeout", "timeout_user", "purge", "purge_messages", "lock", "lock_channel", "unlock", "unlock_channel", "slowmode", "set_slowmode", "nickname", "set_nickname"];
      const _STAFF_CMDS = ["give_role", "remove_role", "mass_role", "set_topic", "rename_channel", "move_channel"];

      const _sassyDeny = ["lol cute attempt", "that's adorable that you thought you could do that", "you wish bestie", "maybe in your dreams", "nah you're not built for that one", "ask someone with actual power", "that's above your clearance level sorry not sorry"][Math.floor(Math.random() * 7)];
      if (_ADMIN_CMDS.includes(command) && !_userIsAdmin) return _sassyDeny;
      if (_MOD_CMDS.includes(command) && !_userIsMod) return _sassyDeny;
      if (_STAFF_CMDS.includes(command) && !_userIsStaff) return _sassyDeny;

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
          if (member) args.target_id = member.id;
        }
        args.role_name = input.role_name || input.role || "";
      }
      if (command === "set_topic") {
        args.topic = (input.topic || "").substring(0, 1024);
      }
      if (command === "ban" || command === "kick" || command === "warn" || command === "timeout") {
        if (input.target_username && message.guild) {
          const member = await resolveMember(message.guild, input.target_username);
          if (member) args.target_id = member.id;
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
