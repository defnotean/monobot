// ─── Auto-Mod & Safety System ────────────────────────────────────────────────
// Anti-raid, anti-spam, mention spam, new account detection, lockdown

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { sendModLog } from "./logger.js";
import { getBadWords, saveLockdown, clearLockdown, saveSlowmode, clearSlowmode } from "../database.js";

// ─── State ────────────────────────────────────────────────────────────────────

const joinTimestamps  = new Map();   // guildId -> [ms, ...]
const lockedDown      = new Set();   // guildIds in lockdown
const lockdownTimers  = new Map();   // guildId -> timeout handle
const msgTimestamps   = new Map();   // `guildId-userId` -> [ms, ...]
const warnedSpam      = new Set();   // `guildId-userId` already warned this window

// ─── Slowmode auto-management state ──────────────────────────────────────────
const autoSlowmodeChannels = new Set();      // channelIds with auto-slowmode active
const slowmodeSpamTimes    = new Map();      // channelId -> last spam timestamp
const slowmodeResetTimers  = new Map();      // channelId -> reset timer handle

// ─── Configurable thresholds (sensible defaults) ─────────────────────────────

const RAID_JOINS        = 8;          // joins within RAID_WINDOW → raid
const RAID_WINDOW_MS    = 8_000;
const NEW_ACCOUNT_DAYS  = 7;          // accounts younger than this get flagged
const SPAM_MSGS         = 6;          // messages within SPAM_WINDOW → spam
const SPAM_WINDOW_MS    = 4_000;
const SPAM_TIMEOUT_S    = 60;         // timeout for spammers
const MENTION_LIMIT     = 5;          // unique mentions per message before action
const MENTION_TIMEOUT_S = 300;        // 5 min timeout for mention spam

// ─── Stale entry cleanup — runs every 10 minutes ─────────────────────────────
// Prevents joinTimestamps and msgTimestamps from growing unbounded over time

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of joinTimestamps) {
    const cutoff = now - RAID_WINDOW_MS;
    while (times.length > 0 && times[0] < cutoff) times.shift();
    if (times.length === 0) joinTimestamps.delete(key);
  }
  for (const [key, times] of msgTimestamps) {
    const cutoff = now - SPAM_WINDOW_MS;
    while (times.length > 0 && times[0] < cutoff) times.shift();
    if (times.length === 0) { msgTimestamps.delete(key); warnedSpam.delete(key); }
  }
}, 10 * 60_000);

// ─── Anti-Raid ────────────────────────────────────────────────────────────────

export function trackJoin(guildId) {
  const now = Date.now();
  if (!joinTimestamps.has(guildId)) joinTimestamps.set(guildId, []);
  const times = joinTimestamps.get(guildId);
  times.push(now);
  const cutoff = now - RAID_WINDOW_MS;
  while (times.length && times[0] < cutoff) times.shift();
  return times.length >= RAID_JOINS;
}

export async function activateLockdown(guild, reason = "raid detected") {
  if (lockedDown.has(guild.id)) return false;
  lockedDown.add(guild.id);
  saveLockdown(guild.id, Date.now() + 10 * 60_000);

  const everyone = guild.roles.everyone;
  const channels = guild.channels.cache.filter((c) => c.isTextBased() && !c.isThread());
  await Promise.allSettled(
    [...channels.values()].map((ch) =>
      ch.permissionOverwrites.edit(everyone, { SendMessages: false })
    )
  );

  const embed = new EmbedBuilder()
    .setTitle("🚨 Server Lockdown Activated")
    .setDescription(`**Reason:** ${reason}\nAll text channels locked. Admins can still send.`)
    .setColor(0xff0000)
    .setTimestamp();
  await sendModLog(guild, embed);

  // Auto-unlock after 10 minutes — cancel any existing timer first to prevent double-unlock
  if (lockdownTimers.has(guild.id)) clearTimeout(lockdownTimers.get(guild.id));
  lockdownTimers.set(guild.id, setTimeout(() => {
    lockdownTimers.delete(guild.id);
    deactivateLockdown(guild, "auto-unlock after 10 min timeout");
  }, 10 * 60_000));
  return true;
}

