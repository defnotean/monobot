// /karaoke — Live lyric display, synced to Lavalink playback
// Two display modes: "message" (edits one message) or "nickname" (changes bot nick)
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  startKaraoke, stopKaraoke, setOffset, getStatus, enableAutoMode,
} from "../../ai/karaoke.js";
import { getQueue } from "../../music/player.js";

const MODE_CHOICES = [
  { name: "message — edits a message with lyrics (safe, default)", value: "message" },
  { name: "nickname — changes my nickname to the lyric line", value: "nickname" },
];

export const data = new SlashCommandBuilder()
  .setName("karaoke")
  .setDescription("Display synced song lyrics as music plays")
  .addSubcommand(sub =>
    sub.setName("start")
      .setDescription("Start lyrics for a specific song (or auto-detect from music player)")
      .addStringOption(o => o.setName("mode").setDescription("How to display lyrics").addChoices(...MODE_CHOICES).setRequired(false))
      .addStringOption(o => o.setName("song").setDescription("Song title (leave blank to use now playing)").setRequired(false))
      .addStringOption(o => o.setName("artist").setDescription("Artist name").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("auto")
      .setDescription("Auto-show lyrics whenever a new track plays")
      .addStringOption(o => o.setName("mode").setDescription("How to display lyrics").addChoices(...MODE_CHOICES).setRequired(false))
  )
  .addSubcommand(sub => sub.setName("stop").setDescription("Stop lyrics and restore my nickname"))
  .addSubcommand(sub =>
    sub.setName("offset")
      .setDescription("Shift lyrics timing (positive = later, negative = earlier)")
      .addNumberOption(o => o.setName("seconds").setDescription("Seconds to shift (e.g. 1.5 or -2)").setRequired(true))
  )
  .addSubcommand(sub => sub.setName("status").setDescription("Show current karaoke status"));

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "karaoke only works in servers", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === "start") {
    await interaction.deferReply();
    let song   = interaction.options.getString("song");
    let artist = interaction.options.getString("artist");
    const mode = interaction.options.getString("mode") || "message";

    if (!song) {
      const queue = getQueue(guildId);
      const current = queue?.songs?.[0];
      if (!current) return interaction.editReply("nothing is playing — provide a song name, or start playing music first");
      artist = artist || current.artist || current.title.split(" - ")[0] || "Unknown";
      song = current.artist ? current.title : (current.title.split(" - ").slice(1).join(" - ") || current.title);
    }
    if (!artist) return interaction.editReply("please provide an artist name with the song");

    const result = await startKaraoke(interaction.client, guildId, {
      trackName: song, artistName: artist, requesterId: interaction.user.id,
      mode, channelId: interaction.channel.id,
    });

    if (!result.ok) return interaction.editReply(`couldn't start karaoke: ${result.reason}`);

    const embed = new EmbedBuilder()
      .setColor(0xff3aa9)
      .setTitle("🎤 Lyrics started")
      .setDescription(
        `**${result.trackName}** by **${result.artistName}**\n` +
        `${result.lineCount} synced lines · **${mode}** mode\n\n` +
        (mode === "message" ? "lyrics will update in a message below ↓" : "my nickname will change with each line")
      )
      .setFooter({ text: "/karaoke offset <s> to adjust timing · /karaoke stop to end" });
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "auto") {
    await interaction.deferReply();
    const mode = interaction.options.getString("mode") || "message";
    const result = await enableAutoMode(interaction.client, guildId, interaction.user.id, {
      mode, channelId: interaction.channel.id,
    });
    if (!result.ok) return interaction.editReply(`couldn't enable auto lyrics: ${result.reason}`);
    return interaction.editReply(
      `🎤 auto lyrics on (${mode} mode) — lyrics will show for every track\n` +
      `-# /karaoke stop to disable`
    );
  }

  if (sub === "stop") {
    const result = await stopKaraoke(guildId, "manual stop");
    if (!result.ok) return interaction.reply({ content: result.reason, ephemeral: true });
    return interaction.reply("🛑 lyrics stopped");
  }

  if (sub === "offset") {
    const seconds = interaction.options.getNumber("seconds");
    const r = setOffset(guildId, seconds * 1000);
    if (!r.ok) return interaction.reply({ content: r.reason, ephemeral: true });
    return interaction.reply(`⏱️ shifted by ${seconds > 0 ? "+" : ""}${seconds}s · total offset: ${(r.totalOffsetMs / 1000).toFixed(1)}s`);
  }

  if (sub === "status") {
    const status = getStatus(guildId);
    if (!status) return interaction.reply({ content: "no lyrics running", ephemeral: true });

    const elapsed = Math.floor(status.elapsedMs / 1000);
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, "0");

    const embed = new EmbedBuilder()
      .setColor(0xff3aa9)
      .setTitle(`🎤 ${status.trackName}`)
      .setDescription(
        `by **${status.artistName}**\n\n` +
        `**Time:** ${mm}:${ss}\n` +
        `**Mode:** ${status.displayMode}\n` +
        `**Offset:** ${(status.offsetMs / 1000).toFixed(1)}s\n` +
        `**Lines:** ${status.lineCount}\n` +
        (status.autoMode ? "**Auto:** on\n" : "") +
        (status.currentLine ? `\n*"${status.currentLine}"*` : "")
      );
    return interaction.reply({ embeds: [embed] });
  }
}
