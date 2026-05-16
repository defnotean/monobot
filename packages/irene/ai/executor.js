/**
 * @file packages/irene/ai/executor.js
 *
 * Irene's AI tool dispatch — the single entry point (`executeTool`) that the
 * model's tool-call output funnels through. Roughly 200 tools span moderation,
 * channel/role management, voice/music, leveling, memory, personalization,
 * server setup, and a handful of utility/web tools. Every tool the AI invokes
 * lands here, gets routed, and produces a string the model sees as the tool
 * result on its next turn.
 *
 * ## How this differs from Eris's executor
 * Eris (`packages/eris/ai/executor.js`) is the lightweight twin — chat-focused,
 * with a much smaller tool surface (memory + a few utilities). Irene is the
 * server-management half of the pair: she owns the moderation toolkit (ban /
 * kick / timeout / purge / lockdown), the full Discord API surface (channels,
 * roles, emojis, invites, threads, webhooks), the music player, voice features,
 * leveling, birthdays, custom commands, auto-responders, starboard, and the
 * temp-VC system. The two bots talk to each other across the twin boundary via
 * `ask_eris` (HMAC-signed POSTs to Eris's `/api/twin/*` — see
 * `executors/advancedExecutor.js#callEris`).
 *
 * ## Dispatch flow
 * `executeTool(toolName, input, message)`:
 *   1. Normalize via `TOOL_ALIASES` (e.g. `play` → `play_music`, `ban` →
 *      `ban_user`) — covers common shorthand the model emits.
 *   2. Per-user rate-limit check (`checkToolRateLimit`).
 *   3. Read-tool cache lookup (`getCachedResult`) — list_channels / list_roles
 *      / get_server_info etc. are cached 15s per guild+args.
 *   4. Write-tool cache invalidation — scoped to the writing guild only.
 *   5. `_executeToolInner`:
 *      a. Guard against guild-required tools running in DMs
 *         (`GUILD_REQUIRED_TOOLS`).
 *      b. Build a shared `ctx` (guild, helpers, by-string) for sub-executors.
 *      c. Walk `SUB_EXECUTORS` in order — first one to return non-undefined
 *         wins. Each sub-executor owns a domain and short-circuits its own
 *         tool names.
 *      d. Fall back to the inline `switch` for tools not yet extracted into a
 *         sub-executor.
 *   6. Cache the result if the tool is in `CACHEABLE_TOOLS`.
 *
 * ## Category breakdown (sub-executors)
 *  - channelExecutor   — create/delete/edit channels, categories, threads
 *  - roleExecutor      — create/edit/give/remove roles, reaction roles, color picker
 *  - moderationExecutor — ban / kick / timeout / warn / purge / lockdown
 *  - voiceExecutor     — move/disconnect users in voice, voice listen toggle
 *  - setupExecutor     — welcome / autorole / starboard / tickets / verification
 *  - personalizeExecutor — server persona/avatar/banner, per-channel personality
 *  - audioExecutor     — music playback, queue, filters, lyrics mode, TTS
 *  - levelingExecutor  — XP toggles, level rewards, leaderboards
 *  - advancedExecutor  — twin coordination (`ask_eris`), web_search / web_read,
 *                        calculate, reminders, scheduled tasks, image gen
 *  - memoryExecutor    — remember_fact / recall / forget / directives
 *  - toggleExecutor    — feature flags (auto-responders, invite filter, etc.)
 *  - messageExecutor   — send_message, animated messages, snipe, find_message
 *  - serverExecutor    — server-level admin (whitelist, trust, log channel)
 * Inline cases handle the long tail (temp VC, custom commands, birthdays,
 * gifs, welcome customization, list_emojis, list_bans, random_member, etc.).
 *
 * ## Per-tool error contract
 * Tools return a user-facing string on success OR on expected failure
 * (e.g. `"Couldn't find role \"foo\""`, `"this only works in a server, not DMs"`).
 * The cache deliberately refuses to store strings that look like errors
 * (`/^(Error:|Couldn't|Failed|Sorry,|I don't have|No guild)/i`) so retries hit
 * the real handler. A handful of helpers (notably `callEris` and Eris-twin
 * responses) use `{ error: "..." }` objects internally — `erisErrorText` in
 * advancedExecutor normalizes those into the same user-facing string shape.
 * Unknown tools fall through to `"Unknown action: ${toolName}"`.
 *
 * ## Cross-references
 *  - Tool schemas:        `packages/irene/ai/tools.js`
 *  - Tool registry:       `packages/irene/ai/toolRegistry.js`
 *  - Rate limiter:        `packages/irene/utils/toolRateLimit.js`
 *  - Twin client/contract: `packages/irene/ai/executors/advancedExecutor.js`
 *  - Eris counterpart:    `packages/eris/ai/executor.js`
 *  - Reference test:      `packages/irene/tests/ai/executors/listEmojis.test.ts`
 *  - Twin signing test:   `packages/irene/tests/ai/executors/advancedExecutor.test.ts`
 */

// ─── Tool Execution Engine ──────────────────────────────────────────────────
// Thin router — delegates to domain-specific sub-executors, falls back to
// remaining inline cases for tools not yet extracted.

import { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from "discord.js";
import { setAfkSettings, setCreateVcChannel, getCustomCommand, setCustomCommand, deleteCustomCommand, listCustomCommands, isDmOptout, setDmOptout, setVcTemplate, setVcDefaultLimit, setVcTextChannels, setWelcomeEmbed, getWelcomeEmbed, getGuildSettings, setBirthdayChannel, setBirthdayRole, setBirthdayMessage, getBirthdayConfig, addToWhitelist, removeFromWhitelist, getWhitelist, setGifEmbed, logAudit, saveTempVc } from "../database.js";
import { buildWelcomeEmbed, parseEmbedColor } from "../events/guildMemberAdd.js";
import config from "../config.js";
import { checkToolRateLimit } from "../utils/toolRateLimit.js";
import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";
import { log } from "../utils/logger.js";
import { tempChannels, tempTextChannels, tempVcSeq, manualRenames } from "../utils/tempvc.js";

// ─── Sub-Executor Imports ───────────────────────────────────────────────────
import { execute as executeChannel } from "./executors/channelExecutor.js";
import { execute as executeRole } from "./executors/roleExecutor.js";
import { execute as executeModeration } from "./executors/moderationExecutor.js";
import { execute as executeVoice } from "./executors/voiceExecutor.js";
import { execute as executeSetup } from "./executors/setupExecutor.js";
import { execute as executePersonalize } from "./executors/personalizeExecutor.js";
import { execute as executeAudio } from "./executors/audioExecutor.js";
import { execute as executeLeveling } from "./executors/levelingExecutor.js";
import { execute as executeAdvanced } from "./executors/advancedExecutor.js";
import { execute as executeMemory } from "./executors/memoryExecutor.js";
import { execute as executeToggle } from "./executors/toggleExecutor.js";
import { execute as executeMessage } from "./executors/messageExecutor.js";
import { execute as executeServer } from "./executors/serverExecutor.js";

const SUB_EXECUTORS = [
  executeChannel,
  executeRole,
  executeModeration,
  executeVoice,
  executeSetup,
  executePersonalize,
  executeAudio,
  executeLeveling,
  executeAdvanced,
  executeMemory,
  executeToggle,
  executeMessage,
  executeServer,
];

const COLOR_NAMES = { white: "#FFFFFF", black: "#000000", red: "#FF0000", green: "#57F287", blue: "#5865F2", blurple: "#5865F2", yellow: "#FEE75C", orange: "#ED8E00", purple: "#9B59B6", pink: "#FF73FA", cyan: "#1ABC9C" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseHexColor(hex) {
  if (!hex) return undefined;
  return parseInt(hex.replace(/^#/, ""), 16);
}

// Per-guild name→member index, rebuilt lazily. Avoids O(n) Collection.find on
// every tool call for large guilds where parallel tools can multiply that cost.
// Invalidated on any member add/remove/update via invalidateMemberIndex().
const _memberIndexes = new Map(); // guildId → { index: Map<lower, member>, size, builtAt }
const MEMBER_INDEX_TTL = 10 * 60_000; // 10 min — rebuild if stale

// Normalize a name for the lookup index. NFKC collapses fullwidth/decorative
// fonts ("𝓐lice" → "Alice") so a user with a fancy nickname can still be
// addressed by the plain ASCII version.
function normalizeNameKey(name) {
  if (!name) return "";
  let n = String(name);
  try { n = n.normalize("NFKC"); } catch { /* keep raw */ }
  return n.toLowerCase().trim();
}

function buildMemberIndex(guild) {
  const index = new Map();      // normalized key → unique member
  const ambiguous = new Set();  // keys with two or more candidate members
  for (const m of guild.members.cache.values()) {
    const entries = [
      m.user.username,
      m.displayName,
      m.user.globalName,
      m.nickname,
    ];
    for (const raw of entries) {
      const key = normalizeNameKey(raw);
      if (!key) continue;
      const existing = index.get(key);
      if (existing && existing.id !== m.id) {
        // Two distinct members share this key — mark it ambiguous so callers
        // can refuse instead of silently picking whichever the cache iterator
        // yielded first. Two users named "alex" used to both resolve to the
        // same alex, locking the other out of any name-based command.
        ambiguous.add(key);
      } else if (!existing) {
        index.set(key, m);
      }
    }
  }
  const entry = { index, ambiguous, size: guild.members.cache.size, builtAt: Date.now() };
  _memberIndexes.set(guild.id, entry);
  return entry;
}

export function invalidateMemberIndex(guildId) {
  if (guildId) _memberIndexes.delete(guildId);
  else _memberIndexes.clear();
}

export function findMember(guild, username) {
  // Tools call findMember with whatever the LLM passed; if the model omitted
  // the field we'd previously crash with `undefined.match is not a function`,
  // taking the whole tool turn down. Return null so callers emit their normal
  // "Couldn't find user" string.
  if (username == null || username === "") return null;
  const u = String(username);
  // Resolve Discord mention format <@ID> or <@!ID> directly by ID
  const mentionMatch = u.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return guild.members.cache.get(mentionMatch[1]) ?? null;
  // Also handle bare numeric IDs
  if (/^\d{17,20}$/.test(u)) return guild.members.cache.get(u) ?? null;

  const key = normalizeNameKey(u.replace(/^@/, ""));
  if (!key) return null;

  // Use the per-guild name index (O(1)) — rebuild if stale or member count drifted
  let entry = _memberIndexes.get(guild.id);
  const now = Date.now();
  if (!entry || entry.size !== guild.members.cache.size || now - entry.builtAt > MEMBER_INDEX_TTL) {
    entry = buildMemberIndex(guild);
  }
  // Refuse ambiguous names — caller should report that disambiguation is
  // needed rather than silently picking one of the two users.
  if (entry.ambiguous?.has(key)) return null;
  return entry.index.get(key) ?? null;
}

// Variant that distinguishes "no such member" from "ambiguous". Some callers
// (e.g. moderation tools) want to surface a dedicated error so the user can
// retry by mention/ID. Returns { member, ambiguous, key }.
export function findMemberDetailed(guild, username) {
  if (username == null || username === "") return { member: null, ambiguous: false };
  const u = String(username);
  const mentionMatch = u.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return { member: guild.members.cache.get(mentionMatch[1]) ?? null, ambiguous: false };
  if (/^\d{17,20}$/.test(u)) return { member: guild.members.cache.get(u) ?? null, ambiguous: false };

  const key = normalizeNameKey(u.replace(/^@/, ""));
  if (!key) return { member: null, ambiguous: false };

  let entry = _memberIndexes.get(guild.id);
  const now = Date.now();
  if (!entry || entry.size !== guild.members.cache.size || now - entry.builtAt > MEMBER_INDEX_TTL) {
    entry = buildMemberIndex(guild);
  }
  if (entry.ambiguous?.has(key)) return { member: null, ambiguous: true, key };
  return { member: entry.index.get(key) ?? null, ambiguous: false, key };
}

function normalizeChannelLookupName(name) {
  return String(name || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s*\[(?:text|voice|stage|forum|category) channel,\s*id:\d{17,20}\]\s*$/i, "")
    .replace(/\s*\[id:\d{17,20}\]\s*$/i, "")
    .replace(/[\uFE00-\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function findChannel(guild, name, preferType) {
  if (!name) return null;
  // Handle bare numeric IDs and mention format directly
  const idMatch = String(name).match(/^(?:<#)?(\d{17,20})>?$/)
    || String(name).match(/\bid:(\d{17,20})\b/i)
    || String(name).match(/\[id:(\d{17,20})\]/i);
  if (idMatch) return guild.channels.cache.get(idMatch[1]) ?? null;

  const lower = normalizeChannelLookupName(name);
  const matches = guild.channels.cache.filter((c) => normalizeChannelLookupName(c.name) === lower);
  if (!matches.size) return null;
  if (matches.size === 1) return matches.first();

  // Prefer by explicit type if provided
  if (preferType !== undefined) {
    const typed = matches.find((c) => c.type === preferType);
    if (typed) return typed;
  }
  // Prefer text/voice over categories when ambiguous
  const nonCategory = matches.find((c) => c.type !== ChannelType.GuildCategory);
  return nonCategory ?? matches.first();
}

function requesterCurrentVoiceChannel(message) {
  return message?.member?.voice?.channel ?? null;
}

function wantsCurrentVoiceChannel(message) {
  const text = String(message?.content || "").toLowerCase();
  return /\b(this|current|my|the)\s+(vc|voice|voice channel)\b/.test(text)
    || /\b(vc|voice channel)\s+(i'?m|im|i am|we'?re|were|we are)\s+in\b/.test(text)
    || /\bset(?:up)?\s+this\s+(vc|voice)\b/.test(text)
    || /\b(turn|make|set|setup|configure|assign)\s+(this|that)(?:\s+(?:channel|vc|voice(?:\s+channel)?))?\s+(?:into|as|to be|a|an)\b/.test(text);
}

function createVcIntentTargetsExistingChannel(message) {
  const text = String(message?.content || "").toLowerCase();
  if (!/\b(create.?vc|join.?to.?create|create a vc|create vc|create a voice|create voice|creator vc|to be a create|be a create)\b/.test(text)) return false;
  if (!/\b(set|setup|set up|assign|make|turn|configure)\b/.test(text)) return false;
  return wantsCurrentVoiceChannel(message) || /\b(existing|already made|already exists|that channel|this channel)\b/.test(text);
}

function resolveCreateVcTriggerChannel(guild, input, message, fallbackName) {
  const requested = input.channel_id || input.channel_name || fallbackName;
  let ch = findChannel(guild, requested, ChannelType.GuildVoice);
  const currentVoice = requesterCurrentVoiceChannel(message);
  const currentRequested = !requested || /^(this|current|my|here|voice|vc|this vc|current vc|my vc)$/i.test(String(requested).trim());
  if ((!ch && wantsCurrentVoiceChannel(message)) || currentRequested) ch = currentVoice;
  return { ch, requested };
}

function configureCreateVcTrigger(guild, input, message, fallbackName) {
  const { ch, requested } = resolveCreateVcTriggerChannel(guild, input, message, fallbackName);
  if (!ch) return `Couldn't find channel "${requested || input.channel_name || "current voice channel"}"`;
  if (ch.type !== ChannelType.GuildVoice) return `"${ch.name}" isn't a voice channel`;
  setCreateVcChannel(guild.id, ch.id);
  return `Create-VC trigger set to "${ch.name}" - users who join it will get their own personal VC`;
}

export function findRole(guild, name) {
  const lower = name.toLowerCase().replace(/^@/, "");
  // Special case: @everyone role has the same ID as the guild
  if (lower === "everyone") return guild.roles.everyone;
  return guild.roles.cache.find((r) => r.name.toLowerCase() === lower && r.id !== guild.id);
}

/**
 * Resolve a comma-separated role name string into an array of role IDs.
 * e.g. "Streamer Pings, Announcements" → ["123", "456"]
 */
export function findRoles(guild, names) {
  if (!names) return [];
  const parts = names.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const name of parts) {
    const role = findRole(guild, name);
    if (role) ids.push(role.id);
  }
  return ids;
}

/**
 * Build a content string that mentions all given role IDs.
 * Normalises both single string IDs and arrays. Returns "" if none.
 */
export function buildPingContent(roleIds) {
  const arr = Array.isArray(roleIds) ? roleIds : (roleIds ? [roleIds] : []);
  if (!arr.length) return "";
  return arr.map((id) => `<@&${id}>`).join(" ");
}

const DURATION_MS = {
  "1m": 60_000, "5m": 300_000, "10m": 600_000, "30m": 1_800_000,
  "1h": 3_600_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "7d": 604_800_000,
};

// Strict hierarchy check for moderation actions (ban, kick, timeout, warn, nickname)
function checkHierarchy(moderator, target, guild) {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (target.id === guild.ownerId) return `Can't do that to the server owner`;
  if (target.id === moderator.id) return `Can't do that to yourself`;
  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles.highest.position;
  const targetTop = target.roles.highest.position;
  if (targetTop >= modTop) return `You can't moderate **${target.displayName}** — they're the same rank or higher than you`;
  return null;
}

// Smarter hierarchy check for role assignment — allows harmless self-assignment
const DANGEROUS_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MentionEveryone,
];

function checkRoleAssignment(moderator, target, role, guild) {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (target.id === guild.ownerId) return `Can't modify the server owner's roles`;
  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles.highest.position;

  // Self-assignment: allow if the role has no dangerous permissions
  if (target.id === moderator.id) {
    const isDangerous = DANGEROUS_PERMS.some((p) => role.permissions.has(p));
    if (!isDangerous) return null; // harmless role like "Druid Gremlin" — fine
    return `Can't assign **${role.name}** through me — Discord blocks bots from giving out roles with elevated permissions (admin/mod) as a safety measure. Go to **Server Settings > Roles** and drag it onto yourself manually.`;
  }

  // Cross-user: can't touch someone ranked same or higher
  const targetTop = target.roles.highest.position;
  if (targetTop >= modTop) return `You can't modify **${target.displayName}**'s roles — they're the same rank or higher`;

  // Can't assign a role ranked above your own
  if (role.position >= modTop) return `Can't assign **${role.name}** — it sits higher in the hierarchy than your top role. Go to **Server Settings > Roles** to assign it manually.`;

  return null;
}

// ─── Main Executor ──────────────────────────────────────────────────────────

// Complete tool name alias map — all 150+ Irene tools
const TOOL_ALIASES = {
  remember: "remember_fact", save_fact: "remember_fact", memorize: "remember_fact",
  forget: "forget_memory", clear_memories: "clear_all_memories", forget_everything: "clear_all_memories",
  recall: "recall_memories", memories: "recall_memories", facts: "recall_memories",
  play: "play_music", play_song: "play_music", music: "play_music", song: "play_music",
  skip: "skip_song", next: "skip_song", stop: "stop_music", pause: "pause_music", resume: "resume_music",
  queue: "music_queue", q: "music_queue", np: "now_playing", nowplaying: "now_playing", whats_playing: "now_playing",
  volume: "set_volume", vol: "set_volume", loop: "toggle_loop", repeat: "toggle_loop",
  shuffle: "shuffle_queue", filter: "music_filter", filters: "music_filter", bass: "music_filter", nightcore: "music_filter",
  lyrics: "start_lyrics_mode", lyrics_mode: "start_lyrics_mode", show_lyrics: "start_lyrics_mode", sing: "start_lyrics_mode",
  stop_lyrics: "stop_lyrics_mode", lyrics_off: "stop_lyrics_mode",
  auto_lyrics: "auto_lyrics_mode",
  tts: "toggle_tts", speak: "say_tts", say: "say_tts", tts_voice: "set_tts_voice",
  ban: "ban_user", kick: "kick_user", mute: "timeout_user", timeout: "timeout_user",
  warn: "warn_user",
  purge: "purge_messages", clear: "purge_messages", delete_messages: "purge_messages", clean: "purge_messages",
  lock: "lock_channel", unlock: "unlock_channel", lockdown: "lockdown_server",
  slowmode: "set_slowmode", slow: "set_slowmode",
  nickname: "set_nickname", nick: "set_nickname",
  find: "find_message", snipe: "snipe", deleted: "snipe", editsnipe: "editsnipe", edit_snipe: "editsnipe", esnipe: "editsnipe",
  disconnect: "disconnect_user_from_voice", dc: "disconnect_user_from_voice",
  move_user: "move_user_to_voice",
  topic: "set_channel_topic",
  add_role: "give_role", assign_role: "give_role",
  color_roles: "setup_color_roles",
  roles: "list_roles", channels: "list_channels", bans: "list_bans",
  reaction_roles: "setup_reaction_roles", role_picker: "setup_role_picker",
  nuke: "nuke_channel",
  serverinfo: "get_server_info", server: "get_server_info",
  userinfo: "get_user_info", whois: "get_user_info",
  who_has: "who_has_role", random_user: "random_member", random: "random_member",
  count: "count_members", emojis: "list_emojis", emoji: "add_emoji",
  invite: "create_invite", thread: "create_thread",
  message: "send_message", announce: "send_message",
  calc: "calculate", math: "calculate", calculator: "calculate",
  gif: "send_gif", reaction: "send_gif",
  search: "web_search", google: "web_search", lookup: "web_search",
  read_page: "web_read", scrape: "web_read",
  image: "generate_image", draw: "generate_image", generate: "generate_image", create_image: "generate_image",
  summarize: "summarize_channel", summary: "summarize_channel", what_did_i_miss: "summarize_channel",
  remind: "reminder_set", reminder: "reminder_set", cancel_reminder: "reminder_cancel",
  giveaway: "manage_giveaway", start_giveaway: "manage_giveaway",
  welcome: "customize_welcome", test_welcome: "send_test_welcome",
  birthday: "get_birthday", bday: "get_birthday", set_birthday: "set_birthday", birthdays: "list_birthdays",
  starboard: "setup_starboard", set_starboard: "setup_starboard", stats: "setup_stats_channels",
  ticket: "setup_ticket", verify: "setup_verification",
  autorole: "set_autorole", log_channel: "set_log_channel",
  leveling: "toggle_leveling", xp: "toggle_leveling", levels: "toggle_leveling",
  level_reward: "set_level_reward", remove_level: "remove_level_reward",
  vc: "vc_info", voice: "vc_info", claim_vc: "vc_claim",
  lock_vc: "vc_lock", unlock_vc: "vc_unlock", private_vc: "vc_private", public_vc: "vc_public",
  rename_vc: "vc_rename", transfer_vc: "vc_transfer", vc_boot: "vc_kick",
  voice_lb: "voice_leaderboard", vc_leaderboard: "voice_leaderboard",
  listen: "toggle_voice_listen", voice_listen: "toggle_voice_listen", wake_word: "toggle_voice_listen",
  youtube: "configure_youtube", yt: "configure_youtube",
  github_feed: "configure_github", twitch: "configure_twitch",
  patch_notes: "configure_patch_news", game_updates: "configure_patch_news",
  custom_command: "create_custom_command", add_command: "create_custom_command",
  edit_command: "edit_custom_command", delete_command: "delete_custom_command",
  commands: "list_custom_commands",
  auto_responder: "create_auto_responder", delete_responder: "delete_auto_responder",
  responders: "list_auto_responders",
  scrim: "manage_scrim", match: "manage_scrim", elo: "manage_scrim",
  eris: "ask_eris", ask_eris_twin: "ask_eris", evil_irene: "ask_eris", evil: "ask_eris", ask_evil: "ask_eris", ask_evil_irene: "ask_eris",
  twin: "toggle_twin_chat",
  persona: "set_server_persona", server_avatar: "set_server_avatar", server_banner: "set_server_banner",
  channel_persona: "set_channel_personality",
  whitelist: "whitelist_server", unwhitelist: "unwhitelist_server", whitelisted: "list_whitelist",
  trust: "trust_user", trusted: "list_trusted_users", untrust: "untrust_user",
};

// ─── Tool Result Cache ─────────────────────────────────────────────────────
const _toolCache = new Map();
const CACHE_TTL = 15_000; // 15 seconds
const CACHEABLE_TOOLS = new Set([
  "recall_memories", "get_server_info", "get_user_info",
  "list_channels", "list_roles", "get_role_permissions", "list_emojis",
  "list_bans", "count_members", "who_has_role", "random_member",
  "list_custom_commands", "list_auto_responders", "list_trusted_users",
  "list_whitelist", "music_queue", "now_playing", "vc_info",
  "get_birthday", "list_birthdays", "voice_leaderboard", "server_milestones",
  "list_invites", "invite_stats", "list_members", "list_pins", "list_directives",
]);
const CACHE_INVALIDATING_TOOLS = new Set([
  "create_channel", "delete_channel", "nuke_channel", "rename_channel",
  "set_channel_topic", "set_slowmode", "lock_channel", "unlock_channel",
  "move_channel", "clone_channel", "set_channel_permissions",
  "create_role", "delete_role", "edit_role", "give_role", "remove_role",
  "mass_role", "set_role_permissions", "reorder_roles",
  "ban_user", "kick_user", "warn_user", "timeout_user", "tempban", "set_nickname",
  "remember_fact", "forget_memory", "clear_all_memories",
  "create_custom_command", "edit_custom_command", "delete_custom_command",
  "create_auto_responder", "delete_auto_responder",
  "add_emoji", "remove_emoji",
  "set_birthday", "remove_birthday",
  "play_music", "skip_song", "stop_music", "set_volume",
  "save_directive", "remove_directive",
]);

function getCachedResult(toolName, args, guildId) {
  if (!CACHEABLE_TOOLS.has(toolName)) return null;
  // Include guildId in key — list_channels for guild A ≠ guild B
  const key = `${guildId || "dm"}:${toolName}:${JSON.stringify(args || {})}`;
  const entry = _toolCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.result;
  _toolCache.delete(key);
  return null;
}

function setCachedResult(toolName, args, guildId, result) {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  // Don't cache error strings — they'll be stale on retry and mask real failures
  if (typeof result === "string" && /^(Error:|Couldn't|Failed|Sorry,|I don't have|No guild)/i.test(result)) return;
  const key = `${guildId || "dm"}:${toolName}:${JSON.stringify(args || {})}`;
  _toolCache.set(key, { result, ts: Date.now() });
  if (_toolCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _toolCache) {
      if (now - v.ts > CACHE_TTL) _toolCache.delete(k);
    }
  }
}

// Per-guild invalidation — prevents one guild's mutation from busting cached
// reads for unrelated guilds. Cache keys are `${guildId}:${tool}:${argsJson}`,
// so we only need to drop entries that begin with this guild's prefix.
function invalidateGuildCache(guildId) {
  const prefix = `${guildId || "dm"}:`;
  for (const key of _toolCache.keys()) {
    if (key.startsWith(prefix)) _toolCache.delete(key);
  }
}

export async function executeTool(toolName, input, message) {
  input ||= {};
  // Auto-correct common Gemini tool name mistakes
  if (TOOL_ALIASES[toolName]) {
    log(`[EXECUTOR] Auto-corrected tool: ${toolName} → ${TOOL_ALIASES[toolName]}`);
    toolName = TOOL_ALIASES[toolName];
  }

  const userId = message?.author?.id;
  if (userId) {
    const rateCheck = checkToolRateLimit(userId, toolName);
    if (!rateCheck.allowed) {
      const secs = Math.ceil(rateCheck.retryAfterMs / 1000);
      return `chill — you're using ${toolName} too fast. try again in ${secs}s`;
    }
  }

  const guildId = message?.guild?.id;

  // Check cache for read-only tools
  const cached = getCachedResult(toolName, input, guildId);
  if (cached !== null) {
    log(`[EXECUTOR] Cache hit: ${toolName}`);
    return cached;
  }

  // Invalidate cache on write operations — scoped to this guild only.
  // Previously this cleared the entire cache across all guilds, so a write in
  // guild A wiped cached `list_roles` etc. for guild B, defeating the point of
  // the per-guild key prefix.
  if (CACHE_INVALIDATING_TOOLS.has(toolName)) invalidateGuildCache(guildId);

  const result = await _executeToolInner(toolName, input, message);
  setCachedResult(toolName, input, guildId, result);
  return result;
}

// Tools that absolutely need a guild context — every server-management tool.
// Tools NOT on this list (memory, web_search, calculate, ask_eris, etc.) are
// safe to run from DMs. Use this set instead of relying on each handler to
// guard `guild` itself, since most inline cases dereference guild.* directly.
const GUILD_REQUIRED_TOOLS = new Set([
  "create_channel", "delete_channel", "nuke_channel", "rename_channel", "clone_channel",
  "set_channel_topic", "set_slowmode", "lock_channel", "unlock_channel",
  "move_channel", "set_channel_permissions", "create_category", "delete_category",
  "create_role", "delete_role", "edit_role", "give_role", "remove_role",
  "mass_role", "set_role_permissions", "reorder_roles", "list_roles",
  "setup_reaction_roles", "add_reaction_role", "remove_reaction_role",
  "setup_role_picker", "setup_dropdown_roles", "setup_color_roles",
  "ban_user", "kick_user", "warn_user", "timeout_user", "tempban", "unban_user",
  "set_nickname", "purge_messages", "lockdown_server", "unlock_server", "find_message",
  "move_user_to_voice", "disconnect_user_from_voice",
  "set_create_vc_channel", "set_vc_template", "set_vc_default_limit",
  "set_vc_naming_mode", "toggle_vc_rich_presence", "set_afk_channel",
  "set_welcome_channel", "customize_welcome", "set_access_role", "setup_verification",
  "trust_user", "untrust_user", "list_trusted_users", "set_log_channel",
  "set_autorole", "whitelist_server", "unwhitelist_server", "list_whitelist",
  "set_dm_results", "set_dm_welcome", "set_leave_channel",
  "set_server_avatar", "set_server_banner", "set_server_persona",
  "set_channel_personality", "set_bad_words", "set_escalation",
  "setup_stats_channels", "setup_starboard", "toggle_auto_responders",
  "toggle_twin_chat", "toggle_voice_tracking", "setup_ticket",
  "configure_suggestions", "sticky_message", "remove_sticky", "toggle_invite_filter",
  "configure_patch_news", "configure_twitch", "configure_youtube",
  "configure_github", "configure_giveaway_pings", "test_patch_news",
  "configure_birthdays", "send_test_birthday", "send_test_welcome",
  "send_message", "send_animated_message", "create_thread",
  "add_emoji", "remove_emoji", "create_invite", "list_invites", "delete_invite",
  "invite_stats", "set_server_settings", "set_server_icon", "view_audit_log",
  "list_members", "list_channels", "list_emojis", "list_bans",
  "get_server_info", "get_role_permissions", "random_member", "count_members",
  "who_has_role", "get_user_info",
  "set_level_reward", "remove_level_reward", "toggle_leveling",
  "set_level_channel", "set_level_ping_roles", "voice_leaderboard", "server_milestones",
  "create_custom_command", "edit_custom_command", "delete_custom_command",
  "list_custom_commands",
  "create_auto_responder", "list_auto_responders", "delete_auto_responder",
  "manage_giveaway", "manage_scrim",
  "edit_message", "delete_message", "read_messages", "search_messages",
  "pin_message", "unpin_message", "list_pins",
  "react_to_message", "remove_reaction",
  "save_directive", "list_directives", "remove_directive",
  "vc_info", "vc_private", "vc_public", "vc_lock", "vc_unlock", "vc_rename",
  "vc_transfer", "vc_kick", "vc_allow", "vc_claim",
  "set_birthday", "get_birthday", "list_birthdays", "remove_birthday",
  "summarize_channel",
]);

async function _executeToolInner(toolName, input, message) {
  const guild = message.guild;
  // Guard tools that can't run in DMs. Without this, the inline switch and
  // several sub-executors crash on `guild.something` or `findChannel(undefined)`.
  if (!guild && GUILD_REQUIRED_TOOLS.has(toolName)) {
    return "this only works in a server, not DMs";
  }
  const by = `by Irene for ${message.author?.username || "user"}`;

  // ─── Build shared context for sub-executors ─────────────────────────
  const ctx = {
    guild,
    by,
    findMember,
    findChannel,
    findRole,
    findRoles,
    buildPingContent,
    parseHexColor,
    checkHierarchy,
    checkRoleAssignment,
    webRateLimitPerMin: config.webRateLimitPerMin || 10,
  };

  if (toolName === "create_channel" && createVcIntentTargetsExistingChannel(message)) {
    return "not creating a new channel — this request is to configure the existing/current voice channel. use set_create_vc_channel with channel_id or the user's current VC.";
  }

  if (toolName === "set_vc_template" && createVcIntentTargetsExistingChannel(message)) {
    return configureCreateVcTrigger(guild, input, message, input.template);
  }

  // ─── Try domain sub-executors first ─────────────────────────────────
  for (const executor of SUB_EXECUTORS) {
    const result = await executor(toolName, input, message, ctx);
    if (result !== undefined) return result;
  }

  // ─── Remaining inline cases ─────────────────────────────────────────
  switch (toolName) {
    // ─── Temp VC Management ──────────────────────────────────────────
    case "vc_private":
    case "vc_public":
    case "vc_lock":
    case "vc_unlock":
    case "vc_rename":
    case "vc_transfer":
    case "vc_kick":
    case "vc_allow":
    case "vc_claim": {
      const caller = message.member;
      const voiceCh = caller?.voice?.channel;
      if (!voiceCh) return "you're not in a voice channel";

      const isAdmin = caller.permissions.has(PermissionFlagsBits.Administrator) || caller.id === guild.ownerId;
      const ownerId = tempChannels.get(voiceCh.id);
      const isOwner = ownerId === caller.id;
      const isTempVc = tempChannels.has(voiceCh.id);

      if (toolName === "vc_claim") {
        if (!isTempVc) return "this isn't a temp VC";
        if (ownerId && voiceCh.members.has(ownerId)) return "the owner is still in the channel — can't claim";
        // Update Discord first — if this throws, state is untouched
        await voiceCh.permissionOverwrites.edit(caller, {
          ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true,
          ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true,
        });
        tempChannels.set(voiceCh.id, caller.id);
        manualRenames.delete(voiceCh.id); // new owner — let auto-renamer pick up their game
        saveTempVc(voiceCh.id, { ownerId: caller.id, guildId: guild.id, seq: tempVcSeq.get(voiceCh.id) ?? 1, textChannelId: tempTextChannels.get(voiceCh.id) ?? null });
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        const { queueRename } = await import("../utils/vcrenamer.js");
        queueRename(voiceCh, guild);
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `you now own **${voiceCh.name}**`;
      }

      if (!isTempVc && !isAdmin) return "this isn't a temp VC";
      if (!isOwner && !isAdmin) return "you don't own this channel";

      if (toolName === "vc_private") {
        // Both Connect AND ViewChannel false — matches the panel's Private definition
        await voiceCh.permissionOverwrites.edit(guild.roles.everyone, { Connect: false, ViewChannel: false });
        for (const [, m] of voiceCh.members) {
          if (!m.user.bot) await voiceCh.permissionOverwrites.edit(m, { Connect: true, ViewChannel: true }).catch(() => {});
        }
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔒 **${voiceCh.name}** is now private — only current members can see and rejoin`;
      }

      if (toolName === "vc_public") {
        await voiceCh.permissionOverwrites.edit(guild.roles.everyone, { Connect: null, ViewChannel: null });
        for (const [, m] of voiceCh.members) {
          if (!m.user.bot) await voiceCh.permissionOverwrites.delete(m).catch(() => {});
        }
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔓 **${voiceCh.name}** is now public`;
      }

      if (toolName === "vc_lock") {
        const limit = input.limit ?? voiceCh.members.filter((m) => !m.user.bot).size;
        await voiceCh.setUserLimit(limit);
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔒 **${voiceCh.name}** locked to ${limit} users`;
      }

      if (toolName === "vc_unlock") {
        await voiceCh.setUserLimit(0);
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `🔓 **${voiceCh.name}** limit removed`;
      }

      if (toolName === "vc_rename") {
        if (!input.name) return "no name provided";
        const trimmedName = input.name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 100) return "channel name must be between 2 and 100 characters";
        await voiceCh.setName(trimmedName);
        // Lock the auto-renamer so it doesn't immediately overwrite the AI's rename
        manualRenames.set(voiceCh.id, Date.now());
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `renamed to **${trimmedName}**`;
      }

      if (toolName === "vc_transfer") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        if (!voiceCh.members.has(target.id)) return `${target.user.tag} isn't in your channel`;
        if (target.id === caller.id) return "that's already you";
        // Update Discord first — if this throws, state is untouched
        await voiceCh.permissionOverwrites.edit(target, {
          ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true,
          ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true,
        });
        await voiceCh.permissionOverwrites.edit(caller, {
          ManageChannels: null, MoveMembers: null, MuteMembers: null, DeafenMembers: null,
        }).catch(() => {});
        tempChannels.set(voiceCh.id, target.id);
        manualRenames.delete(voiceCh.id); // new owner — let auto-renamer pick up their game
        saveTempVc(voiceCh.id, { ownerId: target.id, guildId: guild.id, seq: tempVcSeq.get(voiceCh.id) ?? 1, textChannelId: tempTextChannels.get(voiceCh.id) ?? null });
        const { updateControlPanel } = await import("../utils/vcpanel.js");
        const { queueRename } = await import("../utils/vcrenamer.js");
        queueRename(voiceCh, guild);
        updateControlPanel(voiceCh.id, guild).catch(() => {});
        return `transferred ownership of **${voiceCh.name}** to ${target.user.tag}`;
      }

      if (toolName === "vc_kick") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        if (!voiceCh.members.has(target.id)) return `${target.user.tag} isn't in your channel`;
        if (target.id === caller.id) return "you can't kick yourself";
        if (target.id === ownerId) return "you can't kick the channel owner";
        await target.voice.disconnect(`Kicked from VC by ${caller.user.tag}`);
        if (input.ban) await voiceCh.permissionOverwrites.edit(target, { Connect: false });
        const { updateControlPanel: ucpKick } = await import("../utils/vcpanel.js");
        ucpKick(voiceCh.id, guild).catch(() => {});
        return `kicked ${target.user.tag} from **${voiceCh.name}**${input.ban ? " and banned from rejoining" : ""}`;
      }

      if (toolName === "vc_allow") {
        const target = findMember(guild, input.username);
        if (!target) return `Couldn't find user "${input.username}"`;
        await voiceCh.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
        const { updateControlPanel: ucpAllow } = await import("../utils/vcpanel.js");
        ucpAllow(voiceCh.id, guild).catch(() => {});
        return `${target.user.tag} can now join **${voiceCh.name}**`;
      }

      return `Unknown VC action: ${toolName}`;
    }

    case "set_create_vc_channel": {
      return configureCreateVcTrigger(guild, input, message);
    }

    case "set_afk_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (ch.type !== ChannelType.GuildVoice) return `"${ch.name}" isn't a voice channel`;
      const minutes = input.timeout_minutes || 30;
      setAfkSettings(guild.id, ch.id, minutes);
      await guild.setAFKChannel(ch.id).catch(() => {});
      await guild.setAFKTimeout(Math.min(minutes * 60, 3600)).catch(() => {});
      return `AFK channel set to "${ch.name}" — users who self-deafen for ${minutes} minute${minutes !== 1 ? "s" : ""} will be moved there automatically`;
    }

    case "set_vc_template": {
      setVcTemplate(guild.id, input.template);
      return (
        `VC template set to: \`${input.template}\`\n` +
        `**Name vars:** \`{creator}\` \`{game}\` \`{game|Fallback Text}\` \`{server}\` \`{stream}\` \`@@nato@@\`\n` +
        `**Count vars:** \`@@num@@\` (total users) \`@@num_others@@\` (excluding creator)\n` +
        `**Numbering:** \`##\` (#1) \`$#\` (1) \`+#\` (I) \`$0#\` (01) \`$00#\` (001)\n` +
        `**Singular/plural:** \`<<mouse/mice>>\` (uses @@num@@) \`<<mouse\\\\mice>>\` (uses @@num_others@@)\n` +
        `**Random word:** \`[[Squad/Team/Party]]\``
      );
    }

    case "set_vc_default_limit": {
      setVcDefaultLimit(guild.id, input.limit);
      return input.limit > 0 ? `New temp VCs will have a default limit of ${input.limit} users` : `Default VC limit removed — new VCs will be unlimited`;
    }

    case "set_vc_naming_mode": {
      const { setVcNamingMode } = await import("../database.js");
      const mode = input.mode;
      if (!["smart", "anonymous", "random"].includes(mode)) return `Invalid mode "${mode}" — use smart, anonymous, or random`;
      setVcNamingMode(guild.id, mode);
      const modeDesc = {
        smart: "**Smart** — shows the creator's name (e.g. `Valorant • eating's vc`)",
        anonymous: "**Anonymous** — numbered VCs, no names (e.g. `Valorant • VC #1`)",
        random: "**Random** — themed names (e.g. `The Lounge • Alpha`, `Chill Zone • Bravo`)",
      };
      return `VC naming mode set to ${modeDesc[mode]}`;
    }

    case "toggle_vc_rich_presence": {
      const { setVcRichPresence } = await import("../database.js");
      setVcRichPresence(guild.id, input.enabled);
      return input.enabled
        ? `Rich presence enabled in VC names — they will now show details like "Marvel Rivals: In Combat"`
        : `Rich presence disabled in VC names — they will now only show the base game name like "Marvel Rivals"`;
    }

    // ─── Directives: persistent behavioral rules ───────────────────
    case "save_directive": {
      const { addDirective } = await import("../database.js");
      const directive = String(input.directive || "").trim();
      if (!directive) return "give me the rule text — what should i remember to do?";
      if (directive.length > 500) return "directive is too long (max 500 chars)";
      let channelId = null;
      if (input.channel_name) {
        const ch = findChannel(guild, input.channel_id || input.channel_name);
        if (ch) channelId = ch.id;
      }
      const result = addDirective(guild.id, directive, channelId, message.author.id);
      if (!result.success) return result.reason;
      return `saved directive #${result.index + 1}: "${directive}"${channelId ? ` (applies to <#${channelId}>)` : " (server-wide)"}`;
    }

    case "list_directives": {
      const { getDirectives } = await import("../database.js");
      const directives = getDirectives(guild.id);
      if (!directives.length) return "no directives saved for this server";
      return directives.map((d, i) => `${i + 1}. ${d.text}${d.channel ? ` (channel: <#${d.channel}>)` : ""}`).join("\n");
    }

    case "remove_directive": {
      const { removeDirective } = await import("../database.js");
      const keyword = String(input.keyword || "").trim();
      if (!keyword) return "give me a directive number or keyword to remove";
      const idx = /^\d+$/.test(keyword) ? parseInt(keyword, 10) - 1 : keyword;
      const result = removeDirective(guild.id, idx);
      if (!result.success) return result.reason;
      return `removed directive: "${result.removed}"`;
    }

    // ─── Relationship / Mood Management ────────────────────────────
    case "adjust_relationship": {
      const { getRelationship, updateRelationship } = await import("../database.js");
      let userId = input.user_id || input.userId || input.username;
      if (!userId) return "need a user_id to adjust relationship";
      // Models often pass a username instead of a snowflake — resolve it via
      // the guild member index so we don't end up keying affinity off literal
      // strings (and the `<@username>` mention won't render as a ping).
      if (guild && !/^\d{17,20}$/.test(String(userId))) {
        const member = findMember(guild, userId);
        if (member) userId = member.id;
        else return `couldn't find user "${userId}"`;
      }
      if (input.reset) {
        const current = getRelationship(userId);
        updateRelationship(userId, -current.affinity_score);
        return `relationship with <@${userId}> reset to neutral. ${input.reason || ""}`.trim();
      }
      // Clamp per-call delta so a hallucinated tool-call with affinity_delta
      // like 9999 can't yeet a relationship to max in one shot. Relationship
      // changes should feel earned, not magic-number'd.
      const rawDelta = Number(input.affinity_delta) || 0;
      const delta = Math.max(-25, Math.min(25, Math.round(rawDelta)));
      updateRelationship(userId, delta);
      const after = getRelationship(userId);
      const label = after.affinity_score > 50 ? "bestie" : after.affinity_score > 20 ? "friend" : after.affinity_score > 0 ? "acquaintance" : after.affinity_score > -30 ? "neutral" : "enemy";
      return `adjusted feelings toward <@${userId}> by ${delta > 0 ? "+" : ""}${delta}. now: ${label} (${after.affinity_score}). ${input.reason || ""}`.trim();
    }

    case "adjust_mood": {
      const { shiftMood: shift, getMood: mood } = await import("../database.js");
      // Same clamp for mood/energy — these are -100..100 ranges; a single tool
      // call shouldn't move the needle more than 30 points.
      const moodD = Math.max(-30, Math.min(30, Math.round(Number(input.mood_delta) || 0)));
      const energyD = Math.max(-30, Math.min(30, Math.round(Number(input.energy_delta) || 0)));
      shift(moodD, energyD);
      const after = mood();
      return `mood shifted by ${moodD > 0 ? "+" : ""}${moodD}, energy by ${energyD > 0 ? "+" : ""}${energyD}. now: mood ${after.mood_score}, energy ${after.energy}. ${input.reason || ""}`.trim();
    }

    // ─── Messaging ───────────────────────────────────────────────────
    case "send_message": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const hasEmbed = input.embed_title || input.embed_description || input.embed_image || input.embed_fields;
      if (hasEmbed) {
        const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, cyan: 0x1abc9c, teal: 0x1abc9c, gold: 0xF1C40F, magenta: 0xE91E63 };
        let color = 0x2b2d31; // default: dark embed (blends with Discord dark mode)
        if (input.embed_color) {
          const lower = input.embed_color.toLowerCase().trim();
          if (NAMED_COLORS[lower]) color = NAMED_COLORS[lower];
          else {
            const parsed = parseInt(lower.replace(/^#|^0x/, ""), 16);
            if (!isNaN(parsed)) color = parsed;
          }
        }
        const embed = new EmbedBuilder().setColor(color);
        if (input.embed_title) embed.setTitle(input.embed_title.substring(0, 256));
        if (input.embed_description) embed.setDescription(input.embed_description.replace(/\\n/g, "\n").substring(0, 4096));
        else if (input.content && input.embed_title) embed.setDescription(input.content.replace(/\\n/g, "\n").substring(0, 4096));
        if (input.embed_image) embed.setImage(input.embed_image);
        if (input.embed_thumbnail) embed.setThumbnail(input.embed_thumbnail);
        if (input.embed_author) embed.setAuthor({ name: input.embed_author.substring(0, 256), iconURL: input.embed_author_icon || undefined });
        if (input.embed_footer) embed.setFooter({ text: input.embed_footer.substring(0, 2048), iconURL: input.embed_footer_icon || undefined });
        if (input.embed_timestamp) embed.setTimestamp();
        if (Array.isArray(input.embed_fields)) {
          const fields = input.embed_fields.slice(0, 25).map(f => ({
            name: String(f.name).replace(/\\n/g, "\n").substring(0, 256),
            value: String(f.value).replace(/\\n/g, "\n").substring(0, 1024),
            inline: !!f.inline,
          }));
          embed.addFields(...fields);
        }

        // Build optional components (buttons + dropdown)
        const components = [];
        const BUTTON_STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, link: ButtonStyle.Link };

        // Known actions map AI-chosen action names to customIds that existing
        // interactionCreate handlers already route. Extending this list is how
        // you give the AI new functional buttons in custom panels.
        const BUTTON_ACTIONS = {
          open_ticket: "ticket_create",
        };

        if (Array.isArray(input.buttons) && input.buttons.length) {
          for (let i = 0; i < input.buttons.length; i += 5) {
            const slice = input.buttons.slice(i, i + 5);
            const row = new ActionRowBuilder().addComponents(
              slice.map((b, idx) => {
                const btn = new ButtonBuilder()
                  .setLabel((b.emoji ? `${b.emoji} ` : "") + (b.label || "Button").slice(0, 80))
                  .setStyle(BUTTON_STYLES[b.style] || ButtonStyle.Secondary);
                if (b.style === "link" && b.url) {
                  btn.setURL(b.url);
                } else if (b.action && BUTTON_ACTIONS[b.action]) {
                  btn.setCustomId(BUTTON_ACTIONS[b.action]);
                } else if (b.role_id) {
                  btn.setCustomId(`toggle_role:${b.role_id}`);
                } else {
                  // No handler — tag the customId so our fallback can recognize
                  // and ack it gracefully (instead of Discord showing "This
                  // interaction failed" after the 3s token window expires).
                  btn.setCustomId(`btn_inert:${Date.now()}:${i + idx}`);
                }
                return btn;
              })
            );
            components.push(row);
          }
        }

        if (input.dropdown?.options?.length) {
          const d = input.dropdown;
          const exclusive = d.exclusive ?? false;
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`dropdown_role:${exclusive ? "exclusive" : "multi"}`)
            .setPlaceholder(d.placeholder || "Select...")
            .setMinValues(d.min ?? (exclusive ? 1 : 0))
            .setMaxValues(d.max ?? (exclusive ? 1 : d.options.length));
          for (const opt of d.options.slice(0, 25)) {
            const o = new StringSelectMenuOptionBuilder()
              .setLabel(opt.label || "Option")
              .setValue(opt.role_id || opt.label);
            if (opt.description) o.setDescription(opt.description.slice(0, 100));
            if (opt.emoji) o.setEmoji(opt.emoji);
            menu.addOptions(o);
          }
          components.push(new ActionRowBuilder().addComponents(menu));
        }

        try {
          const sendPayload = { embeds: [embed] };
          if (components.length) sendPayload.components = components;
          // content goes above the embed as plain text (for pings, etc.)
          if (input.content && input.embed_description) sendPayload.content = input.content.substring(0, 2000);
          await ch.send(sendPayload);
        } catch (e) {
          await ch.send(`**${input.embed_title || ""}**\n${input.embed_description || input.content || ""}`).catch(() => {});
          return `Sent as plain text (embed failed: ${e.message})`;
        }
      } else {
        await ch.send((input.content || "").substring(0, 2000));
      }
      return `Sent message to #${ch.name}`;
    }

    case "send_animated_message": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const {
        animateEmbed, typewriterFrames, progressBarFrames, countdownFrames,
        revealFrames, loadingFrames, sparkleFrames, statusFrames,
        giveawayRevealFrames, pollResultFrames, alertFrames,
      } = await import("../utils/animate.js");

      // Parse color
      const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, gold: 0xF1C40F };
      let color = undefined;
      if (input.color) {
        const lower = input.color.toLowerCase().trim();
        if (NAMED_COLORS[lower]) color = NAMED_COLORS[lower];
        else { const p = parseInt(lower.replace(/^#|^0x/, ""), 16); if (!isNaN(p)) color = p; }
      }

      let frames;
      const text = (input.text || "").replace(/\\n/g, "\n");
      switch (input.animation) {
        case "typewriter":
          frames = typewriterFrames(input.title, text, { color });
          break;
        case "progress":
          frames = progressBarFrames(input.title, text, { color });
          break;
        case "countdown":
          frames = countdownFrames(3, input.end_title || "GO!", { color, subtitle: text });
          break;
        case "reveal":
          frames = revealFrames(input.title, text, { color, revealColor: color });
          break;
        case "loading":
          frames = loadingFrames(input.title, { color });
          break;
        case "sparkle":
          frames = sparkleFrames(input.title, text, { color });
          break;
        case "status":
          frames = statusFrames(input.title, text.split("|").map(s => s.trim()), { color });
          break;
        case "giveaway":
          frames = giveawayRevealFrames(input.title, input.winner || "???", { color });
          break;
        case "poll_results":
          if (!Array.isArray(input.poll_options)) return "poll_results needs poll_options array";
          frames = pollResultFrames(input.title, input.poll_options, { color });
          break;
        case "alert":
          frames = alertFrames(input.title, text, { color });
          break;
        default:
          return `Unknown animation type: ${input.animation}`;
      }
      if (!frames?.length) return "No frames generated";
      await animateEmbed(ch, frames, 1000);
      return `Sent animated ${input.animation} embed to #${ch.name}`;
    }

    case "create_thread": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const thread = await ch.threads.create({ name: input.name, autoArchiveDuration: parseInt(input.auto_archive) || 1440, reason: `Created ${by}` });
      return `Created thread "${thread.name}" in #${ch.name}`;
    }

    // ─── Emoji ───────────────────────────────────────────────────────
    case "add_emoji": {
      const emoji = await guild.emojis.create({ attachment: input.url, name: input.name, reason: `Added ${by}` });
      return `Added emoji :${emoji.name}:`;
    }

    case "remove_emoji": {
      const emoji = guild.emojis.cache.find((e) => e.name.toLowerCase() === input.name.toLowerCase());
      if (!emoji) return `Couldn't find emoji "${input.name}"`;
      await emoji.delete(`Removed ${by}`);
      return `Removed emoji :${input.name}:`;
    }

    // ─── Invites ─────────────────────────────────────────────────────
    case "create_invite": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const invite = await ch.createInvite({
        maxUses: input.max_uses || 0,
        maxAge: input.max_age ?? 0,
        temporary: input.temporary || false,
        reason: `Created ${by}`,
      });
      return `Created invite: https://discord.gg/${invite.code}${input.max_uses ? ` (${input.max_uses} uses)` : ""}${input.max_age ? ` (expires in ${input.max_age}s)` : " (never expires)"}`;
    }

    // ─── Custom Commands ─────────────────────────────────────────────
    case "create_custom_command": {
      const existing = getCustomCommand(guild.id, input.trigger);
      if (existing) return `!${input.trigger} already exists. Use edit_custom_command to modify it.`;
      const colorNames = COLOR_NAMES;
      let embedColor = null;
      if (input.embed_color) {
        const raw = input.embed_color.toLowerCase().trim();
        if (raw && raw !== "none") {
          embedColor = colorNames[raw] ?? (raw.startsWith("#") ? raw : `#${raw}`);
        }
      }
      setCustomCommand(guild.id, input.trigger, {
        description: input.description, response: input.response,
        role_to_give: input.role_to_give || null, role_to_remove: input.role_to_remove || null,
        embed_title: input.embed_title || null, embed_color: embedColor,
        embed_url: input.embed_url || null, embed_image: input.embed_image || null,
        embed_thumbnail: input.embed_thumbnail || null, embed_footer: input.embed_footer || null,
        embed_author: input.embed_author || null, embed_author_icon: input.embed_author_icon || null,
        admin_only: input.admin_only || false, auto_delete: input.auto_delete || false,
        created_by: message.author.id,
      });
      return `Created command !${input.trigger}`;
    }

    case "edit_custom_command": {
      const cmd = getCustomCommand(guild.id, input.trigger);
      if (!cmd) return `!${input.trigger} doesn't exist`;
      const updated = { ...cmd };
      if (input.cmd_description !== undefined) updated.description = input.cmd_description || null;
      for (const key of ["response", "role_to_give", "role_to_remove"]) {
        if (input[key] !== undefined) updated[key] = input[key] || null;
      }
      // Booleans must not be coerced — false || null would wrongly store null
      for (const key of ["admin_only", "auto_delete"]) {
        if (input[key] !== undefined) updated[key] = input[key];
      }
      for (const key of ["embed_title", "embed_url", "embed_image", "embed_thumbnail", "embed_footer", "embed_author", "embed_author_icon"]) {
        if (input[key] !== undefined) updated[key] = input[key] === "none" ? null : (input[key] || null);
      }
      if (input.embed_color !== undefined) {
        const raw = input.embed_color?.toLowerCase().trim();
        if (!raw || raw === "none") {
          updated.embed_color = null;
        } else {
          updated.embed_color = COLOR_NAMES[raw] ?? (raw.startsWith("#") ? raw : `#${raw}`);
        }
      }
      setCustomCommand(guild.id, input.trigger, updated);
      return `Updated !${input.trigger}`;
    }

    case "delete_custom_command": {
      return deleteCustomCommand(guild.id, input.trigger) ? `Deleted !${input.trigger}` : `!${input.trigger} doesn't exist`;
    }

    case "list_custom_commands": {
      const cmds = listCustomCommands(guild.id);
      if (!cmds.length) return "No custom commands yet";
      return cmds.map((c) => `!${c.trigger} — ${c.description}${c.admin_only ? " (admin only)" : ""}`).join("\n");
    }

    // ─── Welcome Customization ───────────────────────────────────────
    case "customize_welcome": {
      if (input.reset) {
        setWelcomeEmbed(guild.id, null);
        return "Welcome embed reset to defaults.";
      }

      const patch = {};
      const colorFields = ["color"];
      const boolFields  = ["show_title","show_thumbnail","show_banner","show_author","show_footer","show_timestamp","show_member_field","show_age_field","show_joined_field","ping_user"];
      const strFields   = ["title","title_url","description","content","thumbnail_url","banner_url","author_name","author_icon_url","author_url","footer_text","footer_icon_url","member_field_name","age_field_name","joined_field_name"];

      for (const f of colorFields) {
        if (input[f] !== undefined) {
          const parsed = parseEmbedColor(input[f]);
          if (parsed !== null) patch[f] = input[f];
          else return `Unknown color "${input[f]}" — use a hex (#FF0000) or a name like red, blue, white, purple…`;
        }
      }
      for (const f of boolFields) if (input[f] !== undefined) patch[f] = input[f];
      for (const f of strFields) {
        if (input[f] !== undefined) {
          patch[f] = (input[f] === "default" || input[f] === "none") ? null : input[f];
        }
      }
      if (input.extra_fields !== undefined) patch.extra_fields = input.extra_fields;

      if (input.ping_roles !== undefined) {
        if (input.ping_roles === "none" || input.ping_roles === "") {
          patch.ping_role_ids = [];
        } else {
          const roleIds = findRoles(guild, input.ping_roles);
          if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
          patch.ping_role_ids = roleIds;
        }
      }

      if (!Object.keys(patch).length) return "Nothing to update — pass at least one option.";

      setWelcomeEmbed(guild.id, patch);

      const changed = Object.keys(patch).map((k) => {
        const v = patch[k];
        if (typeof v === "boolean") return `${k}: ${v ? "on" : "off"}`;
        if (v === null) return `${k}: reset to default`;
        if (Array.isArray(v)) return `${k}: ${v.length} field(s)`;
        return `${k}: ${v}`;
      });
      return `Welcome embed updated ✓\n${changed.join("\n")}\n\nUse send_test_welcome to preview it.`;
    }

    // ─── Birthday Tools ─────────────────────────────────────────────
    case "set_birthday": {
      const { setBirthday, getBirthday: getBday } = await import("../database.js");
      let targetId = message.author.id;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
      }
      const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const m = Math.floor(input.month);
      const d = Math.floor(input.day);
      const y = input.year ? Math.floor(input.year) : null;
      if (m < 1 || m > 12) return "Month must be 1–12.";
      if (d < 1 || d > DAYS_IN_MONTH[m]) return `${MONTHS[m]} only has ${DAYS_IN_MONTH[m]} days.`;
      if (m === 2 && d === 29 && y) {
        const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
        if (!isLeap) return `${y} wasn't a leap year — Feb only had 28 days`;
      }
      if (y && (y < 1900 || y > new Date().getFullYear())) return `Year ${y} doesn't seem right.`;
      setBirthday(targetId, guild.id, m, d, y);
      const who = targetId === message.author.id ? "Your" : `<@${targetId}>'s`;
      const dateStr = y ? `**${MONTHS[m]} ${d}, ${y}**` : `**${MONTHS[m]} ${d}**`;
      let extra = "";
      if (y) {
        const today = new Date();
        let age = today.getFullYear() - y;
        if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
        extra += ` (currently ${age} years old, turning ${age + 1} on their next birthday)`;
      }
      const today = new Date();
      const nextBday = new Date(today.getFullYear(), m - 1, d);
      if (nextBday <= today) nextBday.setFullYear(today.getFullYear() + 1);
      const daysUntil = Math.ceil((nextBday - today) / 86_400_000);
      if (daysUntil === 0) extra += " — that's today! 🎉";
      else if (daysUntil === 1) extra += " — that's tomorrow!";
      else extra += ` — ${daysUntil} days away`;
      return `${who} birthday has been saved as ${dateStr}${extra} 🎂`;
    }

    case "get_birthday": {
      const { getBirthday: getBday } = await import("../database.js");
      let targetId = message.author.id;
      let targetName = message.author.username;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
        targetName = member.displayName;
      }
      const bday = getBday(targetId, guild.id);
      if (!bday) return targetId === message.author.id ? "You haven't set your birthday yet. Tell me your birthday and I'll remember it!" : `${targetName} hasn't set their birthday yet.`;
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const dateStr = bday.year ? `**${MONTHS[bday.month]} ${bday.day}, ${bday.year}**` : `**${MONTHS[bday.month]} ${bday.day}**`;
      const today = new Date();
      let ageInfo = "";
      if (bday.year) {
        let age = today.getFullYear() - bday.year;
        if (today.getMonth() + 1 < bday.month || (today.getMonth() + 1 === bday.month && today.getDate() < bday.day)) age--;
        ageInfo = ` — currently ${age} years old, turning ${age + 1}`;
      }
      const nextBday = new Date(today.getFullYear(), bday.month - 1, bday.day);
      if (nextBday <= today) nextBday.setFullYear(today.getFullYear() + 1);
      const daysUntil = Math.ceil((nextBday - today) / 86_400_000);
      const countdown = daysUntil === 0 ? " — that's TODAY! 🎉" : daysUntil === 1 ? " — that's TOMORROW!" : ` — ${daysUntil} days away`;
      return `${targetName}'s birthday is ${dateStr}${ageInfo}${countdown} 🎂`;
    }

    case "list_birthdays": {
      const { getGuildBirthdays } = await import("../database.js");
      const all = getGuildBirthdays(guild.id);
      if (!all.length) return "No birthdays registered in this server yet.";
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const today = new Date();
      function daysUntil(month, day) {
        const bDate = new Date(today.getFullYear(), month - 1, day);
        if (bDate < today) bDate.setFullYear(today.getFullYear() + 1);
        return Math.ceil((bDate - today) / 86_400_000);
      }
      const sorted = [...all].sort((a, b) => daysUntil(a.month, a.day) - daysUntil(b.month, b.day));
      const lines = sorted.slice(0, 20).map((b) => {
        const member = guild.members.cache.get(b.userId);
        const name = member?.displayName ?? `<@${b.userId}>`;
        const days = daysUntil(b.month, b.day);
        const when = days === 0 ? "🎉 today!" : days === 1 ? "tomorrow" : `in ${days}d`;
        let turningStr = "";
        if (b.year) {
          const nextBirthday = new Date(today.getFullYear(), b.month - 1, b.day);
          if (nextBirthday < today) nextBirthday.setFullYear(today.getFullYear() + 1);
          const turningAge = nextBirthday.getFullYear() - b.year;
          turningStr = ` — turning ${turningAge}`;
        }
        return `**${name}** — ${MONTHS[b.month]} ${b.day}${b.year ? `, ${b.year}` : ""} (${when}${turningStr})`;
      });
      return `🎂 Upcoming birthdays:\n${lines.join("\n")}`;
    }

    case "remove_birthday": {
      const { removeBirthday: rmBday } = await import("../database.js");
      let targetId = message.author.id;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
      }
      const removed = rmBday(targetId, guild.id);
      return removed ? "Birthday removed ✓" : "No birthday was set for that user.";
    }

    case "configure_birthdays": {
      if (input.disable) {
        setBirthdayChannel(guild.id, null);
        return "Birthday announcements disabled.";
      }
      if (!input.channel_name) return "Please provide a channel name.";
      const channel = findChannel(guild, input.channel_id || input.channel_name);
      if (!channel) return `Channel #${input.channel_name} not found`;
      setBirthdayChannel(guild.id, channel.id);
      const parts = [`Birthday channel set to #${channel.name}`];
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (role) { setBirthdayRole(guild.id, role.id); parts.push(`Birthday role: @${role.name} (24 h)`); }
        else parts.push(`Role "${input.role_name}" not found — skipped`);
      }
      if (input.message) {
        setBirthdayMessage(guild.id, input.message === "default" ? null : input.message);
        parts.push("Custom message saved");
      }
      return parts.join("\n");
    }

    // ─── Music Tools ──────────────────────────────────────────────────
    case "play_music": {
      const { getQueue, createQueue, connectToChannel, playSong, searchSong, searchPlaylist } = await import("../music/player.js");
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      const vc = member?.voice?.channel;
      if (!vc) return "you need to be in a voice channel first so i know where to join";

      const query = input.query;

      try {
        const playlist = await searchPlaylist(query);
        if (playlist && playlist.tracks.length) {
          let queue = getQueue(guild.id);
          if (!queue) {
            queue = createQueue(guild.id, vc, message.channel);
            await connectToChannel(queue);
          }
          const wasEmpty = queue.songs.length === 0;
          for (const track of playlist.tracks) {
            track.requestedBy = message.author.toString();
            queue.songs.push(track);
          }
          if (wasEmpty) await playSong(queue);
          return `queued **${playlist.tracks.length}** tracks from **${playlist.name}** — ${wasEmpty ? "playing now" : "added to queue"}`;
        }

        const song = await searchSong(query);
        if (!song) return `couldn't find anything for "${query}"`;

        let queue = getQueue(guild.id);
        if (!queue) {
        queue = createQueue(guild.id, vc, message.channel);
        await connectToChannel(queue);
      }
        song.requestedBy = message.author.toString();
        queue.songs.push(song);
        if (queue.songs.length === 1) {
          await playSong(queue);
          return `now playing **${song.title}** (${song.duration || "?"})`;
        }
        return `added **${song.title}** to the queue at position #${queue.songs.length}`;
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes("429")) return "YouTube is rate-limiting us right now — try again in a minute or try a different song";
        if (msg.includes("confirm your age") || msg.includes("Sign in")) return "that video is age-restricted and can't be played";
        return `couldn't play that — ${msg}`;
      }
    }

    case "skip_song": {
      const { getQueue, playSong } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "nothing is playing right now";
      const skipped = queue.songs[0].title;
      queue._skipOnce = true;
      queue.player.stopTrack();
      return `skipped **${skipped}**`;
    }

    case "stop_music": {
      const { deleteQueue } = await import("../music/player.js");
      deleteQueue(guild.id);
      return "stopped the music and left the voice channel";
    }

    case "pause_music": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.playing) return "nothing is playing";
      queue.player.setPaused(true);
      return "paused ⏸";
    }

    case "resume_music": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing to resume";
      queue.player.setPaused(false);
      return "resumed ▶";
    }

    case "music_queue": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "the queue is empty";
      const lines = queue.songs.slice(0, 15).map((s, i) =>
        `${i === 0 ? "▶" : `${i}.`} **${s.title}** (${s.duration || "?"})${i === 0 ? " — now playing" : ""}`
      );
      const extra = queue.songs.length > 15 ? `\n...and ${queue.songs.length - 15} more` : "";
      return lines.join("\n") + extra;
    }

    case "now_playing": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "nothing is playing right now";
      const s = queue.songs[0];
      const elapsed = queue.songStartedAt ? Math.floor((Date.now() - queue.songStartedAt) / 1000) : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = String(elapsed % 60).padStart(2, "0");
      return `now playing **${s.title}** (${mins}:${secs} / ${s.duration || "?"})${queue.looping ? " 🔂 loop" : ""}${queue.loopingQueue ? " 🔁 queue loop" : ""}`;
    }

    case "set_volume": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
      // Guard NaN — the model occasionally omits volume entirely or sends a
      // non-numeric string. Math.floor(undefined) = NaN, which then propagates
      // into setGlobalVolume(NaN) and throws inside Lavalink. Validate first.
      const raw = Number(input.volume);
      if (!Number.isFinite(raw)) return "give me a volume between 0 and 100";
      const vol = Math.min(Math.max(Math.floor(raw), 0), 100);
      queue.volume = vol;
      if (queue.player) queue.player.setGlobalVolume(vol);
      return `volume set to **${vol}%**`;
    }

    case "toggle_loop": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
      if (input.mode === "song") { queue.looping = true; queue.loopingQueue = false; return "looping current song 🔂"; }
      if (input.mode === "queue") { queue.looping = false; queue.loopingQueue = true; return "looping entire queue 🔁"; }
      queue.looping = false; queue.loopingQueue = false; return "looping disabled";
    }

    case "shuffle_queue": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
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
      return queue.shuffle ? "shuffle ON 🔀" : "shuffle OFF";
    }

    case "music_filter": {
      const { getQueue } = await import("../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.player) return "nothing is playing";

      const FILTERS = {
        none:      {},
        bassboost: { equalizer: [{ band: 0, gain: 0.2 }, { band: 1, gain: 0.15 }, { band: 2, gain: 0.1 }] },
        nightcore: { timescale: { speed: 1.3, pitch: 1.2, rate: 1.0 } },
        vaporwave: { timescale: { speed: 0.8, pitch: 0.9, rate: 1.0 } },
        "8d":      { rotation: { rotationHz: 0.17 }, tremolo: { frequency: 0.34, depth: 0.3 }, vibrato: { frequency: 0.17, depth: 0.15 }, lowpass: { smoothing: 20 }, equalizer: [{ band: 0, gain: 0.3 }, { band: 1, gain: 0.2 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.3 }] },
        karaoke:   { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220, filterWidth: 100 } },
        tremolo:   { tremolo: { frequency: 2.0, depth: 0.4 } },
        vibrato:   { vibrato: { frequency: 2.0, depth: 0.4 } },
        lowpass:   { lowPass: { smoothing: 20 } },
      };

      const filterConfig = FILTERS[input.filter];
      if (!filterConfig) return `unknown filter "${input.filter}" — try: ${Object.keys(FILTERS).join(", ")}`;

      await queue.player.setFilters(filterConfig);
      return input.filter === "none" ? "filters cleared ✓" : `**${input.filter}** filter applied 🎵`;
    }

    // ─── Lyrics Mode (nickname displays synced lyrics) ──────────────
    case "start_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { startKaraoke } = await import("../ai/karaoke.js");
      const { getQueue } = await import("../music/player.js");
      let song = input.song, artist = input.artist;
      const mode = input.mode || "message"; // default to safe message mode
      if (!song) {
        const queue = getQueue(message.guild.id);
        const current = queue?.songs?.[0];
        if (!current) return "nothing is playing — provide a song name or start playing music first";
        artist = artist || current.artist || current.title.split(" - ")[0] || "Unknown";
        song = current.artist ? current.title : (current.title.split(" - ").slice(1).join(" - ") || current.title);
      }
      if (!artist) return "i need an artist name to find the lyrics";
      const r = await startKaraoke(message.client, message.guild.id, {
        trackName: song, artistName: artist, requesterId: message.author.id,
        mode, channelId: message.channel.id,
      });
      return r.ok
        ? `🎤 lyrics mode on (${mode}) — **${r.trackName}** by **${r.artistName}** (${r.lineCount} lines)`
        : `couldn't start lyrics: ${r.reason}`;
    }

    case "stop_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { stopKaraoke } = await import("../ai/karaoke.js");
      const r = await stopKaraoke(message.guild.id, "user requested");
      return r.ok ? "🛑 lyrics mode off, nickname restored" : r.reason;
    }

    case "auto_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { enableAutoMode } = await import("../ai/karaoke.js");
      const r = await enableAutoMode(message.client, message.guild.id, message.author.id, {
        mode: input.mode || "message", channelId: message.channel.id,
      });
      return r.ok ? "🎤 auto lyrics mode on — lyrics will follow every track" : r.reason;
    }

    // ─── Info / Everyone Tools ───────────────────────────────────────
    case "test_patch_news": {
      const { fetchLatestPost, KNOWN_FEEDS: feeds } = await import("../utils/patchbot.js");
      const raw = input.feed?.toLowerCase().trim();

      const known = feeds[raw];
      if (!known && !raw?.startsWith("http")) {
        return `unknown feed "${input.feed}" — available: ${Object.keys(feeds).join(", ")}`;
      }

      const feedUrl = known?.url ?? known?.listingUrl ?? raw;
      const feedName = known?.name ?? "Custom Feed";
      const feedColor = known?.color ?? 0x5865F2;

      const offset = input.offset ?? 0;
      const search = input.search ?? null;

      try {
        const result = await fetchLatestPost(feedUrl, feedName, feedColor, { offset, search });
        if (!result) return `no posts found for ${feedName}`;
        if (result.notFound) {
          const list = result.available?.slice(0, 6).map((t, i) => `${i}. ${t}`).join("\n") ?? "none";
          return `couldn't find that specific patch. available patches:\n${list}`;
        }
        await message.channel.send({ embeds: [result.embed], components: result.components });
        return `posted ${feedName} update: "${result.title}"`;
      } catch (err) {
        return `failed to fetch ${feedName}: ${err.message}`;
      }
    }

    case "send_test_birthday": {
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return "Couldn't resolve your guild member — try again in the server.";
      const { buildBirthdayEmbed } = await import("../utils/birthday.js");
      const { getBirthdayConfig: getBdayConfig, getBirthday: getBdayRecord } = await import("../database.js");
      const bdayConfig = getBdayConfig(guild.id);
      const bdayRecord = getBdayRecord(message.author.id, guild.id);
      const { embed, pingContent } = buildBirthdayEmbed(member, bdayConfig, bdayRecord);
      await message.channel.send({ content: `${pingContent} *(test birthday announcement)*`, embeds: [embed] });
      return "Test birthday announcement sent!";
    }

    case "send_test_welcome": {
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return "Couldn't resolve your guild member — try again in the server.";

      const settings = getGuildSettings(guild.id);
      const embedCfg = getWelcomeEmbed(guild.id);
      const { embed, pingContent } = buildWelcomeEmbed(member, settings, embedCfg);

      await message.channel.send({ content: `${pingContent || member.toString()} *(test welcome)*`, embeds: [embed] });
      return "Test welcome message sent!";
    }

    case "send_gif": {
      const klipyKey = process.env.KLIPY_API_KEY;
      if (!klipyKey) return "GIF feature not set up — add KLIPY_API_KEY to environment variables";
      const q = encodeURIComponent(input.query || "meme");
      const res = await fetch(`https://api.klipy.com/api/v1/${klipyKey}/gifs/search?q=${q}&per_page=20&content_filter=medium&customer_id=${message.author.id}`);
      if (!res.ok) return `Klipy API error: ${res.status}`;
      const json = await res.json();
      const results = json?.data?.data;
      if (!results?.length) return `couldn't find a GIF for "${input.query}"`;
      const pick = results[Math.floor(Math.random() * Math.min(results.length, 10))];
      const gifUrl = pick.file?.hd?.gif?.url ?? pick.file?.md?.gif?.url ?? pick.file?.sm?.gif?.url ?? null;
      if (!gifUrl) return `found a result but couldn't extract the GIF URL`;

      const gifSettings = getGuildSettings(guild.id);
      const useEmbed = gifSettings?.gif_embed !== false;

      {
        const color = useEmbed ? 0xFFFFFF : 0x2b2d31;
        const embed = new EmbedBuilder().setImage(gifUrl).setColor(color);
        let resolvedCaption = input.caption || "";
        if (resolvedCaption && guild) {
          resolvedCaption = resolvedCaption.replace(/@(\w+)/g, (match, name) => {
            const member = guild.members.cache.find(m => m.user.username.toLowerCase() === name.toLowerCase() || m.displayName.toLowerCase() === name.toLowerCase());
            return member ? `<@${member.id}>` : match;
          });
        }
        const sendOpts = resolvedCaption
          ? { content: resolvedCaption, embeds: [embed] }
          : { embeds: [embed] };
        try {
          await message.channel.send(sendOpts);
        } catch (err) {
          log(`[GIF] Embed send failed: ${err.message} — falling back to URL`);
          const fallback = input.caption ? `${input.caption}\n${gifUrl}` : gifUrl;
          await message.channel.send(fallback).catch(() => {});
        }
      }
      return `sent GIF for "${input.query}"`;
    }

    case "set_gif_style": {
      const mode = input.style?.toLowerCase();
      if (mode === "raw" || mode === "clean" || mode === "plain") {
        setGifEmbed(guild.id, false);
        return "GIF style → **raw** — no embed border, just the GIF";
      } else if (mode === "embed" || mode === "border" || mode === "fancy") {
        setGifEmbed(guild.id, true);
        return "GIF style → **embed** — GIFs show with a colored border";
      }
      return `use "raw" (no border) or "embed" (with border)`;
    }

    case "get_server_info": {
      const owner = await guild.fetchOwner();
      return `Server: ${guild.name}\nMembers: ${guild.memberCount}\nChannels: ${guild.channels.cache.size}\nRoles: ${guild.roles.cache.size}\nEmojis: ${guild.emojis.cache.size}\nBoosts: Level ${guild.premiumTier} (${guild.premiumSubscriptionCount})\nOwner: ${owner.user.tag}\nCreated: ${guild.createdAt.toDateString()}`;
    }

    case "set_dm_preference": {
      let targetId = message.author.id;
      let targetName = message.author.username;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ||
          message.member?.id === guild.ownerId;
        if (member.id !== message.author.id && !isAdmin) {
          return `You can only change your own DM preference`;
        }
        targetId = member.id;
        targetName = member.user.username;
      }
      setDmOptout(targetId, !input.allow_dms);
      return input.allow_dms
        ? `got it — i'll DM ${targetId === message.author.id ? "you" : targetName} again`
        : `got it — i won't DM ${targetId === message.author.id ? "you" : targetName} anymore`;
    }

    case "get_user_info": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const roles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name).join(", ") || "None";
      return `User: ${member.user.tag}\nNickname: ${member.nickname || "None"}\nJoined: ${member.joinedAt.toDateString()}\nCreated: ${member.user.createdAt.toDateString()}\nRoles: ${roles}\nBot: ${member.user.bot ? "Yes" : "No"}`;
    }

    case "list_channels": {
      const cats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
      const lines = [];
      for (const cat of cats.values()) {
        lines.push(`📁 ${cat.name} [id:${cat.id}]`);
        const children = guild.channels.cache.filter((c) => c.parentId === cat.id).sort((a, b) => a.position - b.position);
        for (const ch of children.values()) {
          const prefix = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
          lines.push(`  ${prefix} ${ch.name} [id:${ch.id}]`);
        }
      }
      const orphans = guild.channels.cache.filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory);
      for (const ch of orphans.values()) {
        const prefix = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
        lines.push(`${prefix} ${ch.name} [id:${ch.id}]`);
      }
      // Truncate so we never overflow Discord's 2000-char message limit on
      // servers with hundreds of channels.
      const MAX = 1900;
      let out = lines.join("\n");
      if (out.length > MAX) {
        const trimmed = lines.slice(0, Math.floor(lines.length * (MAX / out.length)));
        out = trimmed.join("\n") + `\n…(${lines.length - trimmed.length} more channels truncated)`;
      }
      return out || "No channels";
    }

    case "list_roles": {
      // Compact format to avoid truncation on servers with many roles
      const roles = guild.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
      return `${roles.size} roles: ${roles.map((r) => {
        const icon = r.unicodeEmoji ? ` ${r.unicodeEmoji}` : r.icon ? ` [custom icon]` : "";
        return `${r.name}${icon}`;
      }).join(", ")}` || "No roles";
    }

    case "get_role_permissions": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;

      const PERM_NAMES = {
        Administrator:           PermissionFlagsBits.Administrator,
        "Manage Guild":          PermissionFlagsBits.ManageGuild,
        "Manage Channels":       PermissionFlagsBits.ManageChannels,
        "Manage Roles":          PermissionFlagsBits.ManageRoles,
        "Manage Messages":       PermissionFlagsBits.ManageMessages,
        "Manage Nicknames":      PermissionFlagsBits.ManageNicknames,
        "Manage Webhooks":       PermissionFlagsBits.ManageWebhooks,
        "Manage Emojis":         PermissionFlagsBits.ManageGuildExpressions,
        "Kick Members":          PermissionFlagsBits.KickMembers,
        "Ban Members":           PermissionFlagsBits.BanMembers,
        "Timeout Members":       PermissionFlagsBits.ModerateMembers,
        "View Audit Log":        PermissionFlagsBits.ViewAuditLog,
        "View Channels":         PermissionFlagsBits.ViewChannel,
        "Send Messages":         PermissionFlagsBits.SendMessages,
        "Send TTS Messages":     PermissionFlagsBits.SendTTSMessages,
        "Embed Links":           PermissionFlagsBits.EmbedLinks,
        "Attach Files":          PermissionFlagsBits.AttachFiles,
        "Add Reactions":         PermissionFlagsBits.AddReactions,
        "Use External Emojis":   PermissionFlagsBits.UseExternalEmojis,
        "Mention Everyone":      PermissionFlagsBits.MentionEveryone,
        "Read Message History":  PermissionFlagsBits.ReadMessageHistory,
        "Use Slash Commands":    PermissionFlagsBits.UseApplicationCommands,
        "Connect (Voice)":       PermissionFlagsBits.Connect,
        "Speak (Voice)":         PermissionFlagsBits.Speak,
        "Stream (Voice)":        PermissionFlagsBits.Stream,
        "Move Members (Voice)":  PermissionFlagsBits.MoveMembers,
        "Mute Members (Voice)":  PermissionFlagsBits.MuteMembers,
        "Deafen Members (Voice)":PermissionFlagsBits.DeafenMembers,
        "Priority Speaker":      PermissionFlagsBits.PrioritySpeaker,
        "Change Nickname":       PermissionFlagsBits.ChangeNickname,
        "Create Invites":        PermissionFlagsBits.CreateInstantInvite,
      };

      const granted = [];
      const denied  = [];
      for (const [name, flag] of Object.entries(PERM_NAMES)) {
        (role.permissions.has(flag) ? granted : denied).push(name);
      }

      const color = role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "none";
      const header = `**@${role.name}** (position ${role.position}, color: ${color}, ${role.members.size} members)\n`;
      // Truncate granted/denied lists so we don't overflow Discord's 2000-char
      // message limit. Admin roles often hit this — only one of the two halves
      // is usually long, so favor the shorter of the two for full detail.
      const MAX_LINE = 750;
      const trimList = (items) => {
        let out = items.join(", ");
        if (out.length <= MAX_LINE) return out;
        const truncated = [];
        let used = 0;
        for (const item of items) {
          if (used + item.length + 2 > MAX_LINE) break;
          truncated.push(item);
          used += item.length + 2;
        }
        return `${truncated.join(", ")}, …(+${items.length - truncated.length} more)`;
      };
      return header + `✅ Granted: ${trimList(granted) || "none"}\n` + `❌ Denied: ${trimList(denied) || "none"}`;
    }

    // ─── REFERENCE TOOL ─── See ai/tools.js:1902 for the schema and tests/ai/executors/listEmojis.test.ts:43 for the spec. ───
    case "list_emojis": {
      const emojis = guild.emojis.cache;
      if (!emojis.size) return "No custom emojis";
      return emojis.map((e) => `${e.animated ? "(animated) " : ""}:${e.name}: — ${e.id}`).join("\n");
    }

    case "list_bans": {
      const bans = await guild.bans.fetch({ limit: 50 });
      if (!bans.size) return "No banned users";
      return bans.map((b) => `${b.user.tag} — ${b.reason || "No reason"}`).join("\n");
    }

    case "random_member": {
      await guild.members.fetch({ limit: 100 });
      let members = guild.members.cache.filter((m) => !m.user.bot);
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (!role) return `Couldn't find role "${input.role_name}"`;
        members = members.filter((m) => m.roles.cache.has(role.id));
      }
      const arr = [...members.values()];
      if (!arr.length) return "No members found matching that filter";
      const count = Math.min(input.count || 1, arr.length, 10);
      const picked = [];
      const used = new Set();
      while (picked.length < count && picked.length < arr.length) {
        const idx = Math.floor(Math.random() * arr.length);
        if (!used.has(idx)) { used.add(idx); picked.push(arr[idx]); }
      }
      return picked.map((m) => m.user.tag).join(", ") || "No members found";
    }

    case "count_members": {
      await guild.members.fetch({ limit: 100 });
      let members = guild.members.cache.filter((m) => !m.user.bot);
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (!role) return `Couldn't find role "${input.role_name}"`;
        members = members.filter((m) => m.roles.cache.has(role.id));
      }
      if (input.status) {
        members = members.filter((m) => m.presence?.status === input.status);
      }
      return `${members.size} members${input.role_name ? ` with "${input.role_name}"` : ""}${input.status ? ` (${input.status})` : ""}`;
    }

    case "who_has_role": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      const members = role.members.filter((m) => !m.user.bot);
      if (!members.size) return `No one has the "${role.name}" role`;
      // Truncate so we never overflow Discord's 2000-char message limit. A
      // role with hundreds of members previously made the parent send fail.
      const tags = [...members.values()].map((m) => m.user.tag);
      const MAX_LIST_CHARS = 1500;
      let used = 0;
      const taken = [];
      for (const tag of tags) {
        if (used + tag.length + 2 > MAX_LIST_CHARS) break;
        taken.push(tag);
        used += tag.length + 2;
      }
      const remainder = members.size - taken.length;
      const suffix = remainder > 0 ? ` (and ${remainder} more)` : "";
      return `${members.size} members with "${role.name}": ${taken.join(", ")}${suffix}`;
    }

    // ─── Server Whitelist (bot-owner only) ────────────────────────────
    case "whitelist_server": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied whitelist_server — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can manage the whitelist.";
      }
      const raw = input.invite_or_id?.trim();
      if (!raw) return "Provide a Discord invite link or guild ID.";

      const inviteMatch = raw.match(/(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/);
      const code = inviteMatch?.[1];

      if (code) {
        try {
          const invite = await Promise.race([
            message.client.fetchInvite(code),
            new Promise((_, reject) => setTimeout(() => reject(new Error("invite lookup timed out after 10s")), 10_000)),
          ]);
          const g = invite.guild;
          if (!g) return "Couldn't resolve a server from that invite.";

          addToWhitelist(g.id, {
            name:       g.name,
            icon_url:   g.iconURL?.({ size: 128 }) ?? null,
            members:    invite.memberCount ?? g.memberCount ?? null,
            invited_by: message.author.id,
          });

          return [
            `✅ **${g.name}** added to whitelist`,
            `ID: \`${g.id}\``,
            invite.memberCount ? `Members: ~${invite.memberCount}` : null,
            `The bot can now join this server.`,
          ].filter(Boolean).join("\n");
        } catch (err) {
          return `Couldn't resolve that invite — ${err.message}. Make sure it's a valid, non-expired invite.`;
        }
      }

      if (/^\d{17,20}$/.test(raw)) {
        const existingGuild = message.client.guilds.cache.get(raw);
        addToWhitelist(raw, {
          name:       existingGuild?.name ?? "Unknown (ID-only)",
          icon_url:   existingGuild?.iconURL?.({ size: 128 }) ?? null,
          members:    existingGuild?.memberCount ?? null,
          invited_by: message.author.id,
        });
        return `✅ Guild \`${raw}\`${existingGuild ? ` (**${existingGuild.name}**)` : ""} added to whitelist.`;
      }

      return "That doesn't look like a Discord invite or guild ID. Send something like `discord.gg/abc123` or a numeric guild ID.";
    }

    case "unwhitelist_server": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied unwhitelist_server — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can manage the whitelist.";
      }
      const raw = input.guild_id?.trim();
      if (!raw) return "Provide a guild ID or server name.";

      // Resolve target — first try the whitelist data, then fall back to
      // current guild memberships. Boss's intent on "unwhitelist X" is
      // usually "kick the bot out of X"; if X isn't on the whitelist but
      // the bot is sitting in it (often because boss is a member, which
      // bypasses the gatekeep at events/ready.js), still leave it.
      let targetId = null;
      let targetName = null;
      let wasOnWhitelist = false;

      const wl = getWhitelist();
      if (/^\d{17,20}$/.test(raw)) {
        if (wl[raw]) { targetId = raw; targetName = wl[raw].name; wasOnWhitelist = true; }
        else {
          const g = message.client.guilds.cache.get(raw);
          if (g) { targetId = raw; targetName = g.name; }
        }
      } else {
        const lower = raw.toLowerCase();
        const wlMatch = Object.entries(wl).find(([, info]) => info.name?.toLowerCase().includes(lower));
        if (wlMatch) { targetId = wlMatch[0]; targetName = wlMatch[1].name; wasOnWhitelist = true; }
        else {
          const g = [...message.client.guilds.cache.values()].find((x) => x.name?.toLowerCase().includes(lower));
          if (g) { targetId = g.id; targetName = g.name; }
        }
      }

      if (!targetId) return `No whitelisted server matching "${raw}", and the bot isn't in any server with that name/ID.`;

      if (wasOnWhitelist) removeFromWhitelist(targetId);

      const targetGuild = message.client.guilds.cache.get(targetId);
      if (targetGuild) {
        await targetGuild.leave().catch(() => {});
        return wasOnWhitelist
          ? `✅ **${targetName}** (\`${targetId}\`) removed from whitelist and left the server.`
          : `✅ Left **${targetName}** (\`${targetId}\`). It wasn't on the whitelist, just kicked the bot out.`;
      }
      return wasOnWhitelist
        ? `✅ **${targetName}** (\`${targetId}\`) removed from whitelist.`
        : `Nothing to do — \`${targetId}\` wasn't on the whitelist and the bot isn't in that server.`;
    }

    case "list_whitelist": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied list_whitelist — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can view the whitelist.";
      }
      const wl = getWhitelist();
      log(`[WHITELIST] list_whitelist read — ${Object.keys(wl).length} entries: [${Object.keys(wl).join(", ") || "(empty)"}]`);
      const entries = Object.entries(wl);
      if (!entries.length) return "Whitelist is empty — the bot will only stay in servers you're a member of.";

      const lines = entries.map(([id, info]) => {
        const inGuild = message.client.guilds.cache.has(id);
        const status = inGuild ? "✅ joined" : "⏳ not joined yet";
        return `**${info.name}** — \`${id}\` — ${status}${info.members ? ` (~${info.members} members)` : ""}`;
      });
      return `📋 **Whitelisted Servers** (${entries.length}):\n${lines.join("\n")}`;
    }

    default:
      return `Unknown action: ${toolName}`;
  }
}
