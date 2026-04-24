import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed, warnEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

const CHOICES = ["rock", "paper", "scissors"];
const EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };

export const data = new SlashCommandBuilder()
  .setName("rps")
  .setDescription("Play Rock Paper Scissors")
  .addStringOption((o) =>
    o.setName("choice").setDescription("Your choice").setRequired(true).addChoices(
      { name: "Rock", value: "rock" },
      { name: "Paper", value: "paper" },
      { name: "Scissors", value: "scissors" }
    )
  );

export async function execute(interaction) {
  const cooldown = checkCooldown("rps", interaction.user.id, 5000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  const userChoice = interaction.options.getString("choice");
  const botChoice = CHOICES[Math.floor(Math.random() * 3)];

  let result, embed;
  if (userChoice === botChoice) {
    result = "tie";
    embed = warnEmbed("It's a Tie!", `${EMOJI[userChoice]} vs ${EMOJI[botChoice]}`);
  } else if (
    (userChoice === "rock" && botChoice === "scissors") ||
    (userChoice === "paper" && botChoice === "rock") ||
    (userChoice === "scissors" && botChoice === "paper")
  ) {
    result = "win";
    embed = successEmbed("You Win!", `${EMOJI[userChoice]} beats ${EMOJI[botChoice]}`);
  } else {
    result = "lose";
    embed = errorEmbed("You Lose!", `${EMOJI[botChoice]} beats ${EMOJI[userChoice]}`);
  }

  await interaction.reply({ embeds: [embed] });
}
