import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType } from "discord.js";
import { setGuildSetting } from "../../database.js";
import { buildDigest, postDigest } from "../../ai/weeklyDigest.js";

export const data = new SlashCommandBuilder()
  .setName("digest")
  .setDescription("Weekly server digest — bump ROI + growth")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName("now").setDescription("Generate and preview the digest right now")
      .addIntegerOption(opt => opt.setName("days").setDescription("Lookback window (default 7)").setMinValue(1).setMaxValue(30)))
  .addSubcommand(sub =>
    sub.setName("channel").setDescription("Set the channel where weekly digests auto-post")
      .addChannelOption(opt => opt.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(sub =>
    sub.setName("post").setDescription("Post the digest to the configured channel now"))
  .addSubcommand(sub =>
    sub.setName("disable").setDescription("Stop auto-posting weekly digests"));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (sub === "now") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const days = interaction.options.getInteger("days") ?? 7;
    const embed = await buildDigest(guild, { days });
    if (!embed) return interaction.editReply({ content: `no activity in the last ${days} days` });
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "channel") {
    const ch = interaction.options.getChannel("channel");
    setGuildSetting(guild.id, "digest_channel_id", ch.id);
    return interaction.reply({ content: `weekly digests will post to ${ch} every sunday at noon`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "post") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await postDigest(guild, interaction.client);
    if (result.posted) return interaction.editReply({ content: `posted ✨` });
    return interaction.editReply({ content: `couldn't post: ${result.reason}` });
  }

  if (sub === "disable") {
    setGuildSetting(guild.id, "digest_channel_id", null);
    return interaction.reply({ content: `weekly digest auto-posting disabled`, flags: MessageFlags.Ephemeral });
  }
}
