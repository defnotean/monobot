import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, canModerate, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a user from the server")
  .addUserOption((o) => o.setName("user").setDescription("User to ban").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Reason for the ban"))
  .addIntegerOption((o) =>
    o.setName("days").setDescription("Days of messages to delete (0-7)").setMinValue(0).setMaxValue(7)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.BanMembers, "Ban Members")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.BanMembers, "Ban Members")) return;

  const user = interaction.options.getUser("user");
  if (user.id === interaction.user.id) return interaction.reply({ content: "You can't ban yourself", flags: 64 });
  if (user.id === interaction.client.user.id) return interaction.reply({ content: "I'm not banning myself lol", flags: 64 });

  const reason = interaction.options.getString("reason") || "No reason provided";
  const days = interaction.options.getInteger("days") || 0;

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && !canModerate(interaction, member)) return;

  // Defer once perm/hierarchy checks pass — DM round-trip + sendModLog can
  // easily blow past Discord's 3s initial-response window when the target
  // has DMs disabled and we wait for the rejection.
  await interaction.deferReply();

  try {
    // ── Execute ban first — DM after so a failed ban doesn't confuse the user ──
    await interaction.guild.members.ban(user, { deleteMessageDays: days, reason });

    const dmSent = await user
      .send(`You have been **banned** from **${interaction.guild.name}**.\nReason: ${reason}`)
      .then(() => true)
      .catch(() => false);

    await interaction.editReply({
      embeds: [
        successEmbed("User Banned")
          .setDescription(`${user} has been banned from the server.${!dmSent ? "\n> ⚠️ Could not DM user — they may have DMs disabled." : ""}`)
          .addFields(
            { name: "Reason",           value: reason,                                                         inline: false },
            { name: "Banned by",        value: interaction.user.toString(),                                    inline: true  },
            { name: "Messages Deleted", value: days > 0 ? `\`${days} day${days === 1 ? "" : "s"}\`` : "None", inline: true  },
            { name: "DM Sent",          value: dmSent ? "✅ Yes" : "❌ Failed",                                inline: true  },
          ),
      ],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Member Banned")
        .setDescription(`**User:** ${user.tag} (${user.id})`)
        .addFields(
          { name: "Reason",           value: reason,                                    inline: false },
          { name: "Moderator",        value: interaction.user.tag,                      inline: true  },
          { name: "Messages Deleted", value: days > 0 ? `${days}d` : "None",            inline: true  },
        )
    );
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed("Ban Failed", error.message)] });
  }
}
