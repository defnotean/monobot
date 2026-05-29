import { getGuildSettings, setAutorole, setWelcomeChannel, getDmWelcome, getWelcomeEmbed, recordInviteJoin, getGhostPingChannels } from "../database.js";
import { EmbedBuilder } from "discord.js";
import { checkRaid } from "../utils/raid.js";

const WELCOME_CHANNEL_NAMES = [
  "welcome", "welcomes", "welcome-chat", "welcome-mat",
  "welcome-channel", "greetings", "introductions",
];
import { logEmbed, LC, logEvent } from "../utils/embeds.js";
import { log, sendModLog } from "../utils/logger.js";
import { trackJoin, activateLockdown, checkNewAccount } from "../utils/safety.js";
import { findUsedInvite, refreshInvites } from "../utils/invites.js";
import { updateStatsChannels } from "../utils/stats.js";

// ─── Named colour lookup ──────────────────────────────────────────────────────
const NAMED_COLORS = {
  white: 0xFFFFFF, black: 0x000000, red: 0xFF0000, green: 0x57F287,
  blue: 0x5865F2, blurple: 0x5865F2, yellow: 0xFEE75C, orange: 0xED8E00,
  purple: 0x9B59B6, pink: 0xFF73FA, cyan: 0x1ABC9C, teal: 0x1ABC9C,
};

