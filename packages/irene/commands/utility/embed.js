import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { EmbedBuilder } from "discord.js";
import { log } from "../../utils/logger.js";

const NAMED_COLORS = {
  red: 0xFF0000,
  blue: 0x5865F2,
  green: 0x57F287,
  yellow: 0xFEE75C,
  orange: 0xED8E00,
  purple: 0x9B59B6,
  pink: 0xFF73FA,
  white: 0xFFFFFF,
  black: 0x000000,
  cyan: 0x00FFFF,
  magenta: 0xFF00FF,
  brown: 0x8B4513,
  gray: 0x808080,
  silver: 0xC0C0C0,
  gold: 0xFFD700,
  lime: 0x00FF00,
  navy: 0x000080,
  teal: 0x008080,
  maroon: 0x800000,
  olive: 0x808000,
};

function hasManageMessages(interaction) {
  const perms = interaction.memberPermissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.ManageMessages) || perms?.has?.("ManageMessages"));
}

export const data = new SlashCommandBuilder()
  .setName("embed")
  .setDescription("Build and send a custom embed")
  .setDefaultMemberPermissions(0x4000000); // ManageMessages

export async function execute(interaction) {
  // Check permission
  if (!hasManageMessages(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("permission denied", "you need manage messages to use this")],
      flags: 64,
    }).catch(() => {});
    return;
  }

  // Create modal
  const modal = new ModalBuilder()
    .setCustomId("embed_builder")
    .setTitle("Build Custom Embed");

  const titleInput = new TextInputBuilder()
    .setCustomId("embed_title")
    .setLabel("Title (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);

  const descInput = new TextInputBuilder()
    .setCustomId("embed_description")
    .setLabel("Description (required)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4096);

  const colorInput = new TextInputBuilder()
    .setCustomId("embed_color")
    .setLabel("Color (hex or name, optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("e.g. #FF0000 or red");

  const imageInput = new TextInputBuilder()
    .setCustomId("embed_image")
    .setLabel("Image URL (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const footerInput = new TextInputBuilder()
    .setCustomId("embed_footer")
    .setLabel("Footer text (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256);

  const fieldsInput = new TextInputBuilder()
    .setCustomId("embed_fields")
    .setLabel("Fields (optional: name|value on each line, max 5)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder("e.g.\nField 1|This is field 1\nField 2|This is field 2");

  modal.addComponents(
    /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(titleInput)),
    /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(descInput)),
    /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(colorInput)),
    /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(imageInput)),
    /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(footerInput)),
  );

  await interaction.showModal(modal);
}

export async function handleEmbedModal(interaction) {
  if (!hasManageMessages(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("permission denied", "you need manage messages to send embeds")],
      flags: 64,
    }).catch(() => {});
    return;
  }
  const botPerms = interaction.channel?.permissionsFor?.(interaction.guild?.members?.me ?? interaction.client?.user);
  if (!botPerms?.has?.(PermissionFlagsBits.SendMessages) || !botPerms?.has?.(PermissionFlagsBits.EmbedLinks)) {
    await interaction.reply({
      embeds: [errorEmbed("missing permissions", "i need send messages and embed links in this channel")],
      flags: 64,
    }).catch(() => {});
    return;
  }

  const title = interaction.fields.getTextInputValue("embed_title");
  const description = interaction.fields.getTextInputValue("embed_description");
  const colorStr = interaction.fields.getTextInputValue("embed_color");
  const imageUrl = interaction.fields.getTextInputValue("embed_image");
  const footer = interaction.fields.getTextInputValue("embed_footer");
  const fieldsStr = interaction.fields.getTextInputValue("embed_fields");

  // Parse color with strict validation
  let color = 0x7C3AED; // default purple
  if (colorStr) {
    const trimmed = colorStr.trim().toLowerCase();
    if (NAMED_COLORS[trimmed]) {
      color = NAMED_COLORS[trimmed];
    } else if (trimmed.startsWith("#")) {
      const hex = trimmed.slice(1);
      // Must be exactly 6 hex characters
      if (/^[0-9A-F]{6}$/i.test(hex)) {
        color = parseInt(hex, 16);
      } else {
        return await interaction.reply({
          embeds: [errorEmbed("Invalid Color", "hex color must be exactly 6 characters (e.g., #FF0000)")],
          flags: 64,
        }).catch(() => {});
      }
    } else {
      return await interaction.reply({
        embeds: [errorEmbed("Invalid Color", "use a named color or hex code (e.g., red or #FF0000)")],
        flags: 64,
      }).catch(() => {});
    }
  }

  // Parse fields (name|value format, max 5)
  const fields = [];
  if (fieldsStr) {
    const lines = fieldsStr.split("\n").filter((line) => line.trim());
    if (lines.length > 5) {
      return await interaction.reply({
        embeds: [errorEmbed("Too Many Fields", "maximum 5 fields allowed")],
        flags: 64,
      }).catch(() => {});
    }

    for (const line of lines) {
      const [name, value] = line.split("|").map((s) => s.trim());
      if (!name || !value) {
        return await interaction.reply({
          embeds: [errorEmbed("Invalid Field Format", "use 'name|value' format for each field")],
          flags: 64,
        }).catch(() => {});
      }
      fields.push({ name, value, inline: false });
    }
  }

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  if (footer) {
    embed.setFooter({ text: footer });
  }

  if (fields.length > 0) {
    embed.addFields(...fields);
  }

  // Create a preview (ephemeral)
  try {
    await interaction.reply({
      embeds: [embed],
      flags: 64,
      content: "Preview of your embed (ephemeral):",
    });

    // Ask for confirmation before sending
    const confirmEmbed = new EmbedBuilder()
      .setTitle("Send Embed?")
      .setDescription("The preview above shows how your embed will look. React to confirm sending it to the channel.")
      .setColor(0x7C3AED);

    const confirmMsg = await interaction.followUp({
      embeds: [confirmEmbed],
      flags: 64,
    });

    // Add reactions for confirmation
    await confirmMsg.react("✅").catch(() => {});
    await confirmMsg.react("❌").catch(() => {});

    // Wait for reaction (30s timeout)
    const filter = (reaction, user) => {
      return ["✅", "❌"].includes(reaction.emoji.name) && user.id === interaction.user.id;
    };

    const collected = await confirmMsg
      .awaitReactions({ filter, max: 1, time: 30000 })
      .catch(() => null);

    if (!collected || collected.first()?.emoji.name === "❌") {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Cancelled")
            .setDescription("Embed was not sent.")
            .setColor(0xFF0000),
        ],
        flags: 64,
      }).catch(() => {});
      return;
    }

    // Send to channel
    await interaction.channel.send({ embeds: [embed] });
    await interaction.editReply({
      embeds: [successEmbed("Embed Sent", "your custom embed has been posted to the channel")],
      flags: 64,
    }).catch(() => {});
    log(`[Embed] ${interaction.user.tag} created custom embed in ${interaction.guild.name}`);
  } catch (err) {
    log(`[Embed] error sending embed: ${err.message}`);
    await interaction.reply({
      embeds: [errorEmbed("Error", "couldn't send embed — check if the image URL is valid")],
      flags: 64,
    }).catch(() => {});
  }
}
