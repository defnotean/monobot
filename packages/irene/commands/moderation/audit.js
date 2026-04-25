import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { formatEntry, joinEntries, MODERATION_ACTION_TYPES } from "../../utils/auditFormat.js";
import { log } from "../../utils/logger.js";

const FETCH_LIMIT = 100;     // max per Discord API call
const RECENT_HOURS = 24;
const EMBED_COLOR = 0x5865F2;

export const data = new SlashCommandBuilder()
  .setName("audit")
  .setDescription("Search Discord audit log for moderation actions (45-day retention)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog)
  .addSubcommand((s) => s.setName("user")
    .setDescription("All mod actions performed against a specific user")
    .addUserOption((o) => o.setName("target").setDescription("Who to audit").setRequired(true)))
  .addSubcommand((s) => s.setName("by")
    .setDescription("All mod actions performed BY a specific moderator")
    .addUserOption((o) => o.setName("moderator").setDescription("Whose actions to audit").setRequired(true)))
  .addSubcommand((s) => s.setName("recent")
    .setDescription(`Mod actions in the last ${RECENT_HOURS}h (any actor, any target)`));

function emptyEmbed(title, description) {
  return new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description);
}

async function fetchModEntries(guild) {
  // Discord audit log returns 100 entries max per call. For /audit's purposes
  // (recent moderation activity), one call is enough. If a guild needs deeper
  // history, that's where persistent storage would come in (see follow-up).
  try {
    const log = await guild.fetchAuditLogs({ limit: FETCH_LIMIT });
    return [...log.entries.values()].filter((e) => MODERATION_ACTION_TYPES.has(e.action));
  } catch (err) {
    throw new Error(`couldn't fetch audit log: ${err.message ?? err}`);
  }
}

export async function execute(interaction) {
  // Permission gate at command-handler level (defense in depth — the slash
  // command already requires ViewAuditLog via setDefaultMemberPermissions,
  // but admins can override default perms server-wide so re-check here).
  if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ViewAuditLog)) {
    return interaction.reply({
      content: "you need View Audit Log permission to use /audit.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let entries;
  try {
    entries = await fetchModEntries(interaction.guild);
  } catch (err) {
    return interaction.editReply({ content: err.message }).catch(() => {});
  }

  let filtered;
  let title;
  let emptyMsg;

  if (sub === "user") {
    const target = interaction.options.getUser("target");
    filtered = entries.filter((e) => e.target?.id === target.id);
    title = `Audit log — actions on ${target.tag}`;
    emptyMsg = `No moderation actions found for ${target.tag} in the last ${FETCH_LIMIT} audit entries (45-day window).`;
  } else if (sub === "by") {
    const mod = interaction.options.getUser("moderator");
    filtered = entries.filter((e) => e.executor?.id === mod.id);
    title = `Audit log — actions by ${mod.tag}`;
    emptyMsg = `${mod.tag} has performed no moderation actions in the last ${FETCH_LIMIT} audit entries.`;
  } else if (sub === "recent") {
    const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
    filtered = entries.filter((e) => e.createdTimestamp >= cutoff);
    title = `Audit log — last ${RECENT_HOURS}h`;
    emptyMsg = `No moderation actions in the last ${RECENT_HOURS} hours.`;
  } else {
    return interaction.editReply({ content: `unknown subcommand: ${sub}` }).catch(() => {});
  }

  if (filtered.length === 0) {
    return interaction.editReply({ embeds: [emptyEmbed(title, emptyMsg)] }).catch(() => {});
  }

  // Discord returns newest-first; keep that order.
  const { value, shown, truncated } = joinEntries(filtered);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setDescription(value)
    .setFooter({
      text: truncated
        ? `Showing ${shown} of ${filtered.length} matches (older trimmed to fit). Discord retains audit logs for 45 days.`
        : `${shown} match${shown === 1 ? "" : "es"}. Discord retains audit logs for 45 days.`,
    });

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  log(`[Audit] ${interaction.user.tag} ran /audit ${sub} in ${interaction.guild?.name ?? "?"} — ${shown}/${filtered.length} entries`);
}
