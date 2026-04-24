// /bumps — bump leaderboard, personal stats, server trend
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("bumps")
  .setDescription("See who's been bumping the server")
  .addSubcommand(sub =>
    sub.setName("leaderboard")
      .setDescription("Top bumpers in this server")
      .addStringOption(opt =>
        opt.setName("period")
          .setDescription("Time period")
          .addChoices(
            { name: "all time", value: "all" },
            { name: "last 7 days", value: "7" },
            { name: "last 30 days", value: "30" },
          )
      )
      .addStringOption(opt =>
        opt.setName("service")
          .setDescription("Filter by bump service")
          .addChoices(
            { name: "any", value: "any" },
            { name: "disboard", value: "disboard" },
            { name: "discadia", value: "discadia" },
            { name: "disforge", value: "disforge" },
            { name: "discordservers.com", value: "discordservers" },
          )
      )
  )
  .addSubcommand(sub =>
    sub.setName("me")
      .setDescription("See your personal bump stats")
      .addUserOption(opt => opt.setName("user").setDescription("User to look up (default: you)"))
  )
  .addSubcommand(sub =>
    sub.setName("trend")
      .setDescription("Daily bump activity over the last 14 days")
  )
  .addSubcommand(sub =>
    sub.setName("dm")
      .setDescription("Opt into or out of personal DM pings when a server is bumpable")
      .addBooleanOption(opt => opt.setName("enabled").setDescription("true = DM me when bumpable, false = off").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("mvp")
      .setDescription("Opt into or out of the weekly MVP thank-you DM")
      .addBooleanOption(opt => opt.setName("enabled").setDescription("true = receive MVP DMs, false = opt out").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("correlation")
      .setDescription("How many new members join this server shortly after a bump")
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === "leaderboard") {
    const period = interaction.options.getString("period") || "all";
    const serviceOpt = interaction.options.getString("service") || "any";
    const periodDays = period === "all" ? null : parseInt(period, 10);
    const service = serviceOpt === "any" ? null : serviceOpt;

    const { getBumpLeaderboard, getGuildStreak } = await import("../../ai/bumpAnalytics.js");
    const { getBestRankInPeriod } = await import("../../ai/bumpCelebrations.js");
    const rankPeriod = periodDays ?? 30;
    const [rows, streak, bestRank] = await Promise.all([
      getBumpLeaderboard(guildId, { limit: 10, periodDays, service }),
      getGuildStreak(guildId, service),
      getBestRankInPeriod(guildId, { periodDays: rankPeriod, service, bumpsTable: "eris_bumps" }),
    ]);

    if (!rows.length) {
      return interaction.reply({
        content: "no bumps recorded yet. once someone bumps, they'll show up here.",
        ephemeral: true,
      });
    }

    const lines = await Promise.all(rows.map(async (r, i) => {
      const member = interaction.guild.members.cache.get(r.user_id)
        ?? await interaction.guild.members.fetch(r.user_id).catch(() => null);
      const name = member?.displayName || `<@${r.user_id}>`;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      return `${medal} **${name}** — ${r.count} bump${r.count === 1 ? "" : "s"}`;
    }));

    const footerParts = [
      period === "all" ? "all time" : `last ${period}d`,
      service ? service : null,
      streak > 1 ? `${streak}-day streak` : null,
      bestRank != null ? `best rank #${bestRank}` : null,
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle(`Bump leaderboard · ${interaction.guild.name}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: footerParts.join(" · ") });

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "me") {
    const target = interaction.options.getUser("user") || interaction.user;
    const { getBumpCount, getUserStreak } = await import("../../ai/bumpAnalytics.js");
    const [total, weekly, streak] = await Promise.all([
      getBumpCount(target.id, guildId, {}),
      getBumpCount(target.id, guildId, { periodDays: 7 }),
      getUserStreak(target.id, guildId),
    ]);

    const embed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle(`${target.username}'s bump stats`)
      .addFields(
        { name: "Total bumps", value: String(total), inline: true },
        { name: "This week", value: String(weekly), inline: true },
        { name: "Day streak", value: String(streak), inline: true },
      );

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "dm") {
    const enabled = interaction.options.getBoolean("enabled");
    const { setUserPref } = await import("../../ai/bumpUserPrefs.js");
    const r = await setUserPref(interaction.user.id, "personal_ping_enabled", enabled, "eris");
    if (!r.ok) {
      return interaction.reply({
        content: `couldn't save that: ${r.error}. db migration might be pending — try again later.`,
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: enabled
        ? "✅ you'll get a DM when a server you're in is bumpable. admins still have to enable the feature on the server (via `/bumpconfig personal_ping on`) for you to actually receive them.\n\nturn off anytime with `/bumps dm enabled:false`."
        : "✅ no more DM pings. you can opt back in with `/bumps dm enabled:true`.",
      ephemeral: true,
    });
  }

  if (sub === "mvp") {
    const enabled = interaction.options.getBoolean("enabled");
    // User-facing setting is opt-in; storage column is opt-OUT, so invert.
    const { setUserPref } = await import("../../ai/bumpUserPrefs.js");
    const r = await setUserPref(interaction.user.id, "weekly_mvp_optout", !enabled, "eris");
    if (!r.ok) {
      return interaction.reply({
        content: `couldn't save that: ${r.error}. db migration might be pending — try again later.`,
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: enabled
        ? "✅ you'll get the weekly MVP DM if you end up carrying the server that week."
        : "✅ opted out — no weekly MVP DMs. re-enable with `/bumps mvp enabled:true`.",
      ephemeral: true,
    });
  }

  if (sub === "correlation") {
    const { getJoinCorrelationStats, POST_BUMP_WINDOW_MIN } = await import("../../ai/bumpCorrelation.js");
    const stats = await getJoinCorrelationStats(guildId, { periodDays: 14, botName: "eris" });

    if (stats.totalJoins === 0) {
      return interaction.reply({
        content: "no join data yet for this server. once people start joining, the correlation metric will populate.",
        ephemeral: true,
      });
    }
    const ratio = Math.round(stats.postBumpRatio * 100);
    const embed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle("Bump → join correlation · last 14 days")
      .setDescription(
        `**${stats.postBumpJoins}** of **${stats.totalJoins}** new members joined within **${POST_BUMP_WINDOW_MIN}** minutes of a bump — that's **${ratio}%**.\n\n` +
        `average joins per bump: **${stats.avgJoinsPerBump.toFixed(2)}**`
      )
      .setFooter({ text: "not a perfect measure but gives you a sense" });
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "trend") {
    const { getBumpsPerDay } = await import("../../ai/bumpAnalytics.js");
    const { getBestRankInPeriod } = await import("../../ai/bumpCelebrations.js");
    const [days, bestRank] = await Promise.all([
      getBumpsPerDay(guildId, 14),
      getBestRankInPeriod(guildId, { periodDays: 14, bumpsTable: "eris_bumps" }),
    ]);
    if (!days.length) return interaction.reply({ content: "no trend data yet", ephemeral: true });

    // Simple ascii sparkline — each day a block whose height encodes count.
    const max = Math.max(1, ...days.map(d => d.count));
    const glyphs = ["⣀", "⣤", "⣶", "⣿"];
    const bar = days.map(d => {
      if (d.count === 0) return "⠀";
      const idx = Math.min(glyphs.length - 1, Math.floor((d.count / max) * glyphs.length));
      return glyphs[idx];
    }).join("");

    const total = days.reduce((s, d) => s + d.count, 0);
    const avg = (total / days.length).toFixed(1);
    const rankLine = bestRank != null ? `\nbest rank last 14d: **#${bestRank}**` : "";

    const embed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle(`Bump trend · last 14 days`)
      .setDescription(`\`\`\`${bar}\`\`\`\n**${total}** bumps · **${avg}**/day · peak **${max}**${rankLine}`);

    return interaction.reply({ embeds: [embed] });
  }
}
