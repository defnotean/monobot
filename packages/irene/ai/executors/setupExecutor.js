// ─── Setup / Server Settings Executor ───────────────────────────────────────

import { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from "discord.js";
import { setWelcomeChannel, setLogChannel, setAutorole, setAccessRole, setDmResults, setStatsChannels, addReactionRole, removeReactionRole, setStarboard, setColorRoles, getGuildSettings, getPatchFeeds, setPatchFeeds, getTwitchConfig, setTwitchConfig } from "../../database.js";
import { KNOWN_FEEDS } from "../../utils/patchbot.js";
import { log } from "../../utils/logger.js";
import { isGuildCategory } from "../../utils/channelTypes.js";

const HANDLED = new Set([
  "set_welcome_channel", "set_access_role", "setup_verification",
  "set_log_channel", "set_autorole", "set_dm_results",
  "configure_patch_news", "configure_twitch", "configure_youtube",
  "configure_github", "setup_ticket", "setup_stats_channels",
  "setup_reaction_roles", "setup_starboard", "add_reaction_role",
  "remove_reaction_role", "setup_role_picker", "setup_dropdown_roles", "setup_color_roles",
  "toggle_seasonal_colors", "preview_seasonal_palette", "force_seasonal_rotation",
  "set_ghost_ping_channels",
  "sticky_message", "remove_sticky",
  "list_roles_by_category",
  "learn_rules_from_channel",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, by, findChannel, findRole, findRoles, findMember } = ctx;

  switch (toolName) {
    case "set_welcome_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      setWelcomeChannel(guild.id, ch.id, input.welcome_message || null);
      return `Welcome channel set to #${ch.name}`;
    }

    case "set_access_role": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      setAccessRole(guild.id, role.id);
      return `Done — anyone who uses me will now automatically get the "${role.name}" role`;
    }

    case "setup_verification": {
      // Pre-check permissions
      if (!guild.members.me.permissions.has("ManageRoles")) return "i need the **Manage Roles** permission to set up verification";
      if (!guild.members.me.permissions.has("ManageChannels")) return "i need the **Manage Channels** permission to lock down channels";

      // Find or validate the verified role
      const roleName = input.verified_role;
      let verRole = findRole(guild, roleName);
      if (!verRole) {
        try {
          verRole = await guild.roles.create({ name: roleName, reason: "Verification system setup by Irene" });
        } catch (e) {
          return `couldn't find or create role "${roleName}": ${e.message}`;
        }
      }

      // Check role hierarchy — bot must be above the verified role
      const botTop = guild.members.me.roles.highest.position;
      if (verRole.position >= botTop) {
        return `the role **@${verRole.name}** is higher than my role in the hierarchy — move it below my role in Server Settings > Roles, then try again`;
      }

      // Parse public channels — use partial/fuzzy matching for decorated channel names
      const publicNames = (input.public_channels || "rules, verification, welcome, verify, entrance")
        .split(",").map(s => s.trim().toLowerCase().replace(/^#/, "")).filter(Boolean);

      const publicChannelIds = [];
      for (const name of publicNames) {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === name)
          || guild.channels.cache.find(c => c.name.toLowerCase().includes(name));
        if (ch && !publicChannelIds.includes(ch.id)) publicChannelIds.push(ch.id);
      }

      // Also auto-detect: any channel with "rule", "verif", "welcome", "entrance" in the name
      const autoDetectKeywords = ["rule", "verif", "welcome", "entrance", "intro"];
      for (const ch of guild.channels.cache.values()) {
        if (isGuildCategory(ch)) continue;
        const lower = ch.name.toLowerCase();
        if (autoDetectKeywords.some(k => lower.includes(k)) && !publicChannelIds.includes(ch.id)) {
          publicChannelIds.push(ch.id);
        }
      }

      // Save to database
      const { setVerificationRole, setPublicChannels } = await import("../../database.js");
      setVerificationRole(guild.id, verRole.id);
      setPublicChannels(guild.id, publicChannelIds);

      // Lockdown runs in background to avoid AI response timeout
      const lockdownChannel = message.channel;

      // Fire and forget — runs in background after tool returns
      (async () => {
        let locked = 0;
        let kept = 0;
        let failed = 0;

        async function lockChannel(channel, isPublic) {
          try {
            if (isPublic) {
              await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true, SendMessages: false });
              await channel.permissionOverwrites.edit(verRole, { ViewChannel: true, SendMessages: true });
              kept++;
            } else {
              await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
              await channel.permissionOverwrites.edit(verRole, { ViewChannel: true });
              locked++;
            }
          } catch { failed++; }
          await new Promise(r => setTimeout(r, 300));
        }

        // First: lock ALL categories
        for (const ch of guild.channels.cache.values()) {
          if (!isGuildCategory(ch)) continue;
          const children = ch.children?.cache;
          const allPublic = children?.size > 0 && children.every(c => publicChannelIds.includes(c.id));
          await lockChannel(ch, allPublic);
        }

        // Second: lock ALL individual channels
        for (const ch of guild.channels.cache.values()) {
          if (isGuildCategory(ch) || ch.isThread?.()) continue;
          if (!ch.permissionsFor?.(guild.members.me)?.has("ManageChannels")) { failed++; continue; }
          await lockChannel(ch, publicChannelIds.includes(ch.id));
        }

        // Post summary when done
        try {
          await lockdownChannel.send([
            `✅ **verification lockdown complete!**`,
            `🔒 locked **${locked}** channels/categories`,
            `🔓 kept **${kept}** channels public`,
            failed > 0 ? `⚠️ couldn't modify ${failed} channels` : "",
            "unverified users can only see public channels now",
          ].filter(Boolean).join("\n"));
        } catch {}
      })().catch(e => log(`[Verification] Lockdown error: ${e.message}`));

      const summary = [
        `✅ verification role set to **@${verRole.name}**`,
        `🔒 locking down all channels now... this takes a moment`,
        `🔓 keeping public: ${publicNames.map(n => `#${n}`).join(", ")}`,
        "",
        "i'll post a summary when the lockdown is complete",
        "created VCs will also be locked to verified users only",
      ];

      return summary.join("\n");
    }

    case "set_log_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      setLogChannel(guild.id, ch.id);
      return `Mod log channel set to #${ch.name}`;
    }

    case "set_autorole": {
      const name = input.role_name?.toLowerCase().trim();
      if (!name || ["none", "off", "disable", "disabled", "remove", "clear"].includes(name)) {
        setAutorole(guild.id, null);
        return "Auto-role **disabled** — new members won't get a role automatically";
      }
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      if (role.position >= guild.members.me.roles.highest.position) {
        return `can't use **@${role.name}** as autorole — it's higher than my role in the hierarchy. move it below my role in Server Settings > Roles`;
      }
      setAutorole(guild.id, role.id);
      return `Auto-role set to **${role.name}** — new members will get this role when they join`;
    }

    case "set_dm_results": {
      setDmResults(guild.id, input.enabled);
      return input.enabled
        ? "DM results **enabled** — users will get a DM with tool results after commands are used"
        : "DM results **disabled** — no more DMs, everything stays in the channel";
    }

    case "configure_patch_news": {
      const config = getPatchFeeds(guild.id);

      if (input.list) {
        if (!config.feeds?.length) return "No patch feeds configured yet.";
        const channel = config.channel_id ? guild.channels.cache.get(config.channel_id) : null;
        const globalPingNames = (config.ping_role_ids ?? []).map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
        const lines = config.feeds.map((f) => {
          const feedPingNames = (f.ping_role_ids ?? []).map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
          const pingText = feedPingNames.length ? ` (pings: @${feedPingNames.join(", @")})` : "";
          return `- **${f.name}**${pingText}`;
        });
        return `Patch news channel: ${channel ? `#${channel.name}` : "not set"}${globalPingNames.length ? `\nDefault ping roles: ${globalPingNames.map((n) => `@${n}`).join(", ")}` : ""}\nFeeds:\n${lines.join("\n")}`;
      }

      if (input.channel_name) {
        const channel = findChannel(guild, input.channel_id || input.channel_name);
        if (!channel) return `Channel #${input.channel_name} not found`;
        config.channel_id = channel.id;
      }

      if (input.add_feed) {
        const key = input.add_feed.toLowerCase().trim();
        const known = KNOWN_FEEDS[key];
        if (known) {
          if (config.feeds?.some((f) => f.name === known.name)) return `${known.name} is already added.`;
          if (!config.feeds) config.feeds = [];
          const feedEntry = { name: known.name, color: known.color };
          if (known.type === "riot") feedEntry.type = "riot";
          else if (known.type === "cs2") feedEntry.type = "cs2";
          else feedEntry.url = known.url;
          if (input.feed_ping_roles) {
            const feedRoleIds = findRoles(guild, input.feed_ping_roles);
            if (feedRoleIds.length) feedEntry.ping_role_ids = feedRoleIds;
          }
          config.feeds.push(feedEntry);
        } else if (input.add_feed.startsWith("http")) {
          if (config.feeds?.some((f) => f.url === input.add_feed)) return "That feed URL is already added.";
          if (!config.feeds) config.feeds = [];
          const feedEntry = { name: input.add_feed.replace(/https?:\/\//, "").split("/")[0], url: input.add_feed, color: 0x5865F2 };
          if (input.feed_ping_roles) {
            const feedRoleIds = findRoles(guild, input.feed_ping_roles);
            if (feedRoleIds.length) feedEntry.ping_role_ids = feedRoleIds;
          }
          config.feeds.push(feedEntry);
        } else {
          return `Unknown feed "${input.add_feed}". Available: ${Object.keys(KNOWN_FEEDS).join(", ")} — or provide a custom RSS URL.`;
        }
      }

      if (input.remove_feed) {
        const lower = input.remove_feed.toLowerCase();
        const before = config.feeds?.length ?? 0;
        config.feeds = (config.feeds ?? []).filter((f) => f.name.toLowerCase() !== lower && f.url !== input.remove_feed);
        if ((config.feeds?.length ?? 0) === before) return `Feed "${input.remove_feed}" not found in configured feeds.`;
      }

      if (input.ping_roles) {
        const roleIds = findRoles(guild, input.ping_roles);
        if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
        config.ping_role_ids = roleIds;
      }

      setPatchFeeds(guild.id, config);
      const parts = [];
      if (input.channel_name) parts.push(`Channel set to #${input.channel_name}`);
      if (input.add_feed) parts.push(`Added feed: ${input.add_feed}`);
      if (input.remove_feed) parts.push(`Removed feed: ${input.remove_feed}`);
      if (input.ping_roles) parts.push(`Ping roles set to: ${input.ping_roles}`);
      if (input.feed_ping_roles) parts.push(`Feed-specific ping roles: ${input.feed_ping_roles}`);
      return parts.length ? parts.join("\n") : "Patch news config updated.";
    }

    case "configure_twitch": {
      const twitchConfig = getTwitchConfig(guild.id);

      // ── Test notification ──────────────────────────────────────────────
      if (input.test) {
        if (!twitchConfig.channel_id) return "Set a notification channel first (use channel_name).";
        const channel = guild.channels.cache.get(twitchConfig.channel_id);
        if (!channel) return "The configured notification channel no longer exists.";

        const username = input.test.toLowerCase().trim();
        const embed = new EmbedBuilder()
          .setColor(0x9146FF)
          .setAuthor({ name: `${username} is now LIVE on Twitch!` })
          .setTitle("\ud83c\udfae Playing some games with chat! (TEST NOTIFICATION)")
          .setURL(`https://twitch.tv/${username}`)
          .addFields(
            { name: "Game", value: "Just Chatting", inline: true },
            { name: "Viewers", value: "142", inline: true },
          )
          .setFooter({ text: "\u26a0\ufe0f This is a test notification \u2014 not a real stream" })
          .setTimestamp();

        const testPingIds = twitchConfig.ping_role_ids?.length ? twitchConfig.ping_role_ids : (twitchConfig.ping_role_id ? [twitchConfig.ping_role_id] : []);
        const content = testPingIds.length ? `${testPingIds.map((id) => `<@&${id}>`).join(" ")} *(test \u2014 no actual ping sent)*` : "";

        await channel.send({ content: content || undefined, embeds: [embed] }).catch(() => {});
        return `\u2705 Sent a test Twitch notification for **${username}** in <#${channel.id}>`;
      }

      if (input.list) {
        if (!twitchConfig.streamers?.length) return "No Twitch streamers configured yet.";
        const channel = twitchConfig.channel_id ? guild.channels.cache.get(twitchConfig.channel_id) : null;
        const defaultRoleIds = twitchConfig.ping_role_ids?.length ? twitchConfig.ping_role_ids : (twitchConfig.ping_role_id ? [twitchConfig.ping_role_id] : []);
        const defaultRoleNames = defaultRoleIds.map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
        const lines = twitchConfig.streamers.map((s) => {
          const streamerRoles = twitchConfig.streamer_roles?.[s];
          const streamerRoleIds = Array.isArray(streamerRoles) ? streamerRoles : (streamerRoles ? [streamerRoles] : []);
          const streamerRoleNames = streamerRoleIds.map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
          const roleText = streamerRoleNames.length ? ` \u2192 pings @${streamerRoleNames.join(", @")}` : (defaultRoleNames.length ? ` \u2192 pings @${defaultRoleNames.join(", @")} (default)` : "");
          return `- **${s}**${roleText}`;
        });
        return `Twitch notifications channel: ${channel ? `#${channel.name}` : "not set"}${defaultRoleNames.length ? `\nDefault ping roles: ${defaultRoleNames.map((n) => `@${n}`).join(", ")}` : ""}\nStreamers:\n${lines.join("\n")}`;
      }

      if (input.channel_name) {
        const channel = findChannel(guild, input.channel_id || input.channel_name);
        if (!channel) return `Channel #${input.channel_name} not found`;
        twitchConfig.channel_id = channel.id;
      }

      if (twitchConfig.streamers) {
        twitchConfig.streamers = twitchConfig.streamers.filter((s) => s && s.trim().length > 0);
      }

      if (input.add_streamer) {
        const username = input.add_streamer.toLowerCase().trim();
        if (!username) return "that doesn't look like a valid username";
        if (!twitchConfig.streamers) twitchConfig.streamers = [];
        if (twitchConfig.streamers.includes(username)) return `${username} is already being watched.`;
        twitchConfig.streamers.push(username);

        const streamerRolesInput = input.streamer_ping_roles || input.streamer_ping_role;
        if (streamerRolesInput) {
          const roleIds = findRoles(guild, streamerRolesInput);
          if (roleIds.length) {
            if (!twitchConfig.streamer_roles) twitchConfig.streamer_roles = {};
            twitchConfig.streamer_roles[username] = roleIds;
          }
        }
      }

      if (input.remove_streamer) {
        const username = input.remove_streamer.toLowerCase().trim();
        const before = twitchConfig.streamers?.length ?? 0;
        twitchConfig.streamers = (twitchConfig.streamers ?? []).filter((s) => s !== username);
        if ((twitchConfig.streamers?.length ?? 0) === before) return `Streamer "${username}" not found in the list.`;
        if (twitchConfig.streamer_roles?.[username]) delete twitchConfig.streamer_roles[username];
      }

      if (input.ping_roles) {
        const roleIds = findRoles(guild, input.ping_roles);
        if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
        twitchConfig.ping_role_ids = roleIds;
        twitchConfig.ping_role_id = roleIds[0];
      } else if (input.ping_role) {
        const role = findRole(guild, input.ping_role);
        if (!role) return `Role "${input.ping_role}" not found`;
        twitchConfig.ping_role_id = role.id;
        twitchConfig.ping_role_ids = [role.id];
      }

      if (input.auto_detect !== undefined) {
        twitchConfig.auto_detect = !!input.auto_detect;
      }

      setTwitchConfig(guild.id, twitchConfig);
      const parts = [];
      if (input.channel_name) parts.push(`Channel set to #${input.channel_name}`);
      if (input.add_streamer) {
        parts.push(`Now watching: ${input.add_streamer}`);
        const spr = input.streamer_ping_roles || input.streamer_ping_role;
        if (spr) parts.push(`  \u2192 pings @${spr} when they go live`);
      }
      if (input.remove_streamer) parts.push(`Removed: ${input.remove_streamer}`);
      if (input.ping_roles) parts.push(`Default ping roles set to: ${input.ping_roles}`);
      else if (input.ping_role) parts.push(`Default ping role set to @${input.ping_role}`);
      if (input.auto_detect !== undefined) parts.push(`Auto-detect streaming: **${twitchConfig.auto_detect ? "enabled" : "disabled"}** — ${twitchConfig.auto_detect ? "will notify when anyone in the server goes live" : "only watching manually added streamers"}`);
      return parts.length ? parts.join("\n") : "Twitch config updated.";
    }

    case "configure_youtube": {
      const { getYoutubeConfig, setYoutubeConfig } = await import("../../database.js");
      const { addYoutubeFeed, removeYoutubeFeed } = await import("../../utils/youtube.js");
      const configs = getYoutubeConfig(guild.id);

      if (input.list) {
        if (!configs.length) return "No YouTube feeds configured yet.";
        const lines = configs.map((f) => {
          const ch = guild.channels.cache.get(f.discordChannelId);
          const pingNames = (f.ping_role_ids ?? []).map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
          const pingText = pingNames.length ? ` (pings: @${pingNames.join(", @")})` : "";
          return `- **${f.youtubeChannelId}** → #${ch?.name ?? "unknown"}${pingText}`;
        });
        return `YouTube feeds:\n${lines.join("\n")}`;
      }

      if (input.add_channel) {
        if (!input.channel_name) return "Please also specify channel_name (the Discord channel to post in).";
        const ch = findChannel(guild, input.channel_id || input.channel_name);
        if (!ch) return `Channel #${input.channel_name} not found`;
        const result = addYoutubeFeed(guild.id, input.add_channel, ch.id);
        if (!result.success) return result.error;

        if (input.ping_roles) {
          const roleIds = findRoles(guild, input.ping_roles);
          if (roleIds.length) {
            const updated = getYoutubeConfig(guild.id);
            const feed = updated.find((f) => f.youtubeChannelId === input.add_channel);
            if (feed) feed.ping_role_ids = roleIds;
            setYoutubeConfig(guild.id, updated);
          }
        }
        const parts = [`Added YouTube channel **${input.add_channel}** → #${ch.name}`];
        if (input.ping_roles) parts.push(`Ping roles: ${input.ping_roles}`);
        return parts.join("\n");
      }

      if (input.remove_channel) {
        const result = removeYoutubeFeed(guild.id, input.remove_channel);
        return result.success ? `Removed YouTube channel **${input.remove_channel}**` : result.error;
      }

      if (input.ping_roles) {
        const roleIds = findRoles(guild, input.ping_roles);
        if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
        for (const feed of configs) {
          feed.ping_role_ids = roleIds;
        }
        setYoutubeConfig(guild.id, configs);
        return `YouTube ping roles set to: ${input.ping_roles} (applied to all ${configs.length} feed(s))`;
      }

      return "YouTube config updated.";
    }

    case "configure_github": {
      const { getGithubConfig, setGithubConfig } = await import("../../database.js");
      const { addGithubFeed, removeGithubFeed } = await import("../../utils/github.js");
      const configs = getGithubConfig(guild.id);

      if (input.list) {
        if (!configs.length) return "No GitHub feeds configured yet.";
        const lines = configs.map((f) => {
          const ch = guild.channels.cache.get(f.discordChannelId);
          const pingNames = (f.ping_role_ids ?? []).map((id) => guild.roles.cache.get(id)?.name).filter(Boolean);
          const pingText = pingNames.length ? ` (pings: @${pingNames.join(", @")})` : "";
          return `- **${f.repo}**/${f.branch ?? "main"} → #${ch?.name ?? "unknown"}${pingText}`;
        });
        return `GitHub feeds:\n${lines.join("\n")}`;
      }

      if (input.add_repo) {
        if (!input.channel_name) return "Please also specify channel_name (the Discord channel to post in).";
        const ch = findChannel(guild, input.channel_id || input.channel_name);
        if (!ch) return `Channel #${input.channel_name} not found`;
        const branch = input.branch || "main";
        const result = addGithubFeed(guild.id, input.add_repo, ch.id, branch);
        if (!result.success) return result.error;

        if (input.ping_roles) {
          const roleIds = findRoles(guild, input.ping_roles);
          if (roleIds.length) {
            const updated = getGithubConfig(guild.id);
            const feed = updated.find((f) => f.repo === input.add_repo);
            if (feed) feed.ping_role_ids = roleIds;
            setGithubConfig(guild.id, updated);
          }
        }
        const parts = [`Added GitHub repo **${input.add_repo}**/${branch} → #${ch.name}`];
        if (input.ping_roles) parts.push(`Ping roles: ${input.ping_roles}`);
        return parts.join("\n");
      }

      if (input.remove_repo) {
        const result = removeGithubFeed(guild.id, input.remove_repo);
        return result.success ? `Removed GitHub repo **${input.remove_repo}**` : result.error;
      }

      if (input.ping_roles) {
        const roleIds = findRoles(guild, input.ping_roles);
        if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
        for (const feed of configs) {
          feed.ping_role_ids = roleIds;
        }
        setGithubConfig(guild.id, configs);
        return `GitHub ping roles set to: ${input.ping_roles} (applied to all ${configs.length} feed(s))`;
      }

      return "GitHub config updated.";
    }

    case "list_roles_by_category": {
      const { getRolesByCategory, categorizeRole } = await import("@defnotean/shared/roleCategorizer");
      const category = String(input?.category || "").trim().toLowerCase();
      if (!category) return "Pass a category — one of: admin, moderator, helper, bot, everyone, cosmetic, staff, trusted.";
      const matches = getRolesByCategory(guild, category);
      if (!matches.length) return `No roles in this server are categorized as **${category}**. (Categorization is based on actual permissions — cosmetic roles with no power are skipped.)`;
      const lines = matches.map((r) => {
        const cat = categorizeRole(r, guild);
        const perms = r.permissions.toArray();
        const permSummary = perms.length <= 3 ? perms.join(", ") : `${perms.length} perms`;
        return `• **${r.name}** (ID ${r.id}) — ${cat}${perms.length ? ` [${permSummary}]` : ""}`;
      });
      return `Roles categorized as **${category}** (${matches.length}):\n${lines.join("\n")}`;
    }

    case "learn_rules_from_channel": {
      // Admin gate (defense in depth — ai/executor.js already filters
      // ADMIN_TOOLS out of the schema sent to non-admins, but a runtime
      // re-check here protects against any prompt-routing slip-ups).
      const isOwner = message.member?.id === guild.ownerId;
      const isAdmin = message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
      if (!isOwner && !isAdmin) {
        return "Only admins (Manage Server) can teach me the rules.";
      }
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}" — try the channel name or #mention.`;
      if (!ch.isTextBased?.()) return `#${ch.name} isn't a text channel.`;

      // Pull last 50 messages — same as the slash-command flow.
      let messages;
      try {
        const fetched = await ch.messages.fetch({ limit: 50 });
        messages = [...fetched.values()].reverse(); // chronological
      } catch (err) {
        return `Couldn't read #${ch.name}: ${err.message}`;
      }

      const corpus = messages
        .filter((m) => !m.author.bot && m.content.trim())
        .map((m) => m.content)
        .join("\n");
      if (corpus.trim().length < 20) {
        return `#${ch.name} has no usable text. Add rules manually with /rules add or pick a different channel.`;
      }

      const { addRule } = await import("../../database.js");
      const { quickReply } = await import("../providers/index.js");

      const systemInstruction = [
        "You are extracting individual rules from a Discord server's rules channel.",
        "Read the user's text and identify each distinct rule.",
        "Return ONLY a JSON array of objects, with no commentary, no markdown fences, no preamble.",
        "Each object has shape: { \"text\": string, \"severity\": \"low\" | \"medium\" | \"high\" }",
        "Severity guide:",
        "  low    — minor etiquette (English-only, no spam, use right channels)",
        "  medium — community standards (banter ok, no targeted harassment, no self-promo)",
        "  high   — TOS-level (NSFW, slurs, threats, doxxing)",
        "Examples of NON-rules to ignore: server welcome text, decoration emojis, the date the server was made, descriptions of channels.",
        "If you can't find any rules, return an empty array [].",
        "Output exactly: a single JSON array.",
      ].join("\n");

      let raw;
      try {
        raw = await quickReply(message.client, systemInstruction, corpus, null);
      } catch (err) {
        return `Rule extraction failed: ${err?.message ?? err}`;
      }

      let parsed;
      try {
        const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
        const start = cleaned.indexOf("[");
        const end = cleaned.lastIndexOf("]");
        if (start < 0 || end <= start) throw new Error("no JSON array");
        parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (!Array.isArray(parsed)) throw new Error("not an array");
      } catch (err) {
        return `Couldn't parse the AI's rule extraction: ${err.message}`;
      }

      const added = [];
      const skipped = [];
      for (const item of parsed) {
        const text = String(item?.text ?? "").trim();
        if (!text) { skipped.push("(empty)"); continue; }
        const severity = ["low", "medium", "high"].includes(item?.severity) ? item.severity : "medium";
        const r = addRule(guild.id, text, severity, by?.id || message.author.id);
        if (r.success) added.push(`#${r.rule.number} [${r.rule.severity}] ${r.rule.text}`);
        else skipped.push(`(${r.reason})`);
      }

      if (added.length === 0 && skipped.length === 0) {
        return `Read #${ch.name} but didn't find any rules to extract.`;
      }
      const summary = added.length
        ? `Got it. Learned ${added.length} rule${added.length === 1 ? "" : "s"} from #${ch.name}:\n${added.join("\n")}`
        : `Read #${ch.name} but everything I extracted was already known or empty.`;
      const tail = `\n\nAuto-mod is currently OFF — run /rules enable to turn on enforcement, or /rules list to review.`;
      return summary + tail;
    }

    case "setup_ticket": {
      const {
        setTicketCategory, setTicketViewRoles, setTicketPingRoles, setTicketWelcome,
        setTicketPanel, setTicketPanelMessage, setTicketPanelChannel, setTicketAutoCategory,
        setTicketTypes, addTicketType, removeTicketType,
        getTicketConfig,
      } = await import("../../database.js");

      // Helper: convert a "reset"-or-value string input to null-or-value.
      const _resetable = (v) => (typeof v === "string" && v.toLowerCase() === "reset") ? null : (typeof v === "string" ? v : undefined);

      // ── Resolve category ────────────────────────────────────────────────
      // Priority: explicit `category` input > current setting > auto-create TICKETS.
      let category = null;
      if (input?.category) {
        const needle = String(input.category).trim();
        category = guild.channels.cache.find((c) =>
          c.type === ChannelType.GuildCategory &&
          (c.id === needle || c.name.toLowerCase() === needle.toLowerCase() || c.name === needle)
        );
        if (!category) return `Couldn't find a category called "${input.category}" — create it first, or pass an existing category name/ID.`;
      } else {
        const current = getTicketConfig(guild.id);
        if (current.category_id) category = guild.channels.cache.get(current.category_id);
        if (!category) {
          category = guild.channels.cache.find((c) => c.name.toUpperCase() === "TICKETS" && c.type === ChannelType.GuildCategory);
        }
        if (!category) {
          category = await guild.channels.create({ name: "TICKETS", type: ChannelType.GuildCategory, reason: "Ticket system setup" });
        }
      }
      setTicketCategory(guild.id, category.id);

      // ── Role settings (independent view vs ping) ────────────────────────
      // Delegate to the categorizer's resolveRoleHints, which handles:
      //   - raw role IDs,
      //   - exact name match (case-insensitive),
      //   - category keywords (mods/admins/staff/helpers/trusted) — looked
      //     up by actual PERMISSIONS so a cosmetic role called "Moderator"
      //     with zero perms can't be mistaken for a real mod.
      const { resolveRoleHints } = await import("@defnotean/shared/roleCategorizer");
      const _resolveRoleIds = (raw) => resolveRoleHints(guild, raw).map((r) => r.id);

      const touched = [];
      const _applyRoles = (raw, setter, label) => {
        if (!Array.isArray(raw)) return;
        if (raw.length === 0) {
          setter(guild.id, []);
          touched.push(`${label} roles cleared`);
          return;
        }
        const ids = _resolveRoleIds(raw);
        setter(guild.id, ids);
        if (ids.length) {
          touched.push(`${label} roles: ${ids.map((id) => guild.roles.cache.get(id)?.name || id).join(", ")}`);
        } else {
          // Non-empty input but nothing resolved — surface so the AI knows.
          touched.push(`${label} roles — couldn't resolve any of: ${raw.join(", ")} (pass an exact role name or ID)`);
        }
      };
      _applyRoles(input?.view_roles, setTicketViewRoles, "view");
      _applyRoles(input?.ping_roles, setTicketPingRoles, "ping");

      // Dynamic auto-category — the moment this is set, new matching roles
      // automatically get access without a rerun of setup.
      const ALLOWED_CATS = new Set(["admin", "moderator", "helper", "staff", "trusted"]);
      const _applyAuto = (raw, kind) => {
        if (typeof raw !== "string") return;
        const v = raw.trim().toLowerCase();
        if (!v || v === "none" || v === "reset" || v === "off") {
          setTicketAutoCategory(guild.id, kind, null);
          touched.push(`${kind} auto-category cleared`);
          return;
        }
        if (!ALLOWED_CATS.has(v)) {
          touched.push(`${kind} auto-category "${raw}" isn't a valid category (use: admin/moderator/helper/staff/trusted)`);
          return;
        }
        setTicketAutoCategory(guild.id, kind, v);
        touched.push(`${kind} auto-category: ${v} (resolved live on every ticket)`);
      };
      _applyAuto(input?.view_auto_category, "view");
      _applyAuto(input?.ping_auto_category, "ping");

      // ── Ticket types (multi-category routing) ───────────────────────────
      // Each type is resolved here: its `category` input (name or ID) gets
      // mapped to a real category_id before persisting. Invalid categories
      // are tolerated — the type is saved without a category_id and falls
      // back to the global ticket category at ticket-creation time.
      if (Array.isArray(input?.ticket_types)) {
        const resolved = [];
        const skipped  = [];
        for (const raw of input.ticket_types) {
          if (!raw || typeof raw !== "object") continue;
          const clean = {
            key: raw.key,
            label: raw.label,
            emoji: raw.emoji,
            style: raw.style,
          };
          if (raw.category) {
            const catNeedle = String(raw.category).trim();
            const byId = guild.channels.cache.get(catNeedle);
            const byName = !byId ? guild.channels.cache.find((c) =>
              c.type === ChannelType.GuildCategory &&
              (c.name === catNeedle || c.name.toLowerCase() === catNeedle.toLowerCase())
            ) : null;
            const cat = (byId && byId.type === ChannelType.GuildCategory) ? byId : byName;
            if (cat) clean.category_id = cat.id;
            else skipped.push(`${raw.key || "?"} (category "${raw.category}" not found)`);
          }
          resolved.push(clean);
        }
        const saved = setTicketTypes(guild.id, resolved);
        touched.push(`ticket types: ${saved.length ? saved.map((t) => t.label).join(", ") : "cleared"}`);
        if (skipped.length) touched.push(`some type categories skipped: ${skipped.join("; ")}`);
      }
      if (Array.isArray(input?.remove_ticket_types)) {
        const removed = [];
        for (const key of input.remove_ticket_types) {
          if (removeTicketType(guild.id, String(key))) removed.push(String(key));
        }
        if (removed.length) touched.push(`removed ticket types: ${removed.join(", ")}`);
      }

      // ── Welcome embed (title + description + color) ─────────────────────
      const welcomePatch = {};
      if (input?.welcome_title       !== undefined) welcomePatch.title       = _resetable(input.welcome_title);
      if (input?.welcome_description !== undefined) welcomePatch.description = _resetable(input.welcome_description);
      if (input?.welcome_color       !== undefined) welcomePatch.color       = _resetable(input.welcome_color);
      if (Object.keys(welcomePatch).length) {
        setTicketWelcome(guild.id, welcomePatch);
        for (const key of Object.keys(welcomePatch)) {
          touched.push(`welcome ${key} ${welcomePatch[key] === null ? "reset" : "updated"}`);
        }
      }

      // ── Panel embed (title + description + color + button label/emoji) ──
      const panelPatch = {};
      if (input?.panel_title         !== undefined) panelPatch.title        = _resetable(input.panel_title);
      if (input?.panel_description   !== undefined) panelPatch.description  = _resetable(input.panel_description);
      if (input?.panel_color         !== undefined) panelPatch.color        = _resetable(input.panel_color);
      if (input?.panel_button_label  !== undefined) panelPatch.button_label = _resetable(input.panel_button_label);
      if (input?.panel_button_emoji  !== undefined) panelPatch.button_emoji = _resetable(input.panel_button_emoji);
      if (Object.keys(panelPatch).length) {
        setTicketPanel(guild.id, panelPatch);
        for (const key of Object.keys(panelPatch)) {
          touched.push(`panel ${key} ${panelPatch[key] === null ? "reset" : "updated"}`);
        }
      }

      // ── Explicit panel channel (independent from the ticket category) ───
      // Accepts name or ID. 'auto'/'reset' means "go back to auto-create
      // #open-ticket under the ticket category".
      if (typeof input?.panel_channel === "string") {
        const raw = input.panel_channel.trim();
        if (!raw || raw.toLowerCase() === "auto" || raw.toLowerCase() === "reset") {
          setTicketPanelChannel(guild.id, null);
          touched.push("panel channel reset to auto");
        } else {
          const byId = guild.channels.cache.get(raw);
          const byName = !byId ? guild.channels.cache.find((c) =>
            c.isTextBased?.() && (c.name === raw || c.name.toLowerCase() === raw.toLowerCase())
          ) : null;
          const target = byId || byName;
          if (!target) return `Couldn't find a text channel called "${input.panel_channel}" — create it first, or pass an existing channel name/ID.`;
          if (!target.isTextBased?.()) return `"${input.panel_channel}" isn't a text channel.`;
          setTicketPanelChannel(guild.id, target.id);
          touched.push(`panel channel: #${target.name}`);
        }
      }

      // ── Optional: post (or edit-in-place) the open-ticket panel ─────────
      let panelNote = "";
      if (input?.post_panel) {
        const cfg = getTicketConfig(guild.id);

        // Resolve target channel — stored panel channel > existing #open-ticket > new.
        let panelCh = null;
        let existingMsg = null;
        if (cfg.panel_channel_id) {
          panelCh = guild.channels.cache.get(cfg.panel_channel_id) || null;
          if (panelCh && cfg.panel_message_id) {
            existingMsg = await panelCh.messages.fetch(cfg.panel_message_id).catch(() => null);
          }
        }
        if (!panelCh) {
          panelCh = guild.channels.cache.find((c) => c.name === "open-ticket" && c.parentId === category.id) || null;
        }
        if (!panelCh) {
          panelCh = await guild.channels.create({
            name: "open-ticket",
            type: ChannelType.GuildText,
            parent: category.id,
            reason: "Ticket panel channel",
          });
        }

        const panelEmbed = new EmbedBuilder()
          .setTitle(cfg.panel_title || "🎫 Support Tickets")
          .setDescription(cfg.panel_description || "Need help? Click the button below to open a private ticket with the staff team.")
          .setColor(typeof cfg.panel_color === "number" ? cfg.panel_color : 0x5865F2);
        const panelBtn = new ButtonBuilder()
          .setCustomId("ticket_create")
          .setLabel(cfg.panel_button_label || "Open Ticket")
          .setStyle(ButtonStyle.Primary);
        const emoji = (cfg.panel_button_emoji || "🎫").trim();
        if (emoji) {
          try { panelBtn.setEmoji(emoji); } catch { /* bad emoji — skip */ }
        }
        const payload = { embeds: [panelEmbed], components: [new ActionRowBuilder().addComponents(panelBtn)] };

        if (existingMsg) {
          await existingMsg.edit(payload);
          setTicketPanelMessage(guild.id, panelCh.id, existingMsg.id);
          panelNote = ` Panel updated in #${panelCh.name}.`;
        } else {
          const posted = await panelCh.send(payload);
          setTicketPanelMessage(guild.id, panelCh.id, posted.id);
          panelNote = ` Panel posted in #${panelCh.name}.`;
        }
      }

      const parts = [`Ticket system configured. Category: ${category.name}.`];
      if (touched.length) parts.push(`Updated: ${touched.join("; ")}.`);
      if (panelNote) parts.push(panelNote.trim());
      parts.push("By default new tickets are only visible to the opener + Irene — staff access comes from category perms unless a view role is set.");
      return parts.join(" ");
    }

    case "setup_stats_channels": {
      const { updateStatsChannels } = await import("../../utils/stats.js");
      const category = input.category
        ? guild.channels.cache.find((c) => c.name.toLowerCase() === input.category.toLowerCase() && c.type === ChannelType.GuildCategory)
        : null;

      const membersVc = await guild.channels.create({
        name: "👥 Members: ...",
        type: ChannelType.GuildVoice,
        parent: category?.id ?? null,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }],
      });
      const onlineVc = await guild.channels.create({
        name: "🟢 Online: ...",
        type: ChannelType.GuildVoice,
        parent: category?.id ?? null,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }],
      });
      const botsVc = await guild.channels.create({
        name: "🤖 Bots: ...",
        type: ChannelType.GuildVoice,
        parent: category?.id ?? null,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }],
      });

      setStatsChannels(guild.id, {
        members_channel_id: membersVc.id,
        online_channel_id: onlineVc.id,
        bots_channel_id: botsVc.id,
      });

      await updateStatsChannels(guild).catch(() => {});
      return `Stats channels created${category ? ` in "${category.name}"` : ""}`;
    }

    case "setup_reaction_roles": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!input.roles?.length) return "No roles provided";

      const lines = [];
      const rolesToCreate = [];

      for (const r of input.roles) {
        let role = findRole(guild, r.role_name);
        if (!role && r.create_if_missing) {
          const colorMap = { black: "#000000", white: "#FFFFFF", red: "#FF0000", orange: "#FF8C00", yellow: "#FFD700", green: "#2ECC71", blue: "#3498DB", purple: "#9B59B6", pink: "#FF69B4" };
          const hex = colorMap[r.role_name.toLowerCase()] ?? null;
          role = await guild.roles.create({
            name: r.role_name,
            color: hex ? parseInt(hex.replace("#", ""), 16) : undefined,
            reason: `Reaction role setup`,
          });
        }
        if (!role) { lines.push(`${r.emoji} — ⚠️ Role "${r.role_name}" not found`); continue; }
        lines.push(`${r.emoji} — <@&${role.id}>`);
        rolesToCreate.push({ emoji: r.emoji, roleId: role.id, roleName: role.name });
      }

      const colorWords = new Set(["black","white","red","orange","yellow","green","blue","purple","pink","cyan","teal","magenta","gold","silver"]);
      const allColors = input.roles?.every((r) => colorWords.has(r.role_name?.toLowerCase()));
      const mentionsColor = (input.title + " " + (input.description ?? "")).toLowerCase().includes("color");
      const exclusive = input.exclusive ?? (allColors || mentionsColor);
      const defaultDesc = exclusive
        ? "React to pick a role — you can only have one at a time!"
        : "React to get a role!";

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(input.title || "Reaction Roles")
        .setDescription((input.description || defaultDesc) + "\n\n" + lines.join("\n"))
        .setFooter({ text: exclusive ? "Exclusive — picking a new one removes the old" : "React below to assign yourself a role" })
        .setTimestamp();

      const sentMsg = await ch.send({ embeds: [embed] });

      let reactCount = 0;
      for (let i = 0; i < rolesToCreate.length; i++) {
        const r = rolesToCreate[i];
        try {
          await sentMsg.react(r.emoji);
          addReactionRole(guild.id, sentMsg.id, r.emoji, r.roleId, exclusive);
          reactCount++;
          if (i < rolesToCreate.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        } catch (err) {
          log(`[ReactionRoles] Failed to react ${r.emoji}: ${err.message}`);
        }
      }
      log(`[ReactionRoles] Added ${reactCount}/${rolesToCreate.length} reactions to message ${sentMsg.id}`);

      return `Reaction roles set up in #${ch.name} with ${rolesToCreate.length} roles — users can react to get them`;
    }

    case "add_reaction_role": {
      const rrRole = findRole(guild, input.role_name);
      if (!rrRole) return `Couldn't find role "${input.role_name}"`;
      const exclusive = input.exclusive ?? true;
      addReactionRole(guild.id, input.message_id, input.emoji, rrRole.id, exclusive);
      try {
        const ch = message.channel;
        let targetMsg = await ch.messages.fetch(input.message_id).catch(() => null);
        if (!targetMsg) {
          for (const [, c] of guild.channels.cache) {
            if (!c.isTextBased?.()) continue;
            targetMsg = await c.messages.fetch(input.message_id).catch(() => null);
            if (targetMsg) break;
          }
        }
        if (targetMsg) await targetMsg.react(input.emoji).catch(() => {});
      } catch {}
      return `Reaction role added + reacted: ${input.emoji} → @${rrRole.name}`;
    }

    case "remove_reaction_role": {
      removeReactionRole(guild.id, input.message_id, input.emoji);
      return `Reaction role removed for ${input.emoji} on message ${input.message_id}`;
    }

    case "setup_starboard": {
      const sbCh = findChannel(guild, input.channel_id || input.channel_name);
      if (!sbCh) return `Couldn't find channel "${input.channel_name}"`;
      const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
      setStarboard(guild.id, sbCh.id, threshold);
      return `Starboard set to #${sbCh.name} — messages with ${threshold}+ ⭐ reactions will be posted there`;
    }

    case "setup_role_picker": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!input.roles?.length) return "No roles provided";

      const BUTTON_STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
      const resolved = [];
      for (const r of input.roles) {
        let role = findRole(guild, r.name);
        if (!role && r.create_if_missing) {
          role = await guild.roles.create({ name: r.name, reason: "Role picker setup" });
        }
        if (!role) return `Couldn't find role "${r.name}" — set create_if_missing: true to create it`;
        resolved.push({ id: role.id, name: role.name, emoji: r.emoji ?? null, label: r.description ?? r.name, style: r.style || "secondary" });
      }

      const rows = [];
      for (let i = 0; i < resolved.length; i += 5) {
        const slice = resolved.slice(i, i + 5);
        const row = new ActionRowBuilder().addComponents(
          slice.map((r) => {
            const cleanLabel = r.label.replace(/^[\p{Emoji}\s]+/u, "").trim() || r.label;
            const label = r.emoji ? `${r.emoji} ${cleanLabel}` : r.label;
            return new ButtonBuilder()
              .setCustomId(`toggle_role:${r.id}`)
              .setLabel(label.slice(0, 80))
              .setStyle(BUTTON_STYLES[r.style] || ButtonStyle.Secondary);
          })
        );
        rows.push(row);
      }

      // Parse embed color
      const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, cyan: 0x1abc9c, teal: 0x1abc9c, gold: 0xF1C40F };
      let embedColor = 0x2b2d31; // dark default — clean and modern
      if (input.embed_color) {
        const lower = input.embed_color.toLowerCase().trim();
        if (NAMED_COLORS[lower]) embedColor = NAMED_COLORS[lower];
        else { const p = parseInt(lower.replace(/^#|^0x/, ""), 16); if (!isNaN(p)) embedColor = p; }
      }

      const embed = new EmbedBuilder()
        .setTitle(input.title)
        .setDescription((input.description ?? "click a button to toggle a role").replace(/\\n/g, "\n"))
        .setColor(embedColor);
      if (input.embed_image) embed.setImage(input.embed_image);
      if (input.embed_thumbnail) embed.setThumbnail(input.embed_thumbnail);
      if (input.embed_footer) embed.setFooter({ text: input.embed_footer });

      await ch.send({ embeds: [embed], components: rows });
      return `Role picker posted in #${ch.name} with ${resolved.length} roles`;
    }

    case "setup_dropdown_roles": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!input.roles?.length) return "No roles provided";
      if (input.roles.length > 25) return "Max 25 roles per dropdown menu";

      const resolved = [];
      for (const r of input.roles) {
        let role = findRole(guild, r.name);
        if (!role && r.create_if_missing) {
          role = await guild.roles.create({ name: r.name, reason: "Dropdown role picker setup" });
        }
        if (!role) return `Couldn't find role "${r.name}" — set create_if_missing: true to create it`;
        resolved.push({ id: role.id, name: role.name, emoji: r.emoji ?? null, description: r.description ?? null });
      }

      const exclusive = input.exclusive ?? false;
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`dropdown_role:${exclusive ? "exclusive" : "multi"}`)
        .setPlaceholder(input.placeholder || (exclusive ? "Pick a role..." : "Pick your roles..."))
        .setMinValues(input.min_roles ?? (exclusive ? 1 : 0))
        .setMaxValues(input.max_roles ?? (exclusive ? 1 : resolved.length));

      // Safe emoji set — Discord rejects some Unicode emoji in components
      const SAFE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]$/u;

      for (const r of resolved) {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(r.name)
          .setValue(r.id);
        if (r.description) option.setDescription(r.description.slice(0, 100));
        if (r.emoji) {
          try {
            // Check if it's a custom server emoji (name only, no colons)
            // Discord needs { id, name } for custom emoji, not just the name string
            const customEmoji = guild.emojis.cache.find(e => e.name === r.emoji || e.name === r.emoji.replace(/:/g, ""));
            if (customEmoji) {
              option.setEmoji({ id: customEmoji.id, name: customEmoji.name });
            } else {
              option.setEmoji(r.emoji); // Try as Unicode emoji
            }
          } catch { /* skip invalid emoji */ }
        }
        menu.addOptions(option);
      }

      let row;
      try {
        row = new ActionRowBuilder().addComponents(menu);
      } catch (err) {
        // If emoji validation fails at build time, retry without emoji
        const menuRetry = new StringSelectMenuBuilder()
          .setCustomId(`dropdown_role:${exclusive ? "exclusive" : "multi"}`)
          .setPlaceholder(input.placeholder || (exclusive ? "Pick a role..." : "Pick your roles..."))
          .setMinValues(input.min_roles ?? (exclusive ? 1 : 0))
          .setMaxValues(input.max_roles ?? (exclusive ? 1 : resolved.length));
        for (const r of resolved) {
          const opt = new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id);
          if (r.description) opt.setDescription(r.description.slice(0, 100));
          menuRetry.addOptions(opt);
        }
        row = new ActionRowBuilder().addComponents(menuRetry);
      }

      // Parse embed color (same pattern as setup_role_picker)
      const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, cyan: 0x1abc9c, teal: 0x1abc9c, gold: 0xF1C40F };
      let embedColor = 0x2b2d31;
      if (input.embed_color) {
        const lower = input.embed_color.toLowerCase().trim();
        if (NAMED_COLORS[lower]) embedColor = NAMED_COLORS[lower];
        else { const p = parseInt(lower.replace(/^#|^0x/, ""), 16); if (!isNaN(p)) embedColor = p; }
      }

      // Build a polished embed
      const defaultDesc = exclusive
        ? "━━━━━━━━━━━━━━━━━━━━\n\nselect a role from the dropdown below\npicking a new one removes the old\n\n━━━━━━━━━━━━━━━━━━━━"
        : "━━━━━━━━━━━━━━━━━━━━\n\nselect your roles from the dropdown below\nyou can toggle multiple at once\n\n━━━━━━━━━━━━━━━━━━━━";

      const embed = new EmbedBuilder()
        .setTitle(input.title)
        .setDescription((input.description ?? defaultDesc).replace(/\\n/g, "\n"))
        .setColor(embedColor);
      if (input.embed_image) embed.setImage(input.embed_image);
      if (input.embed_thumbnail) embed.setThumbnail(input.embed_thumbnail);
      embed.setFooter({ text: input.embed_footer ?? (exclusive ? "exclusive — one role at a time" : "click to toggle • you can pick multiple") });

      try {
        await ch.send({ embeds: [embed], components: [row] });
      } catch (sendErr) {
        // If send fails (e.g., invalid emoji that slipped through), retry without any emoji
        if (sendErr.message?.includes("INVALID_EMOJI") || sendErr.message?.includes("Invalid Form Body")) {
          log(`[DropdownRoles] Emoji error — retrying without emoji: ${sendErr.message}`);
          const fallbackMenu = new StringSelectMenuBuilder()
            .setCustomId(`dropdown_role:${exclusive ? "exclusive" : "multi"}`)
            .setPlaceholder(input.placeholder || (exclusive ? "Pick a role..." : "Pick your roles..."))
            .setMinValues(input.min_roles ?? (exclusive ? 1 : 0))
            .setMaxValues(input.max_roles ?? (exclusive ? 1 : resolved.length));
          for (const r of resolved) {
            const opt = new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id);
            if (r.description) opt.setDescription(r.description.slice(0, 100));
            fallbackMenu.addOptions(opt);
          }
          const fallbackRow = new ActionRowBuilder().addComponents(fallbackMenu);
          await ch.send({ embeds: [embed], components: [fallbackRow] });
        } else {
          throw sendErr;
        }
      }
      return `Dropdown role picker posted in #${ch.name} with ${resolved.length} roles (${exclusive ? "exclusive" : "multi-select"})`;
    }

    case "setup_color_roles": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const colors = input.colors ?? [];
      if (!colors.length) return "No colors provided";

      const roleIds = [];
      for (const color of colors) {
        let role = guild.roles.cache.find((r) => r.name === color.name);
        if (!role) {
          // Strict hex validation — Discord colors are 0x000000..0xFFFFFF.
          // Previously accepted any parseInt'able string, so "#12345678" or
          // "#notacolor" would silently create a role with a garbage color.
          const hexStr = (color.hex || "").replace(/^#/, "").trim();
          if (!/^[0-9A-Fa-f]{6}$/.test(hexStr)) {
            roleIds.push({ id: null, name: color.name, emoji: color.emoji ?? null, error: `invalid hex: ${color.hex}` });
            continue;
          }
          const hex = parseInt(hexStr, 16);
          role = await guild.roles.create({ name: color.name, color: hex, reason: "Color role picker" });
        }
        roleIds.push({ id: role.id, name: color.name, emoji: color.emoji ?? null });
      }

      // Filter out entries that failed hex validation above so we don't
      // persist null role IDs.
      const validRoleIds = roleIds.filter((r) => r.id);
      setColorRoles(guild.id, validRoleIds.map((r) => r.id));
      // For the rest of the flow below, only surface the valid ones.
      const hexErrors = roleIds.filter((r) => r.error).map((r) => `${r.name} (${r.error})`);

      const rows = [];
      for (let i = 0; i < validRoleIds.length; i += 5) {
        const slice = validRoleIds.slice(i, i + 5);
        const row = new ActionRowBuilder().addComponents(
          slice.map((r) =>
            new ButtonBuilder()
              .setCustomId(`color_role:${r.id}`)
              .setLabel((() => {
                const cleanName = r.name.replace(/^[\p{Emoji}\s]+/u, "").trim() || r.name;
                return r.emoji ? `${r.emoji} ${cleanName}` : r.name;
              })())
              .setStyle(ButtonStyle.Secondary)
          )
        );
        rows.push(row);
      }

      // Parse embed color
      const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, cyan: 0x1abc9c, teal: 0x1abc9c, gold: 0xF1C40F };
      let embedColor = 0x2b2d31;
      if (input.embed_color) {
        const lower = input.embed_color.toLowerCase().trim();
        if (NAMED_COLORS[lower]) embedColor = NAMED_COLORS[lower];
        else { const p = parseInt(lower.replace(/^#|^0x/, ""), 16); if (!isNaN(p)) embedColor = p; }
      }

      const embed = new EmbedBuilder()
        .setTitle(input.title ?? "🎨 Pick a Color")
        .setDescription((input.description ?? "pick a color below — only one at a time\nclick again to remove").replace(/\\n/g, "\n"))
        .setColor(embedColor);
      if (input.embed_image) embed.setImage(input.embed_image);
      if (input.embed_footer) embed.setFooter({ text: input.embed_footer });

      await ch.send({ embeds: [embed], components: rows });
      return `Color role picker posted in #${ch.name} with ${roleIds.length} colors`;
    }

    case "set_ghost_ping_channels": {
      const { setGhostPingChannels } = await import("../../database.js");
      const names = input.channel_names || [];
      if (!names.length) {
        setGhostPingChannels(guild.id, []);
        return "Ghost-ping on join disabled — no channels will ping new members";
      }
      const resolved = [];
      const missing = [];
      for (const name of names) {
        const ch = findChannel(guild, name);
        if (ch?.isTextBased?.()) resolved.push({ id: ch.id, name: ch.name });
        else missing.push(name);
      }
      if (!resolved.length) return `Couldn't find any of those channels: ${missing.join(", ")}`;
      setGhostPingChannels(guild.id, resolved.map(r => r.id));
      const warning = missing.length ? ` (couldn't find: ${missing.join(", ")})` : "";
      return `Ghost-ping on join set up for: ${resolved.map(r => `#${r.name}`).join(", ")}${warning}. New members will get a quick @mention in each channel that auto-deletes after 1.5s.`;
    }

    case "toggle_seasonal_colors": {
      const { setSeasonalColors } = await import("../../database.js");
      const { getColorRoles } = await import("../../database.js");
      const colorRoleIds = getColorRoles(guild.id);
      if (!colorRoleIds.length && input.enabled) return "No color roles set up yet — use setup_color_roles first, then enable seasonal rotation";
      setSeasonalColors(guild.id, input.enabled);
      if (input.enabled) {
        // Do an immediate rotation
        const { rotateSeasonalColors, getCurrentPalette } = await import("../../utils/seasonalColors.js");
        const { setLastSeasonalPalette } = await import("../../database.js");
        const result = await rotateSeasonalColors(guild, colorRoleIds);
        const palette = getCurrentPalette();
        setLastSeasonalPalette(guild.id, palette.name);
        return `Seasonal colors enabled! ${result.emoji} Currently: **${result.season}** — updated ${result.updated} roles. Colors will auto-rotate with the seasons (Spring pastels → Summer vibrant → Fall warm → Winter frost + special events like Halloween & Christmas)`;
      }
      return "Seasonal colors disabled — color roles will stay as they are now";
    }

    case "preview_seasonal_palette": {
      const { PALETTES, getCurrentPalette } = await import("../../utils/seasonalColors.js");
      const paletteName = input.palette === "current" ? null : input.palette;
      const palette = paletteName ? PALETTES[paletteName] : getCurrentPalette();
      if (!palette) return `Unknown palette "${input.palette}" — try: spring, summer, fall, winter, halloween, christmas, valentines, current`;
      const lines = palette.colors.map((c, i) => `\`${c.hex}\` **${c.name}**`);
      return `${palette.emoji} **${palette.name}** palette:\n${lines.join("\n")}`;
    }

    case "force_seasonal_rotation": {
      const { getColorRoles, getSeasonalColors } = await import("../../database.js");
      if (!getSeasonalColors(guild.id)) return "Seasonal colors aren't enabled for this server — use toggle_seasonal_colors first";
      const colorRoleIds = getColorRoles(guild.id);
      if (!colorRoleIds.length) return "No color roles found — set them up first with setup_color_roles";
      const { rotateSeasonalColors, getCurrentPalette } = await import("../../utils/seasonalColors.js");
      const { setLastSeasonalPalette } = await import("../../database.js");
      const result = await rotateSeasonalColors(guild, colorRoleIds);
      const palette = getCurrentPalette();
      setLastSeasonalPalette(guild.id, palette.name);
      return `${result.emoji} Forced rotation to **${result.season}** — updated ${result.updated} color roles`;
    }

    case "sticky_message": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const { setStickyMessage, updateStickyMessageId } = await import("../../database.js");

      const embedData = (input.embed_title || input.embed_description) ? {
        title: input.embed_title || null,
        description: input.embed_description || null,
        color: input.embed_color || "#2b2d31",
        footer: input.embed_footer || "\ud83d\udccc sticky message",
      } : null;

      setStickyMessage(guild.id, ch.id, input.content || null, embedData);

      // Send the initial sticky
      const sendOpts = {};
      if (input.content) sendOpts.content = input.content;
      if (embedData) {
        const embed = new EmbedBuilder();
        if (embedData.title) embed.setTitle(embedData.title);
        if (embedData.description) embed.setDescription(embedData.description.replace(/\\n/g, "\n"));
        embed.setColor(typeof embedData.color === "string" ? parseInt(embedData.color.replace("#", ""), 16) : 0x2b2d31);
        if (embedData.footer) embed.setFooter({ text: embedData.footer });
        sendOpts.embeds = [embed];
      }
      const sent = await ch.send(sendOpts);
      updateStickyMessageId(guild.id, ch.id, sent.id);

      return `Sticky message set in #${ch.name} — it'll stay at the bottom`;
    }

    case "remove_sticky": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const { getStickyMessage, removeStickyMessage } = await import("../../database.js");
      const existing = getStickyMessage(guild.id, ch.id);
      if (!existing) return `No sticky message in #${ch.name}`;
      if (existing.lastMessageId) {
        try { const old = await ch.messages.fetch(existing.lastMessageId); await old.delete(); } catch {}
      }
      removeStickyMessage(guild.id, ch.id);
      return `Removed sticky message from #${ch.name}`;
    }
  }
}
