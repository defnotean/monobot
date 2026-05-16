/**
 * @file packages/irene/database/schemas.js
 * @module irene/database/schemas
 *
 * Default-shape constants for entities backed by the in-memory cache.
 *
 * Why this file exists:
 *   The in-memory cache (when Supabase is absent, or before the first write
 *   for a given key) stores raw partial objects — `data.guild_settings[g]`
 *   may be `undefined`, `{}`, or only a few sparsely-set fields. Downstream
 *   code that destructures or property-accesses (e.g. `cfg.welcome_color`,
 *   `mood.energy`, `rel.affinity_score`) was crashing on missing rows or
 *   missing keys.
 *
 * Usage pattern in database.js:
 *   const stored = data.X[key] ?? {};
 *   return { ...DEFAULTS, ...stored };   // missing keys fall through
 *
 * Per-key conservatism:
 *   When the "real" default is genuinely unknown (e.g. a guild's welcome
 *   channel — we don't know it until an admin sets it), the default is
 *   `null` rather than a guess. Numeric/boolean/array defaults match the
 *   inline `??` fallbacks that the legacy getters already used, so behavior
 *   is preserved.
 */

// ─── Guild settings ──────────────────────────────────────────────────────────
// One per guild_id under data.guild_settings. The keys covered here are the
// ones reached by name from outside this module (mostly by AI executors and
// event handlers that haven't been routed through a dedicated getter). The
// full set of properties on a stored row is open-ended; this default object
// covers the load-bearing ones.
//
// Channel/role IDs default to null (we cannot guess a real ID).
// Counters and arrays default to the same neutral value the legacy getter
// returned inline so call sites observe no behavioral change.
export const GUILD_SETTINGS_DEFAULTS = Object.freeze({
  // Feature counters / limits
  max_warnings: 3,                 // moderation auto-action threshold

  // Auto-mod
  auto_mod_enabled: false,
  rules: [],
  rule_exemptions: [],
  rule_violations: [],

  // Channels (null until an admin sets them — see comment above)
  welcome_channel: null,
  welcome_message: null,
  leave_channel: null,
  leave_message: null,
  log_channel: null,
  birthday_channel_id: null,
  starboard_channel: null,
  afk_channel_id: null,
  create_vc_channel_id: null,
  ticket_category_id: null,
  ticket_panel_channel_id: null,
  ticket_panel_message_id: null,

  // Roles (null until set)
  autorole_id: null,
  verification_role_id: null,
  irene_access_role_id: null,
  birthday_role_id: null,

  // VC settings
  vc_template: null,               // null = use smart auto mode
  vc_default_limit: 0,
  vc_naming_mode: "smart",         // smart | anonymous | random
  vc_rich_presence: true,
  vc_text_channels: false,
  afk_timeout_minutes: null,

  // Color roles / seasonal palettes
  color_role_ids: [],
  seasonal_colors: false,
  last_seasonal_palette: null,

  // Display toggles
  gif_embed: false,
  dm_results: false,
  dm_welcome_enabled: false,
  dm_welcome_message: "Welcome to {server}! Feel free to introduce yourself.",

  // Ticket arrays (split + legacy combined)
  ticket_view_role_ids: [],
  ticket_ping_role_ids: [],
  ticket_types: [],

  // Tracked-content lists
  public_channels: [],
  trusted_users: [],
  ghost_ping_channels: [],
  bad_words: [],
  tts_channels: [],
  tts_voice: "Kore",

  // Sub-objects (left empty — populated by their own setters)
  channel_personalities: {},
  reaction_roles: {},
  voice_stats: {},
  auto_slowmode: {},
  sticky_messages: {},
  audit_log: [],
  invite_history: [],
  temp_bans: [],

  // Auto-mod escalation policy (null = no auto-action at that tier)
  escalation: { mute_at: null, kick_at: null, ban_at: null },

  // Stats channels (null = not configured)
  stats_channels: null,

  // Patch feed (RSS) defaults
  patch_feeds: { channel_id: null, feeds: [] },

  // Starboard
  starboard_threshold: 3,

  // Birthday auto-announce template
  birthday_message:
    "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉",
});

