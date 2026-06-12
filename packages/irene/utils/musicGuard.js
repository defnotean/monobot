// ─── Music Guard — shared DJ + same-VC authorization ────────────────────────
// Single source of truth for "may this member control playback?". Mirrors the
// control-panel button handler in events/interactionCreate.js:
//   1. same-VC — the requester must be in the bot's voice channel
//      (Administrator permission or server owner bypasses)
//   2. DJ role — the requester must hold the configured DJ role
//      (server owner / Manage Guild bypass; no-op when no DJ role is set)
// Applied by the /skip /stop /pause /resume /volume /loop /shuffle slash
// commands and by the AI music tool executor (ai/executors/musicExecutor.js)
// so the LLM path cannot bypass the documented DJ model.

import { PermissionFlagsBits } from "discord.js";
import { errorEmbed } from "./embeds.js";
import { getDjRole } from "../commands/music/dj.js";

/**
 * Core check shared by the slash commands and the AI tool path.
 * Returns null when the member may control playback, otherwise a denial
 * descriptor `{ reason: "vc"|"dj", title, text }`.
 */
export function checkDjAndSameVc(member, guild) {
  // ── Same-VC: must share the bot's voice channel (admin/owner bypass) ──────
  const botVc  = guild.members.cache.get(guild.client.user.id)?.voice?.channel;
  const userVc = member?.voice?.channel;
  const isAdmin = member?.permissions.has(PermissionFlagsBits.Administrator)
    || member?.id === guild.ownerId;

  if (!isAdmin && (!userVc || userVc.id !== botVc?.id)) {
    return {
      reason: "vc",
      title: "Not In Channel",
      text: "You need to be in the same voice channel as me to control the music.",
    };
  }

  // ── DJ role: matches requireDj in commands/music/dj.js ────────────────────
  const djRoleId = getDjRole(guild.id);
  if (
    djRoleId
    && member?.id !== guild.ownerId
    && !member?.permissions.has(PermissionFlagsBits.ManageGuild)
    && !member?.roles.cache.has(djRoleId)
  ) {
    const roleName = guild.roles.cache.get(djRoleId)?.name || "unknown";
    return {
      reason: "dj",
      title: "DJ Role Required",
      text: `only **${roleName}** can use this command`,
    };
  }

  return null;
}

/**
 * Slash-command wrapper. Replies ephemerally with the denial and returns
 * false when blocked; returns true when the member may control playback.
 */
export async function requireDjAndSameVc(interaction) {
  const denial = checkDjAndSameVc(interaction.member, interaction.guild);
  if (!denial) return true;
  await interaction.reply({
    embeds: [errorEmbed(denial.title, denial.text)],
    flags: 64,
  });
  return false;
}
