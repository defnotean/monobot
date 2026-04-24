import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName("purge")
  .setDescription("Bulk delete messages")
  .addIntegerOption((o) =>
    o.setName("count").setDescription("Number of messages to delete (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)
  )
  .addUserOption((o) => o.setName("user").setDescription("Only delete messages from this user"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.ManageMessages, "Manage Messages")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.ManageMessages, "Manage Messages")) return;

  const count = interaction.options.getInteger("count");
  const user  = interaction.options.getUser("user");

  await interaction.deferReply({ ephemeral: true });

  try {
    let messages = await interaction.channel.messages.fetch({ limit: count });
    if (user) messages = messages.filter((m) => m.author.id === user.id);

    // ── Separate deletable vs too-old (Discord silently skips >14-day messages) ─
    const cutoff    = Date.now() - TWO_WEEKS_MS;
    const tooOld    = messages.filter((m) => m.createdTimestamp < cutoff);
    const deletable = messages.filter((m) => m.createdTimestamp >= cutoff);

    if (deletable.size === 0) {
      const reason = tooOld.size > 0
        ? `All **${tooOld.size}** matching message${tooOld.size === 1 ? " is" : "s are"} older than **14 days** — Discord doesn't allow bulk-deleting messages that old.`
        : "No messages found to delete.";
      return interaction.editReply({ embeds: [errorEmbed("Nothing to Delete", reason)] });
    }

    const deleted = await interaction.channel.bulkDelete(deletable, true);

    const skippedNote = tooOld.size > 0
      ? `\n> ⚠️ **${tooOld.size}** message${tooOld.size === 1 ? " was" : "s were"} older than 14 days and could not be deleted.`
      : "";

    await interaction.editReply({
      embeds: [
        successEmbed("Messages Purged")
          .setDescription(`Successfully deleted \`${deleted.size}\` message${deleted.size === 1 ? "" : "s"} in ${interaction.channel}.${skippedNote}`)
          .addFields(
            { name: "Requested by", value: interaction.user.toString(), inline: true },
            ...(user ? [{ name: "Filtered to", value: user.tag, inline: true }] : []),
          ),
      ],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Messages Purged")
        .setDescription(`**Channel:** ${interaction.channel}`)
        .addFields(
          { name: "Deleted",   value: `\`${deleted.size}\``,                                       inline: true },
          { name: "Skipped",   value: tooOld.size > 0 ? `\`${tooOld.size}\` (too old)` : "None",  inline: true },
          { name: "Moderator", value: interaction.user.tag,                                         inline: true },
          ...(user ? [{ name: "Filtered by", value: user.tag, inline: true }] : []),
        )
    );
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed("Purge Failed", error.message)] });
  }
}
