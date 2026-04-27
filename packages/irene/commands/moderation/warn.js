import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, modEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner, canModerate } from "../../utils/permissions.js";
import { addWarning, getWarnings, getEscalation, deleteWarning } from "../../database.js";
import { sendModLog } from "../../utils/logger.js";
import { paginate, formatDuration } from "../../utils/pagination.js";

export const data = new SlashCommandBuilder()
  .setName("warn")
  .setDescription("Warn a user")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Issue a warning to a user")
      .addUserOption((o) => o.setName("user").setDescription("User to warn").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason for the warning").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("view")
      .setDescription("View a user's warnings")
      .addUserOption((o) => o.setName("user").setDescription("User to check").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a warning by index")
      .addUserOption((o) => o.setName("user").setDescription("User to modify").setRequired(true))
      .addIntegerOption((o) => o.setName("index").setDescription("Warning index (1-based)").setRequired(true).setMinValue(1))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export async function execute(interaction) {
  if (!requireAdminOrOwner(interaction)) return;
  if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members")) return;

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    await handleAdd(interaction);
  } else if (subcommand === "view") {
    await handleView(interaction);
  } else if (subcommand === "remove") {
    await handleRemove(interaction);
  }
}

async function handleAdd(interaction) {
  const user   = interaction.options.getUser("user");
  // Discord audit-log reason cap is 512 chars; truncate so auto-escalation
  // calls (members.ban/kick/timeout) don't get rejected by Discord.
  const reason = String(interaction.options.getString("reason") || "").slice(0, 500);

  // Guard: can't warn the bot itself
  if (user.id === interaction.client.user.id) {
    return interaction.reply({
      embeds: [errorEmbed("Invalid Target", "You can't warn the bot.")],
      ephemeral: true,
    });
  }

  // Hierarchy check — same role-position guard as /ban, /kick, /timeout. If
  // the warn auto-escalates, the bot will attempt the action and Discord
  // would reject it; better to block here so we don't leave a stray warning.
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && !canModerate(interaction, member)) return;

  await interaction.deferReply();

  addWarning(interaction.guild.id, user.id, interaction.user.id, reason);
  const warnings = getWarnings(interaction.guild.id, user.id);
  const count    = warnings.length;

  // DM the user — track success so mods know if it failed
  const dmSent = await user
    .send(
      `You have been **warned** in **${interaction.guild.name}**.\n` +
      `Reason: ${reason}\n` +
      `Total warnings: ${count}`
    )
    .then(() => true)
    .catch(() => false);

  // ── Auto-escalation ────────────────────────────────────────────────────────
  const escalation    = getEscalation(interaction.guild.id);
  let escalationNote  = null;

  if (member) {
    if (escalation.ban_at !== null && count >= escalation.ban_at) {
      try {
        await interaction.guild.members.ban(user, { reason: `Auto-escalation: ${count} warnings` });
        escalationNote = `🚫 Auto-banned after reaching **${count}** warnings.`;
      } catch (err) {
        escalationNote = `⚠️ Auto-ban failed: ${err.message}`;
      }
    } else if (escalation.kick_at !== null && count >= escalation.kick_at) {
      try {
        await member.kick(`Auto-escalation: ${count} warnings`);
        escalationNote = `👢 Auto-kicked after reaching **${count}** warnings.`;
      } catch (err) {
        escalationNote = `⚠️ Auto-kick failed: ${err.message}`;
      }
    } else if (escalation.mute_at !== null && count >= escalation.mute_at) {
      try {
        await member.timeout(24 * 60 * 60 * 1000, `Auto-escalation: ${count} warnings`);
        escalationNote = `🔇 Auto-timed out (24h) after reaching **${count}** warnings.`;
      } catch (err) {
        escalationNote = `⚠️ Auto-timeout failed: ${err.message}`;
      }
    }
  }

  // ── Reply ──────────────────────────────────────────────────────────────────
  const notes = [];
  if (!dmSent)        notes.push("> ⚠️ Could not DM the user — they may have DMs disabled.");
  if (escalationNote) notes.push(`> ${escalationNote}`);

  await interaction.editReply({
    embeds: [
      successEmbed("Warning Issued")
        .setDescription(`${user} has been warned.${notes.length ? "\n\n" + notes.join("\n") : ""}`)
        .addFields(
          { name: "Reason",         value: reason,                          inline: false },
          { name: "Total Warnings", value: `\`${count}\``,                  inline: true  },
          { name: "Issued by",      value: interaction.user.toString(),      inline: true  },
          { name: "DM Sent",        value: dmSent ? "✅ Yes" : "❌ Failed", inline: true  },
        ),
    ],
  });

  await sendModLog(
    interaction.guild,
    modEmbed("Member Warned")
      .setDescription(`**User:** ${user.tag} (${user.id})${escalationNote ? `\n${escalationNote}` : ""}`)
      .addFields(
        { name: "Reason",         value: reason,               inline: false },
        { name: "Moderator",      value: interaction.user.tag, inline: true  },
        { name: "Total Warnings", value: `\`${count}\``,       inline: true  },
      )
  );
}

async function handleView(interaction) {
  const user = interaction.options.getUser("user");
  const warnings = getWarnings(interaction.guild.id, user.id);

  if (warnings.length === 0) {
    return interaction.reply({
      embeds: [modEmbed("No Warnings", `${user} has no warnings.`)],
      flags: 64,
    });
  }

  await paginate(interaction, {
    items: warnings,
    itemsPerPage: 10,
    ephemeral: true,
    formatPage: (items, pageIndex, totalPages) => {
      const warningLines = items.map((w, idx) => {
        const issuedIdx = warnings.indexOf(w) + 1;
        const date = new Date(w.created_at).toLocaleDateString();
        const mod = w.issued_by_tag || "Unknown";
        return `**${issuedIdx}.** ${w.reason || "*(no reason)*"}\n  > ${date} by ${mod}`;
      });

      return modEmbed(
        `Warnings for ${user.username}`,
        `**Total:** ${warnings.length} warning${warnings.length === 1 ? "" : "s"}\n\n${warningLines.join("\n\n") || "*(none)*"}`
      ).setFooter({
        text: `Page ${pageIndex + 1} / ${totalPages}`
      });
    },
  });
}

async function handleRemove(interaction) {
  const user = interaction.options.getUser("user");
  const index = interaction.options.getInteger("index");
  const warnings = getWarnings(interaction.guild.id, user.id);

  if (warnings.length === 0) {
    return interaction.reply({
      embeds: [errorEmbed("No Warnings", `${user} has no warnings to remove.`)],
      flags: 64,
    });
  }

  if (index < 1 || index > warnings.length) {
    return interaction.reply({
      embeds: [errorEmbed("Invalid Index", `warning index must be between 1 and ${warnings.length}.`)],
      flags: 64,
    });
  }

  const targetId = warnings[index - 1].id;
  deleteWarning(targetId, interaction.guild.id);

  await interaction.reply({
    embeds: [modEmbed("Warning Removed", `Removed warning **#${index}** from ${user}.`)
      .addFields({
        name: "Remaining Warnings",
        value: `${warnings.length - 1}`,
        inline: true,
      })
    ],
  });

  await sendModLog(
    interaction.guild,
    modEmbed("Warning Removed")
      .setDescription(`**User:** ${user.tag} (${user.id})`)
      .addFields(
        { name: "Removed Warning", value: `#${index}`,                inline: true },
        { name: "Moderator",       value: interaction.user.tag,       inline: true },
        { name: "Remaining",       value: `\`${warnings.length - 1}\``, inline: true },
      )
  );
}