export async function deactivateLockdown(guild, reason = "manual unlock") {
  if (!lockedDown.has(guild.id)) return false;
  lockedDown.delete(guild.id);
  clearLockdown(guild.id);
  if (lockdownTimers.has(guild.id)) { clearTimeout(lockdownTimers.get(guild.id)); lockdownTimers.delete(guild.id); }

  const everyone = guild.roles.everyone;
  const channels = guild.channels.cache.filter((c) => c.isTextBased() && !c.isThread());
  await Promise.allSettled(
    [...channels.values()].map((ch) =>
      ch.permissionOverwrites.edit(everyone, { SendMessages: null })
    )
  );

  const embed = new EmbedBuilder()
    .setTitle("✅ Lockdown Lifted")
    .setDescription(`**Reason:** ${reason}`)
    .setColor(0x57f287)
    .setTimestamp();
  await sendModLog(guild, embed);
  return true;
}

export const isLockedDown = (guildId) => lockedDown.has(guildId);

export function restoreLockdownState(guildId) {
  lockedDown.add(guildId);
}

// ─── New Account Detection ────────────────────────────────────────────────────

export async function checkNewAccount(member) {
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  if (ageDays >= NEW_ACCOUNT_DAYS) return;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Suspicious New Account")
    .setDescription(`<@${member.id}> joined with a very new account`)
    .addFields(
      { name: "Account Age", value: `${Math.floor(ageDays * 24)}h old`, inline: true },
      { name: "Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
    )
    .setColor(0xfee75c)
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp()
    .setFooter({ text: `ID: ${member.id}` });
  await sendModLog(member.guild, embed);
}

// ─── Anti-Spam ────────────────────────────────────────────────────────────────

export async function checkSpam(message) {
  if (!message.guild || message.author.bot) return false;
  // Skip admins
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const key = `${message.guild.id}-${message.author.id}`;
  const now = Date.now();
  if (!msgTimestamps.has(key)) msgTimestamps.set(key, []);
  const times = msgTimestamps.get(key);
  times.push(now);
  const cutoff = now - SPAM_WINDOW_MS;
  while (times.length && times[0] < cutoff) times.shift();
  if (times.length < SPAM_MSGS) return false;

  // Spam threshold hit — also set slowmode on the channel (Feature 15)
  msgTimestamps.delete(key);
  warnedSpam.delete(key);

  // Auto-slowmode: set 5s slowmode on the channel
  const channelId = message.channel.id;
  if (!autoSlowmodeChannels.has(channelId)) {
    autoSlowmodeChannels.add(channelId);
    saveSlowmode(channelId, message.guild.id, Date.now() + 2 * 60_000);
    try {
      await message.channel.setRateLimitPerUser(5, "Auto-mod: spam detected");
    } catch {}
  }

  // Update last spam time and reset/extend the 2-minute lift timer
  slowmodeSpamTimes.set(channelId, Date.now());
  saveSlowmode(channelId, message.guild.id, Date.now() + 2 * 60_000);
  if (slowmodeResetTimers.has(channelId)) clearTimeout(slowmodeResetTimers.get(channelId));
  slowmodeResetTimers.set(channelId, setTimeout(async () => {
    slowmodeResetTimers.delete(channelId);
    autoSlowmodeChannels.delete(channelId);
    clearSlowmode(channelId, message.guild.id);
    try {
      const ch = message.guild.channels.cache.get(channelId);
      if (ch) await ch.setRateLimitPerUser(0, "Auto-mod: spam cooldown expired");
    } catch {}
  }, 2 * 60_000));

  try {
    // Re-fetch member — they may have left between the message and now
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return true; // left the server, nothing to do
    await member.timeout(SPAM_TIMEOUT_S * 1000, "Auto-mod: spam");
    await message.reply(`hey, slow down — you've been timed out for ${SPAM_TIMEOUT_S}s`).catch(() => {});
    const embed = new EmbedBuilder()
      .setTitle("🤖 Auto-Mod: Spam")
      .setDescription(`<@${message.author.id}> was timed out for spamming`)
      .addFields(
        { name: "User", value: `${message.author.tag}`, inline: true },
        { name: "Timeout", value: `${SPAM_TIMEOUT_S}s`, inline: true }
      )
      .setColor(0xfee75c)
      .setTimestamp();
    await sendModLog(message.guild, embed);
  } catch {}
  return true;
}

// ─── Bad Word Filter (Feature 16) ────────────────────────────────────────────

// Per-guild pre-compiled regex cache — avoids rebuilding regexes on every message.
// Each entry: { words: string[], regexes: RegExp[] }
const _badWordRegexCache = new Map();

/** Call this whenever the bad-word list for a guild is updated. */
export function invalidateBadWordCache(guildId) { _badWordRegexCache.delete(guildId); }

function getCompiledBadWordRegexes(guildId) {
  const words = getBadWords(guildId);
  if (!words.length) return null;

  const cached = _badWordRegexCache.get(guildId);
  // Reuse cache if the word list hasn't changed
  if (cached && cached.words.length === words.length && cached.words.every((w, i) => w === words[i])) {
    return cached.regexes;
  }

  const regexes = words.map((w) => {
    const escaped = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i");
  });
  _badWordRegexCache.set(guildId, { words: [...words], regexes });
  return regexes;
}

export async function checkBadWords(message) {
  if (!message.guild || message.author.bot) return false;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const regexes = getCompiledBadWordRegexes(message.guild.id);
  if (!regexes) return false;

  const content = message.content;
  const matched = regexes.some((re) => re.test(content));

  if (!matched) return false;

  try {
    await message.delete();
  } catch {}

  try {
    const warning = await message.channel.send(
      `<@${message.author.id}> watch the language — that word isn't allowed here`
    );
    setTimeout(() => warning.delete().catch(() => {}), 5_000);
  } catch {}

  return true;
}

// ─── Anti-Invite Link Filter ─────────────────────────────────────────────────

/** Check message for Discord invite links — returns true if blocked */
export async function checkInviteLinks(message) {
  const { getGuildSettings } = await import("../database.js");
  const settings = getGuildSettings(message.guild.id);
  if (!settings?.invite_filter) return false;

  // Skip admins and bot owner
  if (message.member?.permissions?.has("Administrator")) return false;
  if (message.member?.permissions?.has("ManageGuild")) return false;

  // Whitelist certain roles
  const whitelistedRoles = settings.invite_filter_whitelist || [];
  if (whitelistedRoles.some(r => message.member?.roles?.cache?.has(r))) return false;

  // Check for invite patterns
  const inviteRegex = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[\w-]+/gi;
  if (!inviteRegex.test(message.content)) return false;

  // Allow invites to the current server
  try {
    const matches = message.content.match(/(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[\w-]+/gi) || [];
    for (const match of matches) {
      const code = match.split("/").pop();
      try {
        const invite = await message.client.fetchInvite(code);
        if (invite.guild?.id === message.guild.id) continue; // Same server — allowed
      } catch {} // Invalid invite — still block it

      // Block it
      await message.delete().catch(() => {});
      await message.channel.send({ content: `${message.author}, invite links aren't allowed here.` }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

      const embed = new EmbedBuilder()
        .setTitle("🔗 Invite Link Blocked")
        .addFields(
          { name: "User", value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Invite", value: match },
        )
        .setColor(0xed4245)
        .setTimestamp();
      await sendModLog(message.guild, embed);
      return true;
    }
  } catch {}
  return false;
}

// ─── Mention Spam ─────────────────────────────────────────────────────────────

export async function checkMentionSpam(message) {
  if (!message.guild || message.author.bot) return false;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount < MENTION_LIMIT) return false;

  try {
    await message.delete().catch(() => {});
    await message.member.timeout(MENTION_TIMEOUT_S * 1000, "Auto-mod: mention spam");
    await message.channel.send(`<@${message.author.id}> don't mass mention people — you've been timed out`).catch(() => {});
    const embed = new EmbedBuilder()
      .setTitle("🤖 Auto-Mod: Mention Spam")
      .setDescription(`<@${message.author.id}> mass mentioned ${mentionCount} users/roles`)
      .addFields(
        { name: "User", value: `${message.author.tag}`, inline: true },
        { name: "Mentions", value: String(mentionCount), inline: true },
        { name: "Timeout", value: `${MENTION_TIMEOUT_S}s`, inline: true }
      )
      .setColor(0xed4245)
      .setTimestamp();
    await sendModLog(message.guild, embed);
  } catch {}
  return true;
}
