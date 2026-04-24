import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

export const data = new SlashCommandBuilder()
  .setName("roll")
  .setDescription("Roll a dice")
  .addIntegerOption((o) =>
    o.setName("sides").setDescription("Number of sides (default: 6)").setMinValue(2).setMaxValue(100)
  )
  .addIntegerOption((o) =>
    o.setName("count").setDescription("Number of dice (default: 1)").setMinValue(1).setMaxValue(10)
  );

export async function execute(interaction) {
  const cooldown = checkCooldown("roll", interaction.user.id, 3000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  const sides = interaction.options.getInteger("sides") || 6;
  const count = interaction.options.getInteger("count") || 1;

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);

  const embed = primaryEmbed("🎲 Dice Roll", null);

  if (count === 1) {
    embed.setDescription(`You rolled a **${total}**`);
    embed.addFields({ name: "Die", value: `d${sides}`, inline: true });
  } else {
    embed.addFields(
      { name: "Rolls", value: rolls.map((r) => `**${r}**`).join(", "), inline: false },
      { name: "Total", value: total.toString(), inline: true },
      { name: "Formula", value: `${count}d${sides}`, inline: true }
    );
  }

  await interaction.reply({ embeds: [embed] });
}
