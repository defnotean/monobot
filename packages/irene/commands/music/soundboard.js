import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed, musicEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";
import { paginate } from "../../utils/pagination.js";
import { validateUrlAsync } from "@defnotean/shared/safeFetch";
import { assertAllowedMusicUrl } from "../../music/player.js";

const SOUND_URL_DENIAL = "Soundboard clips must use YouTube, Spotify, or SoundCloud URLs. Direct file/CDN URLs are no longer allowed.";

function soundboardUrlErrorMessage(err) {
  const message = err?.message || "";
  return /Only YouTube, Spotify, and SoundCloud/i.test(message)
    ? SOUND_URL_DENIAL
    : message || SOUND_URL_DENIAL;
}

async function validateSoundboardUrl(url) {
  const safeUrl = assertAllowedMusicUrl(url);
  await validateUrlAsync(safeUrl);
  return safeUrl;
}

// ─── Soundboard Store ──────────────────────────────────────────────────────────
// Key: guildId, Value: { soundName: { url, category?, duration? } }
const soundboardStore = new Map();

const MAX_SOUNDS_PER_GUILD = 30;

// ─── Utility Functions ─────────────────────────────────────────────────────────

function getGuildSounds(guildId) {
  return soundboardStore.get(guildId) || {};
}

function setGuildSounds(guildId, sounds) {
  if (Object.keys(sounds).length === 0) {
    soundboardStore.delete(guildId);
  } else {
    soundboardStore.set(guildId, sounds);
  }
}

function addSound(guildId, name, url, category = null, duration = null) {
  const sounds = getGuildSounds(guildId);

  if (Object.keys(sounds).length >= MAX_SOUNDS_PER_GUILD) return false;

  sounds[name] = { url, category, duration };
  setGuildSounds(guildId, sounds);
  log(`[Soundboard] Added sound "${name}" in guild ${guildId}`);
  return true;
}

function getSound(guildId, name) {
  const sounds = getGuildSounds(guildId);
  const sound = sounds[name];
  if (!sound) return null;
  // Return url for backward compatibility, but sound data is stored as object
  return typeof sound === "string" ? sound : sound.url;
}

function removeSound(guildId, name) {
  const sounds = getGuildSounds(guildId);

  if (!sounds[name]) return false;

  delete sounds[name];
  setGuildSounds(guildId, sounds);
  log(`[Soundboard] Removed sound "${name}" in guild ${guildId}`);
  return true;
}

function getAllSounds(guildId) {
  return Object.entries(getGuildSounds(guildId));
}

export function initSoundboardData(loaded) {
  if (!loaded || !loaded.soundboard) return;
  soundboardStore.clear();
  for (const [guildId, sounds] of Object.entries(loaded.soundboard)) {
    soundboardStore.set(guildId, sounds);
  }
  log(`[Soundboard] Loaded ${soundboardStore.size} guilds with sounds from database`);
}

