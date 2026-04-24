// ─── /vc — Slash command wrapper for temp VC controls ────────────────────────

import { SlashCommandBuilder } from "discord.js";
import { tempChannels } from "../../utils/tempvc.js";
import { executeTool } from "../../ai/executor.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("vc")
  .setDescription("Control your temp voice channel")
  .addSubcommand((s) => s.setName("private").setDescription("Make your VC private"))
  .addSubcommand((s) => s.setName("public").setDescription("Make your VC public"))
  .addSubcommand((s) => s.setName("lock").setDescription("Lock your VC to current member count")
    .addIntegerOption((o) => o.setName("limit").setDescription("Custom user limit")))
  .addSubcommand((s) => s.setName("unlock").setDescription("Remove user limit from your VC"))
  .addSubcommand((s) => s.setName("rename").setDescription("Rename your VC")
    .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)))
  .addSubcommand((s) => s.setName("kick").setDescription("Kick someone from your VC")
    .addUserOption((o) => o.setName("user").setDescription("User to kick").setRequired(true))
    .addBooleanOption((o) => o.setName("ban").setDescription("Prevent them from rejoining")))
  .addSubcommand((s) => s.setName("transfer").setDescription("Transfer VC ownership")
    .addUserOption((o) => o.setName("user").setDescription("New owner").setRequired(true)));

export async function execute(interaction) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({ embeds: [errorEmbed("Not in Voice", "You're not in a voice channel.")], ephemeral: true });
  }

  if (!tempChannels.has(voiceChannel.id)) {
    return interaction.reply({ embeds: [errorEmbed("Not a Temp VC", "You're not in a temp voice channel.")], ephemeral: true });
  }

  const ownerId = tempChannels.get(voiceChannel.id);
  const isOwner = ownerId === member.id;
  const isAdmin = member.permissions.has(8n); // Administrator

  if (!isOwner && !isAdmin) {
    return interaction.reply({ embeds: [errorEmbed("No Permission", "You don't own this VC.")], ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();

  // Build a minimal message proxy for executeTool
  const msgProxy = {
    guild: interaction.guild,
    author: interaction.user,
    member: interaction.member,
    channel: interaction.channel,
    client: interaction.client,
  };

  let toolName, toolInput;

  switch (sub) {
    case "private":
      toolName = "vc_private"; toolInput = {}; break;
    case "public":
      toolName = "vc_public"; toolInput = {}; break;
    case "lock":
      toolName = "vc_lock"; toolInput = { limit: interaction.options.getInteger("limit") ?? undefined }; break;
    case "unlock":
      toolName = "vc_unlock"; toolInput = {}; break;
    case "rename":
      toolName = "vc_rename"; toolInput = { name: interaction.options.getString("name") }; break;
    case "kick": {
      const target = interaction.options.getUser("user");
      toolName = "vc_kick"; toolInput = { username: target.id, ban: interaction.options.getBoolean("ban") ?? false }; break;
    }
    case "transfer": {
      const target = interaction.options.getUser("user");
      toolName = "vc_transfer"; toolInput = { username: target.id }; break;
    }
    default:
      return interaction.reply({ embeds: [errorEmbed("Unknown Command", "Unknown subcommand.")], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await executeTool(toolName, toolInput, msgProxy);

    // Build a clean success embed from the tool result text
    let embedTitle = "Done";
    if (sub === "private")  embedTitle = "Channel Set to Private";
    if (sub === "public")   embedTitle = "Channel Set to Public";
    if (sub === "lock")     embedTitle = "Channel Locked";
    if (sub === "unlock")   embedTitle = "Channel Unlocked";
    if (sub === "rename")   embedTitle = "Channel Renamed";
    if (sub === "kick")     embedTitle = "User Kicked from VC";
    if (sub === "transfer") embedTitle = "Ownership Transferred";

    await interaction.editReply({ embeds: [successEmbed(embedTitle, result)] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed("Error", err.message)] });
  }
}
