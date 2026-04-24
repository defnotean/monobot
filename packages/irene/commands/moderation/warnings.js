import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { getWarnings, deleteWarning, clearWarnings } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("warnings")
  .setDescription("View or manage warnings for a user")
  .addUserOption((o) => o.setName("user").setDescription("User to check").setRequired(true))
  .addStringOption((o) =>
    o.setName("action").setDescription("Action to perform").addChoices(
      { name: "View", value: "view" },
      { name: "Clear All", value: "clear" }
    )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members")) return;

  const user = interaction.options.getUser("user");
  const action = interaction.options.getString("action") || "view";

  if (action === "clear") {
    const result = clearWarnings(interaction.guild.id, user.id);
    return interaction.reply({
      embeds: [infoEmbed("Warnings Cleared", `Cleared **${result.changes}** warnings for **${user.tag}**.`)],
    });
  }

  const warnings = getWarnings(interaction.guild.id, user.id);

  if (warnings.length === 0) {
    return interaction.reply({
      embeds: [infoEmbed("No Warnings", `**${user.tag}** has no warnings.`)],
      ephemeral: true,
    });
  }

  const list = warnings
    .slice(0, 10)
    .map((w, i) => `**${i + 1}.** ${w.reason}\n   <t:${Math.floor(new Date(w.created_at).getTime() / 1000)}:R> by <@${w.moderator_id}>`)
    .join("\n\n");

  await interaction.reply({
    embeds: [
      infoEmbed(
        `Warnings for ${user.tag}`,
        `Total: **${warnings.length}**\n\n${list}${warnings.length > 10 ? `\n\n...and ${warnings.length - 10} more` : ""}`
      ).setThumbnail(user.displayAvatarURL()),
    ],
  });
}
