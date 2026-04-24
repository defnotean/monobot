import { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder } from "discord.js";
import { primaryEmbed, infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

const CATEGORY_ICONS = {
  "Moderation":   "🔨",
  "Server Setup": "⚙️",
  "Fun & Games":  "🎮",
  "Music":        "🎵",
  "AI":           "🤖",
  "Utility":      "🔧",
  "Voice":        "🎙️",
  "Other":        "📦",
};

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("List all commands or get info on a specific command")
  .addStringOption((o) => o.setName("command").setDescription("Command name to get details for"));

export async function execute(interaction) {
  const commandName = interaction.options.getString("command");

  if (commandName) {
    const command = interaction.client.commands.get(commandName);
    if (!command) {
      return interaction.reply({
        embeds: [errorEmbed("Command Not Found", `No command named \`${commandName}\` exists.\nUse \`/help\` to see all available commands.`)],
        ephemeral: true,
      });
    }

    const embed = infoEmbed(`/${command.data.name}`, command.data.description);

    if (command.data.options?.length) {
      const options = command.data.options.map((o) => {
        const req = o.required ? " *(required)*" : "";
        return `\`${o.name}\`${req} — ${o.description}`;
      });
      embed.addFields({ name: "Options", value: options.join("\n") });
    }

    // Add cooldown info if available (check typical commands)
    if (["suggest"].includes(commandName)) {
      embed.addFields({ name: "Cooldown", value: "60 seconds per user" });
    }

    // Add required permissions if available
    if (command.data.default_member_permissions) {
      embed.addFields({ name: "Required Permissions", value: "Manage Messages" });
    }

    return interaction.reply({ embeds: [embed] });
  }

  // Auto-categorize commands from their file directory path
  // commands/moderation/* → Moderation, commands/fun/* → Fun & Games, etc.
  const DIR_TO_CATEGORY = {
    moderation: "Moderation",
    setup:      "Server Setup",
    fun:        "Fun & Games",
    music:      "Music",
    ai:         "AI",
    utility:    "Utility",
    voice:      "Voice",
  };

  const categories = {};
  for (const [name, cmd] of interaction.client.commands) {
    // Derive category from the module's file path (e.g., "commands/fun/scrim.js" → "fun")
    let cat = "Other";
    try {
      const modUrl = cmd._moduleURL ?? cmd[Symbol.for?.("moduleURL")] ?? null;
      if (!modUrl) {
        // Fallback: check the import URL from the command's source
        const cmdPath = cmd.__filename ?? "";
        const dirMatch = cmdPath.match(/commands[/\\]([^/\\]+)[/\\]/);
        if (dirMatch) cat = DIR_TO_CATEGORY[dirMatch[1]] ?? "Other";
      }
    } catch {}

    // Reliable fallback: match file-system directory by scanning loaded paths
    if (cat === "Other") {
      for (const [dir, label] of Object.entries(DIR_TO_CATEGORY)) {
        // Check if the slash command data object came from a file in that directory
        // Using a simple heuristic: known commands per directory
        const knownDir = interaction.client._commandDirs?.get(name);
        if (knownDir === dir) { cat = label; break; }
      }
    }

    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(name);
  }

  // Create select menu options with command counts
  const selectOptions = Object.entries(categories).map(([cat, cmds]) => {
    const icon = CATEGORY_ICONS[cat] || "📦";
    return {
      label: `${cat} (${cmds.length})`,
      value: cat,
      emoji: icon.match(/\p{Emoji}/u)?.[0],
      description: `${cmds.length} commands in this category`,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("help_category_select")
    .setPlaceholder("Select a category to view commands")
    .addOptions(selectOptions);

  const actionRow = new ActionRowBuilder().addComponents(selectMenu);

  const embed = primaryEmbed("Irene — Commands", "Select a category from the dropdown to view all commands in that category, or use `/help <command>` for details on a specific command.");

  await interaction.reply({
    embeds: [embed],
    components: [actionRow],
    ephemeral: true,
  });

  // Handle select menu interactions
  const filter = (i) => i.customId === "help_category_select" && i.user.id === interaction.user.id;
  const collector = interaction.channel?.createMessageComponentCollector?.({ filter, time: 120000 });

  if (collector) {
    collector.on("collect", async (i) => {
      const selectedCat = i.values[0];
      const cmds = categories[selectedCat] || [];

      const categoryEmbed = primaryEmbed(
        `${CATEGORY_ICONS[selectedCat] || "📦"} ${selectedCat}`,
        `${cmds.length} commands`
      );

      const commandList = cmds
        .map((name) => {
          const cmd = interaction.client.commands.get(name);
          return `\`/${name}\` — ${cmd?.data?.description || "No description"}`;
        })
        .join("\n");

      categoryEmbed.setDescription(commandList);

      await i.reply({
        embeds: [categoryEmbed],
        ephemeral: true,
      });
    });

    collector.on("end", () => {
      // Optionally disable the menu after 2 minutes
      interaction.editReply({ components: [] }).catch(() => {});
    });
  }
}
