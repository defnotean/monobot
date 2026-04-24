import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("avatar")
  .setDescription("Get a user's avatar")
  .addUserOption((o) => o.setName("user").setDescription("User to get avatar for"));

export async function execute(interaction) {
  const user = interaction.options.getUser("user") || interaction.user;
  const avatarUrl = user.displayAvatarURL({ size: 1024, dynamic: true });

  const embed = new EmbedBuilder()
    .setColor(config.colors.info)
    .setTitle(`${user.username}'s Avatar`)
    .setImage(avatarUrl)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
