// ─── Voice & Nickname Executor ──────────────────────────────────────────────

import { PermissionFlagsBits } from "discord.js";
import { getVoiceStats } from "../../database.js";
import { tempChannels } from "../../utils/tempvc.js";

const HANDLED = new Set([
  "set_nickname", "move_user_to_voice", "disconnect_user_from_voice",
  "vc_info", "voice_leaderboard",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, by, findChannel, findMember, checkHierarchy } = ctx;

  switch (toolName) {
    case "set_nickname": {
      const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      if (!botMember?.permissions.has(PermissionFlagsBits.ManageNicknames)) return "I don't have permission to change nicknames";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const nickHierErr = checkHierarchy(message.member, member, guild);
      if (nickHierErr) return nickHierErr;
      await member.setNickname(input.nickname || null, `Set ${by}`);
      return input.nickname ? `Set ${member.user.tag}'s nickname to "${input.nickname}"` : `Reset ${member.user.tag}'s nickname`;
    }

    case "move_user_to_voice": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      if (!member.voice.channel) return `${member.user.tag} is not in a voice channel`;
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find voice channel "${input.channel_name}"`;
      await member.voice.setChannel(ch, `Moved ${by}`);
      return `Moved ${member.user.tag} to ${ch.name}`;
    }

    case "disconnect_user_from_voice": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      if (!member.voice.channel) return `${member.user.tag} is not in a voice channel`;
      await member.voice.disconnect(`Disconnected ${by}`);
      return `Disconnected ${member.user.tag} from voice`;
    }

    case "vc_info": {
      const caller = message.member;
      const voiceCh = caller?.voice?.channel;
      if (!voiceCh) return "you're not in a voice channel";

      const isTempVc = tempChannels.has(voiceCh.id);
      const ownerId = tempChannels.get(voiceCh.id);
      const owner = ownerId ? guild.members.cache.get(ownerId) : null;
      const nonBots = voiceCh.members.filter((m) => !m.user.bot);
      const memberList = nonBots.map((m) => {
        const game = m.presence?.activities?.find((a) => a.type === 0)?.name;
        return `• ${m.user.tag}${game ? ` — playing ${game}` : ""}`;
      }).join("\n");
      return (
        `**${voiceCh.name}**\n` +
        `Members: ${nonBots.size}${voiceCh.userLimit ? `/${voiceCh.userLimit}` : ""}\n` +
        `Owner: ${owner?.user.tag ?? (isTempVc ? "unknown" : "n/a (permanent)")}\n` +
        `Type: ${isTempVc ? "Temp VC" : "Permanent"}\n` +
        `Bitrate: ${voiceCh.bitrate / 1000}kbps\n` +
        `\n${memberList || "no members"}`
      );
    }

    case "voice_leaderboard": {
      // Defensive fallback — getVoiceStats can return undefined for a guild
      // that's never had voice activity tracked, making Object.entries throw.
      const stats = getVoiceStats(guild.id) || {};
      const entries = Object.entries(stats)
        .map(([uid, s]) => ({ userId: uid, minutes: s?.total_minutes ?? 0, sessions: s?.sessions ?? 0 }))
        .filter((e) => e.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, input.limit || 10);
      if (!entries.length) return "no voice activity tracked yet";
      const lines = entries.map((e, i) => {
        const hours = Math.floor(e.minutes / 60);
        const mins = e.minutes % 60;
        return `${i + 1}. <@${e.userId}> — ${hours}h ${mins}m (${e.sessions} sessions)`;
      });
      return `🎤 Voice Leaderboard:\n${lines.join("\n")}`;
    }
  }
}
