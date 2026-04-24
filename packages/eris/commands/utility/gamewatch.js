// /gamewatch — Track game updates and patch notes
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { searchSteam, addWatch, removeWatch, getWatches } from "../../ai/gameWatcher.js";

export const data = new SlashCommandBuilder()
  .setName("gamewatch")
  .setDescription("Track patch notes and updates for games")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Start tracking updates for a game")
      .addStringOption(opt =>
        opt.setName("game").setDescription("Game name to search for on Steam").setRequired(true)
      )
      .addChannelOption(opt =>
        opt.setName("channel").setDescription("Channel to post updates in (defaults to this channel)").setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName("rss").setDescription("Custom RSS feed URL (for non-Steam games)").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Stop tracking a game")
      .addStringOption(opt =>
        opt.setName("id").setDescription("Watch ID from /gamewatch list").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("Show all active game watches for this server")
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();

  // ─── ADD ──────────────────────────────────────────────────────────────────
  if (sub === "add") {
    await interaction.deferReply({ ephemeral: true });

    const gameName   = interaction.options.getString("game");
    const rssUrl     = interaction.options.getString("rss") || null;
    const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

    // RSS-only watch — skip Steam search
    if (rssUrl) {
      const id = addWatch(interaction.guild.id, {
        channelId: targetChannel.id,
        gameName,
        rssUrl,
        addedBy: interaction.user.id,
      });
      return interaction.editReply(
        `✅ Now tracking **${gameName}** via RSS in <#${targetChannel.id}>\nWatch ID: \`${id}\``
      );
    }

    // Search Steam for the game
    const results = await searchSteam(gameName);
    if (!results.length) {
      return interaction.editReply(
        `couldn't find **${gameName}** on Steam. Try a more specific name, or provide a custom RSS URL with the \`rss\` option.`
      );
    }

    // If exact match, add immediately — otherwise show top results
    const exact = results.find(r => r.name.toLowerCase() === gameName.toLowerCase());
    const pick  = exact || results[0];

    const id = addWatch(interaction.guild.id, {
      channelId: targetChannel.id,
      gameName: pick.name,
      steamAppId: pick.id,
      addedBy: interaction.user.id,
    });

    const embed = new EmbedBuilder()
      .setColor(0x1b2838)
      .setTitle(`✅ Now tracking: ${pick.name}`)
      .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${pick.id}/header.jpg`)
      .setDescription(
        `Patch notes and updates will be posted in <#${targetChannel.id}> every time Steam publishes something new.\n\n` +
        `**Watch ID:** \`${id}\`\n` +
        `**Steam App ID:** ${pick.id}`
      )
      .setFooter({ text: "Use /gamewatch list to see all watches · /gamewatch remove <id> to stop" });

    // Warn if the first result wasn't an exact match
    if (!exact && results.length > 1) {
      embed.addFields({
        name: "Not the right game?",
        value: results.slice(1, 4).map(r => `• ${r.name} (App ID: ${r.id})`).join("\n") +
          "\nUse `/gamewatch remove` and try again with a more specific name.",
      });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ─── REMOVE ───────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const watchId = interaction.options.getString("id");
    const watches = getWatches(interaction.guild.id);
    const watch   = watches.find(w => w.id === watchId);

    if (!watch) {
      return interaction.reply({ content: `no watch found with ID \`${watchId}\` — use \`/gamewatch list\` to see active watches`, ephemeral: true });
    }

    removeWatch(interaction.guild.id, watchId);
    return interaction.reply({
      content: `✅ Stopped tracking **${watch.gameName}**.`,
      ephemeral: true,
    });
  }

  // ─── LIST ─────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const watches = getWatches(interaction.guild.id);

    if (!watches.length) {
      return interaction.reply({
        content: "no game watches set up yet — use `/gamewatch add <game>` to start tracking updates",
        ephemeral: true,
      });
    }

    const lines = watches.map(w => {
      const src = w.steamAppId ? `Steam \`${w.steamAppId}\`` : `RSS`;
      return `**${w.gameName}** — <#${w.channelId}> · ${src}\nID: \`${w.id}\``;
    });

    const embed = new EmbedBuilder()
      .setColor(0x1b2838)
      .setTitle(`Game watches — ${interaction.guild.name}`)
      .setDescription(lines.join("\n\n"))
      .setFooter({ text: `${watches.length} active watch${watches.length === 1 ? "" : "es"} · /gamewatch remove <id> to stop one` });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
