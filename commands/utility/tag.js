import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed, primaryEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";
import { paginate } from "../../utils/pagination.js";

// ── Tag Store ──────────────────────────────────────────────────────────────────
// Key: guildId, Value: { tagName: { content, createdBy, createdAt } }
const tagStore = new Map();

// ── Utility Functions ──────────────────────────────────────────────────────────

function getGuildTags(guildId) {
  return tagStore.get(guildId) || {};
}

function setGuildTags(guildId, tags) {
  if (Object.keys(tags).length === 0) {
    tagStore.delete(guildId);
  } else {
    tagStore.set(guildId, tags);
  }
}

function validateTagName(name) {
  // Must be lowercase, alphanumeric + hyphens/underscores only, max 32 chars
  if (name.length > 32) return false;
  return /^[a-z0-9_-]+$/.test(name);
}

function addTag(guildId, name, content, createdBy) {
  const tags = getGuildTags(guildId);

  if (!validateTagName(name)) return false; // invalid name format
  if (Object.keys(tags).length >= 50) return false; // max 50 tags per guild
  if (content.length > 2000) return false; // max 2000 chars

  tags[name] = {
    content,
    createdBy,
    createdAt: Date.now(),
  };

  setGuildTags(guildId, tags);
  log(`[Tag] Created tag "${name}" in guild ${guildId}`);
  return true;
}

function getTag(guildId, name) {
  const tags = getGuildTags(guildId);
  return tags[name] || null;
}

function updateTag(guildId, name, content) {
  const tags = getGuildTags(guildId);

  if (!tags[name]) return false;
  if (content.length > 2000) return false;

  tags[name].content = content;
  setGuildTags(guildId, tags);
  log(`[Tag] Updated tag "${name}" in guild ${guildId}`);
  return true;
}

function deleteTag(guildId, name) {
  const tags = getGuildTags(guildId);

  if (!tags[name]) return false;

  delete tags[name];
  setGuildTags(guildId, tags);
  log(`[Tag] Deleted tag "${name}" in guild ${guildId}`);
  return true;
}

function getAllTags(guildId) {
  return Object.keys(getGuildTags(guildId));
}

// ── Command ────────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("tag")
  .setDescription("Manage quick-access text snippets")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a new tag")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("Name of the tag")
          .setRequired(true)
          .setMaxLength(30)
      )
      .addStringOption((o) =>
        o.setName("content")
          .setDescription("Content of the tag (max 2000 chars)")
          .setRequired(true)
          .setMaxLength(2000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("edit")
      .setDescription("Edit an existing tag")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("Name of the tag")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("content")
          .setDescription("New content (max 2000 chars)")
          .setRequired(true)
          .setMaxLength(2000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("delete")
      .setDescription("Delete a tag")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("Name of the tag")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list")
      .setDescription("List all tags in this server")
  )
  .addSubcommand((sub) =>
    sub
      .setName("info")
      .setDescription("Get information about a tag")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("Tag name")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("get")
      .setDescription("Retrieve a tag")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("Tag name to retrieve")
          .setRequired(true)
      )
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  // ── Retrieve tag ────────────────────────────────────────────────────────────
  if (subcommand === "get") {
    const nameOption = interaction.options.getString("name").toLowerCase();
    const tag = getTag(interaction.guild.id, nameOption);

    if (!tag) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Not Found", `no tag named \`${nameOption}\``)],
        flags: 64,
      });
    }

    // Send as regular message (not ephemeral) with embed
    const embed = primaryEmbed(`Tag: ${nameOption}`, tag.content)
      .setColor(0x7C3AED);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ── Subcommands (require management permissions) ────────────────────────────
  if (subcommand === "create" || subcommand === "edit" || subcommand === "delete") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        embeds: [errorEmbed("Permission Denied", "you need Manage Messages permission")],
        flags: 64,
      });
    }
  }

  if (subcommand === "create") {
    const name = interaction.options.getString("name").toLowerCase();
    const content = interaction.options.getString("content");

    if (!validateTagName(name)) {
      return interaction.reply({
        embeds: [errorEmbed("Invalid Tag Name", "tag names must be lowercase alphanumeric with hyphens/underscores only, max 32 chars")],
        flags: 64,
      });
    }

    if (getTag(interaction.guild.id, name)) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Exists", `a tag named \`${name}\` already exists`)],
        flags: 64,
      });
    }

    if (!addTag(interaction.guild.id, name, content, interaction.user.id)) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Creation Failed", "tag limit reached (50 tags per server) or content too long")],
        flags: 64,
      });
    }

    await interaction.reply({
      embeds: [successEmbed("Tag Created", `created tag: \`${name}\``)],
      flags: 64,
    });
  } else if (subcommand === "edit") {
    const name = interaction.options.getString("name").toLowerCase();
    const content = interaction.options.getString("content");

    if (!updateTag(interaction.guild.id, name, content)) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Not Found", `no tag named \`${name}\``)],
        flags: 64,
      });
    }

    await interaction.reply({
      embeds: [successEmbed("Tag Updated", `updated tag: \`${name}\``)],
      flags: 64,
    });
  } else if (subcommand === "delete") {
    const name = interaction.options.getString("name").toLowerCase();

    if (!deleteTag(interaction.guild.id, name)) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Not Found", `no tag named \`${name}\``)],
        flags: 64,
      });
    }

    await interaction.reply({
      embeds: [successEmbed("Tag Deleted", `deleted tag: \`${name}\``)],
      flags: 64,
    });
  } else if (subcommand === "list") {
    const allTags = getAllTags(interaction.guild.id);

    if (allTags.length === 0) {
      return interaction.reply({
        embeds: [infoEmbed("No Tags", "this server has no tags yet")],
        flags: 64,
      });
    }

    // Use pagination for tag list (10 per page)
    await paginate(interaction, {
      items: allTags,
      itemsPerPage: 10,
      formatPage: (items, pageNum, totalPages) => {
        const tagList = items.map((t) => `\`${t}\``).join(", ");
        return infoEmbed(`Server Tags (Page ${pageNum}/${totalPages})`, tagList)
          .setFooter({ text: `${allTags.length}/50 total tags` });
      },
      ephemeral: true,
      timeout: 120000,
    });
  } else if (subcommand === "info") {
    const name = interaction.options.getString("name").toLowerCase();
    const tag = getTag(interaction.guild.id, name);

    if (!tag) {
      return interaction.reply({
        embeds: [errorEmbed("Tag Not Found", `no tag named \`${name}\``)],
        flags: 64,
      });
    }

    const creatorUser = await interaction.client.users.fetch(tag.createdBy).catch(() => null);
    const createdDate = new Date(tag.createdAt).toLocaleString();

    const embed = infoEmbed(`Tag Info: ${name}`, tag.content)
      .addFields(
        { name: "Creator", value: creatorUser?.username || "Unknown", inline: true },
        { name: "Created", value: createdDate, inline: true },
        { name: "Content Length", value: `${tag.content.length} chars`, inline: true }
      );

    await interaction.reply({
      embeds: [embed],
      flags: 64,
    });
  }
}

// ── Export for database integration ────────────────────────────────────────────

export function initTagData(loaded) {
  if (loaded && loaded.tags) {
    tagStore.clear();
    Object.entries(loaded.tags).forEach(([guildId, tags]) => {
      tagStore.set(guildId, tags);
    });
    log(`[Tag] Loaded tags for ${tagStore.size} guilds`);
  }
}

export function getTagData() {
  const result = {};
  tagStore.forEach((tags, guildId) => {
    result[guildId] = tags;
  });
  return result;
}
