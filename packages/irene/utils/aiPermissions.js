// ─── Centralized AI Permission System ────────────────────────────────────────
// Single source of truth for who can use what tools.
// Integration into messageCreate.js and executor.js is a follow-up task.

import config from "../config.js";

// Permission levels (highest to lowest)
export const PERM_LEVELS = {
  OWNER: 4,
  ADMIN: 3,
  MOD: 2,
  STAFF: 1,
  EVERYONE: 0,
};

/**
 * Determine a member's permission level.
 * @param {object} member — Discord GuildMember
 * @param {string} [guildId] — guild ID (reserved for future trusted-user lookup)
 * @returns {number} permission level from PERM_LEVELS
 */
export function getPermissionLevel(member, guildId) {
  if (!member) return PERM_LEVELS.EVERYONE;

  // Bot owner (defnotean)
  if (member.id === config.userId) return PERM_LEVELS.OWNER;

  // Guild owner
  if (member.guild?.ownerId === member.id) return PERM_LEVELS.ADMIN;

  // Discord permissions
  const perms = member.permissions;
  if (perms?.has?.("Administrator") || perms?.has?.("ManageGuild")) return PERM_LEVELS.ADMIN;
  if (perms?.has?.("ManageMessages") || perms?.has?.("KickMembers") || perms?.has?.("BanMembers")) return PERM_LEVELS.MOD;
  if (perms?.has?.("ManageRoles") || perms?.has?.("ManageChannels")) return PERM_LEVELS.STAFF;

  return PERM_LEVELS.EVERYONE;
}

/**
 * Check if a given permission level can use a specific tool.
 * @param {string} toolName
 * @param {number} permLevel — from PERM_LEVELS
 * @returns {boolean}
 */
export function canUseTool(toolName, permLevel) {
  const required = TOOL_PERM_MAP[toolName];
  if (required === undefined) return true; // Unknown tools default to EVERYONE
  return permLevel >= required;
}

/**
 * Get the minimum permission level required for a tool.
 * @param {string} toolName
 * @returns {number} permission level, or EVERYONE if not mapped
 */
export function getToolPermLevel(toolName) {
  return TOOL_PERM_MAP[toolName] ?? PERM_LEVELS.EVERYONE;
}

/**
 * Get a human-readable label for a permission level.
 * @param {number} level
 * @returns {string}
 */
export function permLevelLabel(level) {
  switch (level) {
    case PERM_LEVELS.OWNER: return "Bot Owner";
    case PERM_LEVELS.ADMIN: return "Admin";
    case PERM_LEVELS.MOD: return "Moderator";
    case PERM_LEVELS.STAFF: return "Staff";
    default: return "Everyone";
  }
}

// ─── Tool → minimum permission level required ────────────────────────────────
// Tools not listed here default to EVERYONE (anyone can use them).

