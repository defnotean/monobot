// /bumpathon — run a timed bump-a-thon event with a goal
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { getGuildSettings, setGuildSetting } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("bumpathon")
  .setDescription("Run a timed bump goal event for the server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName("start").setDescription("Start a bump-a-thon")
    .addIntegerOption(o => o.setName("goal").setDescription("How many bumps to hit").setRequired(true).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(o => o.setName("hours").setDescription("Time limit in hours (1-168)").setRequired(true).setMinValue(1).setMaxValue(168)))
  .addSubcommand(s => s.setName("status").setDescription("Current bump-a-thon progress"))
  .addSubcommand(s => s.setName("cancel").setDescription("Cancel the active bump-a-thon"));

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const settings = getGuildSettings(guildId) || {};

  if (sub === "start") {
    const goal = interaction.options.getInteger("goal");
    const hours = interaction.options.getInteger("hours");
    const startedAt = Date.now();
    const endsAt = startedAt + hours * 60 * 60 * 1000;

    setGuildSetting(guildId, "bumpathon", {
      goal, startedAt, endsAt, startedBy: interaction.user.id,
    });

    const embed = new EmbedBuilder()
      .setColor(0x10B981)
      .setTitle("🚀 BUMP-A-THON STARTED")
      .setDescription(`goal: **${goal}** bumps\nends: <t:${Math.floor(endsAt / 1000)}:R>\nstarted by: <@${interaction.user.id}>\n\nevery bump counts. call \`/bumps me\` to see your contribution. hit the goal before time runs out.`)
      .setFooter({ text: "Eris will ping once when the goal is hit" });

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "status") {
    const event = settings.bumpathon;
    if (!event || event.endsAt < Date.now()) {
      return interaction.reply({ content: "no active bump-a-thon", ephemeral: true });
    }
    // Count bumps since the event started.
    const { getSupabase } = await import("../../database.js");
    let progress = 0;
    const sb = getSupabase();
    if (sb) {
      const { count } = await sb.from("eris_bumps")
        .select("id", { count: "exact", head: true })
        .eq("guild_id", guildId)
        .gte("bumped_at", new Date(event.startedAt).toISOString());
      progress = count || 0;
    }

    const pct = Math.min(1, progress / event.goal);
    const filled = Math.round(pct * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    const embed = new EmbedBuilder()
      .setColor(pct >= 1 ? 0xF1C40F : pct >= 0.5 ? 0x10B981 : 0x5865F2)
      .setTitle("Bump-a-thon status")
      .setDescription(`**${progress} / ${event.goal}** bumps\n\`${bar}\` **${Math.floor(pct * 100)}%**\n\nends <t:${Math.floor(event.endsAt / 1000)}:R>`)
      .setFooter({ text: pct >= 1 ? "GOAL HIT 🏆" : `${event.goal - progress} to go` });
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "cancel") {
    setGuildSetting(guildId, "bumpathon", null);
    return interaction.reply({ content: "✅ bump-a-thon cancelled", ephemeral: true });
  }
}
