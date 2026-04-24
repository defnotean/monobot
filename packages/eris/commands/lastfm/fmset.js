// /fmset — Link a Last.fm account to your Discord profile
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { getUserInfo, getAllTopArtists, getAllTopAlbums, getAllTopTracks } from "../../lastfm/api.js";
import { setFmUser, removeFmUser, indexUserArtists, indexUserAlbums, indexUserTracks } from "../../lastfm/db.js";
import { FM_COLOR, userUrl } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmset")
  .setDescription("Link your Last.fm account")
  .addSubcommand(sub =>
    sub.setName("username")
      .setDescription("Set your Last.fm username")
      .addStringOption(opt =>
        opt.setName("username").setDescription("Your Last.fm username").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Unlink your Last.fm account")
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "remove") {
    await removeFmUser(interaction.user.id);
    return interaction.reply({
      content: "done, your last.fm account has been unlinked",
      flags: MessageFlags.Ephemeral,
    });
  }

  // sub === "username"
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const username = interaction.options.getString("username").trim();

  let userInfo;
  try {
    userInfo = await getUserInfo(username);
  } catch (err) {
    return interaction.editReply(
      err.code === 6
        ? `couldn't find a last.fm user named **${username}** — double check the spelling`
        : `last.fm is being weird rn: ${err.message}`
    );
  }

  await setFmUser(interaction.user.id, userInfo.name);

  // Background-index artists, albums, tracks for WhoKnows + server commands (fire and forget)
  const uid = interaction.user.id;
  getAllTopArtists(userInfo.name, 500)
    .then(artists => indexUserArtists(uid, artists))
    .catch(() => {});
  getAllTopAlbums(userInfo.name, 300)
    .then(albums => indexUserAlbums(uid, albums))
    .catch(() => {});
  getAllTopTracks(userInfo.name, 300)
    .then(tracks => indexUserTracks(uid, tracks))
    .catch(() => {});

  const scrobbles = parseInt(userInfo.playcount || 0);
  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setTitle("Last.fm account linked")
    .setDescription(`**[${userInfo.name}](${userUrl(userInfo.name)})** · ${scrobbles.toLocaleString()} scrobbles`)
    .setThumbnail(userInfo.image?.find(i => i.size === "large")?.["#text"] || null)
    .setFooter({ text: "use /fm to show your now playing" });

  await interaction.editReply({ embeds: [embed] });
}
