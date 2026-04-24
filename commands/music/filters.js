import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed, musicEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";
import { log } from "../../utils/logger.js";

// ─── Filter Definitions ────────────────────────────────────────────────────────
// Each filter defines Lavalink equalizer settings and other parameters
const FILTERS = {
  bassboost: {
    name: "Bass Boost",
    description: "Enhanced bass",
    equalizer: [
      { band: 0, gain: 0.2 },
      { band: 1, gain: 0.15 },
      { band: 2, gain: 0.1 },
    ],
  },
  nightcore: {
    name: "Nightcore",
    description: "Chipmunk-like effect with speed boost",
    timescale: { speed: 1.3, pitch: 1.2, rate: 1.0 },
  },
  vaporwave: {
    name: "Vaporwave",
    description: "Slowed and lo-fi effect",
    timescale: { speed: 0.8, pitch: 0.9, rate: 1.0 },
  },
  "8d": {
    name: "True 8D Spatial Audio",
    description: "Surround panning with spatial depth and Doppler pitch",
    rotation: { rotationHz: 0.17 },
    tremolo: { frequency: 0.34, depth: 0.3 },
    vibrato: { frequency: 0.17, depth: 0.15 },
    lowpass: { smoothing: 20 },
    equalizer: [
      { band: 0, gain: 0.3 }, // Bass boost
      { band: 1, gain: 0.2 },
      { band: 13, gain: 0.2 }, // Treble boost
      { band: 14, gain: 0.3 },
    ],
  },
  karaoke: {
    name: "Karaoke",
    description: "Reduced vocals",
    equalizer: [
      { band: 0, gain: 0.1 },
      { band: 1, gain: -0.3 },
      { band: 2, gain: 0.1 },
    ],
  },
  tremolo: {
    name: "Tremolo",
    description: "Volume oscillation effect",
    tremolo: { frequency: 2.0, depth: 0.4 },
  },
  vibrato: {
    name: "Vibrato",
    description: "Pitch oscillation effect",
    vibrato: { frequency: 2.0, depth: 0.4 },
  },
};

// ─── Command ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("filter")
  .setDescription("Apply audio filters to music")
  .addSubcommand((sub) =>
    sub
      .setName("apply")
      .setDescription("Apply a filter")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Filter to apply")
          .setRequired(true)
          .addChoices(
            ...Object.keys(FILTERS).map((key) => ({
              name: FILTERS[key].name,
              value: key,
            }))
          )
      )
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("Show available filters"))
  .addSubcommand((sub) => sub.setName("current").setDescription("Show currently active filters"))
  .addSubcommand((sub) => sub.setName("reset").setDescription("Clear all filters"));

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  // "list" and "current" don't need music to be playing
  if (subcommand !== "list" && subcommand !== "current") {
    const queue = getQueue(guildId);
    if (!queue || !queue.playing) {
      return interaction.reply({
        embeds: [errorEmbed("Nothing Playing", "no music is playing")],
        flags: 64,
      });
    }
  }

  if (subcommand === "apply") {
    const queue = getQueue(guildId);
    const filterName = interaction.options.getString("name");
    const filter = FILTERS[filterName];

    if (!filter) {
      return interaction.reply({
        embeds: [errorEmbed("Filter Not Found", `"${filterName}" is not available`)],
        flags: 64,
      });
    }

    // Check for conflicts
    let conflictWarning = null;
    if ((filterName === "nightcore" || filterName === "vaporwave") &&
        (queue.activeFilter === "vaporwave" || queue.activeFilter === "nightcore")) {
      conflictWarning = "⚠️ **Conflict Warning:** Nightcore and Vaporwave have conflicting speed settings. Applying this filter will override the previous one.";
    }

    try {
      // Build filter config for Shoukaku
      const filterConfig = {};

      if (filter.equalizer) {
        filterConfig.equalizer = filter.equalizer;
      }
      if (filter.timescale) {
        filterConfig.timescale = filter.timescale;
      }
      if (filter.rotation) {
        filterConfig.rotation = filter.rotation;
      }
      if (filter.tremolo) {
        filterConfig.tremolo = filter.tremolo;
      }
      if (filter.vibrato) {
        filterConfig.vibrato = filter.vibrato;
      }
      if (filter.lowpass) {
        filterConfig.lowpass = filter.lowpass;
      }

      // Apply to Lavalink player
      if (!queue.player) {
        return interaction.reply({ embeds: [errorEmbed("Not Connected", "Player disconnected — try playing a song first.")], ephemeral: true });
      }
      queue.player.setFilters(filterConfig);
      queue.activeFilter = filterName;

      log(`[Filter] Applied ${filterName} to guild ${guildId}`);

      const embed = musicEmbed("Filter Applied", `**${filter.name}**`)
        .setDescription(filter.description)
        .addFields({
          name: "Now Playing",
          value: queue.songs[0]?.title || "Unknown",
          inline: false,
        });

      if (conflictWarning) {
        embed.addFields({ name: "Warning", value: conflictWarning, inline: false });
      }

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      log(`[Filter] Error applying ${filterName}: ${error.message}`);
      await interaction.reply({
        embeds: [errorEmbed("Filter Error", error.message)],
        flags: 64,
      });
    }
  } else if (subcommand === "list") {
    const filterList = Object.entries(FILTERS)
      .map(([key, filter]) => `**${filter.name}** (\`${key}\`)\n${filter.description}`)
      .join("\n\n");

    await interaction.reply({
      embeds: [musicEmbed("Available Filters").setDescription(filterList)],
    });
  } else if (subcommand === "current") {
    const queue = getQueue(guildId);
    const activeFilterName = queue?.activeFilter || null;

    if (!activeFilterName) {
      return interaction.reply({
        embeds: [musicEmbed("Active Filters", "No filters are currently active — sound is normal")],
        flags: 64,
      });
    }

    const filter = FILTERS[activeFilterName];
    if (!filter) {
      return interaction.reply({
        embeds: [errorEmbed("Unknown Filter", `Active filter "${activeFilterName}" is not recognized`)],
        flags: 64,
      });
    }

    await interaction.reply({
      embeds: [musicEmbed("Active Filter", `**${filter.name}**`)
        .setDescription(filter.description)
        .addFields({
          name: "To remove",
          value: "Use `/filter reset`",
          inline: false,
        })
      ],
    });
  } else if (subcommand === "reset") {
    const queue = getQueue(guildId);
    try {
      // Clear all filters by setting empty config
      queue.player.setFilters({
        equalizer: [],
        timescale: null,
        rotation: null,
        tremolo: null,
        vibrato: null,
        lowpass: null,
      });
      queue.activeFilter = null;

      log(`[Filter] Reset filters for guild ${guildId}`);

      await interaction.reply({
        embeds: [musicEmbed("Filters Reset", "All filters cleared — back to normal sound")],
      });
    } catch (error) {
      log(`[Filter] Error resetting filters: ${error.message}`);
      await interaction.reply({
        embeds: [errorEmbed("Reset Error", error.message)],
        flags: 64,
      });
    }
  }
}
