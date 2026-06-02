// ─── Temp VC Management Executor ────────────────────────────────────────────
//
// Owns the user-facing temp-VC controls (vc_private/public/lock/unlock/rename/
// transfer/kick/allow/claim) plus the admin-side create-VC configuration tools
// (set_create_vc_channel, set_afk_channel, set_vc_template, set_vc_default_limit,
// set_vc_naming_mode, toggle_vc_rich_presence).
//
// NOTE: the executor.js pre-switch hook still intercepts `set_vc_template` (and
// `create_channel`) when the user's phrasing implies they want to configure the
// CURRENT/EXISTING voice channel rather than apply a literal template — that
// guard runs before sub-executors and short-circuits, so this handler only sees
// genuine template sets.

import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  setAfkSettings,
  setCreateVcChannel,
  setVcTemplate,
  setVcDefaultLimit,
  saveTempVc,
} from "../../database.js";
import { tempChannels, tempTextChannels, tempVcSeq, manualRenames, TEMP_VC_OWNER_OVERWRITE, TEMP_VC_OWNER_REVOKE } from "../../utils/tempvc.js";

const HANDLED = new Set([
  "vc_private", "vc_public", "vc_lock", "vc_unlock", "vc_rename",
  "vc_transfer", "vc_kick", "vc_allow", "vc_claim",
  "set_create_vc_channel", "set_afk_channel", "set_vc_template",
  "set_vc_default_limit", "set_vc_naming_mode", "toggle_vc_rich_presence",
]);

// Resolve the create-VC trigger channel from the request, falling back to the
// requester's current voice channel when they say "this/current/my vc". Mirrors
// the helper that lived in executor.js so set_create_vc_channel /
// set_vc_template-as-trigger behave identically.
function requesterCurrentVoiceChannel(message) {
  return message?.member?.voice?.channel ?? null;
}

function wantsCurrentVoiceChannel(message) {
  const text = String(message?.content || "").toLowerCase();
  return /\b(this|current|my|the)\s+(vc|voice|voice channel)\b/.test(text)
    || /\b(vc|voice channel)\s+(i'?m|im|i am|we'?re|were|we are)\s+in\b/.test(text)
    || /\bset(?:up)?\s+this\s+(vc|voice)\b/.test(text)
    || /\b(turn|make|set|setup|configure|assign)\s+(this|that)(?:\s+(?:channel|vc|voice(?:\s+channel)?))?\s+(?:into|as|to be|a|an)\b/.test(text);
}

function resolveCreateVcTriggerChannel(guild, input, message, findChannel, fallbackName) {
  const requested = input.channel_id || input.channel_name || fallbackName;
  let ch = findChannel(guild, requested, ChannelType.GuildVoice);
  const currentVoice = requesterCurrentVoiceChannel(message);
  const currentRequested = !requested || /^(this|current|my|here|voice|vc|this vc|current vc|my vc)$/i.test(String(requested).trim());
  if ((!ch && wantsCurrentVoiceChannel(message)) || currentRequested) ch = currentVoice;
  return { ch, requested };
}

