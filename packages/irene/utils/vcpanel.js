// ─── VC Control Panel ─────────────────────────────────────────────────────────
// Posts a persistent control panel in the VC's text chat so the owner can
// manage their channel without commands. Designed to be clean, modern, and
// state-aware — button styles and embed colours reflect the current channel state.

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import {
  tempChannels, tempControlPanels, tempTextChannels,
  tempVcSeq, manualRenames, renameTimers, ownerGraceTimers,
  tempVcCreatedAt, tempVcMembers,
} from "./tempvc.js";
import { getChannelGames } from "./vcrenamer.js";
import { log } from "./logger.js";
import { successEmbed, errorEmbed, infoEmbed, warnEmbed } from "./embeds.js";
import { saveTempVc, deleteTempVc } from "../database.js";

// ─── Privacy state helper ─────────────────────────────────────────────────────

function getVcPrivacyState(vc, guild) {
  const eo         = vc.permissionOverwrites.cache.get(guild.roles.everyone.id);
  const denyConnect = eo?.deny.has(PermissionFlagsBits.Connect)     ?? false;
  const denyView    = eo?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
  return {
    isPrivate: denyConnect && denyView,   // hidden AND unconnectable
    isGhost:   denyConnect && !denyView,  // visible but unconnectable
    isPublic:  !denyConnect,              // anyone can join
  };
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function buildPanelEmbed(vc, guild) {
  let ownerId = tempChannels.get(vc.id);
  // Fallback: if tempChannels is stale, derive owner from Discord permissions
  if (!ownerId) {
    for (const [, ow] of vc.permissionOverwrites.cache) {
      if (ow.type === 1 && ow.allow.has(PermissionFlagsBits.ManageChannels)) {
        ownerId = ow.id;
        break;
      }
    }
  }
  const owner       = ownerId ? guild.members.cache.get(ownerId) : null;
  const nonBots     = vc.members.filter((m) => !m.user.bot);
  const memberCount = nonBots.size;

  const { isPrivate, isGhost } = getVcPrivacyState(vc, guild);
  const isSlotFull = vc.userLimit > 0 && memberCount >= vc.userLimit;

  // Embed colour: red = private, purple = ghost, blurple = public
  const color = isPrivate ? 0xED4245 : isGhost ? 0x9B59B6 : 0x5865F2;

  // Status chips — compact one-liner in description
  const chips = [];
  if (isPrivate)      chips.push("🔒 Private");
  else if (isGhost)   chips.push("👻 Ghost");
  else                chips.push("🔓 Public");
  if (isSlotFull)     chips.push("🔴 Full");
  const slotStr = vc.userLimit > 0 ? `${memberCount}/${vc.userLimit}` : `${memberCount}`;
  chips.push(`👥 ${slotStr}`);

  // Activity breakdown
  const gameCounts = getChannelGames(vc);
  const gameStr = gameCounts.size
    ? [...gameCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([g, c]) => `\`${g}\`${c > 1 ? ` ×${c}` : ""}`)
        .join("  ·  ")
        .slice(0, 512)
    : "Nothing";

  // Member mentions — first 8, then overflow note
  const memberList = [...nonBots.values()];
  const shown      = memberList.slice(0, 8).map((m) => `<@${m.id}>`).join(" ");
  const extra      = memberList.length > 8 ? ` *+${memberList.length - 8} more*` : "";
  const membersVal = memberCount > 0 ? shown + extra : "—";

  // Bitrate + region
  const bitrateKbps = Math.round(vc.bitrate / 1000);
  const regionRaw   = vc.rtcRegion;
  const regionLabel = regionRaw
    ? regionRaw.replace(/-/g, " ").replace(/\b./g, (c) => c.toUpperCase())
    : "Automatic";
  const slotsLabel  = vc.userLimit > 0 ? `${vc.userLimit} max` : "No limit";

  // If ownerId is known but not cached, still show a mention — Discord will resolve it
  const ownerValue = ownerId ? `<@${ownerId}>` : "—";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: "Voice Channel",
      iconURL: guild.iconURL({ size: 64 }) ?? undefined,
    })
    .setTitle(vc.name)
    .setDescription(chips.join("  ·  "))
    .addFields(
      { name: "👑  Owner",    value: ownerValue, inline: true },
      { name: "🎮  Activity", value: gameStr,                             inline: true },
      { name: "📡  Bitrate",  value: `${bitrateKbps} kbps`,              inline: true },
      { name: "👥  Members",  value: membersVal,                          inline: false },
      { name: "🔢  Slots",    value: slotsLabel,                          inline: true },
      { name: "🌍  Region",   value: regionLabel,                         inline: true },
    )
    .setFooter({ text: "Channel owner only  ·  Updates on join / leave" })
    .setTimestamp();

  // Use owner's avatar if cached; fall back to the guild icon so the panel always has art
  if (owner?.user?.displayAvatarURL()) {
    embed.setThumbnail(owner.user.displayAvatarURL({ size: 128 }));
  } else if (guild.iconURL()) {
    embed.setThumbnail(guild.iconURL({ size: 128 }));
  }

  // Owner's rich presence (only if there's something meaningful)
  const ownerActivity = owner?.presence?.activities?.find((a) => a.type === 0);
  const rpDetails     = ownerActivity?.details ?? null;
  const rpState       = ownerActivity?.state   ?? null;
  const rpParty       = ownerActivity?.party?.size;
  if (rpDetails || rpState || rpParty) {
    const rpLines = [];
    if (rpDetails) rpLines.push(`**${rpDetails}**`);
    if (rpState)   rpLines.push(rpState);
    if (rpParty)   rpLines.push(`Party: ${rpParty[0]}/${rpParty[1]}`);
    embed.addFields({ name: "🕹️  Rich Presence", value: rpLines.join("\n"), inline: false });
  }

  return embed;
}

