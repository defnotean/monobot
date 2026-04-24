import { errorEmbed } from "../utils/embeds.js";
import { log } from "../utils/logger.js";
import { getColorRoles } from "../database.js";
import { handlePanelInteraction, handlePanelModal, handlePanelSelect } from "../utils/vcpanel.js";
import { handleEmbedModal } from "../commands/utility/embed.js";
import { handleGiveawayButton } from "../commands/fun/giveaway.js";
import { handlePollButton } from "../commands/fun/polladvanced.js";
import { handleSetupWizard } from "../commands/setup/setup-wizard.js";
import { handleTicketWizard } from "../commands/setup/ticket.js";

export const name = "interactionCreate";

export async function execute(interaction) {
  // Buttons can't fire from DMs — guard upfront
  if ((interaction.isButton()) && !interaction.guild) {
    await interaction.reply({ content: "this only works in servers", flags: 64 }).catch(() => {});
    return;
  }

  // ── Music control panel buttons ──────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("music:")) {
    const [, action, guildId] = interaction.customId.split(":");
    // Dynamic import can be slow on first load — defer so the interaction doesn't expire
    const { getQueue, deleteQueue, playSong, buildNowPlayingPanel } = await import("../music/player.js");
    const queue = getQueue(guildId);

    if (!queue || !queue.player) {
      await interaction.reply({ content: "nothing is playing right now", flags: 64 }).catch(() => {});
      return;
    }

    // DJ + same-VC validation — mirror the slash command checks
    const { PermissionFlagsBits } = await import("discord.js");
    const botVc  = interaction.guild.members.cache.get(interaction.client.user.id)?.voice?.channel;
    const userVc = interaction.member?.voice?.channel;
    const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator)
      || interaction.member?.id === interaction.guild.ownerId;

    if (!isAdmin && (!userVc || userVc.id !== botVc?.id)) {
      await interaction.reply({ content: "you need to be in the same voice channel to use these controls", flags: 64 }).catch(() => {});
      return;
    }

    // DJ role check (skip for pause toggle — everyone should be able to pause)
    if (action !== "pause") {
      try {
        const { requireDj } = await import("../commands/music/dj.js");
        if (!(await requireDj(interaction))) return;
      } catch {}
    }

    try {
      switch (action) {
        case "pause": {
          const paused = queue.player.paused;
          queue.player.setPaused(!paused);
          // Update the panel to reflect new state
          const panel = buildNowPlayingPanel(queue);
          if (panel) await interaction.update(panel).catch(() => {});
          else await interaction.deferUpdate().catch(() => {});
          break;
        }
        case "skip": {
          const skipped = queue.songs[0]?.title ?? "current track";
          // Temporarily bypass loop for this skip — don't permanently disable it
          queue._skipOnce = true;
          queue.player.stopTrack();
          await interaction.reply({ content: `⏭ Skipped **${skipped}**`, flags: 64 }).catch(() => {});
          break;
        }
        case "stop": {
          deleteQueue(guildId);
          await interaction.update({ content: "⏹ Music stopped", embeds: [], components: [] }).catch(() => {});
          break;
        }
        case "loop": {
          // Cycle: off → song → queue → off
          if (!queue.looping && !queue.loopingQueue) {
            queue.looping = true; queue.loopingQueue = false;
            await interaction.reply({ content: "🔂 Looping current song", flags: 64 }).catch(() => {});
          } else if (queue.looping) {
            queue.looping = false; queue.loopingQueue = true;
            await interaction.reply({ content: "🔁 Looping entire queue", flags: 64 }).catch(() => {});
          } else {
            queue.looping = false; queue.loopingQueue = false;
            await interaction.reply({ content: "➡️ Loop disabled", flags: 64 }).catch(() => {});
          }
          // Update panel buttons
          const panel = buildNowPlayingPanel(queue);
          if (panel && queue.nowPlayingMsg) {
            await queue.nowPlayingMsg.edit(panel).catch(() => {});
          }
          break;
        }
        case "shuffle": {
          queue.shuffle = !queue.shuffle;
          if (queue.shuffle && queue.songs.length > 2) {
            const current = queue.songs[0];
            const rest = queue.songs.slice(1);
            for (let i = rest.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [rest[i], rest[j]] = [rest[j], rest[i]];
            }
            queue.songs = [current, ...rest];
          }
          await interaction.reply({ content: queue.shuffle ? "🔀 Shuffle on" : "➡️ Shuffle off", flags: 64 }).catch(() => {});
          const panel = buildNowPlayingPanel(queue);
          if (panel && queue.nowPlayingMsg) {
            await queue.nowPlayingMsg.edit(panel).catch(() => {});
          }
          break;
        }
        default:
          await interaction.deferUpdate().catch(() => {});
      }
    } catch (err) {
      log(`[MusicPanel] Button error: ${err.message}`);
      await interaction.reply({ content: `something went wrong — ${err.message}`, flags: 64 }).catch(() => {});
    }
    return;
  }

  // ── Bump reminder quick actions ──────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId.startsWith("bump_snooze_") || interaction.customId.startsWith("bump_mute_tonight_"))) {
    try {
      const hasPerm = interaction.memberPermissions?.has?.("ManageGuild")
        || interaction.memberPermissions?.has?.("Administrator");
      if (!hasPerm) {
        await interaction.reply({ content: "manage-server permission required", flags: 64 });
        return;
      }
      const { snoozeReminder, muteTonight } = await import("../ai/bumpReminder.js");
      if (interaction.customId.startsWith("bump_snooze_")) {
        const parts = interaction.customId.split("_");
        const minutes = parseInt(parts[2], 10) || 15;
        const serviceKey = parts.slice(3).join("_") || "disboard";
        const newAt = snoozeReminder(interaction.guild.id, serviceKey, minutes, interaction.client);
        const ts = Math.floor(newAt / 1000);
        await interaction.reply({ content: `snoozed ${minutes}m — next ping <t:${ts}:R>`, flags: 64 });
      } else {
        const quiet = muteTonight(interaction.guild.id);
        await interaction.reply({ content: `quiet hours set ${quiet.start}:00 → ${quiet.end}:00 (${quiet.tz}). no pings until morning.`, flags: 64 });
      }
    } catch (err) {
      log(`[BUMP] Button error: ${err.message}`);
      await interaction.reply({ content: `something went wrong — ${err.message}`, flags: 64 }).catch(() => {});
    }
    return;
  }

  // ── VC control panel buttons ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("vc_panel:")) {
    await handlePanelInteraction(interaction).catch((err) => {
      log(`[VCPanel] Button error: ${err.message}`);
    });
    return;
  }

  // ── VC control panel modals ───────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("vc_modal:")) {
    await handlePanelModal(interaction).catch((err) => {
      log(`[VCPanel] Modal error: ${err.message}`);
    });
    return;
  }

  // ── Embed builder modal ────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "embed_builder") {
    await handleEmbedModal(interaction).catch((err) => {
      log(`[Embed] Modal error: ${err.message}`);
    });
    return;
  }

  // ── Scrim Modals ──────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("scrim_modal:score:")) {
    const { activeScrims } = await import("../utils/scrims.js");
    const id = interaction.customId.split(":")[2];
    const scrim = activeScrims.get(id);
    if (scrim) {
       scrim.scoreStr = interaction.fields.getTextInputValue("score");
       await interaction.reply({ content: `✅ Match score updated to **${scrim.scoreStr}**!`, ephemeral: true });
    } else {
       await interaction.reply({ content: `Wait, this scrim lobby has expired.`, ephemeral: true });
    }
    return;
  }

  // ── VC control panel select menus ─────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("vc_select:")) {
    await handlePanelSelect(interaction).catch((err) => {
      log(`[VCPanel] Select error: ${err.message}`);
    });
    return;
  }

  // ── Giveaway buttons ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("giveaway_")) {
    await handleGiveawayButton(interaction).catch((err) => {
      log(`[Giveaway] Button error: ${err.message}`);
    });
    return;
  }

  // ── Setup wizard interactions ─────────────────────────────────────────────
  if ((interaction.isButton() || interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isStringSelectMenu())
      && interaction.customId?.startsWith("setupwiz:")) {
    await handleSetupWizard(interaction).catch((err) => {
      log(`[SetupWizard] ${err.message}`);
      interaction.reply({ content: `setup error: ${err.message}`, flags: 64 }).catch(() => {});
    });
    return;
  }

  // ── Ticket setup wizard interactions ──────────────────────────────────────
  // Buttons + role/channel selects + modal submits all share the ticketwiz:
  // prefix and are dispatched to handleTicketWizard.
  if ((interaction.isButton() || interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isModalSubmit?.())
      && interaction.customId?.startsWith("ticketwiz:")) {
    await handleTicketWizard(interaction).catch((err) => {
      log(`[TicketWizard] ${err.message}`);
      interaction.reply({ content: `ticket setup error: ${err.message}`, flags: 64 }).catch(() => {});
    });
    return;
  }

  // ── Mod action undo buttons ───────────────────────────────────────────────
  // Attached to ban/timeout/warn mod-log embeds. Only admins can click.
  if (interaction.isButton() && interaction.customId.startsWith("modundo:")) {
    await handleModUndo(interaction).catch((err) => {
      log(`[ModUndo] Button error: ${err.message}`);
      interaction.reply({ content: `undo failed: ${err.message}`, flags: 64 }).catch(() => {});
    });
    return;
  }

  // ── Scrim Match commands ──────────────────────────────────────────────────
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("scrim:")) {
    const { manageScrimInteraction } = await import("../utils/scrims.js");
    try {
      await manageScrimInteraction(interaction);
    } catch (err) {
      log(`[Scrim] Interactor failed: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
         await interaction.reply({ content: "Something went wrong managing this match.", ephemeral: true }).catch(()=>{});
      }
    }
    return;
  }

  // ── Poll buttons ─────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("poll_vote")) {
    await handlePollButton(interaction).catch((err) => {
      log(`[Poll] Button error: ${err.message}`);
    });
    return;
  }

  // ── Color role buttons ────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("color_role:")) {
    const roleId = interaction.customId.split(":")[1];
    const member = interaction.member;
    const guild = interaction.guild;

    // Defer immediately — role ops can take >3s and the interaction will expire
    try { await interaction.deferReply({ flags: 64 }); } catch { return; }

    const colorRoleIds = getColorRoles(guild.id);
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.editReply({ content: "that role doesn't exist anymore" }).catch(() => {});
      return;
    }

    try {
      const hasRole = member.roles.cache.has(roleId);

      // Remove all other color roles first
      const toRemove = member.roles.cache.filter(
        (r) => colorRoleIds.includes(r.id) && r.id !== roleId
      );
      if (toRemove.size) await member.roles.remove([...toRemove.keys()]);

      if (hasRole) {
        await member.roles.remove(roleId);
        await interaction.editReply({ content: `removed **${role.name}**` }).catch(() => {});
        log(`[ColorRole] ${member.user.tag} removed ${role.name}`);
      } else {
        await member.roles.add(roleId);
        await interaction.editReply({ content: `you're now **${role.name}**` }).catch(() => {});
        log(`[ColorRole] ${member.user.tag} picked ${role.name}`);
      }
    } catch (err) {
      log(`[ColorRole] error for ${member.user.tag}: ${err.message}`);
      await interaction.editReply({ content: "couldn't update your role — make sure the bot role is above the color roles" }).catch(() => {});
    }
    return;
  }

  // ── Toggle role buttons (ping roles, notification roles, etc.) ───────────
  if (interaction.isButton() && interaction.customId.startsWith("toggle_role:")) {
    const roleId = interaction.customId.split(":")[1];
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(roleId);

    // Defer immediately — if the interaction already expired (rapid clicks), just bail
    try { await interaction.deferReply({ flags: 64 }); } catch { return; }

    if (!role) {
      await interaction.editReply({ content: "that role doesn't exist anymore" }).catch(() => {});
      return;
    }
    try {
      const hasRole = member.roles.cache.has(roleId);
      if (hasRole) {
        await member.roles.remove(roleId);
        await interaction.editReply({ content: `removed **${role.name}**` }).catch(() => {});
        log(`[ToggleRole] ${member.user.tag} removed ${role.name}`);
      } else {
        await member.roles.add(roleId);
        await interaction.editReply({ content: `you now have **${role.name}**` }).catch(() => {});
        log(`[ToggleRole] ${member.user.tag} added ${role.name}`);
      }
    } catch (err) {
      log(`[ToggleRole] error for ${member.user.tag}: ${err.message}`);
      await interaction.editReply({ content: "couldn't update your role — make sure the bot role is above this role" }).catch(() => {});
    }
    return;
  }

  // ── Dropdown role picker (select menu) ─────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("dropdown_role:")) {
    const mode = interaction.customId.split(":")[1]; // "exclusive" or "multi"
    const selectedRoleIds = interaction.values;
    const member = interaction.member;
    const guild = interaction.guild;

    try { await interaction.deferReply({ flags: 64 }); } catch { return; }

    try {
      // Filter out deleted roles — dropdown options may reference roles that no longer exist
      const validSelected = selectedRoleIds.filter(id => guild.roles.cache.has(id));
      const invalidCount = selectedRoleIds.length - validSelected.length;

      if (mode === "exclusive") {
        // Exclusive: remove all dropdown roles, add only the selected one
        const allOptionIds = interaction.component.options.map(o => o.value).filter(id => guild.roles.cache.has(id));
        const toRemove = member.roles.cache.filter(r => allOptionIds.includes(r.id) && !validSelected.includes(r.id));
        if (toRemove.size) await member.roles.remove([...toRemove.keys()]);
        if (validSelected.length) {
          if (!member.roles.cache.has(validSelected[0])) await member.roles.add(validSelected[0]);
          const roleName = guild.roles.cache.get(validSelected[0])?.name || "unknown";
          const warning = invalidCount ? ` (${invalidCount} role${invalidCount > 1 ? "s" : ""} no longer exist${invalidCount > 1 ? "" : "s"})` : "";
          await interaction.editReply({ content: `you're now **${roleName}**${warning}` }).catch(() => {});
          log(`[DropdownRole] ${member.user.tag} picked ${roleName} (exclusive)`);
        } else {
          await interaction.editReply({ content: "that role doesn't exist anymore — ask an admin to redo this dropdown" }).catch(() => {});
        }
      } else {
        // Multi-select: sync roles to match selection
        const added = [];
        const removed = [];
        const allOptionIds = interaction.component.options.map(o => o.value).filter(id => guild.roles.cache.has(id));
        for (const roleId of validSelected) {
          if (!member.roles.cache.has(roleId)) {
            await member.roles.add(roleId);
            added.push(guild.roles.cache.get(roleId)?.name || roleId);
          }
        }
        for (const optionId of allOptionIds) {
          if (!validSelected.includes(optionId) && member.roles.cache.has(optionId)) {
            await member.roles.remove(optionId);
            removed.push(guild.roles.cache.get(optionId)?.name || optionId);
          }
        }
        const parts = [];
        if (added.length) parts.push(`added: **${added.join(", ")}**`);
        if (removed.length) parts.push(`removed: **${removed.join(", ")}**`);
        if (invalidCount) parts.push(`(${invalidCount} role${invalidCount > 1 ? "s" : ""} no longer exist${invalidCount > 1 ? "" : "s"})`);
        await interaction.editReply({ content: parts.length ? parts.join(" · ") : "no changes" }).catch(() => {});
        log(`[DropdownRole] ${member.user.tag} updated roles — +${added.length} -${removed.length}`);
      }
    } catch (err) {
      log(`[DropdownRole] error for ${member.user.tag}: ${err.message}`);
      await interaction.editReply({ content: "couldn't update your roles — make sure the bot role is above these roles" }).catch(() => {});
    }
    return;
  }

  // ── Legacy inert buttons from send_message ───────────────────────────────
  // send_message used to mint customIds like `btn:<ts>:<idx>` for any button
  // that wasn't a role-toggle or a link — nothing routed them, so clicks
  // showed "This interaction failed" after the 3s timeout. If the button OR
  // its surrounding embed hints at ticket-open intent, wire it through to
  // the ticket_create handler so already-posted panels start working without
  // needing a re-post. Any remaining inert btn:* / btn_inert:* is ack'd
  // silently so users don't see the red failure. Read .component.label BEFORE
  // rewriting customId — the .component getter resolves via this.customId.
  if (interaction.isButton() && (interaction.customId.startsWith("btn:") || interaction.customId.startsWith("btn_inert:"))) {
    const label = (interaction.component?.label || "").toLowerCase();
    const embed = interaction.message?.embeds?.[0];
    const embedText = [embed?.title, embed?.description].filter(Boolean).join(" ").toLowerCase();
    const labelMatch  = /ticket|support|get.*help|contact.*(?:staff|us|mod|support)|🎫/.test(label);
    // Embed-based backup: if the surrounding embed clearly talks about opening
    // a ticket, treat any inert button on that embed as a ticket button. This
    // catches cases where the button label is vague ("click here", an emoji).
    // Match "ticket" / "tickets" / "ticketing" — word-boundary "\\bticket\\b"
    // would miss plurals, which is what Irene usually writes ("Support Tickets").
    const embedMatch  = /ticket/.test(embedText) && /\b(open|create|new|click|press|hit|submit)\b/.test(embedText);
    if (labelMatch || embedMatch) {
      // customId is a plain writable property on MessageComponentInteraction
      // (see discord.js v14 src/structures/MessageComponentInteraction.js:36).
      // defineProperty is a defensive fallback in case a future version makes
      // it a getter.
      try { interaction.customId = "ticket_create"; } catch {}
      if (interaction.customId !== "ticket_create") {
        try { Object.defineProperty(interaction, "customId", { value: "ticket_create", configurable: true, writable: true }); } catch {}
      }
      // Fall through to the ticket handler below.
    } else {
      await interaction.deferUpdate().catch(() => {});
      log(`[Button] Inert button clicked (customId=${interaction.customId}, label="${label}") — acked silently`);
      return;
    }
  }

  // ── Ticket buttons ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("ticket_")) {
    const action = interaction.customId.split(":")[0];
    if (action === "ticket_create") {
      // Defer FIRST — channel create + send can exceed Discord's 3s window.
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      try {
        const { ChannelType, PermissionFlagsBits, EmbedBuilder } = await import("discord.js");
        const { getTicketConfig, resolveTicketRoles } = await import("../database.js");
        const { errorEmbed } = await import("../utils/embeds.js");
        const cfg = getTicketConfig(interaction.guild.id);

        // Parse the optional type key from the customId (ticket_create:<key>).
        // If it matches a configured type AND that type has a valid category,
        // use the type's category. Otherwise fall back to the global
        // ticket_category_id. This way a panel button from BEFORE the types
        // feature (customId "ticket_create" only) still works, and a type
        // whose category got deleted quietly falls back rather than erroring.
        const typeKey  = (interaction.customId.split(":")[1] || "").toLowerCase() || null;
        const pickedType = typeKey && Array.isArray(cfg.types) ? cfg.types.find((t) => t.key === typeKey) : null;
        const typeCategoryId = pickedType?.category_id && interaction.guild.channels.cache.get(pickedType.category_id) ? pickedType.category_id : null;
        const effectiveCategoryId = typeCategoryId || cfg.category_id;
        if (!effectiveCategoryId) return interaction.editReply({ embeds: [errorEmbed("Not Configured", "Ticket system hasn't been set up yet. An admin should run `/ticket setup`.")] }).catch(() => {});

        // Prevent duplicate open tickets for the same user IN THE SAME CATEGORY.
        // Opening one support ticket + one appeal ticket is fine; two support
        // tickets is not.
        const typePrefix = pickedType ? `${pickedType.key}-` : "";
        const safeName = `${typePrefix}ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
        const existing = interaction.guild.channels.cache.find(c => c.name === safeName && c.parentId === effectiveCategoryId);
        if (existing) return interaction.editReply({ content: `You already have an open ticket: ${existing}` }).catch(() => {});

        // Defaults: only the opener + bot get channel access. The ticket
        // channel inherits whatever perms the admin configured on the parent
        // category. Explicit view/ping IDs are opt-in; auto_category is an
        // opt-in DYNAMIC layer — roles in that category are resolved fresh
        // here so a role added AFTER setup still shows up automatically.
        const { view_role_ids: viewRoleIds, ping_role_ids: pingRoleIds } = await resolveTicketRoles(interaction.guild);

        const overwrites = [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        ];
        for (const roleId of viewRoleIds) {
          overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }

        const ticketCh = await interaction.guild.channels.create({
          name: safeName,
          type: ChannelType.GuildText,
          parent: effectiveCategoryId,
          permissionOverwrites: overwrites,
          reason: `Ticket opened by ${interaction.user.tag}${pickedType ? ` (type: ${pickedType.label})` : ""}`,
        });

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim").setStyle(ButtonStyle.Primary).setEmoji("🙋"),
          new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setEmoji("🔒"),
        );

        // Welcome embed — default text/color unless admin overrode them.
        // `{user}` substitutes to the opener's mention; `{type}` substitutes
        // to the picked type's label if one was chosen.
        const typeLabel = pickedType?.label || "";
        const defaultTitle = pickedType ? `🎫 ${pickedType.label}` : "🎫 Ticket Opened";
        const defaultDesc  = `${interaction.user}, describe your issue and someone will be with you shortly.`;
        const welcomeTitle = (cfg.welcome_title || defaultTitle).replace(/\{type\}/g, typeLabel);
        const welcomeDesc  = (cfg.welcome_description || defaultDesc)
          .replace(/\{user\}/g, `<@${interaction.user.id}>`)
          .replace(/\{type\}/g, typeLabel);
        const welcomeColor = typeof cfg.welcome_color === "number" ? cfg.welcome_color : 0x5865F2;
        const welcomeEmbed = new EmbedBuilder().setColor(welcomeColor).setTitle(welcomeTitle).setDescription(welcomeDesc);

        const pingContent = pingRoleIds.length ? pingRoleIds.map((id) => `<@&${id}>`).join(" ") : undefined;
        await ticketCh.send({
          content: pingContent,
          allowedMentions: { users: [interaction.user.id], roles: pingRoleIds },
          embeds: [welcomeEmbed],
          components: [row],
        });
        await interaction.editReply({ content: `Ticket created: ${ticketCh}` }).catch(() => {});
      } catch (err) {
        log(`[Ticket] Create error: ${err.message}`);
        await interaction.editReply({ content: `Failed to create ticket: ${err.message}` }).catch(() => {});
      }
    } else if (action === "ticket_close") {
      try {
        const { PermissionFlagsBits } = await import("discord.js");
        const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
          || interaction.channel.name.includes(interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, ""));
        if (!hasPerms) return interaction.reply({ content: "Only the ticket owner or staff can close this ticket.", ephemeral: true });

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
        const { warnEmbed } = await import("../utils/embeds.js");
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_confirm_close").setLabel("Confirm Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("ticket_cancel_close").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        );
        await interaction.reply({ embeds: [warnEmbed("Close Ticket?", "This will permanently delete this channel and all messages.")], components: [confirmRow] });
      } catch (err) {
        log(`[Ticket] Close error: ${err.message}`);
      }
    } else if (action === "ticket_confirm_close") {
      try {
        await interaction.reply({ content: "🔒 Closing ticket in 3 seconds..." });
        setTimeout(async () => {
          await interaction.channel?.delete("Ticket closed by " + interaction.user.tag).catch(() => {});
        }, 3000);
      } catch (err) {
        log(`[Ticket] Confirm close error: ${err.message}`);
      }
    } else if (action === "ticket_cancel_close") {
      await interaction.update({ content: "Ticket close cancelled.", embeds: [], components: [] }).catch(() => {});
    } else if (action === "ticket_claim") {
      try {
        const { PermissionFlagsBits } = await import("discord.js");
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({ content: "Only staff members can claim tickets.", ephemeral: true });
        }
        const { successEmbed } = await import("../utils/embeds.js");
        // Grant the claimer explicit permissions and pin them to the ticket
        await interaction.channel.permissionOverwrites.edit(interaction.user, { ViewChannel: true, SendMessages: true }).catch(() => {});
        await interaction.channel.setTopic(`Claimed by ${interaction.user.tag}`).catch(() => {});
        await interaction.reply({ embeds: [successEmbed("Ticket Claimed", `This ticket is now being handled by **${interaction.user.tag}**`)] });
      } catch (err) {
        log(`[Ticket] Claim error: ${err.message}`);
      }
    }
    return;
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    log(`Command error [${interaction.commandName}]: ${error.message}`);
    console.error(error);

    const reply = {
      embeds: [errorEmbed("Error", "Something went wrong executing that command.")],
      flags: 64,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

// ─── Mod-action undo handler ────────────────────────────────────────────────
// Buttons attached to ban/timeout/warn mod-log embeds. One-click reversal for
// admins. Only admins can click; updates the original embed in-place to
// strike through the action and show who reversed it.
async function handleModUndo(interaction) {
  const { PermissionFlagsBits } = await import("discord.js");

  // Only accept buttons the bot itself posted — prevents customId spoofing
  // via user-crafted embeds/webhooks.
  if (interaction.message?.author?.id !== interaction.client.user.id) {
    return interaction.reply({ content: "this button isn't from me", flags: 64 }).catch(() => {});
  }

  // Idempotency — once a successful undo strips the components, a second
  // clicker (if somehow they can still see the button) sees no components.
  if (!interaction.message?.components?.length) {
    return interaction.reply({ content: "already reversed", flags: 64 }).catch(() => {});
  }

  const parts = (interaction.customId || "").split(":");
  const [prefix, kind, targetId, extra] = parts;
  if (prefix !== "modundo" || !kind || !targetId) {
    return interaction.reply({ content: "malformed undo button", flags: 64 }).catch(() => {});
  }
  if (!/^\d{17,20}$/.test(targetId) && kind !== "warn") {
    return interaction.reply({ content: "invalid target id", flags: 64 }).catch(() => {});
  }

  // Authorize — must have ban/kick/moderate members perms, or be admin
  const member = interaction.member;
  const isAdmin = member?.permissions?.has?.(PermissionFlagsBits.Administrator)
               || member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
               || member?.permissions?.has?.(PermissionFlagsBits.BanMembers);
  if (!isAdmin) {
    return interaction.reply({ content: "only admins can reverse mod actions", flags: 64 }).catch(() => {});
  }

  try { await interaction.deferReply({ flags: 64 }); }
  catch (err) { if (err?.code === 10062 || err?.code === 40060) return; throw err; }

  const guild = interaction.guild;
  const reason = `Reversed via mod-log by ${interaction.user.tag}`;
  let result;
  let noop = false;

  try {
    if (kind === "ban") {
      const ban = await guild.bans.fetch(targetId).catch(() => null);
      if (!ban) { result = `that user isn't banned anymore`; noop = true; }
      else {
        await guild.members.unban(targetId, reason);
        result = `unbanned ${ban.user.tag}`;
      }
    } else if (kind === "timeout") {
      const target = await guild.members.fetch(targetId).catch(() => null);
      if (!target) { result = "that member isn't in the server anymore"; noop = true; }
      else if (!target.isCommunicationDisabled()) { result = `${target.user.tag} isn't timed out`; noop = true; }
      else {
        await target.timeout(null, reason);
        result = `removed timeout from ${target.user.tag}`;
      }
    } else if (kind === "mute") {
      const target = await guild.members.fetch(targetId).catch(() => null);
      if (!target) { result = "that member isn't in the server anymore"; noop = true; }
      else {
        const { getGuildSettings } = await import("../database.js");
        const gs = getGuildSettings(guild.id) || {};
        let muteRole = gs.mute_role_id ? guild.roles.cache.get(gs.mute_role_id) : null;
        if (!muteRole) muteRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "muted");
        if (!muteRole || !target.roles.cache.has(muteRole.id)) { result = `${target.user.tag} isn't muted`; noop = true; }
        else {
          await target.roles.remove(muteRole, reason);
          result = `unmuted ${target.user.tag}`;
        }
      }
    } else if (kind === "warn") {
      const warnId = Number(extra);
      if (!Number.isInteger(warnId) || warnId <= 0) {
        return interaction.editReply({ content: "invalid warning id" }).catch(() => {});
      }
      const { deleteWarning } = await import("../database.js");
      const { changes } = deleteWarning(warnId, guild.id);
      result = changes ? `removed warning #${warnId}` : `warning #${warnId} is already gone`;
      if (!changes) noop = true;
    } else {
      return interaction.editReply({ content: `unknown undo kind: ${kind}` }).catch(() => {});
    }
  } catch (err) {
    return interaction.editReply({ content: `couldn't undo: ${err.message}` }).catch(() => {});
  }

  // Edit the original message: strike-through description + remove buttons.
  // Preserve newlines (strike-through does work across lines inside one ~~ block).
  try {
    const original = interaction.message;
    const embed = original.embeds?.[0];
    if (embed) {
      const { EmbedBuilder } = await import("discord.js");
      const clone = EmbedBuilder.from(embed);
      const oldDesc = embed.description || "";
      const safeDesc = oldDesc.slice(0, 3800);
      const tag = noop
        ? `ℹ️ Already reversed before click (clicked by <@${interaction.user.id}>) · ${result}`
        : `✅ **Reversed** by <@${interaction.user.id}> · ${result}`;
      clone.setDescription(`~~${safeDesc}~~\n\n${tag}`);
      await original.edit({ embeds: [clone], components: [] })
        .catch((err) => log(`[ModUndo] strike-through edit failed: ${err?.message || err}`));
    }
  } catch (err) {
    log(`[ModUndo] strike-through crash: ${err?.message || err}`);
  }

  await interaction.editReply({ content: `✅ ${result}` }).catch(() => {});
}
