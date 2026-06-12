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
 *  - advancedExecutor  — twin coordination (`ask_eris`), web_search / scrape_url,
 *                        calculate, reminders, scheduled tasks, image gen
 *  - memoryExecutor    — remember_fact / recall / forget / directives
 *  - toggleExecutor    — feature flags (auto-responders, invite filter, etc.)
 *  - messageExecutor   — send_message, animated messages, snipe, find_message
 *  - emojiExecutor     — custom emoji listing
 *  - serverExecutor    — server-level admin (whitelist, trust, log channel)
 * Inline cases handle the long tail (temp VC, custom commands, birthdays,
 * gifs, welcome customization, list_bans, random_member, etc.).
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
 *  - Rate limiter:        `packages/shared/src/utils/toolRateLimit.js`
 *  - Twin client/contract: `packages/irene/ai/executors/advancedExecutor.js`
 *  - Eris counterpart:    `packages/eris/ai/executor.js`
 *  - Reference test:      `packages/irene/tests/ai/executors/listEmojis.test.ts`
 *  - Twin signing test:   `packages/irene/tests/ai/executors/advancedExecutor.test.ts`
 */

// ─── Tool Execution Engine ──────────────────────────────────────────────────
// Thin router — delegates to domain-specific sub-executors, falls back to
// remaining inline cases for tools not yet extracted.

// Most tool-specific imports now live inside the domain sub-executors. The
// executor keeps only what the thin router itself needs: the create-VC intent
// guard (ChannelType + setCreateVcChannel + findChannel), rate limiting,
// aliasing, the unknown-tool fallback, and the shared `ctx` helpers it passes
// to every sub-executor.
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { setCreateVcChannel } from "../database.js";
import config from "../config.js";
import { checkToolRateLimit } from "@defnotean/shared/toolRateLimit";
import { log } from "../utils/logger.js";
import { TOOL_ALIASES } from "./toolAliases.js";
import { ADMIN_TOOLS } from "./tools.js";
import { isAdminMember } from "../utils/permissions.js";
import { recordUnknownTool } from "./unknownTools.js";
import { channelKeyFor, registry as toolRegistry } from "./toolRegistry.js";
import {
  findMember,
  findChannel,
  findRole,
  findRoles,
  buildPingContent,
} from "./resolve.js";
import { parseHexColor } from "./colors.js";
import { checkHierarchy, checkRoleAssignment } from "./hierarchy.js";
export { TOOL_ALIASES, validateToolAliases } from "./toolAliases.js";
export { _unknownToolCounts } from "./unknownTools.js";
// Lookup helpers now live in resolve.js — re-export the public surface so
// importers (advancedExecutor, commandPrefix, guildMember* events, etc.) that do
// `import { findMember } from "../executor.js"` keep working unchanged.
export {
  findMember,
  findMemberDetailed,
  findChannel,
  findRole,
  findRoles,
  buildPingContent,
  invalidateMemberIndex,
} from "./resolve.js";

// ─── Sub-Executor Imports ───────────────────────────────────────────────────
import { execute as executeChannel } from "./executors/channelExecutor.js";
import { execute as executeRole } from "./executors/roleExecutor.js";
import { execute as executeModeration, consumePendingAction } from "./executors/moderationExecutor.js";
import { execute as executeVoice } from "./executors/voiceExecutor.js";
import { execute as executeSetup } from "./executors/setupExecutor.js";
import { execute as executePersonalize } from "./executors/personalizeExecutor.js";
import { execute as executeAudio } from "./executors/audioExecutor.js";
import { execute as executeLeveling } from "./executors/levelingExecutor.js";
import { execute as executeAdvanced } from "./executors/advancedExecutor.js";
import { execute as executeMemory } from "./executors/memoryExecutor.js";
import { execute as executeToggle } from "./executors/toggleExecutor.js";
import { execute as executeMessage } from "./executors/messageExecutor.js";
import { execute as executeEmoji } from "./executors/emojiExecutor.js";
import { execute as executeServer } from "./executors/serverExecutor.js";
import { execute as executeVc } from "./executors/vcExecutor.js";
import { execute as executeDirective } from "./executors/directiveExecutor.js";
import { execute as executeCustomCommand } from "./executors/customCommandExecutor.js";
import { execute as executeBirthday } from "./executors/birthdayExecutor.js";
import { execute as executeMusic } from "./executors/musicExecutor.js";
import { execute as executeTest } from "./executors/testExecutor.js";
import { execute as executeMedia } from "./executors/mediaExecutor.js";
import { execute as executeInfo } from "./executors/infoExecutor.js";
import { execute as executeWhitelist } from "./executors/whitelistExecutor.js";

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
  executeEmoji,
  executeServer,
  executeVc,
  executeDirective,
  executeCustomCommand,
  executeBirthday,
  executeMusic,
  executeTest,
  executeMedia,
  executeInfo,
  executeWhitelist,
];
const ADMIN_TOOL_NAMES = new Set(ADMIN_TOOLS.map((t) => t.name));
const ADMIN_TOOL_PERMISSION_OVERRIDES = new Map([
  ["ban_user", PermissionFlagsBits.BanMembers],
  ["tempban", PermissionFlagsBits.BanMembers],
  ["unban_user", PermissionFlagsBits.BanMembers],
  ["kick_user", PermissionFlagsBits.KickMembers],
  ["timeout_user", PermissionFlagsBits.ModerateMembers],
  ["untimeout_user", PermissionFlagsBits.ModerateMembers],
  ["warn_user", PermissionFlagsBits.ManageMessages],
  ["remove_warning", PermissionFlagsBits.ManageMessages],
  ["clear_warnings", PermissionFlagsBits.ManageMessages],
  ["purge_messages", PermissionFlagsBits.ManageMessages],
  ["delete_message", PermissionFlagsBits.ManageMessages],
  ["pin_message", PermissionFlagsBits.ManageMessages],
  ["unpin_message", PermissionFlagsBits.ManageMessages],
  ["react_to_message", PermissionFlagsBits.AddReactions],
  ["remove_reaction", PermissionFlagsBits.ManageMessages],
  ["create_invite", PermissionFlagsBits.CreateInstantInvite],
  ["delete_invite", PermissionFlagsBits.ManageGuild],
  ["list_invites", PermissionFlagsBits.ManageGuild],
  ["invite_stats", PermissionFlagsBits.ManageGuild],
  ["list_bans", PermissionFlagsBits.BanMembers],
  ["view_audit_log", PermissionFlagsBits.ViewAuditLog],
]);