const TOOL_PERM_MAP = {
  // ── OWNER only ─────────────────────────────────────────────────────────────
  // Bot personality / identity
  set_server_persona: PERM_LEVELS.OWNER,
  set_server_avatar: PERM_LEVELS.OWNER,
  set_server_banner: PERM_LEVELS.OWNER,
  set_channel_personality: PERM_LEVELS.OWNER,
  // Mood / relationship internals
  adjust_relationship: PERM_LEVELS.OWNER,
  adjust_mood: PERM_LEVELS.OWNER,
  // Server whitelist
  whitelist_server: PERM_LEVELS.OWNER,
  unwhitelist_server: PERM_LEVELS.OWNER,
  list_whitelist: PERM_LEVELS.OWNER,

  // ── ADMIN+ ─────────────────────────────────────────────────────────────────
  // Channel management (destructive)
  create_channel: PERM_LEVELS.ADMIN,
  delete_channel: PERM_LEVELS.ADMIN,
  nuke_channel: PERM_LEVELS.ADMIN,
  create_category: PERM_LEVELS.ADMIN,
  delete_category: PERM_LEVELS.ADMIN,
  clone_channel: PERM_LEVELS.ADMIN,
  move_channel: PERM_LEVELS.ADMIN,
  set_channel_permissions: PERM_LEVELS.ADMIN,
  // Role management (destructive)
  create_role: PERM_LEVELS.ADMIN,
  delete_role: PERM_LEVELS.ADMIN,
  edit_role: PERM_LEVELS.ADMIN,
  reorder_roles: PERM_LEVELS.ADMIN,
  set_role_permissions: PERM_LEVELS.ADMIN,
  mass_role: PERM_LEVELS.ADMIN,
  setup_reaction_roles: PERM_LEVELS.ADMIN,
  add_reaction_role: PERM_LEVELS.ADMIN,
  remove_reaction_role: PERM_LEVELS.ADMIN,
  setup_role_picker: PERM_LEVELS.ADMIN,
  setup_dropdown_roles: PERM_LEVELS.ADMIN,
  setup_color_roles: PERM_LEVELS.ADMIN,
  toggle_seasonal_colors: PERM_LEVELS.ADMIN,
  set_ghost_ping_channels: PERM_LEVELS.ADMIN,
  preview_seasonal_palette: PERM_LEVELS.EVERYONE,
  force_seasonal_rotation: PERM_LEVELS.ADMIN,
  // Moderation (heavy)
  ban_user: PERM_LEVELS.ADMIN,
  lockdown_server: PERM_LEVELS.ADMIN,
  unlock_server: PERM_LEVELS.ADMIN,
  // Server config
  set_log_channel: PERM_LEVELS.ADMIN,
  set_welcome_channel: PERM_LEVELS.ADMIN,
  customize_welcome: PERM_LEVELS.ADMIN,
  set_dm_welcome: PERM_LEVELS.ADMIN,
  set_leave_channel: PERM_LEVELS.ADMIN,
  set_access_role: PERM_LEVELS.ADMIN,
  setup_verification: PERM_LEVELS.ADMIN,
  set_autorole: PERM_LEVELS.ADMIN,
  set_dm_results: PERM_LEVELS.ADMIN,
  set_bad_words: PERM_LEVELS.ADMIN,
  set_escalation: PERM_LEVELS.ADMIN,
  setup_stats_channels: PERM_LEVELS.ADMIN,
  setup_starboard: PERM_LEVELS.ADMIN,
  setup_ticket: PERM_LEVELS.ADMIN,
  // Feature toggles
  toggle_auto_responders: PERM_LEVELS.ADMIN,
  toggle_twin_chat: PERM_LEVELS.ADMIN,
  toggle_voice_tracking: PERM_LEVELS.ADMIN,
  toggle_tts: PERM_LEVELS.ADMIN,
  toggle_leveling: PERM_LEVELS.ADMIN,
  toggle_voice_listen: PERM_LEVELS.ADMIN,
  // Notification integrations
  configure_patch_news: PERM_LEVELS.ADMIN,
  configure_twitch: PERM_LEVELS.ADMIN,
  configure_youtube: PERM_LEVELS.ADMIN,
  configure_github: PERM_LEVELS.ADMIN,
  configure_giveaway_pings: PERM_LEVELS.ADMIN,
  configure_birthdays: PERM_LEVELS.ADMIN,
  configure_suggestions: PERM_LEVELS.ADMIN,
  // Leveling config
  set_level_reward: PERM_LEVELS.ADMIN,
  remove_level_reward: PERM_LEVELS.ADMIN,
  set_level_channel: PERM_LEVELS.ADMIN,
  set_level_ping_roles: PERM_LEVELS.ADMIN,
  // Dynamic VC config
  set_create_vc_channel: PERM_LEVELS.ADMIN,
  set_vc_template: PERM_LEVELS.ADMIN,
  set_vc_default_limit: PERM_LEVELS.ADMIN,
  set_vc_naming_mode: PERM_LEVELS.ADMIN,
  toggle_vc_rich_presence: PERM_LEVELS.ADMIN,
  set_afk_channel: PERM_LEVELS.ADMIN,
  // Trust management
  trust_user: PERM_LEVELS.ADMIN,
  untrust_user: PERM_LEVELS.ADMIN,
  // Custom commands
  create_custom_command: PERM_LEVELS.ADMIN,
  edit_custom_command: PERM_LEVELS.ADMIN,
  delete_custom_command: PERM_LEVELS.ADMIN,
  // Auto-responders
  create_auto_responder: PERM_LEVELS.ADMIN,
  delete_auto_responder: PERM_LEVELS.ADMIN,
  // Server settings (newtools)
  set_server_settings: PERM_LEVELS.ADMIN,
  set_server_icon: PERM_LEVELS.ADMIN,
  // Giveaway / scrim management
  manage_giveaway: PERM_LEVELS.ADMIN,
  manage_scrim: PERM_LEVELS.ADMIN,
  // Emoji management
  add_emoji: PERM_LEVELS.ADMIN,
  remove_emoji: PERM_LEVELS.ADMIN,
  // TTS config
  set_tts_voice: PERM_LEVELS.ADMIN,
  // Audit log
  view_audit_log: PERM_LEVELS.ADMIN,
  // Invites
  delete_invite: PERM_LEVELS.ADMIN,

  // Temp bans
  tempban: PERM_LEVELS.MOD,
  // Sticky messages
  sticky_message: PERM_LEVELS.ADMIN,
  remove_sticky: PERM_LEVELS.ADMIN,
  // Invite filter
  toggle_invite_filter: PERM_LEVELS.ADMIN,

  // ── MOD+ ───────────────────────────────────────────────────────────────────
  kick_user: PERM_LEVELS.MOD,
  warn_user: PERM_LEVELS.MOD,
  timeout_user: PERM_LEVELS.MOD,
  purge_messages: PERM_LEVELS.MOD,
  lock_channel: PERM_LEVELS.MOD,
  unlock_channel: PERM_LEVELS.MOD,
  set_slowmode: PERM_LEVELS.MOD,
  give_role: PERM_LEVELS.MOD,
  remove_role: PERM_LEVELS.MOD,
  set_nickname: PERM_LEVELS.MOD,
  move_user_to_voice: PERM_LEVELS.MOD,
  disconnect_user_from_voice: PERM_LEVELS.MOD,
  find_message: PERM_LEVELS.MOD,
  pin_message: PERM_LEVELS.MOD,
  unpin_message: PERM_LEVELS.MOD,

  // ── STAFF+ ─────────────────────────────────────────────────────────────────
  rename_channel: PERM_LEVELS.STAFF,
  set_channel_topic: PERM_LEVELS.STAFF,
  send_message: PERM_LEVELS.STAFF,
  send_animated_message: PERM_LEVELS.STAFF,
  create_thread: PERM_LEVELS.STAFF,
  create_invite: PERM_LEVELS.STAFF,
  edit_message: PERM_LEVELS.STAFF,
  read_messages: PERM_LEVELS.STAFF,
  search_messages: PERM_LEVELS.STAFF,
  react_to_message: PERM_LEVELS.STAFF,
  remove_reaction: PERM_LEVELS.STAFF,
  list_invites: PERM_LEVELS.STAFF,
  list_members: PERM_LEVELS.STAFF,
  save_directive: PERM_LEVELS.STAFF,
  remove_directive: PERM_LEVELS.STAFF,

  // ── EVERYONE (explicitly listed for clarity — these are the defaults) ──────
  // Memory
  remember_fact: PERM_LEVELS.EVERYONE,
  recall_memories: PERM_LEVELS.EVERYONE,
  forget_memory: PERM_LEVELS.EVERYONE,
  clear_all_memories: PERM_LEVELS.EVERYONE,
  summarize_channel: PERM_LEVELS.EVERYONE,
  // Birthdays
  set_birthday: PERM_LEVELS.EVERYONE,
  get_birthday: PERM_LEVELS.EVERYONE,
  list_birthdays: PERM_LEVELS.EVERYONE,
  remove_birthday: PERM_LEVELS.EVERYONE,
  // Music
  play_music: PERM_LEVELS.EVERYONE,
  skip_song: PERM_LEVELS.EVERYONE,
  stop_music: PERM_LEVELS.EVERYONE,
  pause_music: PERM_LEVELS.EVERYONE,
  resume_music: PERM_LEVELS.EVERYONE,
  music_queue: PERM_LEVELS.EVERYONE,
  now_playing: PERM_LEVELS.EVERYONE,
  set_volume: PERM_LEVELS.EVERYONE,
  toggle_loop: PERM_LEVELS.EVERYONE,
  shuffle_queue: PERM_LEVELS.EVERYONE,
  music_filter: PERM_LEVELS.EVERYONE,
  // Web / utility
  web_search: PERM_LEVELS.EVERYONE,
  web_read: PERM_LEVELS.EVERYONE,
  calculate: PERM_LEVELS.EVERYONE,
  send_gif: PERM_LEVELS.EVERYONE,
  set_gif_style: PERM_LEVELS.EVERYONE,
  generate_image: PERM_LEVELS.EVERYONE,
  snipe: PERM_LEVELS.EVERYONE,
  // Info (read-only)
  get_server_info: PERM_LEVELS.EVERYONE,
  get_user_info: PERM_LEVELS.EVERYONE,
  list_channels: PERM_LEVELS.EVERYONE,
  list_roles: PERM_LEVELS.EVERYONE,
  get_role_permissions: PERM_LEVELS.EVERYONE,
  list_emojis: PERM_LEVELS.EVERYONE,
  list_bans: PERM_LEVELS.EVERYONE,
  random_member: PERM_LEVELS.EVERYONE,
  count_members: PERM_LEVELS.EVERYONE,
  who_has_role: PERM_LEVELS.EVERYONE,
  list_custom_commands: PERM_LEVELS.EVERYONE,
  list_auto_responders: PERM_LEVELS.EVERYONE,
  list_trusted_users: PERM_LEVELS.EVERYONE,
  list_directives: PERM_LEVELS.EVERYONE,
  list_pins: PERM_LEVELS.EVERYONE,
  voice_leaderboard: PERM_LEVELS.EVERYONE,
  server_milestones: PERM_LEVELS.EVERYONE,
  // Temp VC (owner-of-channel checks happen in executor, not here)
  vc_info: PERM_LEVELS.EVERYONE,
  vc_private: PERM_LEVELS.EVERYONE,
  vc_public: PERM_LEVELS.EVERYONE,
  vc_lock: PERM_LEVELS.EVERYONE,
  vc_unlock: PERM_LEVELS.EVERYONE,
  vc_rename: PERM_LEVELS.EVERYONE,
  vc_transfer: PERM_LEVELS.EVERYONE,
  vc_kick: PERM_LEVELS.EVERYONE,
  vc_allow: PERM_LEVELS.EVERYONE,
  vc_claim: PERM_LEVELS.EVERYONE,
  // DM / personal
  set_dm_preference: PERM_LEVELS.EVERYONE,
  // Reminders
  reminder_set: PERM_LEVELS.EVERYONE,
  reminder_cancel: PERM_LEVELS.EVERYONE,
  // Twin
  ask_eris: PERM_LEVELS.EVERYONE,
  // Testing / preview
  test_patch_news: PERM_LEVELS.EVERYONE,
  send_test_birthday: PERM_LEVELS.EVERYONE,
  send_test_welcome: PERM_LEVELS.EVERYONE,
  // TTS (speaking, not config)
  say_tts: PERM_LEVELS.EVERYONE,
};
