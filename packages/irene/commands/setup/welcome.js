import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { setWelcomeChannel } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("welcome")
  .setDescription("Configure the welcome message channel")
  .addChannelOption((o) => o.setName("channel").setDescription("Welcome channel").setRequired(true))
  .addStringOption((o) =>
    o.setName("message").setDescription("Welcome message ({user}, {mention}, {username}, {server}, {membercount})")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const channel = interaction.options.getChannel("channel");
  const message = interaction.options.getString("message");

  if (message && !message.trim()) {
    return interaction.reply({ content: "Message can't be empty", flags: 64 });
  }

  setWelcomeChannel(interaction.guild.id, channel.id, message);

  const previewName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const preview = (message || "Everyone say hello to {user}! You're member **#{membercount}** — glad you're here.")
    .replace(/{mention}/g, interaction.user.toString())
    .replace(/{user}/g, previewName)
    .replace(/{username}/g, interaction.user.username)
    .replace(/{server}/g, interaction.guild.name)
    .replace(/{membercount}/g, interaction.guild.memberCount);

  await interaction.reply({
    embeds: [
      successEmbed(
        "Welcome Channel Set",
        `Welcome messages will be sent to ${channel}.\n\n**Preview:**\n${preview}`
      ),
    ],
  });
}
