// /fmstreak — Daily scrobble streak (consecutive days with at least one scrobble)
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getStreakData } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, userUrl } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmstreak")
  .setDescription("Show your current daily scrobble streak")
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const linked = await getFmUser(target.id);

  if (!linked) {
    const self = target.id === interaction.user.id;
    return interaction.editReply(
      self
        ? "you haven't linked your last.fm yet — use `/fmset username <your username>`"
        : `${target.username} hasn't linked their last.fm`
    );
  }

  const lfmUser = linked.lastfm_username;

  let streakData;
  try {
    streakData = await getStreakData(lfmUser);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  const { current, active, todayCount } = streakData;

  const streakEmoji =
    current >= 365 ? "🏆" :
    current >= 100 ? "💎" :
    current >= 30  ? "🔥" :
    current >= 7   ? "⚡" :
    current >= 2   ? "✨" : "📅";

  const statusLine = active
    ? `**${current}** day${current === 1 ? "" : "s"} and counting`
    : current === 0
      ? "no active streak — start one today!"
      : `streak ended at **${current}** day${current === 1 ? "" : "s"}`;

  const lines = [statusLine];
  if (active && todayCount > 0) {
    lines.push(`${todayCount.toLocaleString()} scrobble${todayCount === 1 ? "" : "s"} today`);
  }
  if (!active && current === 0) {
    lines.push("scrobble something to start your streak");
  }

  // Flavor text based on streak length
  const flavor =
    current >= 365 ? "a full year?? that's insane dedication" :
    current >= 100 ? "100+ days, genuinely impressive" :
    current >= 30  ? "a month straight, nice" :
    current >= 14  ? "two weeks going strong" :
    current >= 7   ? "week streak, not bad" :
    current >= 3   ? "getting into it" :
    current === 0  ? "" : "just getting started";

  if (flavor) lines.push(`-# ${flavor}`);

  const embed = new EmbedBuilder()
    .setColor(active ? FM_COLOR : 0x6B7280)
    .setAuthor({
      name: `${lfmUser}'s scrobble streak`,
      url: userUrl(lfmUser),
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(`${streakEmoji} ${lines.join("\n")}`);

  await interaction.editReply({ embeds: [embed] });
}
