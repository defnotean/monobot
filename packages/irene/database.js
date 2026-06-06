/**
 * @file packages/irene/database.js
 * @module irene/database
 *
 * Irene persistence layer — synchronous in-memory cache fronted by an
 * asynchronous, debounced flush to Supabase. Every read returns straight
 * from the local `data` object; every write mutates the cache, marks a
 * bucket dirty, and schedules a ~2s debounced flush. On SIGTERM/SIGINT the
 * process awaits the final flush so the cache is durable across deploys.
 *
 * Why it's shaped this way:
 *   - Discord interactions have a 3-second ack budget; we can't await
 *     network round-trips inside a slash-command handler.
 *   - Render restarts the process on every deploy, so cache-only would
 *     mean amnesia. Supabase is the system of record on cold boot.
 *
 * Domains covered (see the BARREL MODULE MAP below for where each lives):
 *   - guild_settings — per-guild config (welcome, log channels, ghost-ping,
 *     autorole, server rules, auto-mod rules/exemptions/violations,
 *     ticket system config, AFK, temp-VC, color roles, access role,
 *     channel/server personas, bad words, reaction roles, etc.).
 *   - moderation_log — warnings (warnings[], _nextWarningId).
 *   - tickets — config, panel, roles, types, resolution state.
 *   - reminders, scheduled_tasks — time-driven jobs with monotonic IDs.
 *   - custom_commands — per-guild trigger/response map.
 *   - trusted_users — privileged user list with a 5-minute background
 *     refresh cache (recently added) so revocations propagate without a
 *     bot restart while keeping read-path hot.
 *   - mood / relationships — emotional state synced with the Eris sibling
 *     bot via the perEntity dual-write path.
 *   - personality, persistent runtime (music queues, temp VC, lockdown),
 *     external feeds (RSS / Twitch / TTS / YouTube / GitHub), giveaways,
 *     highlights, voice stats, auto-responders, feature toggles, audit log,
 *     invite tracking, temp bans, invite filter, sticky messages,
 *     birthdays, server whitelist, starboard, conversations, DM opt-out.
 *
 * ─── BARREL MODULE MAP ──────────────────────────────────────────────────────
 *   This file is now a BARREL. The implementation lives in cohesive sibling
 *   modules under ./database/*, and the public surface re-exported here is
 *   byte-for-byte the same set of names as before the split. Importers across
 *   the repo do `import { x } from ".../database.js"` — nothing needs to change.
 *
 *   ./database/core.js     — the singleton in-memory cache (`data`), the
 *                            Supabase client (`getSupabase`/`initDatabase`), the
 *                            debounced dirty-set save pipeline (`save`,
 *                            `flushNow`, `_flushSave`, `_dualWriteFanout`,
 *                            `_PERSISTED_SLICES`/`_GLOBAL_STATE_SLICES`), the
 *                            per-key mutex (`withUserLock`), the `ensureGuild`
 *                            helper, the lazy perEntity/saga imports, and the
 *                            `_internal` test surface. Domain modules import
 *                            core; core imports NO domain module (acyclic).
 *   ./database/scrim.js, moderation.js, guildSettings.js, tickets.js,
 *   voiceCosmetic.js, access.js, customCommandsStore.js, welcomeLeave.js,
 *   conversations.js, engagement.js, birthdays.js, whitelist.js, emotional.js,
 *   personality.js, runtime.js, feeds.js, extras.js, invites.js — one cohesive
 *   slice of the public API each. The pre-existing ./database/customCommands.js,
 *   perEntity.js, and schemas.js are unchanged.
 *
 * Per-entity storage pattern:
 *   Each logical entity (guild settings, custom commands, mood state,
 *   relationships, scrim stats, starboard entries, saved queues, global
 *   state) is written through helpers in ./database/perEntity.js to a
 *   dedicated `irene_*` table keyed by `guild_id` or `bot_name`. Rows
 *   carry an integer `version` for optimistic concurrency and a `data`
 *   JSON payload. Rapid writes within COALESCE_MS collapse into a single
 *   round-trip; conflicts retry up to MAX_RETRIES; insert-vs-update is
 *   negotiated via unique-violation fall-through. See
 *   `packages/irene/tests/database/perEntity.test.ts` for the contract.
 *   The perEntity module is loaded lazily inside `_flushSave` to avoid a
 *   circular import (perEntity imports `getSupabase` from core).
 *
 * REQUIRE_PERSISTENCE — fail-fast guarantee:
 *   When the `REQUIRE_PERSISTENCE` env var is truthy, boot will abort
 *   hard if Supabase credentials are missing or the initial load throws.
 *   This is the production posture: a silent fallback to in-memory mode
 *   on Render would burn user state on every deploy.
 *
 * In-memory mode caveats:
 *   Without Supabase credentials (or in tests) the module runs purely
 *   from `data` with no flush. Nothing survives a restart. A loud
 *   warning is logged at boot so this state is impossible to miss in
 *   the logs. NEVER ship this to production — gate with REQUIRE_PERSISTENCE.
 *
 * Concurrency / lock model:
 *   - Reads are sync and unlocked; the JS event loop is the only writer.
 *   - `withUserLock(userId, fn)` serialises read-modify-write sequences
 *     against the same user (e.g. economy, affinity bumps, warning-id
 *     allocation) so two concurrent interactions can't race the cache.
 *   - The flush itself is debounced and reentrant-safe via a dirty-set;
 *     a flush in progress drains pending mutations before resolving.
 *   - Cross-process contention with the Eris sibling bot is handled at
 *     the perEntity layer through Postgres `version` checks — the loser
 *     of a version race re-reads and retries.
 *
 * Do not add new top-level table reads/writes here without also wiring
 * the perEntity helper, the boot-time loader, and a test in
 * `tests/database/perEntity.test.ts`.
 */