function canAttemptAdminTool(toolName, member) {
  if (isAdminMember(member)) return true;
  const permission = ADMIN_TOOL_PERMISSION_OVERRIDES.get(toolName);
  return Boolean(permission && member?.permissions?.has?.(permission));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Member/channel/role lookups + the member-name index cache now live in
// resolve.js; COLOR_NAMES/parseHexColor in colors.js; checkHierarchy/
// checkRoleAssignment in hierarchy.js. They're imported above and re-exported so
// the public surface is unchanged.

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

// ─── Main Executor ──────────────────────────────────────────────────────────

// Alias map and boot-time alias drift validation live in toolAliases.js.
// Public exports stay here for compatibility with existing tests/imports.
// Counter for AI-hallucinated tools. Bounded/pruned in unknownTools.js so a
// long-running process cannot collect unbounded one-off hallucinated names.

// ─── Tool Result Cache ─────────────────────────────────────────────────────
const _toolCache = new Map();
const CACHE_TTL = 15_000; // 15 seconds
const CACHEABLE_TOOLS = new Set([
  "recall_memories", "get_server_info", "get_user_info",
  "list_roles", "get_role_permissions", "list_emojis",
  "count_members", "who_has_role", "random_member",
  "list_custom_commands", "list_auto_responders", "list_trusted",
  "list_whitelist", "music_queue", "now_playing",
  "list_birthdays", "voice_leaderboard", "server_milestones",
  "list_members", "list_directives",
]);
const CACHE_INVALIDATING_TOOLS = new Set([
  "create_channel", "delete_channel", "nuke_channel", "rename_channel",
  "set_channel_topic", "set_slowmode", "lock_channel", "unlock_channel",
  "move_channel", "clone_channel", "set_channel_permissions",
  "create_role", "delete_role", "edit_role", "give_role", "remove_role",
  "mass_role", "set_role_permissions", "reorder_roles",
  "ban_user", "kick_user", "warn_user", "timeout_user", "tempban", "set_nickname",
  "remember_fact", "forget_fact", "forget_all",
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

// ─── Destructive-action confirm bridge ──────────────────────────────────────
//
// moderationExecutor._maybeDeferToConfirm returns a renderable OBJECT (not a
// string) carrying { content, components, _pendingToken } when an AI-initiated
// destructive action must be confirmed by a human. That object has to survive
// the executor pipeline untouched (no caching, no error-string stringify) and
// reach the provider loop so a real Confirm/Cancel message gets posted.
//
// isDeferralResult guards the cache/serialize paths here; postDeferralIfNeeded
// is the single render bridge the provider loops share (see dual.js / nvidia.js
// / openaiCompat.js) so the detection + post logic can't diverge.

// A deferral result is a plain object with a string token + a components array.
// Anything else (string success/error, undefined fall-through, {error:...} from
// twin helpers) is a normal result.
export function isDeferralResult(result) {
  return (
    !!result &&
    typeof result === "object" &&
    typeof result._pendingToken === "string" &&
    Array.isArray(result.components)
  );
}

// Short string fed back to the MODEL after a confirm prompt is posted, so it
// doesn't re-issue the destructive tool call thinking it failed.
export const PENDING_CONFIRM_NOTICE =
  "A moderator confirmation prompt has been posted; the action is pending human approval.";

/**
 * Render bridge shared by every provider loop. If `result` is a deferral
 * object, post its { content, components } as a real Discord message to
 * `channel` so the Confirm/Cancel buttons render, then return the short
 * pending-notice string for the model. Otherwise return `result` unchanged.
 *
 * Fail-closed: the destructive action is already stashed in the pending store
 * before we get here, so it CANNOT auto-execute. If we can't post the prompt we
 * surface an error string to the model (never silently drop, never auto-run) and
 * immediately reclaim the now-unreachable pending entry (its Confirm/Cancel
 * buttons never rendered) instead of letting it linger until TTL.
 *
 * @param {*} result   the raw executeTool result
 * @param {object} channel  a Discord channel-like object with .send()
 * @returns {Promise<*>} the model-facing result (string for deferrals)
 */
export async function postDeferralIfNeeded(result, channel) {
  if (!isDeferralResult(result)) return result;
  if (!channel || typeof channel.send !== "function") {
    // No channel to render into — fail closed: tell the model it couldn't be
    // posted rather than pretending the action ran. Reclaim the orphaned token.
    log(`[EXECUTOR] confirm bridge: no channel.send available — confirm prompt NOT posted`);
    consumePendingAction(result._pendingToken);
    return "Couldn't post the moderator confirmation prompt (no channel) — the destructive action was NOT performed.";
  }
  try {
    await channel.send({ content: result.content, components: result.components });
    return PENDING_CONFIRM_NOTICE;
  } catch (err) {
    log(`[EXECUTOR] confirm bridge: failed to post confirm prompt: ${err?.message || err}`);
    consumePendingAction(result._pendingToken);
    return `Couldn't post the moderator confirmation prompt (${err?.message || "send failed"}) — the destructive action was NOT performed.`;
  }
}

function trackSuccessfulUsage(toolName, message, result) {
  if (typeof result === "string" && /^(Error:|Unknown action:)/i.test(result)) return;
  toolRegistry.trackUsage(channelKeyFor(message), toolName);
}

export async function executeTool(toolName, input, message, opts = {}) {
  input ||= {};
  // Auto-correct common Gemini tool name mistakes
  if (TOOL_ALIASES[toolName]) {
    log(`[EXECUTOR] Auto-corrected tool: ${toolName} → ${TOOL_ALIASES[toolName]}`);
    toolName = TOOL_ALIASES[toolName];
  }

  if (ADMIN_TOOL_NAMES.has(toolName) && !canAttemptAdminTool(toolName, message?.member)) {
    log(`[SECURITY] Blocked admin tool "${toolName}" for non-admin at executeTool boundary`);
    return "only admins/mods can set or remove directives";
  }

  const userId = message?.author?.id;
  if (userId) {
    const rateCheck = checkToolRateLimit(userId, toolName);
    if (!rateCheck.allowed) {
      const secs = Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000);
      return `chill — you're using ${toolName} too fast. try again in ${secs}s`;
    }
  }

  const guildId = message?.guild?.id;

  // Check cache for read-only tools
  const cached = getCachedResult(toolName, input, guildId);
  if (cached !== null) {
    log(`[EXECUTOR] Cache hit: ${toolName}`);
    trackSuccessfulUsage(toolName, message, cached);
    return cached;
  }

  // Invalidate cache on write operations — scoped to this guild only.
  // Previously this cleared the entire cache across all guilds, so a write in
  // guild A wiped cached `list_roles` etc. for guild B, defeating the point of
  // the per-guild key prefix.
  if (CACHE_INVALIDATING_TOOLS.has(toolName)) invalidateGuildCache(guildId);

  const result = await _executeToolInner(toolName, input, message, opts);
  // A pending-confirm deferral object must reach the provider loop intact —
  // never cache it (it carries a one-shot token) and never let the error-string
  // refusal logic stringify it. setCachedResult already no-ops for these
  // (ban/kick/tempban/purge aren't CACHEABLE_TOOLS), but guard explicitly so a
  // future cacheable tool can't accidentally stash one.
  trackSuccessfulUsage(toolName, message, result);
  if (isDeferralResult(result)) return result;
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
  "trust_user", "untrust_user", "list_trusted", "set_log_channel",
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

async function _executeToolInner(toolName, input, message, opts = {}) {
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
    // AI-initiated when the call originates from a provider tool loop (dual /
    // nvidia / openaiCompat pass aiInitiated:true). Slash commands, scheduled
    // tasks and presence-triggered calls go through executeTool WITHOUT this
    // flag, so moderationExecutor's confirm gate stays off for them and they
    // execute destructive actions immediately as before.
    aiInitiated: !!opts.aiInitiated,
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

  // ─── Unknown-tool fallback ──────────────────────────────────────────
  // Every concrete tool now lives in a domain sub-executor above; if none of
  // them claimed this toolName it's an AI hallucination. Track it so we can
  // spot patterns — if Gemini/NVIDIA keeps inventing the same nonexistent tool,
  // we want to know so we can either add it or tighten the prompt. Logged on the
  // first hit and every 10th thereafter to stay visible without spam.
  const unknownUserId = message?.author?.id || "unknown";
  const count = recordUnknownTool(toolName);
  const argPreview = JSON.stringify(input || {}).slice(0, 120);
  if (count === 1 || count % 10 === 0) {
    log(`[EXECUTOR] Unknown tool: ${toolName} (hit #${count}, user ${unknownUserId}, args: ${argPreview})`);
  }
  return `Unknown action: ${toolName}`;
}