// ─── Button rows ──────────────────────────────────────────────────────────────
// Three clean rows of three — grouped by purpose, state-aware styling.
//
//  Row 1  [Privacy]     Private  ·  Ghost  ·  Public
//  Row 2  [Settings]    Rename   ·  Limit  ·  Invite
//  Row 3  [Management]  Kick     ·  Transfer  ·  Disband

function buildPanelRows(vcId, vc, guild) {
  const { isPrivate, isGhost, isPublic } = getVcPrivacyState(vc, guild);
  const hasLimit = vc.userLimit > 0;

  // Row 1 — privacy modes (active state highlighted)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_panel:private:${vcId}`)
      .setLabel("Private")
      .setEmoji("🔒")
      .setStyle(isPrivate ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_panel:ghost:${vcId}`)
      .setLabel("Ghost")
      .setEmoji("👻")
      .setStyle(isGhost ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_panel:public:${vcId}`)
      .setLabel("Public")
      .setEmoji("🔓")
      .setStyle(isPublic ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // Row 2 — channel settings
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_panel:rename:${vcId}`)
      .setLabel("Rename")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vc_panel:limit:${vcId}`)
      .setLabel("Set Limit")
      .setEmoji("🔢")
      .setStyle(hasLimit ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_panel:invite:${vcId}`)
      .setLabel("Invite")
      .setEmoji("📨")
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 3 — member management (danger actions grouped here)
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_panel:kick:${vcId}`)
      .setLabel("Kick")
      .setEmoji("👢")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`vc_panel:transfer:${vcId}`)
      .setLabel("Transfer")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_panel:disband:${vcId}`)
      .setLabel("Disband VC")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3];
}

// ─── Create panel ─────────────────────────────────────────────────────────────

export async function createControlPanel(vc, textChannel, guild) {
  try {
    // Check if we already have a panel message in this channel — don't create duplicates
    const existing = tempControlPanels.get(vc.id);
    if (existing) {
      try {
        const ch = guild.channels.cache.get(existing.textChannelId);
        const oldMsg = await ch?.messages.fetch(existing.messageId).catch(() => null);
        if (oldMsg) {
          // Panel still exists — just update it instead of creating a new one
          await oldMsg.edit({ embeds: [buildPanelEmbed(vc, guild)], components: buildPanelRows(vc.id, vc, guild) });
          log(`[VCPanel] Updated existing panel for "${vc.name}" (skipped re-create)`);
          return;
        }
      } catch {}
    }

    const embed = buildPanelEmbed(vc, guild);
    const rows  = buildPanelRows(vc.id, vc, guild);
    const msg   = await textChannel.send({ embeds: [embed], components: rows });
    // Pin is best-effort — voice text channels often don't support it
    msg.pin().catch(() => {});
    tempControlPanels.set(vc.id, { messageId: msg.id, textChannelId: textChannel.id });
    // Persist the panel message ID so we can find it after restart without relying on pins
    saveTempVc(vc.id, { ...getTempVcData(vc.id), panelMessageId: msg.id, panelChannelId: textChannel.id });
    log(`[VCPanel] Created panel for "${vc.name}"`);
  } catch (err) {
    log(`[VCPanel] Failed to create panel: ${err.message}`);
  }
}

function getTempVcData(vcId) {
  try {
    const { tempChannels } = require("./tempvc.js");
    return tempChannels.get(vcId) ?? {};
  } catch { return {}; }
}

// ─── Update panel ─────────────────────────────────────────────────────────────

// Cache fetched panel messages to avoid redundant API calls on rapid updates
const _panelMsgCache = new Map(); // vcId → { msg, ts }
const PANEL_MSG_CACHE_TTL = 5000;

export async function updateControlPanel(vcId, guild) {
  const panel = tempControlPanels.get(vcId);
  if (!panel) return;

  const vc     = guild.channels.cache.get(vcId);
  const textCh = guild.channels.cache.get(panel.textChannelId);
  if (!vc || !textCh) return;

  try {
    let msg;
    const cached = _panelMsgCache.get(vcId);
    if (cached && Date.now() - cached.ts < PANEL_MSG_CACHE_TTL) {
      msg = cached.msg;
    } else {
      msg = await textCh.messages.fetch(panel.messageId).catch(() => null);
      if (msg) {
        _panelMsgCache.set(vcId, { msg, ts: Date.now() });
      } else {
        // Message is gone (manually deleted) — drop stale reference so a new panel
        // can be created on the next voice state change
        _panelMsgCache.delete(vcId);
        tempControlPanels.delete(vcId);
        log(`[VCPanel] Panel message for "${vc.name}" was deleted — reference cleared`);
        return;
      }
    }
    await msg.edit({ embeds: [buildPanelEmbed(vc, guild)], components: buildPanelRows(vcId, vc, guild) });
  } catch (err) {
    // Invalidate the msg cache on error so the next update re-fetches rather than
    // hammering the same stale object again
    _panelMsgCache.delete(vcId);
    log(`[VCPanel] Failed to update panel: ${err.message}`);
  }
}

// ─── Button interaction handler ───────────────────────────────────────────────

export async function handlePanelInteraction(interaction) {
  const [, action, vcId] = interaction.customId.split(":");
  const guild  = interaction.guild;
  const caller = interaction.member;
  const vc     = guild.channels.cache.get(vcId);

  if (!vc) {
    await interaction.reply({ embeds: [errorEmbed("Channel Not Found", "That voice channel no longer exists.")], ephemeral: true });
    return;
  }

  // Permission check — owner or admin only.
  // Primary source is tempChannels (in-memory). If missing (e.g. just after restart
  // before the panel re-check runs), fall back to Discord channel permission overwrites
  // to find who actually has ManageChannels — that's the ground-truth owner.
  let ownerId = tempChannels.get(vcId);
  if (!ownerId) {
    for (const [, ow] of vc.permissionOverwrites.cache) {
      if (ow.type === 1 && ow.allow.has(PermissionFlagsBits.ManageChannels)) {
        ownerId = ow.id;
        // Repair in-memory state so subsequent interactions work without the fallback.
        // Also persist to DB so the correct owner survives the next restart.
        tempChannels.set(vcId, ownerId);
        saveTempVc(vcId, { ownerId, guildId: guild.id, seq: tempVcSeq.get(vcId) ?? 1, textChannelId: tempTextChannels.get(vcId) ?? null });
        log(`[VCPanel] Repaired tempChannels for "${vc.name}" from Discord overwrites — owner: ${ownerId}`);
        break;
      }
    }
  }
  const isOwner = ownerId === caller.id;
  const isAdmin = caller.permissions.has(PermissionFlagsBits.Administrator) || caller.id === guild.ownerId;
  if (!isOwner && !isAdmin) {
    await interaction.reply({ embeds: [errorEmbed("Access Denied", "Only the **channel owner** can use these controls.")], ephemeral: true });
    return;
  }

  // ── Rename — show modal ───────────────────────────────────────────────────
  if (action === "rename") {
    const modal = new ModalBuilder()
      .setCustomId(`vc_modal:rename:${vcId}`)
      .setTitle("Rename Voice Channel")
      .addComponents(
        /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("new_name")
            .setLabel("New channel name")
            .setStyle(TextInputStyle.Short)
            .setValue(vc.name)
            .setMaxLength(100)
            .setRequired(true),
        )),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Set Limit — quick-pick select menu ───────────────────────────────────
  if (action === "limit") {
    const cur = vc.userLimit;
    const presets = [
      { label: "No limit",   description: "Open to all",         value: "0",      emoji: "♾️" },
      { label: "2 people",   value: "2",  emoji: "👤" },
      { label: "3 people",   value: "3",  emoji: "👤" },
      { label: "4 people",   value: "4",  emoji: "👤" },
      { label: "5 people",   value: "5",  emoji: "👤" },
      { label: "6 people",   value: "6",  emoji: "👤" },
      { label: "8 people",   value: "8",  emoji: "👥" },
      { label: "10 people",  value: "10", emoji: "👥" },
      { label: "15 people",  value: "15", emoji: "👥" },
      { label: "Custom…",    description: "Type a specific number", value: "custom", emoji: "✏️" },
    ].map((opt) => ({
      ...opt,
      description: cur === parseInt(opt.value) ? "✓ Current limit" : opt.description,
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`vc_select:limit:${vcId}`)
      .setPlaceholder("Choose a slot limit…")
      .addOptions(presets);

    await interaction.reply({
      embeds: [infoEmbed("Set Slot Limit", `Currently: **${cur > 0 ? `${cur} slots` : "No limit"}**\nChoose a new limit or pick **Custom** to type a number.`)],
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
    return;
  }

  // ── Invite link ───────────────────────────────────────────────────────────
  if (action === "invite") {
    try {
      const invite = await vc.createInvite({
        maxAge:   3600, // 1 hour
        maxUses:  10,
        reason:   `VC invite created by ${caller.user.tag}`,
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("📨  Invite Link")
            .setDescription(`Invite people into **${vc.name}**:\n\n**${invite.url}**`)
            .setFooter({ text: "Expires in 1 hour  ·  Max 10 uses" }),
        ],
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({ embeds: [errorEmbed("Invite Failed", err.message)], ephemeral: true });
    }
    return;
  }

  // ── Disband — confirmation prompt ─────────────────────────────────────────
  if (action === "disband") {
    const memberCount = vc.members.filter((m) => !m.user.bot).size;
    const memberNote  = memberCount > 1 ? `\n\n**${memberCount} people** will be disconnected.` : "";
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle("⚠️  Disband Channel?")
          .setDescription(`This will permanently delete **${vc.name}** and disconnect everyone in it.${memberNote}`),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`vc_panel:disband_confirm:${vcId}`).setLabel("Yes, delete it").setStyle(ButtonStyle.Danger).setEmoji("🗑️"),
          new ButtonBuilder().setCustomId(`vc_panel:disband_cancel:${vcId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (action === "disband_cancel") {
    await interaction.update({ embeds: [infoEmbed("Cancelled", "Channel disband cancelled.")], components: [] });
    return;
  }

  if (action === "disband_confirm") {
    // Defer immediately — gives us time to make the API calls without hitting the 3s timeout
    await interaction.deferUpdate();
    try {
      const channelName = vc.name;
      const textChId    = tempTextChannels.get(vcId);

      // Delete the channel FIRST — if this fails, we bail without touching state
      // so the channel remains functional (user can still manage it via panel)
      await vc.delete("Disbanded by owner");

      // Channel deleted — now clean up ALL in-memory state
      tempChannels.delete(vcId);
      tempControlPanels.delete(vcId);
      tempTextChannels.delete(vcId);
      tempVcSeq.delete(vcId);
      manualRenames.delete(vcId);
      const rt = renameTimers.get(vcId);
      if (rt?.timer) clearTimeout(rt.timer);
      renameTimers.delete(vcId);
      // Cancel any pending grace timer so it doesn't fire on a deleted channel
      const grace = ownerGraceTimers.get(vcId);
      if (grace?.timer) clearTimeout(grace.timer);
      ownerGraceTimers.delete(vcId);
      // Clear VC history tracking maps
      tempVcCreatedAt.delete(vcId);
      tempVcMembers.delete(vcId);
      deleteTempVc(vcId);

      // Delete paired text channel if it's separate
      if (textChId && textChId !== vcId) {
        await guild.channels.cache.get(textChId)?.delete("VC disbanded by owner").catch(() => {});
      }

      await interaction.editReply({ embeds: [successEmbed("Channel Disbanded", `**${channelName}** has been deleted.`)], components: [] });
    } catch (err) {
      // Delete failed — state is untouched, channel is still fully functional
      await interaction.editReply({ embeds: [errorEmbed("Failed to Disband", `Couldn't delete the channel: ${err.message}`)], components: [] });
    }
    return;
  }

  // ── Kick / Transfer — show member select menu ─────────────────────────────
  if (action === "kick" || action === "transfer") {
    const others = [...vc.members.values()].filter((m) => !m.user.bot && m.id !== caller.id);
    if (!others.length) {
      await interaction.reply({ embeds: [errorEmbed("No Members", "There are no other members in the channel.")], ephemeral: true });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`vc_select:${action}:${vcId}`)
      .setPlaceholder(action === "kick" ? "Choose a member to kick…" : "Transfer ownership to…")
      .addOptions(others.map((m) => ({
        label:       m.displayName.slice(0, 100),
        description: m.user.tag.slice(0, 100),
        value:       m.id,
        emoji:       action === "kick" ? "👢" : "🔄",
      })));
    await interaction.reply({
      embeds: [
        infoEmbed(
          action === "kick" ? "Kick a Member" : "Transfer Ownership",
          action === "kick"
            ? "Select a member to disconnect from the channel."
            : "Select a member to hand over channel ownership to.",
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
    return;
  }

  // ── All remaining actions — defer the button (no new message), apply change,
  //    then edit the panel embed in-place + send ephemeral confirmation ────────
  await interaction.deferUpdate();

  if (action === "private") {
    await vc.permissionOverwrites.edit(guild.roles.everyone, { Connect: false, ViewChannel: false });
    for (const [, m] of vc.members) {
      if (!m.user.bot) await vc.permissionOverwrites.edit(m, { Connect: true, ViewChannel: true }).catch(() => {});
    }
    await interaction.followUp({ embeds: [successEmbed("Channel Private", `**${vc.name}** is now hidden — only current members can see and rejoin.`)], ephemeral: true });

  } else if (action === "ghost") {
    // Visible to everyone but only current members can connect
    await vc.permissionOverwrites.edit(guild.roles.everyone, { Connect: false, ViewChannel: null });
    for (const [, m] of vc.members) {
      if (!m.user.bot) await vc.permissionOverwrites.edit(m, { Connect: true, ViewChannel: true }).catch(() => {});
    }
    await interaction.followUp({ embeds: [successEmbed("Ghost Mode", `**${vc.name}** is visible but locked — no new members can join.`)], ephemeral: true });

  } else if (action === "public") {
    await vc.permissionOverwrites.edit(guild.roles.everyone, { Connect: null, ViewChannel: null });
    for (const [, m] of vc.members) {
      if (!m.user.bot) await vc.permissionOverwrites.delete(m).catch(() => {});
    }
    await interaction.followUp({ embeds: [successEmbed("Channel Public", `**${vc.name}** is now open — anyone can join.`)], ephemeral: true });

  } else if (action === "lock") {
    // Legacy button — lock to current headcount
    const limit = vc.members.filter((m) => !m.user.bot).size;
    await vc.setUserLimit(limit);
    await interaction.followUp({ embeds: [successEmbed("Channel Locked", `Slot limit set to **${limit}**.`)], ephemeral: true });

  } else if (action === "unlock") {
    // Legacy button — remove limit
    await vc.setUserLimit(0);
    await interaction.followUp({ embeds: [successEmbed("Channel Unlocked", "Slot limit removed — the channel is open to everyone.")], ephemeral: true });

  } else {
    // Unknown action — this should never happen in production but prevents a silent
    // interaction timeout if a new button was added without a matching handler
    await interaction.followUp({ embeds: [errorEmbed("Unknown Action", "This button action is not recognized.")], ephemeral: true });
    return;
  }

  await updateControlPanel(vcId, guild);
}

// ─── Modal submit handler ─────────────────────────────────────────────────────

export async function handlePanelModal(interaction) {
  const [, modalType, vcId] = interaction.customId.split(":");
  const guild = interaction.guild;
  const vc    = guild.channels.cache.get(vcId);

  if (!vc) {
    await interaction.reply({ embeds: [errorEmbed("Channel Not Found", "That voice channel no longer exists.")], ephemeral: true });
    return;
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  if (modalType === "rename") {
    const newName = interaction.fields.getTextInputValue("new_name").trim();
    if (!newName) {
      await interaction.reply({ embeds: [errorEmbed("Invalid Name", "Channel name can't be empty.")], ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      await vc.setName(newName);
      // Lock the auto-renamer for 30 minutes — respect the owner's choice
      manualRenames.set(vcId, Date.now());
      await interaction.editReply({
        embeds: [successEmbed("Channel Renamed", `Renamed to **${newName}**.\n-# Auto-rename paused for 30 minutes.`)],
      });
      await updateControlPanel(vcId, guild).catch(() => {});
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed("Rename Failed", err.message)] });
    }
    return;
  }

  // ── Custom limit ──────────────────────────────────────────────────────────
  if (modalType === "limit") {
    const raw    = interaction.fields.getTextInputValue("limit_value").trim();
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 99) {
      await interaction.reply({ embeds: [errorEmbed("Invalid Limit", "Enter a number between **0** (no limit) and **99**.")], ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      await vc.setUserLimit(parsed);
      const msg = parsed === 0 ? "Slot limit removed — anyone can join." : `Slot limit set to **${parsed}**.`;
      await interaction.editReply({ embeds: [successEmbed("Limit Updated", msg)] });
      await updateControlPanel(vcId, guild);
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed("Failed", err.message)] });
    }
    return;
  }

  // Fallback — prevents a silent timeout if a new modal was added without a handler
  await interaction.reply({ embeds: [errorEmbed("Unknown Modal", "This form submission is not recognized.")], ephemeral: true });
}

// ─── Select menu handler ──────────────────────────────────────────────────────

export async function handlePanelSelect(interaction) {
  const [, action, vcId] = interaction.customId.split(":");
  const guild    = interaction.guild;
  const caller   = interaction.member;
  const vc       = guild.channels.cache.get(vcId);
  const selected = interaction.values[0];

  // ── Limit picker ──────────────────────────────────────────────────────────
  if (action === "limit") {
    if (!vc) {
      await interaction.update({ embeds: [errorEmbed("Channel Gone", "That voice channel no longer exists.")], components: [] });
      return;
    }
    // "Custom" option → show a modal
    if (selected === "custom") {
      const modal = new ModalBuilder()
        .setCustomId(`vc_modal:limit:${vcId}`)
        .setTitle("Custom Slot Limit")
        .addComponents(
          /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("limit_value")
              .setLabel("Number of slots (0 = no limit, max 99)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("e.g. 7")
              .setMaxLength(2)
              .setRequired(true),
          )),
        );
      await interaction.showModal(modal);
      return;
    }
    // Preset selected — apply immediately
    await interaction.deferUpdate();
    try {
      const limit = parseInt(selected, 10);
      await vc.setUserLimit(limit);
      const msg = limit === 0 ? "Slot limit removed — anyone can join." : `Slot limit set to **${limit}**.`;
      await interaction.editReply({ embeds: [successEmbed("Limit Updated", msg)], components: [] });
      await updateControlPanel(vcId, guild);
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed("Failed", err.message)], components: [] });
    }
    return;
  }

  // ── Kick / Transfer ───────────────────────────────────────────────────────
  const targetId = selected;
  const target   = guild.members.cache.get(targetId);

  await interaction.deferReply({ ephemeral: true });

  if (!vc || !target) {
    await interaction.editReply({ embeds: [errorEmbed("Not Found", "Couldn't find that channel or member — they may have left.")] });
    return;
  }

  if (action === "kick") {
    if (!vc.members.has(target.id)) {
      await interaction.editReply({ embeds: [errorEmbed("Already Gone", `**${target.displayName}** has already left the channel.`)] });
      return;
    }
    const currentOwnerId = tempChannels.get(vcId);
    if (target.id === currentOwnerId) {
      await interaction.editReply({ embeds: [errorEmbed("Can't Kick Owner", "Transfer ownership first before removing the owner.")] });
      return;
    }
    await target.voice.disconnect(`Kicked from VC by ${caller.user.tag}`);
    await interaction.editReply({ embeds: [successEmbed("Member Kicked", `**${target.displayName}** has been removed.`)] });

  } else if (action === "transfer") {
    if (!vc.members.has(target.id)) {
      await interaction.editReply({ embeds: [errorEmbed("Not In Channel", `**${target.displayName}** must be in the channel to receive ownership.`)] });
      return;
    }
    try {
      // Update Discord permissions FIRST — if this fails we bail without touching state
      await vc.permissionOverwrites.edit(target, {
        ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true,
        ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true,
      });
      // Revoke old owner's elevated perms (best-effort — don't fail the whole transfer)
      await vc.permissionOverwrites.edit(caller, {
        ManageChannels: null, MoveMembers: null, MuteMembers: null, DeafenMembers: null,
      }).catch(() => {});
      // Discord updated — now sync in-memory state and DB
      tempChannels.set(vcId, target.id);
      manualRenames.delete(vcId); // new owner — let the auto-renamer pick up their game
      saveTempVc(vcId, { ownerId: target.id, guildId: guild.id, seq: tempVcSeq.get(vcId) ?? 1, textChannelId: tempTextChannels.get(vcId) ?? null });
      await interaction.editReply({ embeds: [successEmbed("Ownership Transferred", `**${target.displayName}** is now the channel owner.`)] });
      const { queueRename } = await import("./vcrenamer.js");
      queueRename(vc, guild);
      await updateControlPanel(vcId, guild);
    } catch (err) {
      await interaction.editReply({ embeds: [errorEmbed("Transfer Failed", `Couldn't update channel permissions: ${err.message}`)] });
    }
  }
}