// ─── packages/irene/database.js (barrel) ─────────────────────────────────────
// In-memory cache + ~2s debounced flush to Supabase. Reads sync from
// cache; writes mark a bucket dirty; SIGTERM awaits final flush.
// `withUserLock(userId, fn)` for read-modify-write atomicity.
// See docs/start-here.md and the BARREL MODULE MAP above.

// ── Core: cache, Supabase client, save pipeline, locks, test internals ──
export {
  getSupabase,
  initDatabase,
  flushNow,
  withUserLock,
  _internal,
} from "./database/core.js";

// ── Scrim stats ──
export { getScrimStats, updateScrimStats } from "./database/scrim.js";

// ── Moderation — warnings ──
export {
  addWarning,
  getWarnings,
  deleteWarning,
  clearWarnings,
} from "./database/moderation.js";

// ── Guild settings, directives, server rules, auto-mod, misc settings ──
export {
  getGuildSettings,
  setGuildSetting,
  getDirectives,
  addDirective,
  removeDirective,
  getRules,
  addRule,
  removeRule,
  clearRules,
  setAutoModEnabled,
  isAutoModEnabled,
  getExemptions,
  addExemption,
  removeExemption,
  isUserExempt,
  recordViolation,
  getRecentViolations,
  setGifEmbed,
  setDmResults,
  getDmResults,
  getAiSilencedChannels,
  isAiSilencedChannel,
  setAiSilencedChannel,
  setWelcomeChannel,
  setGhostPingChannels,
  getGhostPingChannels,
  setLogChannel,
  setAutorole,
  setTicketCategory,
} from "./database/guildSettings.js";

// ── Ticket system ──
export {
  setTicketModRoles,
  setTicketViewRoles,
  setTicketPingRoles,
  setTicketWelcome,
  setTicketPanel,
  setTicketPanelMessage,
  setTicketTypes,
  addTicketType,
  removeTicketType,
  setTicketAutoCategory,
  setTicketPanelChannel,
  getTicketConfig,
  resolveTicketRoles,
} from "./database/tickets.js";

// ── AFK / temp-VC / color roles / seasonal palettes ──
export {
  setAfkSettings,
  setCreateVcChannel,
  setVcTemplate,
  getVcTemplate,
  setVcDefaultLimit,
  getVcDefaultLimit,
  setVcNamingMode,
  getVcNamingMode,
  setVcRichPresence,
  getVcRichPresence,
  setVcTextChannels,
  getVcTextChannels,
  setColorRoles,
  getColorRoles,
  setSeasonalColors,
  getSeasonalColors,
  setLastSeasonalPalette,
  getLastSeasonalPalette,
} from "./database/voiceCosmetic.js";

// ── Access control — access/verification role, trusted users, DM opt-out ──
export {
  setAccessRole,
  setVerificationRole,
  getVerificationRole,
  getPublicChannels,
  setPublicChannels,
  getTrustedUsers,
  addTrustedUser,
  removeTrustedUser,
  isDmOptout,
  setDmOptout,
} from "./database/access.js";

