import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { setAutorole } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("autorole")
  .setDescription("Auto-assign a role to new members")
  .addRoleOption((o) => o.setName("role").setDescription("Role to assign").setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const role = interaction.options.getRole("role");
  setAutorole(interaction.guild.id, role.id);

  await interaction.reply({
    embeds: [successEmbed("Auto-Role Set", `New members will automatically receive the ${role} role.`)],
  });
}
