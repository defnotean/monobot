import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireBotPermission, canModerate, requireAdminOrOwner } from "../../utils/permissions.js";
import { sendModLog } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("kick")
  .setDescription("Kick a user from the server")
  .addUserOption((o) => o.setName("user").setDescription("User to kick").setRequired(true))
  .addStringOption((o) => o.setName("reason").setDescription("Reason for the kick"))
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.KickMembers, "Kick Members")) return;
  if (!requireBotPermission(interaction, PermissionFlagsBits.KickMembers, "Kick Members")) return;

  const user = interaction.options.getUser("user");
  if (user.id === interaction.user.id) return interaction.reply({ content: "You can't kick yourself", flags: 64 });
  if (user.id === interaction.client.user.id) return interaction.reply({ content: "I'm not kicking myself lol", flags: 64 });

  const reason = interaction.options.getString("reason") || "No reason provided";
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) {
    return interaction.reply({ embeds: [errorEmbed("Not Found", "That user is not in this server.")], ephemeral: true });
  }

  if (!canModerate(interaction, member)) return;

  // Defer once perm/hierarchy checks pass — DM round-trip + sendModLog can
  // easily blow past Discord's 3s initial-response window when the target
  // has DMs disabled and we wait for the rejection.
  await interaction.deferReply();

  try {
    // ── Execute kick first — DM after so a failed kick doesn't confuse the user ──
    await member.kick(reason);

    const dmSent = await user
      .send(`You have been **kicked** from **${interaction.guild.name}**.\nReason: ${reason}`)
      .then(() => true)
      .catch(() => false);

    await interaction.editReply({
      embeds: [
        successEmbed("User Kicked")
          .setDescription(`${user} has been kicked from the server.${!dmSent ? "\n> ⚠️ Could not DM user — they may have DMs disabled." : ""}`)
          .addFields(
            { name: "Reason",    value: reason,                          inline: false },
            { name: "Kicked by", value: interaction.user.toString(),     inline: true  },
            { name: "DM Sent",   value: dmSent ? "✅ Yes" : "❌ Failed", inline: true  },
          ),
      ],
    });

    await sendModLog(
      interaction.guild,
      modEmbed("Member Kicked")
        .setDescription(`**User:** ${user.tag} (${user.id})`)
        .addFields(
          { name: "Reason",    value: reason,               inline: false },
          { name: "Moderator", value: interaction.user.tag, inline: true  },
        )
    );
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed("Kick Failed", error.message)] });
  }
}