// ── Custom commands ──
export {
  getCustomCommands,
  getCustomCommand,
  setCustomCommand,
  deleteCustomCommand,
  listCustomCommands,
} from "./database/customCommandsStore.js";

// ── Welcome embed, DM welcome, leave messages ──
export {
  getWelcomeEmbed,
  setWelcomeEmbed,
  setDmWelcome,
  getDmWelcome,
  setLeaveChannel,
  getLeaveSettings,
} from "./database/welcomeLeave.js";

// ── Conversations, personas, bad words, escalation, stats channels ──
export {
  saveConversation,
  loadConversations,
  getConversationsData,
  deleteConversation,
  setChannelPersonality,
  getChannelPersonality,
  setServerPersona,
  getServerPersona,
  setBadWords,
  getBadWords,
  setEscalation,
  getEscalation,
  setStatsChannels,
  getStatsChannels,
} from "./database/conversations.js";

// ── Reaction roles, reminders, scheduled tasks, starboard ──
export {
  addReactionRole,
  isReactionRoleExclusive,
  removeReactionRole,
  getReactionRoles,
  getAllReactionRoles,
  addReminder,
  getReminders,
  removeReminder,
  addScheduledTask,
  getScheduledTasks,
  getScheduledTask,
  removeScheduledTask,
  setStarboard,
  getStarboard,
  addStarboardEntry,
  getStarboardEntry,
} from "./database/engagement.js";

// ── Birthdays ──
export {
  setBirthday,
  removeBirthday,
  getBirthday,
  getGuildBirthdays,
  getTodaysBirthdays,
  setBirthdayChannel,
  setBirthdayRole,
  setBirthdayMessage,
  getBirthdayConfig,
  markBirthdayAnnounced,
  wasBirthdayAnnounced,
} from "./database/birthdays.js";

// ── Server whitelist (unified — bot_data:main) ──
export {
  getWhitelist,
  isWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
} from "./database/whitelist.js";

// ── Emotional state — mood, energy, relationships ──
export {
  getMood,
  updateMood,
  shiftMood,
  moodLabel,
  getRelationship,
  updateRelationship,
  updateRelationshipLocked,
  getAllRelationships,
} from "./database/emotional.js";

// ── Personality (Supabase-synced) ──
export { getPersonality, updatePersonality } from "./database/personality.js";

// ── Persistent runtime — music queues, temp VC, lockdown, auto-slowmode ──
export {
  saveQueue,
  getSavedQueues,
  clearSavedQueue,
  clearAllSavedQueues,
  saveTempVc,
  deleteTempVc,
  getAllTempVcs,
  clearAllTempVcs,
  saveLockdown,
  clearLockdown,
  getLockdown,
  saveSlowmode,
  clearSlowmode,
  getAutoSlowmodes,
} from "./database/runtime.js";

// ── External feeds — RSS / Twitch / TTS / YouTube / GitHub ──
export {
  getPatchFeeds,
  setPatchFeeds,
  getPatchLastSeen,
  setPatchLastSeen,
  getTwitchConfig,
  setTwitchConfig,
  getTtsChannels,
  setTtsChannels,
  getTtsVoice,
  setTtsVoice,
  getYoutubeConfig,
  setYoutubeConfig,
  getGithubConfig,
  setGithubConfig,
} from "./database/feeds.js";

// ── Giveaways, highlights, voice stats, auto-responders, toggles, audit ──
export {
  getGiveawayDb,
  saveGiveawayDb,
  getGiveawayPingRoles,
  setGiveawayPingRoles,
  getHighlightDb,
  saveHighlightDb,
  getVoiceStats,
  addVoiceTime,
  getAutoResponders,
  addAutoResponder,
  removeAutoResponder,
  isFeatureEnabled,
  setFeatureToggle,
  logAudit,
} from "./database/extras.js";

// ── Invite tracking, temp bans, invite filter, sticky messages ──
export {
  recordInviteJoin,
  markInviteLeave,
  getInviteHistory,
  getInviteLeaderboard,
  getInvitesBy,
  addTempBan,
  getExpiredTempBans,
  removeTempBan,
  setInviteFilter,
  setInviteFilterWhitelist,
  setStickyMessage,
  getStickyMessage,
  updateStickyMessageId,
  removeStickyMessage,
} from "./database/invites.js";
