import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("See what Eris can do");

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setColor(config.colors.primary)
    .setTitle("Eris")
    .setDescription("i'm eris. just talk to me naturally — mention me or DM me. i'll figure out what you need")
    .addFields(
      { name: "chat", value: "just @ me or DM me. i talk like a real person", inline: true },
      { name: "tools", value: "i can search the web, analyze images, make memes, set reminders, take notes, and way more", inline: true },
      { name: "memory", value: "i remember things about you across conversations", inline: true },
      { name: "owner tools", value: "the bot owner gets terminal access, email, github, system control", inline: true },
    )
    .setFooter({ text: "46 AI tools | powered by gemini" });

  await interaction.reply({ embeds: [embed] });
}
