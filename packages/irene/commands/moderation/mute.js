import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, canModerate, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("mute")
  .setDescription("Mute a user (role-based)")
  .addUserOption((o) => o.setName("user").setDescription("User to mute").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Reason"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.ManageRoles, "Manage Roles")) return;

  const user = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason") || "No reason provided";
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) return interaction.reply({ content: "User not found.", ephemeral: true });
  if (!canModerate(interaction, member)) return;

  // Find or create Muted role
  let muteRole = interaction.guild.roles.cache.find((r) => r.name === "Muted");
  if (!muteRole) {
    try {
      muteRole = await interaction.guild.roles.create({
        name: "Muted",
        color: 0x808080,
        permissions: [],
        reason: "Auto-created mute role",
      });

      // Deny send messages in all text channels
      for (const channel of interaction.guild.channels.cache.values()) {
        if (channel.isTextBased()) {
          await channel.permissionOverwrites.edit(muteRole, {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
          }).catch(() => {});
        }
      }
    } catch (error) {
      return interaction.reply({ content: `Failed to create Muted role: ${error.message}`, ephemeral: true });
    }
  }

  if (member.roles.cache.has(muteRole.id)) {
    return interaction.reply({ content: "That user is already muted.", ephemeral: true });
  }

  try {
    await member.roles.add(muteRole, reason);

    await interaction.reply({
      embeds: [successEmbed("User Muted", `**${user.tag}** has been muted.\nReason: ${reason}`)],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Member Muted", `**User:** ${user.tag} (${user.id})\n**Moderator:** ${interaction.user.tag}\n**Reason:** ${reason}`)
    );
  } catch (error) {
    await interaction.reply({ content: `Failed to mute: ${error.message}`, ephemeral: true });
  }
}