function configureCreateVcTrigger(guild, input, message, findChannel, fallbackName) {
  const { ch, requested } = resolveCreateVcTriggerChannel(guild, input, message, findChannel, fallbackName);
  if (!ch) return `Couldn't find channel "${requested || input.channel_name || "current voice channel"}"`;
  if (ch.type !== ChannelType.GuildVoice) return `"${ch.name}" isn't a voice channel`;
  setCreateVcChannel(guild.id, ch.id);
  return `Create-VC trigger set to "${ch.name}" - users who join it will get their own personal VC`;
}

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findMember, findChannel } = ctx;

  switch (toolName) {
    // ─── Temp VC Management ──────────────────────────────────────────
    case "vc_private":
    case "vc_public":
    case "vc_lock":
    case "vc_unlock":
    case "vc_rename":
    case "vc_transfer":
    case "vc_kick":
    case "vc_allow":
    case "vc_claim": {
      const caller = message.member;
      const voiceCh = caller?.voice?.channel;
      if (!voiceCh) return "you're not in a voice channel";

      const isAdmin = caller.permissions.has(PermissionFlagsBits.Administrator) || caller.id === guild.ownerId;
      const ownerId = tempChannels.get(voiceCh.id);
      const isOwner = ownerId === caller.id;
      const isTempVc = tempChannels.has(voiceCh.id);

      if (toolName === "vc_claim") {
        if (!isTempVc) return "this isn't a temp VC";
        if (ownerId && voiceCh.members.has(ownerId)) return "the owner is still in the channel — can't claim";
        // Update Discord first — if this throws, state is untouched
        await voiceCh.permissionOverwrites.edit(caller, {
          ...TEMP_VC_OWNER_OVERWRITE,
        });
        tempChannels.set(voiceCh.id, caller.id);
        manualRenames.delete(voiceCh.id); // new owner — let auto-renamer pick up their game
        saveTempVc(voiceCh.id, { ownerId: caller.id, guildId: guild.id, seq: tempVcSeq.get(voiceCh.id) ?? 1, textChannelId: tempTextChannels.get(voiceCh.id) ?? null });
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        const { queueRename } = await import("../../utils/vcrenamer.js");
        queueRename(voiceCh, guild);
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `you now own **${voiceCh.name}**`;
      }

      if (!isTempVc && !isAdmin) return "this isn't a temp VC";
      if (!isOwner && !isAdmin) return "you don't own this channel";

      if (toolName === "vc_private") {
        // Both Connect AND ViewChannel false — matches the panel's Private definition
        await voiceCh.permissionOverwrites.edit(guild.roles.everyone, { Connect: false, ViewChannel: false });
        for (const [, m] of voiceCh.members) {
          if (!m.user.bot) await voiceCh.permissionOverwrites.edit(m, { Connect: true, ViewChannel: true }).catch(() => {});
        }
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔒 **${voiceCh.name}** is now private — only current members can see and rejoin`;
      }

      if (toolName === "vc_public") {
        await voiceCh.permissionOverwrites.edit(guild.roles.everyone, { Connect: null, ViewChannel: null });
        for (const [, m] of voiceCh.members) {
          if (!m.user.bot) await voiceCh.permissionOverwrites.delete(m).catch(() => {});
        }
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔓 **${voiceCh.name}** is now public`;
      }

      if (toolName === "vc_lock") {
        const limit = input.limit ?? voiceCh.members.filter((m) => !m.user.bot).size;
        await voiceCh.setUserLimit(limit);
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔒 **${voiceCh.name}** locked to ${limit} users`;
      }

      if (toolName === "vc_unlock") {
        await voiceCh.setUserLimit(0);
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔓 **${voiceCh.name}** limit removed`;
      }

      if (toolName === "vc_rename") {
        if (!input.name) return "no name provided";
        const trimmedName = input.name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 100) return "channel name must be between 2 and 100 characters";
        await voiceCh.setName(trimmedName);
        // Lock the auto-renamer so it doesn't immediately overwrite the AI's rename
        manualRenames.set(voiceCh.id, Date.now());
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `renamed to **${trimmedName}**`;
      }

      if (toolName === "vc_transfer") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        if (!voiceCh.members.has(target.id)) return `${target.user.tag} isn't in your channel`;
        if (target.id === caller.id) return "that's already you";
        // Update Discord first — if this throws, state is untouched
        await voiceCh.permissionOverwrites.edit(target, {
          ...TEMP_VC_OWNER_OVERWRITE,
        });
        await voiceCh.permissionOverwrites.edit(caller, {
          ...TEMP_VC_OWNER_REVOKE,
        }).catch(() => {});
        tempChannels.set(voiceCh.id, target.id);
        manualRenames.delete(voiceCh.id); // new owner — let auto-renamer pick up their game
        saveTempVc(voiceCh.id, { ownerId: target.id, guildId: guild.id, seq: tempVcSeq.get(voiceCh.id) ?? 1, textChannelId: tempTextChannels.get(voiceCh.id) ?? null });
        const { updateControlPanel } = await import("../../utils/vcpanel.js");
        const { queueRename } = await import("../../utils/vcrenamer.js");
        queueRename(voiceCh, guild);
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `transferred ownership of **${voiceCh.name}** to ${target.user.tag}`;
      }

      if (toolName === "vc_kick") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        if (!voiceCh.members.has(target.id)) return `${target.user.tag} isn't in your channel`;
        if (target.id === caller.id) return "you can't kick yourself";
        if (target.id === ownerId) return "you can't kick the channel owner";
        await target.voice.disconnect(`Kicked from VC by ${caller.user.tag}`);
        if (input.ban) await voiceCh.permissionOverwrites.edit(target, { Connect: false });
        const { updateControlPanel: ucpKick } = await import("../../utils/vcpanel.js");
        ucpKick(voiceCh.id, guild).catch(() => {});
        return `kicked ${target.user.tag} from **${voiceCh.name}**${input.ban ? " and banned from rejoining" : ""}`;
      }

      if (toolName === "vc_allow") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        await voiceCh.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
        const { updateControlPanel: ucpAllow } = await import("../../utils/vcpanel.js");
        ucpAllow(voiceCh.id, guild).catch(() => {});
        return `${target.user.tag} can now join **${voiceCh.name}**`;
      }

      return `Unknown VC action: ${toolName}`;
    }

    case "set_create_vc_channel": {
      return configureCreateVcTrigger(guild, input, message, findChannel);
    }

    case "set_afk_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (ch.type !== ChannelType.GuildVoice) return `"${ch.name}" isn't a voice channel`;
      const minutes = input.timeout_minutes || 30;
      setAfkSettings(guild.id, ch.id, minutes);
      await guild.setAFKChannel(ch.id).catch(() => {});
      await guild.setAFKTimeout(Math.min(minutes * 60, 3600)).catch(() => {});
      return `AFK channel set to "${ch.name}" — users who self-deafen for ${minutes} minute${minutes !== 1 ? "s" : ""} will be moved there automatically`;
    }

    case "set_vc_template": {
      setVcTemplate(guild.id, input.template);
      return (
        `VC template set to: \`${input.template}\`\n` +
        `**Name vars:** \`{creator}\` \`{game}\` \`{game|Fallback Text}\` \`{server}\` \`{stream}\` \`@@nato@@\`\n` +
        `**Count vars:** \`@@num@@\` (total users) \`@@num_others@@\` (excluding creator)\n` +
        `**Numbering:** \`##\` (#1) \`$#\` (1) \`+#\` (I) \`$0#\` (01) \`$00#\` (001)\n` +
        `**Singular/plural:** \`<<mouse/mice>>\` (uses @@num@@) \`<<mouse\\\\mice>>\` (uses @@num_others@@)\n` +
        `**Random word:** \`[[Squad/Team/Party]]\``
      );
    }

    case "set_vc_default_limit": {
      setVcDefaultLimit(guild.id, input.limit);
      return input.limit > 0 ? `New temp VCs will have a default limit of ${input.limit} users` : `Default VC limit removed — new VCs will be unlimited`;
    }

    case "set_vc_naming_mode": {
      const { setVcNamingMode } = await import("../../database.js");
      const mode = input.mode;
      if (!["smart", "anonymous", "random"].includes(mode)) return `Invalid mode "${mode}" — use smart, anonymous, or random`;
      setVcNamingMode(guild.id, mode);
      const modeDesc = {
        smart: "**Smart** — shows the creator's name (e.g. `Valorant • eating's vc`)",
        anonymous: "**Anonymous** — numbered VCs, no names (e.g. `Valorant • VC #1`)",
        random: "**Random** — themed names (e.g. `The Lounge • Alpha`, `Chill Zone • Bravo`)",
      };
      return `VC naming mode set to ${modeDesc[mode]}`;
    }

    case "toggle_vc_rich_presence": {
      const { setVcRichPresence } = await import("../../database.js");
      setVcRichPresence(guild.id, input.enabled);
      return input.enabled
        ? `Rich presence enabled in VC names — they will now show details like "Marvel Rivals: In Combat"`
        : `Rich presence disabled in VC names — they will now only show the base game name like "Marvel Rivals"`;
    }
  }
}
