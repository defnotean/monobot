import { SlashCommandBuilder } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

export const data = new SlashCommandBuilder()
  .setName("coinflip")
  .setDescription("Flip a coin");

export async function execute(interaction) {
  const cooldown = checkCooldown("coinflip", interaction.user.id, 3000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  const result = Math.random() < 0.5 ? "Heads" : "Tails";
  const emoji = result === "Heads" ? "🪙" : "🪙";

  const embed = infoEmbed(`${emoji} Coin Flip`, `The coin landed on **${result}**!`);

  await interaction.reply({
    embeds: [embed],
  });
}
