// @ts-check
// Tool alias map + drift validation for Irene's AI executor.
// Kept separate from executor.js so the dispatcher stays a thin router.

import { ADMIN_TOOLS, EVERYONE_TOOLS } from "./tools.js";
import { log } from "../utils/logger.js";

export const TOOL_ALIASES = {
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

// ─── Alias resolution + registry validation ────────────────────────────────
// Mirror of Eris's executor guardrails (packages/eris/ai/executor.js): a
// boot-time audit that catches stale aliases pointing at tools that no longer
// exist, plus an unknown-tool counter so model hallucinations are visible
// instead of silently swallowed by the "Unknown action" fallback. The registry
// is the union of ADMIN_TOOLS + EVERYONE_TOOLS in tools.js — the only tool
// surface the model ever sees and the only set the dispatcher can serve.

// Canonical name set, computed once at module load. Used by the boot-time audit
// below and exported helpers/tests.
export const _toolRegistryNames = new Set(
  [...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name)
);

/**
 * Boot-time audit: every TOOL_ALIASES *value* must point to a real registered
 * tool. If drift is found we throw a clear error listing the offenders, so a
 * stale alias is caught at startup instead of silently mapping a model typo
 * onto a tool name that no longer exists (which would otherwise fall through to
 * the "Unknown action" string at request time).
 *
 * Accepts an optional `registry` (Set or array of names) to make the helper
 * testable in isolation - production calls pass the live tool list.
 *
 * @param {Set<string>|string[]} [registry]
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnDrift=true] set false for "soft" mode (log + return)
 * @returns {string[]} the list of alias targets that are NOT in the registry
 */
export function validateToolAliases(registry = _toolRegistryNames, opts = {}) {
  const { throwOnDrift = true } = opts;
  const registrySet = registry instanceof Set ? registry : new Set(registry || []);

  const offenders = [];
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    if (!registrySet.has(target)) offenders.push({ alias, target });
  }

  if (offenders.length === 0) return [];

  const lines = offenders.map((o) => `  - ${o.alias} -> ${o.target}`).join("\n");
  const msg =
    `[EXECUTOR] TOOL_ALIASES drift detected: ${offenders.length} alias(es) ` +
    `point to tool names not in the registry. The model would silently ` +
    `auto-correct to a nonexistent tool. Fix tools.js or remove the alias.\n` +
    lines;

  if (throwOnDrift) {
    throw new Error(msg);
  }

  // Soft mode: visible warning, no crash. Used if a future build wants to ship
  // with known drift while a tool rename rolls out.
  log(msg);
  return offenders.map((o) => o.target);
}

// Boot-time audit. Throws on drift unless IRENE_SKIP_ALIAS_VALIDATION=1 is set,
// which is the escape hatch for test runs that need to import the module
// without enforcing the full registry contract (e.g. when mocking).
if (process.env.IRENE_SKIP_ALIAS_VALIDATION !== "1") {
  validateToolAliases(_toolRegistryNames, { throwOnDrift: true });
}
