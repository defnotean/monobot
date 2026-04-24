// /karaoke — Live lyric display via bot nickname (Irene-only)
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  isIrene, startKaraoke, stopKaraoke, pauseKaraoke, resumeKaraoke,
  setOffset, getStatus, startAutoMode,
} from "../../ai/karaoke.js";
import { getFmUser } from "../../lastfm/db.js";

export const data = new SlashCommandBuilder()
  .setName("karaoke")
  .setDescription("Make Irene's nickname display synced lyrics as a song plays")
  .addSubcommand(sub =>
    sub.setName("start")
      .setDescription("Start a karaoke session for a song (manually triggered)")
      .addStringOption(o => o.setName("song").setDescription("Song title").setRequired(true))
      .addStringOption(o => o.setName("artist").setDescription("Artist name").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("auto")
      .setDescription("Auto-start karaoke whenever a Last.fm user starts a new track")
      .addStringOption(o => o.setName("user").setDescription("Last.fm username (or leave blank to use yours)").setRequired(false))
  )
  .addSubcommand(sub => sub.setName("stop").setDescription("Stop karaoke and restore my nickname"))
  .addSubcommand(sub => sub.setName("pause").setDescription("Pause the current karaoke"))
  .addSubcommand(sub => sub.setName("resume").setDescription("Resume the paused karaoke"))
  .addSubcommand(sub =>
    sub.setName("offset")
      .setDescription("Adjust timing if lyrics are ahead/behind (positive = lyrics later, negative = lyrics earlier)")
      .addNumberOption(o => o.setName("seconds").setDescription("Seconds to shift (e.g. 1.5 or -2)").setRequired(true))
  )
  .addSubcommand(sub => sub.setName("status").setDescription("Show what's currently playing"));

export async function execute(interaction) {
  // Hard-gate to Irene only — both bots share the codebase but only Irene gets karaoke
  if (!isIrene(interaction.client)) {
    return interaction.reply({
      content: "karaoke is Irene's thing — ask her instead",
      ephemeral: true,
    });
  }

  if (!interaction.guild) {
    return interaction.reply({ content: "karaoke only works in servers", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  // ─── START ────────────────────────────────────────────────────────────────
  if (sub === "start") {
    await interaction.deferReply();
    const song   = interaction.options.getString("song");
    const artist = interaction.options.getString("artist");

    const result = await startKaraoke(interaction.client, guildId, {
      trackName: song, artistName: artist, requesterId: interaction.user.id,
    });

    if (!result.ok) return interaction.editReply(`couldn't start karaoke: ${result.reason}`);

    const embed = new EmbedBuilder()
      .setColor(0xff3aa9)
      .setTitle("🎤 Karaoke started")
      .setDescription(`**${result.trackName}** by **${result.artistName}**\n\n${result.lineCount} synced lyric lines · my nickname will follow along`)
      .setFooter({ text: "Use /karaoke offset <s> if timing is off · /karaoke stop to end" });
    return interaction.editReply({ embeds: [embed] });
  }

  // ─── AUTO (Last.fm-driven) ────────────────────────────────────────────────
  if (sub === "auto") {
    await interaction.deferReply();
    let fmUser = interaction.options.getString("user");
    if (!fmUser) {
      const linked = await getFmUser(interaction.user.id);
      if (!linked) return interaction.editReply("link your Last.fm with `/fmset` first, or pass a username explicitly");
      fmUser = linked.lastfm_username;
    }

    const result = await startAutoMode(interaction.client, guildId, fmUser, interaction.user.id);
    if (!result.ok) return interaction.editReply(`couldn't start auto karaoke: ${result.reason}`);

    return interaction.editReply(
      `🎤 auto karaoke armed — i'll start lyric-syncing whenever **${fmUser}** scrobbles a new track on Last.fm.\n` +
      `-# polls every 30 sec · timing may drift since last.fm doesn't expose playback position`
    );
  }

  // ─── STOP ─────────────────────────────────────────────────────────────────
  if (sub === "stop") {
    const result = await stopKaraoke(guildId, "manual stop");
    if (!result.ok) return interaction.reply({ content: result.reason, ephemeral: true });
    return interaction.reply(`🛑 karaoke stopped (${result.trackName})`);
  }

  // ─── PAUSE / RESUME ───────────────────────────────────────────────────────
  if (sub === "pause") {
    const r = pauseKaraoke(guildId);
    if (!r.ok) return interaction.reply({ content: r.reason, ephemeral: true });
    return interaction.reply(`⏸️ paused at ${r.atSec.toFixed(1)}s`);
  }

  if (sub === "resume") {
    const r = resumeKaraoke(guildId);
    if (!r.ok) return interaction.reply({ content: r.reason, ephemeral: true });
    return interaction.reply(`▶️ resumed from ${r.atSec.toFixed(1)}s`);
  }

  // ─── OFFSET ───────────────────────────────────────────────────────────────
  if (sub === "offset") {
    const seconds = interaction.options.getNumber("seconds");
    const r = setOffset(guildId, seconds);
    if (!r.ok) return interaction.reply({ content: r.reason, ephemeral: true });
    return interaction.reply(`⏱️ shifted by ${seconds > 0 ? "+" : ""}${seconds}s · total offset now ${r.totalOffsetSec.toFixed(1)}s`);
  }

  // ─── STATUS ───────────────────────────────────────────────────────────────
  if (sub === "status") {
    const status = getStatus(guildId);
    if (!status) return interaction.reply({ content: "no karaoke is running here", ephemeral: true });

    const elapsed = `${Math.floor(status.elapsedSec / 60)}:${String(Math.floor(status.elapsedSec % 60)).padStart(2, "0")}`;
    const total   = status.duration ? `${Math.floor(status.duration / 60)}:${String(Math.floor(status.duration % 60)).padStart(2, "0")}` : "?";

    const embed = new EmbedBuilder()
      .setColor(0xff3aa9)
      .setTitle(`🎤 ${status.paused ? "Paused" : "Playing"}: ${status.trackName}`)
      .setDescription(
        `by **${status.artistName}**\n\n` +
        `**Time:** ${elapsed} / ${total}\n` +
        `**Offset:** ${status.offsetSec.toFixed(1)}s\n` +
        `**Lines:** ${status.lineCount}\n` +
        (status.autoMode ? "**Mode:** auto (Last.fm)\n" : "") +
        (status.currentLine ? `\n*"${status.currentLine}"*` : "")
      );
    return interaction.reply({ embeds: [embed] });
  }
}
