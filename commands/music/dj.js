import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";

// ─── DJ Role Store ────────────────────────────────────────────────────────────
// Key: guildId, Value: roleId
const djStore = new Map();

// ─── Utility Functions ─────────────────────────────────────────────────────────

export function getDjRole(guildId) {
  return djStore.get(guildId) || null;
}

export function setDjRole(guildId, roleId) {
  djStore.set(guildId, roleId);
  log(`[DJ] Set DJ role for guild ${guildId}: ${roleId}`);
}

export function removeDjRole(guildId) {
  djStore.delete(guildId);
  log(`[DJ] Removed DJ role requirement for guild ${guildId}`);
}

/**
 * Check if a user can use DJ commands.
 * Returns true if:
 * - No DJ role is set for the guild, OR
 * - User has the DJ role, OR
 * - User is the server owner, OR
 * - User has ManageGuild permission (admin)
 *
 * If denied, replies with an error and returns false.
 */
export async function requireDj(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const djRoleId = getDjRole(guildId);

  // No DJ role set — everyone can use DJ commands
  if (!djRoleId) return true;

  // Check if user is server owner
  if (interaction.guild.ownerId === userId) return true;

  // Check if user has ManageGuild permission
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  // Check if user has DJ role
  if (interaction.member.roles.cache.has(djRoleId)) return true;

  // Denied
  const role = interaction.guild.roles.cache.get(djRoleId);
  const roleName = role?.name || "unknown";
  await interaction.reply({
    embeds: [errorEmbed("DJ Role Required", `only **${roleName}** can use this command`)],
    flags: 64,
  });
  return false;
}

export function initDjData(loaded) {
  if (!loaded || !loaded.dj) return;
  djStore.clear();
  for (const [guildId, roleId] of Object.entries(loaded.dj)) {
    djStore.set(guildId, roleId);
  }
  log(`[DJ] Loaded ${djStore.size} guild DJ roles from database`);
}

export function getDjData() {
  const data = {};
  for (const [guildId, roleId] of djStore) {
    data[guildId] = roleId;
  }
  return data;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("dj")
  .setDescription("Configure DJ role for music commands")
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the DJ role")
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("Role required to use DJ commands").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("remove").setDescription("Remove DJ role requirement")
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show current DJ role")
  )
  .addSubcommand((sub) =>
    sub
      .setName("check")
      .setDescription("Check if a user has DJ permissions")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("User to check").setRequired(true)
      )
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (subcommand === "check") {
    await handleCheck(interaction, guildId);
  } else if (subcommand === "set") {
    // Require ManageGuild permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        embeds: [errorEmbed("Permission Denied", "you need **Manage Guild** permission")],
        flags: 64,
      });
    }

    const role = interaction.options.getRole("role");
    setDjRole(guildId, role.id);

    await interaction.reply({
      embeds: [
        successEmbed("DJ Role Set", `Only users with ${role} can use DJ commands`)
          .addFields(
            {
              name: "🎵 Protected Commands",
              value: "`/skip` `/stop` `/pause` `/resume` `/volume` `/loop` `/shuffle`",
              inline: false,
            },
            {
              name: "📋 Anyone Can Use",
              value: "`/play` `/queue` `/nowplaying` (requesting songs always allowed)",
              inline: false,
            },
            {
              name: "👑 Exemptions",
              value: "Server owner and users with Manage Guild permission bypass this role.",
              inline: false,
            }
          ),
      ],
    });
  } else if (subcommand === "remove") {
    // Require ManageGuild permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        embeds: [errorEmbed("Permission Denied", "you need **Manage Guild** permission")],
        flags: 64,
      });
    }

    removeDjRole(guildId);

    await interaction.reply({
      embeds: [successEmbed("DJ Role Removed", "everyone can now use DJ commands")],
    });
  } else if (subcommand === "status") {
    const djRoleId = getDjRole(guildId);

    if (!djRoleId) {
      return interaction.reply({
        embeds: [infoEmbed("DJ Role Status", "No DJ role is set")
          .addFields({
            name: "Status",
            value: "✅ Everyone can use DJ commands",
            inline: false,
          })
        ],
      });
    }

    const role = interaction.guild.roles.cache.get(djRoleId);
    const roleName = role?.name || "unknown (deleted)";

    await interaction.reply({
      embeds: [infoEmbed("DJ Role Status", `Current DJ role: **${roleName}**`)
        .addFields(
          {
            name: "🎵 Protected Commands",
            value: "`/skip` `/stop` `/pause` `/resume` `/volume` `/loop` `/shuffle`",
            inline: false,
          },
          {
            name: "Who Can Use DJ Commands",
            value: `Only users with ${role} role (or server owner/admins)`,
            inline: false,
          }
        )
      ],
    });
  }
}

async function handleCheck(interaction, guildId) {
  const user = interaction.options.getUser("user");
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) {
    return interaction.reply({
      embeds: [errorEmbed("User Not Found", "Could not find that user in this server")],
      flags: 64,
    });
  }

  const djRoleId = getDjRole(guildId);

  if (!djRoleId) {
    return interaction.reply({
      embeds: [infoEmbed("DJ Status — " + user.username, "No DJ role is set — everyone has DJ access")
        .setThumbnail(user.displayAvatarURL())
      ],
    });
  }

  const role = interaction.guild.roles.cache.get(djRoleId);
  const roleName = role?.name || "unknown";
  const isOwner = interaction.guild.ownerId === user.id;
  const isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);
  const hasRole = member.roles.cache.has(djRoleId);
  const hasDjAccess = isOwner || isAdmin || hasRole;

  let status = "❌ No DJ access";
  let reason = `User needs the **${roleName}** role`;

  if (isOwner) {
    status = "✅ DJ access (Server Owner)";
    reason = "Server owners always have DJ access";
  } else if (isAdmin) {
    status = "✅ DJ access (Admin)";
    reason = "Users with Manage Guild permission always have DJ access";
  } else if (hasRole) {
    status = "✅ DJ access (Has DJ Role)";
    reason = `User has the **${roleName}** role`;
  }

  await interaction.reply({
    embeds: [infoEmbed("DJ Access Check — " + user.username, status)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        {
          name: "Reason",
          value: reason,
          inline: false,
        },
        {
          name: "Has DJ Role",
          value: hasRole ? "✅ Yes" : "❌ No",
          inline: true,
        },
        {
          name: "Is Server Owner",
          value: isOwner ? "✅ Yes" : "❌ No",
          inline: true,
        },
        {
          name: "Is Admin",
          value: isAdmin ? "✅ Yes" : "❌ No",
          inline: true,
        }
      )
    ],
  });
}
