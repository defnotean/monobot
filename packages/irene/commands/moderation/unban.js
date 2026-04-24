import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("unban")
  .setDescription("Unban a user by their ID")
  .addStringOption((o) => o.setName("userid").setDescription("User ID to unban").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Reason"))
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.BanMembers, "Ban Members")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.BanMembers, "Ban Members")) return;

  const userId = interaction.options.getString("userid");
  if (!/^\d{18,20}$/.test(userId)) {
    return interaction.reply({ content: "Please provide a valid user ID (18-20 digit number)", flags: 64 });
  }
  const reason = interaction.options.getString("reason") || "No reason provided";

  try {
    const ban = await interaction.guild.bans.fetch(userId);
    await interaction.guild.members.unban(userId, reason);

    await interaction.reply({
      embeds: [successEmbed("User Unbanned", `**${ban.user.tag}** has been unbanned.\nReason: ${reason}`)],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Member Unbanned", `**User:** ${ban.user.tag} (${userId})\n**Moderator:** ${interaction.user.tag}\n**Reason:** ${reason}`)
    );
  } catch (err) {
    if (err.code === 10026) {
      return interaction.reply({ embeds: [errorEmbed("Not Banned", "That user isn't banned.")], ephemeral: true });
    }
    await interaction.reply({
      embeds: [errorEmbed("Error", `Failed to unban: ${err.message}`)],
      ephemeral: true,
    });
  }
}
