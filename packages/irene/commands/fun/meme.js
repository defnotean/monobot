import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { errorEmbed } from "../../utils/embeds.js";
import { checkCooldown, resetCooldown } from "../../utils/cooldown.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("meme")
  .setDescription("Get a random meme");

export async function execute(interaction) {
  const cooldown = checkCooldown("meme", interaction.user.id, 5000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  await interaction.deferReply();

  try {
    let data = null;
    let retries = 2;

    while (retries > 0) {
      const res = await fetch("https://meme-api.com/gimme");
      if (!res.ok) {
        retries--;
        if (retries === 0) {
          resetCooldown("meme", interaction.user.id);
          return interaction.editReply({ embeds: [errorEmbed("API Error", "External API returned an error, try again")] });
        }
        continue;
      }

      data = await res.json();

      if (!data.url || !data.title) {
        retries--;
        if (retries === 0) {
          resetCooldown("meme", interaction.user.id);
          return interaction.editReply({ embeds: [errorEmbed("Error", "Couldn't find a valid meme.")] });
        }
        continue;
      }

      // Validate URL is valid
      try {
        new URL(data.url);
      } catch {
        retries--;
        if (retries === 0) {
          resetCooldown("meme", interaction.user.id);
          return interaction.editReply({ embeds: [errorEmbed("Error", "Invalid meme URL received.")] });
        }
        continue;
      }

      break;
    }

    if (!data) {
      resetCooldown("meme", interaction.user.id);
      return interaction.editReply({ embeds: [errorEmbed("Error", "Failed to fetch a valid meme.")] });
    }

    const embed = new EmbedBuilder()
      .setColor(config.colors.info)
      .setTitle(data.title)
      .setImage(data.url)
      .setFooter({ text: `r/${data.subreddit || "memes"} | ${data.ups || 0} upvotes` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    resetCooldown("meme", interaction.user.id);
    await interaction.editReply({ embeds: [errorEmbed("Error", "Failed to fetch meme.")] });
  }
}
