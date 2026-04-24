import { SlashCommandBuilder } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

const RESPONSES = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.",
  "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
  "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.",
  "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
  "Don't count on it.", "My reply is no.", "My sources say no.",
  "Outlook not so good.", "Very doubtful.",
];

export const data = new SlashCommandBuilder()
  .setName("8ball")
  .setDescription("Ask the magic 8-ball a question")
  .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true));

export async function execute(interaction) {
  const cooldown = checkCooldown("8ball", interaction.user.id, 5000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  const question = interaction.options.getString("question");
  const answer = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];

  const embed = infoEmbed("Magic 8-Ball", answer);
  embed.addFields({ name: "Question", value: question, inline: false });

  await interaction.reply({
    embeds: [embed],
  });
}
