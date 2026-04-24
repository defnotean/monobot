import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("userinfo")
  .setDescription("Get information about a user")
  .addUserOption((o) => o.setName("user").setDescription("User to look up"));

export async function execute(interaction) {
  const user = interaction.options.getUser("user") || interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  const fields = [
    { name: "👤  Username", value: `\`${user.username}\``, inline: true },
    { name: "🔖  ID", value: `\`${user.id}\``, inline: true },
    { name: "🤖  Bot", value: user.bot ? "Yes" : "No", inline: true },
    { name: "📅  Account Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
  ];

  if (member) {
    fields.push(
      { name: "📥  Joined Server", value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
      { name: "✏️  Nickname", value: member.nickname || "None", inline: true },
      {
        name: `🎭  Roles (${member.roles.cache.size - 1})`,
        value: member.roles.cache.filter((r) => r.id !== interaction.guild.id).map((r) => r.toString()).join(", ") || "None",
        inline: false,
      }
    );
  }

  await interaction.reply({
    embeds: [
      primaryEmbed(`${user.username}`)
        .setAuthor({ name: "User Info", iconURL: user.displayAvatarURL({ size: 64 }) })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setFields(fields),
    ],
  });
}
