import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, canModerate, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

const DURATIONS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "28d": 28 * 24 * 60 * 60 * 1000,
};

export const data = new SlashCommandBuilder()
  .setName("timeout")
  .setDescription("Timeout a user")
  .addUserOption((o) => o.setName("user").setDescription("User to timeout").setRequired(true))
  .addStringOption((o) =>
    o
      .setName("duration")
      .setDescription("Duration")
      .setRequired(true)
      .addChoices(
        { name: "1 minute", value: "1m" },
        { name: "5 minutes", value: "5m" },
        { name: "10 minutes", value: "10m" },
        { name: "30 minutes", value: "30m" },
        { name: "1 hour", value: "1h" },
        { name: "6 hours", value: "6h" },
        { name: "12 hours", value: "12h" },
        { name: "1 day", value: "1d" },
        { name: "3 days", value: "3d" },
        { name: "7 days", value: "7d" },
        { name: "28 days", value: "28d" }
      )
  )
  .addStringOption((o) => o.setName("reason").setDescription("Reason"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members")) return;

  const user = interaction.options.getUser("user");
  const duration = interaction.options.getString("duration");
  const reason = interaction.options.getString("reason") || "No reason provided";
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) return interaction.reply({ embeds: [errorEmbed("Not Found", "User not found in this server.")], ephemeral: true });
  if (!canModerate(interaction, member)) return;

  // Defer once perm/hierarchy checks pass — sendModLog + Discord op can
  // blow past the 3s initial-response window on slow API days.
  await interaction.deferReply();

  try {
    await member.timeout(DURATIONS[duration], reason);

    await interaction.editReply({
      embeds: [
        successEmbed("User Timed Out")
          .setDescription(`${user} has been timed out.`)
          .addFields(
            { name: "Duration", value: `\`${duration}\``, inline: true },
            { name: "Issued by", value: interaction.user.toString(), inline: true },
            { name: "Reason", value: reason, inline: false },
          ),
      ],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Member Timed Out")
        .setDescription(`**User:** ${user.tag} (${user.id})`)
        .addFields(
          { name: "Duration", value: duration, inline: true },
          { name: "Moderator", value: interaction.user.tag, inline: true },
          { name: "Reason", value: reason, inline: false },
        )
    );
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed("Timeout Failed", error.message)] });
  }
}
