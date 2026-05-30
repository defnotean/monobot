import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { hasAdministratorMember } from "../../utils/permissions.js";

export const data = new SlashCommandBuilder()
  .setName("setup-server")
  .setDescription("Auto-create a standard server structure (categories, channels, roles)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  if (!hasAdministratorMember(interaction.member)) {
    return interaction.reply({
      embeds: [errorEmbed("No Permission", "You need **Administrator** to auto-create server roles and channels.")],
      ephemeral: true,
    });
  }
  if (!interaction.guild.members.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      embeds: [errorEmbed("Bot Missing Permissions", "I need **Manage Roles** to create setup roles.")],
      ephemeral: true,
    });
  }
  if (!interaction.guild.members.me?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({
      embeds: [errorEmbed("Bot Missing Permissions", "I need **Manage Channels** to create setup channels.")],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const guild = interaction.guild;
  /** @type {{ categories: string[], channels: string[], roles: string[] }} */
  const created = { categories: [], channels: [], roles: [] };

  try {
    // ─── Roles ──────────────────────────────────────────────────────
    const roleDefs = [
      { name: "Admin", color: 0xe74c3c, permissions: [PermissionFlagsBits.Administrator], hoist: true },
      { name: "Moderator", color: 0xe67e22, permissions: [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers], hoist: true },
      { name: "Member", color: 0x3498db, permissions: [], hoist: false },
    ];

    for (const def of roleDefs) {
      if (!guild.roles.cache.find((r) => r.name === def.name)) {
        const role = await guild.roles.create({
          name: def.name,
          color: def.color,
          permissions: def.permissions,
          hoist: def.hoist,
          reason: "Server setup",
        });
        created.roles.push(role.name);
      }
    }

    // ─── Role position sorting (Admin > Moderator > Member) ────────
    // Attempt to place roles just below the bot's own position so the
    // hierarchy makes sense. Silently skips if Discord rejects it.
    let hierarchyNote = null;
    try {
      const botMember  = guild.members.cache.get(guild.client.user.id);
      const botPos     = botMember?.roles?.highest?.position ?? 1;
      const order      = ["Admin", "Moderator", "Member"];
      const posUpdates = [];
      order.forEach((name, i) => {
        const role = guild.roles.cache.find((r) => r.name === name);
        if (role) posUpdates.push({ role: role.id, position: Math.max(1, botPos - 1 - i) });
      });
      if (posUpdates.length) await guild.roles.setPositions(posUpdates);
    } catch (err) {
      if (err.code === 50013 || err.message?.includes("Missing Permissions")) {
        hierarchyNote =
          "⚠️ Couldn't auto-sort role positions (bot role too low). " +
          "Drag them manually: **Admin → Moderator → Member** from top to bottom in Server Settings › Roles.";
      }
    }

    // ─── Categories & Channels ──────────────────────────────────────
    const structure = [
      {
        name: "INFO",
        channels: [
          { name: "rules", type: ChannelType.GuildText },
          { name: "announcements", type: ChannelType.GuildText },
          { name: "roles", type: ChannelType.GuildText },
        ],
      },
      {
        name: "GENERAL",
        channels: [
          { name: "general", type: ChannelType.GuildText },
          { name: "media", type: ChannelType.GuildText },
          { name: "bot-commands", type: ChannelType.GuildText },
        ],
      },
      {
        name: "MODERATION",
        channels: [
          { name: "mod-log", type: ChannelType.GuildText },
          { name: "mod-chat", type: ChannelType.GuildText },
        ],
      },
      {
        name: "VOICE",
        channels: [
          { name: "General Voice", type: ChannelType.GuildVoice },
          { name: "Music", type: ChannelType.GuildVoice },
          { name: "AFK", type: ChannelType.GuildVoice },
        ],
      },
    ];

    for (const cat of structure) {
      let category = guild.channels.cache.find(
        (c) => c.name.toUpperCase() === cat.name && c.type === ChannelType.GuildCategory
      );

      if (!category) {
        category = await guild.channels.create({
          name: cat.name,
          type: ChannelType.GuildCategory,
          reason: "Server setup",
        });
        created.categories.push(category.name);
      }

      for (const ch of cat.channels) {
        const exists = guild.channels.cache.find(
          (c) => c.name === ch.name && c.parentId === category.id
        );
        if (!exists) {
          const channel = await guild.channels.create({
            name: ch.name,
            type: ch.type,
            parent: category.id,
            reason: "Server setup",
          });
          created.channels.push(`#${channel.name}`);
        }
      }
    }

    const summary = [];
    if (created.roles.length) summary.push(`**Roles:** ${created.roles.join(", ")}`);
    if (created.categories.length) summary.push(`**Categories:** ${created.categories.join(", ")}`);
    if (created.channels.length) summary.push(`**Channels:** ${created.channels.join(", ")}`);

    if (summary.length === 0 && !hierarchyNote) {
      return interaction.editReply({
        embeds: [successEmbed("Server Already Set Up", "All standard channels and roles already exist.")],
      });
    }

    const replyLines = summary.length ? summary.join("\n") : "All standard channels and roles already existed.";
    await interaction.editReply({
      embeds: [
        successEmbed(
          summary.length ? "Server Setup Complete" : "Server Already Set Up",
          hierarchyNote ? `${replyLines}\n\n${hierarchyNote}` : replyLines
        ),
      ],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [errorEmbed("Setup Failed", error.message)],
    });
  }
}
