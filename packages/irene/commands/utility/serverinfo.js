import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("serverinfo")
  .setDescription("Get information about this server");

export async function execute(interaction) {
  const guild = interaction.guild;

  const verificationLabels = ["None", "Low", "Medium", "High", "Highest"];
  const boostTierLabels = ["No Tier", "Tier 1", "Tier 2", "Tier 3"];

  const fields = [
    { name: "👑  Owner", value: `<@${guild.ownerId}>`, inline: true },
    { name: "👥  Members", value: `\`${guild.memberCount}\``, inline: true },
    { name: "🚀  Boost Level", value: `${boostTierLabels[guild.premiumTier] || `Level ${guild.premiumTier}`} (\`${guild.premiumSubscriptionCount}\` boosts)`, inline: true },
    { name: "💬  Channels", value: `\`${guild.channels.cache.size}\``, inline: true },
    { name: "🎭  Roles", value: `\`${guild.roles.cache.size}\``, inline: true },
    { name: "😄  Emojis", value: `\`${guild.emojis.cache.size}\``, inline: true },
    { name: "📅  Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
    { name: "🛡️  Verification", value: verificationLabels[guild.verificationLevel] || guild.verificationLevel.toString(), inline: true },
  ];

  await interaction.reply({
    embeds: [
      primaryEmbed(guild.name, guild.description || null)
        .setAuthor({ name: "Server Info" })
        .setThumbnail(guild.iconURL({ size: 256 }))
        .setFields(fields),
    ],
  });
}
