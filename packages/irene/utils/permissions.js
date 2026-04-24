// ─── Permission Check Helpers ───────────────────────────────────────────────

import { PermissionFlagsBits } from "discord.js";
import { errorEmbed } from "./embeds.js";
import { getTrustedUsers } from "../database.js";

export function isAdminOrOwner(interaction) {
  const member = interaction.member;
  // Server owner always passes
  if (member.id === interaction.guild.ownerId) return true;
  // Has Administrator or ManageGuild permission natively assigned
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  // Explicitly whitelisted anti-nuke trusted user for this specific guild
  if (getTrustedUsers(interaction.guild.id).includes(member.id)) return true;
  return false;
}

export function requirePermission(interaction, permission, permName) {
  // Server owner bypasses all permission checks
  if (interaction.member.id === interaction.guild.ownerId) return true;

  if (!interaction.member.permissions.has(permission)) {
    interaction.reply({
      embeds: [errorEmbed("No Permission", `Sorry, you need the **${permName}** permission to use this command. Please ask a server admin if you believe this is an error.`)],
      ephemeral: true,
    });
    return false;
  }
  return true;
}

export function requireAdminOrOwner(interaction) {
  if (!isAdminOrOwner(interaction)) {
    interaction.reply({
      embeds: [errorEmbed("No Permission", "This command is restricted to **server admins and owners** only.")],
      ephemeral: true,
    });
    return false;
  }
  return true;
}

export function requireBotPermission(interaction, permission, permName) {
  if (!interaction.guild.members.me.permissions.has(permission)) {
    interaction.reply({
      embeds: [errorEmbed("Bot Missing Permissions", `I need the **${permName}** permission to do this. Please ask an admin to update my role.`)],
      ephemeral: true,
    });
    return false;
  }
  return true;
}

export function canModerate(interaction, target) {
  const member = interaction.member;
  const targetMember = target;

  if (targetMember.id === interaction.guild.ownerId) {
    interaction.reply({
      embeds: [errorEmbed("Cannot Moderate", "You cannot moderate the server owner.")],
      ephemeral: true,
    });
    return false;
  }

  if (targetMember.id === interaction.client.user.id) {
    interaction.reply({
      embeds: [errorEmbed("Cannot Moderate", "I can't moderate myself, silly!")],
      ephemeral: true,
    });
    return false;
  }

  if (targetMember.id === member.id) {
    interaction.reply({
      embeds: [errorEmbed("Cannot Moderate", "You can't moderate yourself!")],
      ephemeral: true,
    });
    return false;
  }

  // Owner can moderate anyone
  if (member.id !== interaction.guild.ownerId) {
    if (member.roles.highest.position <= targetMember.roles.highest.position) {
      interaction.reply({
        embeds: [errorEmbed("Cannot Moderate", "That user has a higher or equal role than you.")],
        ephemeral: true,
      });
      return false;
    }
  }

  if (interaction.guild.members.me.roles.highest.position <= targetMember.roles.highest.position) {
    interaction.reply({
      embeds: [errorEmbed("Cannot Moderate", "That user has a higher or equal role than me. Please move my role higher in the role list.")],
      ephemeral: true,
    });
    return false;
  }

  return true;
}
