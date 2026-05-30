import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { errorEmbed, successEmbed } from "../../utils/embeds.js";
import { requireAdminOrOwner } from "../../utils/permissions.js";
import { setAutorole } from "../../database.js";
import { validateAssignableRole } from "../../ai/executors/customCommandExecutor.js";

export const data = new SlashCommandBuilder()
  .setName("autorole")
  .setDescription("Auto-assign a role to new members")
  .addRoleOption((o) => o.setName("role").setDescription("Role to assign").setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const role = interaction.options.getRole("role");
  const reason = validateAssignableRole(interaction.guild, role, {
    actor: interaction.member,
    actionLabel: "Autorole",
  });
  if (reason) {
    await interaction.reply({
      embeds: [errorEmbed("Unsafe Auto-Role", reason)],
      ephemeral: true,
    });
    return;
  }

  setAutorole(interaction.guild.id, role.id);

  await interaction.reply({
    embeds: [successEmbed("Auto-Role Set", `New members will automatically receive the ${role} role.`)],
  });
}