export function getSoundboardData() {
  const data = {};
  for (const [guildId, sounds] of soundboardStore) {
    data[guildId] = sounds;
  }
  return data;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("soundboard")
  .setDescription("Play short audio clips")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a sound to the soundboard (admin only)")
      .addStringOption((opt) => opt.setName("name").setDescription("Sound name (e.g., 'airhorn')").setRequired(true))
      .addStringOption((opt) => opt.setName("url").setDescription("Audio file URL").setRequired(true))
      .addStringOption((opt) => opt.setName("category").setDescription("Optional category/tag (e.g., 'effects', 'memes')"))
      .addIntegerOption((opt) => opt.setName("duration").setDescription("Duration in seconds (optional)").setMinValue(1).setMaxValue(3600))
  )
  .addSubcommand((sub) =>
    sub
      .setName("play")
      .setDescription("Play a sound in voice channel")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Name of the sound to play").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("List all available sounds"))
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a sound (admin only)")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Sound name to remove").setRequired(true).setAutocomplete(true)
      )
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (subcommand === "add") {
    // Admin only
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        embeds: [errorEmbed("Permission Denied", "you need **Manage Guild** permission")],
        flags: 64,
      });
    }

    const name = interaction.options.getString("name").toLowerCase().trim();
    const url = interaction.options.getString("url");
    const category = interaction.options.getString("category")?.toLowerCase().trim() || null;
    const duration = interaction.options.getInteger("duration") || null;

    if (!name || name.length > 32) {
      return interaction.reply({
        embeds: [errorEmbed("Invalid Name", "sound name must be 1-32 characters")],
        flags: 64,
      });
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return interaction.reply({
        embeds: [errorEmbed("Invalid URL", "url must start with http:// or https://")],
        flags: 64,
      });
    }
    let safeUrl;
    try {
      safeUrl = await validateSoundboardUrl(url);
    } catch (err) {
      return interaction.reply({
        embeds: [errorEmbed("Invalid URL", soundboardUrlErrorMessage(err))],
        flags: 64,
      });
    }

    if (!addSound(guildId, name, safeUrl, category, duration)) {
      return interaction.reply({
        embeds: [errorEmbed("Soundboard Full", `max ${MAX_SOUNDS_PER_GUILD} sounds per guild`)],
        flags: 64,
      });
    }

    const embed = successEmbed("Sound Added", `**${name}** is ready to play`)
      .addFields({
        name: "Details",
        value: `Category: ${category || "*(none)*"}\nDuration: ${duration ? `${duration}s` : "*(unknown)*"}`,
        inline: false,
      });

    await interaction.reply({ embeds: [embed] });
  } else if (subcommand === "play") {
    // Check if user is in a voice channel
    if (!interaction.member.voice.channel) {
      return interaction.reply({
        embeds: [errorEmbed("Not in Voice", "you must be in a voice channel to play sounds")],
        flags: 64,
      });
    }

    const name = interaction.options.getString("name").toLowerCase().trim();
    const url = getSound(guildId, name);

    if (!url) {
      return interaction.reply({
        embeds: [errorEmbed("Sound Not Found", `"**${name}**" doesn't exist — try /soundboard list`)],
        flags: 64,
      });
    }

    // Import player dynamically to use playSoundEffect
    try {
      const safeUrl = await validateSoundboardUrl(url);
      const { playSoundEffect } = await import("../../music/player.js");
      await playSoundEffect(guildId, safeUrl, interaction.member.voice.channel);

      await interaction.reply({
        embeds: [musicEmbed("Playing Sound", `**${name}**`)],
      });
    } catch (error) {
      log(`[Soundboard] Play error for "${name}": ${error.message}`);
      await interaction.reply({
        embeds: [errorEmbed("Play Failed", soundboardUrlErrorMessage(error))],
        flags: 64,
      });
    }
  } else if (subcommand === "list") {
    const sounds = getAllSounds(guildId);

    if (sounds.length === 0) {
      return interaction.reply({
        embeds: [infoEmbed("Soundboard Empty", "no sounds added yet — admins can use /soundboard add")],
      });
    }

    // Format sounds for pagination
    const soundItems = sounds.map(([name, data]) => {
      const soundData = typeof data === "string" ? { url: data } : data;
      return {
        name,
        category: soundData.category || "General",
        duration: soundData.duration ? `${soundData.duration}s` : "?",
      };
    });

    if (soundItems.length <= 10) {
      // No pagination needed, show all at once
      const soundLines = soundItems.map((s) => {
        const categoryTag = s.category ? ` \`${s.category}\`` : "";
        return `**${s.name}**${categoryTag} — ${s.duration}`;
      });

      await interaction.reply({
        embeds: [
          musicEmbed("Available Sounds", soundLines.join("\n"))
            .addFields({
              name: "Total",
              value: `${sounds.length}/${MAX_SOUNDS_PER_GUILD}`,
              inline: true,
            })
        ],
      });
    } else {
      // Use pagination
      await paginate(interaction, {
        items: soundItems,
        itemsPerPage: 10,
        formatPage: (items, pageIndex, totalPages) => {
          const soundLines = items.map((s) => {
            const categoryTag = s.category ? ` \`${s.category}\`` : "";
            return `**${s.name}**${categoryTag} — ${s.duration}`;
          });

          return musicEmbed("Available Sounds")
            .setDescription(soundLines.join("\n") || "*(none)*")
            .addFields({
              name: "Total",
              value: `${sounds.length}/${MAX_SOUNDS_PER_GUILD}`,
              inline: true,
            })
            .setFooter({ text: `Page ${pageIndex + 1} / ${totalPages}` });
        },
      });
    }
  } else if (subcommand === "remove") {
    // Admin only
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        embeds: [errorEmbed("Permission Denied", "you need **Manage Guild** permission")],
        flags: 64,
      });
    }

    const name = interaction.options.getString("name").toLowerCase().trim();

    if (!removeSound(guildId, name)) {
      return interaction.reply({
        embeds: [errorEmbed("Sound Not Found", `"**${name}**" doesn't exist`)],
        flags: 64,
      });
    }

    await interaction.reply({
      embeds: [successEmbed("Sound Removed", `**${name}** deleted`)],
    });
  }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

export async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === "name") {
    const sounds = getAllSounds(interaction.guild.id).map(([name]) => name);
    const filtered = sounds.filter((s) => s.startsWith(focusedOption.value.toLowerCase()));

    await interaction.respond(
      filtered.slice(0, 25).map((name) => ({ name, value: name }))
    );
  }
}