// ─── Starboard config (slice) ────────────────────────────────────────────────
// Returned by getStarboard(guildId) — kept here so the default lives in one
// place and the getter just spreads it.
export const STARBOARD_DEFAULTS = Object.freeze({
  channelId: null,
  threshold: 3,
});

// ─── DM welcome (slice) ──────────────────────────────────────────────────────
export const DM_WELCOME_DEFAULTS = Object.freeze({
  enabled: false,
  message: "Welcome to {server}! Feel free to introduce yourself.",
});

// ─── Leave settings (slice) ──────────────────────────────────────────────────
export const LEAVE_DEFAULTS = Object.freeze({
  channelId: null,
  message: "Goodbye, {username}. We hope to see you again!",
});

// ─── Escalation policy ───────────────────────────────────────────────────────
// null at every tier = auto-action disabled.
export const ESCALATION_DEFAULTS = Object.freeze({
  mute_at: null,
  kick_at: null,
  ban_at: null,
});

// ─── Mood ────────────────────────────────────────────────────────────────────
// Mirrors the in-memory `data.mood` shape. mood_score is bounded [-100..100],
// energy is [0..100]. The boot-loader already clamps these; this default
// covers reads when no row has been written yet.
export const MOOD_DEFAULTS = Object.freeze({
  mood_score: 0,
  energy: 50,
});

// ─── Per-user relationship ───────────────────────────────────────────────────
// Used by AI affinity / personality systems. affinity_score is bounded
// [-100..100]; interactions_count is a monotonic counter.
export const RELATIONSHIP_DEFAULTS = Object.freeze({
  affinity_score: 0,
  interactions_count: 0,
});

// ─── Ticket config (returned by getTicketConfig) ─────────────────────────────
// Every "channel/role id" field defaults to null because we genuinely don't
// know it until an admin sets it. Arrays default to empty arrays.
export const TICKET_CONFIG_DEFAULTS = Object.freeze({
  category_id: null,
  types: [],
  view_role_ids: [],
  ping_role_ids: [],
  view_auto_category: null,
  ping_auto_category: null,
  welcome_title: null,
  welcome_description: null,
  welcome_color: null,
  panel_title: null,
  panel_description: null,
  panel_color: null,
  panel_button_label: null,
  panel_button_emoji: null,
  panel_channel_id: null,
  panel_message_id: null,
});

// ─── Twitch config ───────────────────────────────────────────────────────────
export const TWITCH_DEFAULTS = Object.freeze({
  channel_id: null,
  streamers: [],
  ping_role_id: null,
  ping_role_ids: [],
  auto_detect: false,
});

// ─── Birthday config (returned by getBirthdayConfig) ─────────────────────────
export const BIRTHDAY_CONFIG_DEFAULTS = Object.freeze({
  channel_id: null,
  role_id: null,
  message:
    "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉",
});

// ─── Patch feeds (RSS) ───────────────────────────────────────────────────────
export const PATCH_FEEDS_DEFAULTS = Object.freeze({
  channel_id: null,
  feeds: [],
});

/**
 * Merge defaults with a stored row. Returns a NEW object (no mutation of
 * either input). Frozen defaults stay frozen; the result is a plain object
 * the caller can extend safely.
 *
 * Key rules:
 *   - `stored == null` (no row written yet) → defensive clone of defaults.
 *   - `stored` not an object → defensive clone of defaults (defensive against
 *     corrupted cache state).
 *   - Otherwise, defaults are spread first, then stored — but with one
 *     caveat: `undefined` values in `stored` do NOT override defaults.
 *     `null` IS preserved (the audit explicitly called out: "explicit-null
 *     in stored persists").
 *
 * Why filter `undefined` and not `null`: spreading `{...{a:1}, ...{a:undefined}}`
 * yields `{a: undefined}` because spread copies own enumerable properties
 * regardless of their value. That would silently erase the default the caller
 * was relying on. `null` is treated as a deliberate "cleared" state and
 * preserved through the merge.
 */
export function withDefaults(defaults, stored) {
  if (stored == null || typeof stored !== "object") return { ...defaults };
  const merged = { ...defaults };
  for (const k of Object.keys(stored)) {
    if (stored[k] !== undefined) merged[k] = stored[k];
  }
  return merged;
}
