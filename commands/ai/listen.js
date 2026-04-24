// ─── /listen — Toggle AI voice listening in a VC ────────────────────────────
// Wake-word triggered: say "Hey Irene" (or custom wake word) and she responds.

import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed, primaryEmbed } from "../../utils/embeds.js";
import { startListening, stopListening, isListening, getWakeWord, setWakeWord } from "../../voice/listener.js";
import { log } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("listen")
  .setDescription("Toggle AI voice conversation in a voice channel")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Start listening in your current voice channel")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Voice channel to listen in (default: your current VC)")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("stop").setDescription("Stop listening in this server")
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Check if the bot is currently listening")
  )
  .addSubcommand((sub) =>
    sub
      .setName("wakeword")
      .setDescription("Change the wake word (default: irene)")
      .addStringOption((o) =>
        o
          .setName("word")
          .setDescription("New wake word")
          .setRequired(true)
          .setMaxLength(20)
          .setMinLength(2)
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "start") {
    return handleStart(interaction);
  } else if (sub === "stop") {
    return handleStop(interaction);
  } else if (sub === "status") {
    return handleStatus(interaction);
  } else if (sub === "wakeword") {
    return handleWakeWord(interaction);
  }
}

async function handleStart(interaction) {
  const guildId = interaction.guildId;

  // Determine which voice channel to join
  let voiceChannel = interaction.options.getChannel("channel");

  if (!voiceChannel) {
    const member = interaction.member;
    voiceChannel = member.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        embeds: [errorEmbed("not in a voice channel", "join a voice channel first or specify one with the channel option")],
        flags: 64,
      });
    }
  }

  // Check if already listening
  if (isListening(guildId)) {
    return interaction.reply({
      embeds: [errorEmbed("already listening", "use `/listen stop` first to stop the current session")],
      flags: 64,
    });
  }

  // Verify the bot can actually join and speak in the VC — catches the case
  // where we'd otherwise tell the user "listening started" before the
  // underlying voice connect silently fails on missing Connect/Speak perms.
  const me = interaction.guild?.members?.me;
  const botPerms = voiceChannel.permissionsFor(me);
  const missing = [];
  if (!botPerms?.has("Connect")) missing.push("Connect");
  if (!botPerms?.has("Speak")) missing.push("Speak");
  if (!botPerms?.has("ViewChannel")) missing.push("View Channel");
  if (missing.length) {
    return interaction.reply({
      embeds: [errorEmbed("can't join that channel", `i'm missing: **${missing.join(", ")}** in ${voiceChannel.name}`)],
      flags: 64,
    });
  }

  await interaction.deferReply();

  const result = await startListening(voiceChannel, interaction.channel, {
    wakeWord: getWakeWord(guildId),
  });

  if (result.success) {
    const wakeWord = getWakeWord(guildId);
    await interaction.editReply({
      embeds: [
        successEmbed("listening started", `now listening in **${voiceChannel.name}**`)
          .addFields(
            { name: "Wake Word", value: `Say **"Hey ${wakeWord}"** or **"${wakeWord}"** to talk to me`, inline: false },
            { name: "How it works", value: "I'll listen for the wake word, transcribe what you say, and respond with voice", inline: false }
          ),
      ],
    });

    log(`[Listen] Started by ${interaction.user.username} in ${voiceChannel.name} (${guildId})`);
  } else {
    await interaction.editReply({
      embeds: [errorEmbed("failed to start listening", result.error)],
    });
  }
}

async function handleStop(interaction) {
  const guildId = interaction.guildId;

  if (!isListening(guildId)) {
    return interaction.reply({
      embeds: [infoEmbed("not listening", "i'm not currently listening in any voice channel")],
      flags: 64,
    });
  }

  stopListening(guildId);

  await interaction.reply({
    embeds: [successEmbed("listening stopped", "i've stopped listening and left the voice channel")],
  });

  log(`[Listen] Stopped by ${interaction.user.username} in guild ${guildId}`);
}

async function handleStatus(interaction) {
  const guildId = interaction.guildId;
  const active = isListening(guildId);
  const wakeWord = getWakeWord(guildId);

  if (active) {
    await interaction.reply({
      embeds: [
        primaryEmbed("🎙️ Voice Listening Active", null)
          .addFields(
            { name: "Status", value: "Currently listening", inline: true },
            { name: "Wake Word", value: `"${wakeWord}"`, inline: true },
            { name: "Usage", value: `Say **"Hey ${wakeWord}"** followed by your question or request`, inline: false }
          ),
      ],
      flags: 64,
    });
  } else {
    await interaction.reply({
      embeds: [
        infoEmbed("not listening", `voice listening is off. use \`/listen start\` to begin.\ncurrent wake word: **"${wakeWord}"**`),
      ],
      flags: 64,
    });
  }
}

async function handleWakeWord(interaction) {
  const guildId = interaction.guildId;
  const word = interaction.options.getString("word").toLowerCase().trim();

  // Validate — only letters, numbers, spaces
  if (!/^[a-z0-9 ]+$/.test(word)) {
    return interaction.reply({
      embeds: [errorEmbed("invalid wake word", "wake word can only contain letters, numbers, and spaces")],
      flags: 64,
    });
  }

  setWakeWord(guildId, word);

  await interaction.reply({
    embeds: [
      successEmbed("wake word updated", `wake word is now **"${word}"**\nsay **"Hey ${word}"** to talk to me in VC`),
    ],
  });

  log(`[Listen] Wake word changed to "${word}" by ${interaction.user.username} in guild ${guildId}`);
}