export function parseEmbedColor(raw) {
  if (raw == null) return null;
  const lower = raw.toLowerCase().trim();
  if (NAMED_COLORS[lower] !== undefined) return NAMED_COLORS[lower];
  const cleaned = lower.replace(/^#/, "").replace(/^0x/, "");
  const n = parseInt(cleaned, 16);
  return isNaN(n) ? null : n;
}

// ─── Shared age formatter ─────────────────────────────────────────────────────
export function formatAccountAge(createdTimestamp) {
  const ageDays  = Math.floor((Date.now() - createdTimestamp) / 86_400_000);
  const ageHours = Math.floor((Date.now() - createdTimestamp) / 3_600_000);
  if (ageDays < 1)   return `${ageHours}h`;
  if (ageDays < 30)  return `${ageDays}d`;
  const years  = Math.floor(ageDays / 365);
  const months = Math.floor((ageDays % 365) / 30);
  if (years >= 1)    return months > 0 ? `${years}y ${months}mo` : `${years}y`;
  return `${months}mo`;
}

// ─── Shared welcome embed builder ────────────────────────────────────────────
/**
 * Builds the welcome EmbedBuilder and returns { embed, pingContent }.
 * pingContent is the string to pass as `content` in channel.send() (may be empty).
 */
export function buildWelcomeEmbed(member, settings, embedCfg) {
  const cfg = embedCfg ?? {};

  const ageDays  = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  const isNewAccount = ageDays < 7;
  const accountAgeStr = formatAccountAge(member.user.createdTimestamp);
  const joinedDiscordTs = Math.floor(member.user.createdTimestamp / 1000);

  const guildIcon   = member.guild.iconURL({ size: 256 });
  const guildBanner = member.guild.bannerURL({ size: 1024, extension: "png" });
  const memberAvatar = member.user.displayAvatarURL({ size: 256 });

  // Human-only member count (excludes bots)
  const humanCount = member.guild.members.cache.filter(m => !m.user.bot).size || member.guild.memberCount;

  // Helper: run all placeholder substitutions on a string
  const sub = (str) => String(str)
    .replace(/{user}/g,        member.toString())
    .replace(/{username}/g,    member.displayName)
    .replace(/{server}/g,      member.guild.name)
    .replace(/{membercount}/g, humanCount)
    .replace(/{age}/g,         accountAgeStr)
    .replace(/{joined}/g,      `<t:${joinedDiscordTs}:D>`)
    .replace(/{member_number}/g, `#${humanCount}`);

  // ── Resolve config with defaults ─────────────────────────────────────────
  const color           = parseEmbedColor(cfg.color) ?? 0xFFFFFF;

  // Title — can be hidden entirely, can have a clickable URL
  const showTitle       = cfg.show_title        ?? true;
  const rawTitle        = cfg.title             ?? "👋 Welcome, {user}!";
  const titleStr        = sub(rawTitle);
  const titleUrl        = cfg.title_url         ?? null;

  // Description / body
  const welcomeMsg = sub(cfg.description ?? settings?.welcome_message ?? "Everyone say hello to {user}! You're member **#{membercount}** — glad you're here.");

  // Thumbnail (user avatar by default)
  const showThumbnail   = cfg.show_thumbnail   ?? true;
  const thumbnailUrl    = cfg.thumbnail_url && cfg.thumbnail_url !== "none" ? cfg.thumbnail_url : (showThumbnail ? memberAvatar : null);

  // Banner / hero image — OFF by default
  const showBanner      = cfg.show_banner      ?? false;
  const bannerUrl       = cfg.banner_url && cfg.banner_url !== "none"
    ? cfg.banner_url
    : (showBanner ? (guildBanner ?? memberAvatar) : null);

  // Author line
  const showAuthor      = cfg.show_author      ?? true;
  const authorName      = (cfg.author_name && cfg.author_name !== "default") ? sub(cfg.author_name) : member.guild.name;
  const authorIconUrl   = cfg.author_icon_url && cfg.author_icon_url !== "none" ? cfg.author_icon_url : (guildIcon ?? undefined);
  const authorUrl       = cfg.author_url       ?? null;

  // Footer
  const showFooter      = cfg.show_footer      ?? true;
  const footerText      = (cfg.footer_text && cfg.footer_text !== "default") ? sub(cfg.footer_text) : member.guild.name;
  const footerIconUrl   = cfg.footer_icon_url && cfg.footer_icon_url !== "none" ? cfg.footer_icon_url : (guildIcon ?? undefined);

  // Misc toggles
  const showTimestamp   = cfg.show_timestamp   ?? true;
  const showMemberField = cfg.show_member_field ?? true;
  const showAgeField    = cfg.show_age_field    ?? true;
  const showJoinedField = cfg.show_joined_field ?? true;
  const pingUser        = cfg.ping_user         ?? true;

  // Renamed field labels (defaults have emoji)
  const memberFieldName = cfg.member_field_name ?? "🔢 Member";
  const ageFieldName    = cfg.age_field_name    ?? "📅 Account Age";
  const joinedFieldName = cfg.joined_field_name ?? "🗓️ On Discord";

  // Content text outside embed (separate from ping)
  const contentText     = cfg.content ? sub(cfg.content) : null;

  // ── Build embed ───────────────────────────────────────────────────────────
  const embed = new EmbedBuilder().setColor(color);

  if (showTitle) {
    embed.setTitle(titleStr);
    if (titleUrl) embed.setURL(titleUrl);
  }
  embed.setDescription(welcomeMsg);

  if (showAuthor) {
    const authorOpts = { name: authorName, iconURL: authorIconUrl };
    if (authorUrl) authorOpts.url = authorUrl;
    embed.setAuthor(authorOpts);
  }
  if (thumbnailUrl)  embed.setThumbnail(thumbnailUrl);
  if (bannerUrl)     embed.setImage(bannerUrl);
  if (showFooter)    embed.setFooter({ text: footerText, iconURL: footerIconUrl });
  if (showTimestamp) embed.setTimestamp();

  // Standard fields (labels are customizable)
  const fields = [];
  if (showMemberField) fields.push({ name: memberFieldName, value: `#${humanCount}`,                                               inline: true });
  if (showAgeField)    fields.push({ name: ageFieldName,    value: isNewAccount ? `⚠️ ${accountAgeStr} — new!` : accountAgeStr,     inline: true });
  if (showJoinedField) fields.push({ name: joinedFieldName, value: `<t:${joinedDiscordTs}:D>`,                                      inline: true });

  // Extra custom fields (substitution supported)
  const extra = Array.isArray(cfg.extra_fields) ? cfg.extra_fields : [];
  for (const f of extra) {
    fields.push({ name: String(f.name), value: sub(f.value), inline: f.inline ?? false });
  }

  if (fields.length) embed.addFields(...fields);

  // Build ping / content string — supports multiple role pings
  const parts = [];
  const welcomeRoleIds = Array.isArray(cfg.ping_role_ids) ? cfg.ping_role_ids : [];
  if (welcomeRoleIds.length) parts.push(welcomeRoleIds.map((id) => `<@&${id}>`).join(" "));
  if (pingUser)    parts.push(member.toString());
  if (contentText) parts.push(contentText);
  const pingContent = parts.join(" ");

  return { embed, pingContent };
}

export const name = "guildMemberAdd";

export async function execute(member) {
  // Invalidate the member-name index so the new member is resolvable
  // by findMember on the next tool call.
  try {
    const { invalidateMemberIndex } = await import("../ai/executor.js");
    invalidateMemberIndex(member.guild.id);
  } catch {}

  const settings = getGuildSettings(member.guild.id);

  // ── Bump correlation tracker — records whether this join followed a
  // recent bump. Fires first (non-blocking, wrapped) so it never blocks
  // the welcome/raid path even if Supabase is unavailable.
  if (!member?.user?.bot) {
    try {
      const { recordJoinForCorrelation } = await import("../ai/bumpCorrelation.js");
      recordJoinForCorrelation({
        guildId: member.guild.id,
        userId: member.id,
        joinedAtMs: member.joinedTimestamp ?? Date.now(),
        botName: "irene",
      }).catch(err => log(`[Join] correlation record failed: ${err.message}`));
    } catch (err) {
      log(`[Join] correlation hook failed: ${err.message}`);
    }
  }

  // ── Anti-Raid: track join rate (basic + enhanced) ────────────────────────
  const isRaid = trackJoin(member.guild.id);
  if (isRaid) {
    await activateLockdown(member.guild, `raid detected — ${member.guild.memberCount} joins in rapid succession`);
    // Auto-mod destructive call: failure (bot lacks Kick Members, target left,
    // rate limit) must not throw out of the event handler, but must be visible
    // in logs rather than silently swallowed — matches the [Raid] log style below.
    try {
      await member.kick("Auto-mod: raid detected");
    } catch (err) {
      log(`[Raid] Auto-kick failed for ${member?.id ?? "unknown"} on ${member.guild?.id ?? "unknown"}: ${err?.message ?? err}`);
    }
  }
  // Enhanced raid detection with configurable thresholds
  try {
    checkRaid(member.guild, member);
  } catch (err) {
    log(`[Raid] Check error: ${err.message}`);
  }

  // ── New account detection ────────────────────────────────────────────────
  await checkNewAccount(member);

  // ── Invite Tracking (Feature 6) ──────────────────────────────────────────
  let usedInvite = null;
  try {
    const [inviteResult] = await Promise.allSettled([
      findUsedInvite(member.guild),
      refreshInvites(member.guild),
    ]);
    usedInvite = inviteResult.status === "fulfilled" ? inviteResult.value : null;
  } catch {}

  // Log to mod log channel
  const ageDays      = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  const isNewAccount = ageDays < 7;
  const accountAgeStr = formatAccountAge(member.user.createdTimestamp);
  const humanCount   = member.guild.members.cache.filter(m => !m.user.bot).size || member.guild.memberCount;

  const inviteLine = usedInvite
    ? `\`${usedInvite.code}\`${usedInvite.inviter ? ` · by ${usedInvite.inviter.tag}` : ""}${usedInvite.uses ? ` · ${usedInvite.uses} uses` : ""}`
    : null;

  const joinEmbed = logEvent({
    kind: "join",
    target: member.user,
    description: `<@${member.id}> joined the server.`,
    meta: {
      "Account": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
      "Age": isNewAccount ? `⚠️ ${accountAgeStr} (new!)` : accountAgeStr,
      "Member #": `#${humanCount}`,
      "Invite": inviteLine,
    },
  });

  if (usedInvite) {
    // Persist invite join to database for history/leaderboard
    recordInviteJoin(
      member.guild.id,
      member.id,
      member.user.tag,
      usedInvite.code,
      usedInvite.inviter?.id || null,
      usedInvite.inviter?.tag || null,
    );
  }

  await sendModLog(member.guild, joinEmbed);

  // ── Ghost-Ping on Join — ping new member in configured channels and delete ──
  try {
    const ghostPingChannels = getGhostPingChannels(member.guild.id);
    if (ghostPingChannels.length) {
      log(`[GhostPing] Pinging ${member.user.tag} in ${ghostPingChannels.length} channel(s)`);
      for (const chId of ghostPingChannels) {
        let ch = member.guild.channels.cache.get(chId);
        if (!ch) ch = await member.guild.channels.fetch(chId).catch(() => null);
        if (!ch?.isTextBased?.()) {
          log(`[GhostPing] Channel ${chId} not found or not text-based`);
          continue;
        }
        try {
          const pingMsg = await ch.send({
            content: `<@${member.id}>`,
            allowedMentions: { users: [member.id] }, // Explicit — force the notification
          });
          log(`[GhostPing] Sent ping in #${ch.name} (msg ${pingMsg.id})`);
          setTimeout(() => {
            pingMsg.delete().catch((err) => log(`[GhostPing] Failed to delete in #${ch.name}: ${err.message}`));
          }, 2000); // 2s to ensure notification fires before delete
        } catch (err) {
          log(`[GhostPing] Failed to send in ${ch.name}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log(`[GhostPing] Error: ${err.message}`);
  }

  // Auto-role
  if (settings?.autorole_id) {
    try {
      const role = member.guild.roles.cache.get(settings.autorole_id);
      if (role) await member.roles.add(role);
    } catch (err) {
      if (err.code === 10011) {
        log(`[AutoRole] Role ${settings.autorole_id} no longer exists in ${member.guild.name} — clearing setting`);
        setAutorole(member.guild.id, null);
      } else {
        log(`Failed to assign autorole in ${member.guild.name}: ${err.message}`);
      }
    }
  }

  // Welcome message — check settings first, then auto-detect by channel name.
  // Auto-detect uses partial matching to handle emoji-prefixed names like "✨・welcome"
  let welcomeChannelId = settings?.welcome_channel;
  if (!welcomeChannelId) {
    const found = member.guild.channels.cache.find(
      (c) => c.isTextBased() && (
        WELCOME_CHANNEL_NAMES.includes(c.name.toLowerCase()) ||
        WELCOME_CHANNEL_NAMES.some(n => c.name.toLowerCase().includes(n))
      )
    );
    if (found) {
      welcomeChannelId = found.id;
      setWelcomeChannel(member.guild.id, found.id, null);
      log(`[AutoSetup] "${member.guild.name}": auto-detected welcome channel #${found.name}`);
    }
  }

  if (welcomeChannelId) {
    let channel = member.guild.channels.cache.get(welcomeChannelId);
    if (!channel) channel = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);

    if (!channel) {
      log(`[Welcome] Channel ${welcomeChannelId} no longer exists in ${member.guild.name} — clearing`);
      setWelcomeChannel(member.guild.id, null, null);
      welcomeChannelId = null;
    }

    if (channel) {
      // Permission check — don't silently fail on missing permissions
      const me = member.guild.members.me;
      if (me && !channel.permissionsFor(me)?.has("SendMessages")) {
        log(`[Welcome] Missing SendMessages permission in #${channel.name} (${member.guild.name})`);
      } else {
        const embedCfg = getWelcomeEmbed(member.guild.id);
        const { embed: welcomeEmbed, pingContent } = buildWelcomeEmbed(member, settings, embedCfg);

        try {
          await channel.send({
            content: pingContent || undefined,
            embeds: [welcomeEmbed],
          });
          log(`[Welcome] Sent welcome for ${member.user.username} in ${member.guild.name} #${channel.name}`);
        } catch (err) {
          log(`[Welcome] Failed to send in ${member.guild.name} #${channel.name}: ${err.message}`);
        }
      }
    }
  } else {
    log(`[Welcome] No welcome channel configured or detected for ${member.guild.name}`);
  }

// ─── DM Welcome (Feature 7) ───────────────────────────────────────────────
  const dmWelcome = getDmWelcome(member.guild.id);
  const { isDmOptout } = await import("../database.js");
  if (dmWelcome.enabled && !isDmOptout(member.id)) {
    const dmMsg = dmWelcome.message
      .replace(/{server}/g, member.guild.name)
      .replace(/{user}/g, member.user.username)
      .replace(/{membercount}/g, humanCount);

    const guildIcon = member.guild.iconURL({ size: 256 });

    const dmEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setAuthor({ name: member.guild.name, iconURL: guildIcon ?? undefined })
      .setTitle(`👋 Welcome to ${member.guild.name}!`)
      .setDescription(dmMsg)
      .addFields(
        { name: "🔢 Members", value: String(humanCount), inline: true },
        { name: "📅 You joined", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      )
      .setThumbnail(guildIcon ?? undefined)
      .setTimestamp();

    try {
      await member.send({ embeds: [dmEmbed] });
    } catch {
      // DMs might be closed, ignore
    }
  }

  // ── Update stats channels (Feature 17) ──────────────────────────────────
  await updateStatsChannels(member.guild).catch(() => {});
}
