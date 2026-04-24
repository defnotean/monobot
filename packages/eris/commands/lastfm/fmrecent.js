// /fmrecent — Show recent tracks
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getRecentTracks } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, getImage, userUrl, relativeTime, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmrecent")
  .setDescription("Show your recent Last.fm scrobbles")
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName("count").setDescription("Number of tracks (1-15)").setMinValue(1).setMaxValue(15).setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const limit  = interaction.options.getInteger("count") || 10;
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

  let recentData;
  try {
    recentData = await getRecentTracks(lfmUser, limit);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  const tracks = recentData?.track;
  if (!tracks || (Array.isArray(tracks) && tracks.length === 0)) {
    return interaction.editReply(`${lfmUser} hasn't scrobbled anything yet`);
  }

  const list = Array.isArray(tracks) ? tracks : [tracks];
  const imageUrl = getImage(list[0]?.image);

  const lines = list.map((t, i) => {
    const nowPlaying = t["@attr"]?.nowplaying === "true";
    const artist = t.artist?.["#text"] || t.artist?.name || "?";
    const name = t.name || "?";
    const time = nowPlaying ? "▶ now" : (t.date?.uts ? relativeTime(t.date.uts) : "");
    return `\`${String(i + 1).padStart(2)}\` ${nowPlaying ? "🎵 " : ""}**${truncate(name, 28)}** — ${truncate(artist, 22)} · *${time}*`;
  });

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser}'s recent tracks`,
      url: `${userUrl(lfmUser)}/library`,
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(lines.join("\n"))
    .setThumbnail(imageUrl);

  await interaction.editReply({ embeds: [embed] });
}
