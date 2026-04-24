import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { setLogChannel } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("logging")
  .setDescription("Set the moderation log channel")
  .addChannelOption((o) => o.setName("channel").setDescription("Log channel").setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const channel = interaction.options.getChannel("channel");
  setLogChannel(interaction.guild.id, channel.id);

  await interaction.reply({
    embeds: [successEmbed("Log Channel Set", `Moderation logs will be sent to ${channel}.`)],
  });
}
