// ─── packages/irene/database.js ─────────────────────────────────────────
// In-memory cache + ~2s debounced flush to Supabase. Reads sync from
// cache; writes mark a bucket dirty; SIGTERM awaits final flush.
// `withUserLock(userId, fn)` for read-modify-write atomicity.
// See docs/start-here.md and the existing TOC below.

// ─── Database — Supabase backed, in-memory cache ─────────────────────────────
// All reads are synchronous (from cache). Writes update cache immediately then
// flush to Supabase in the background. On startup, loads from Supabase so data
// survives Render deploys and restarts.
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//  1. In-memory cache + scrim stats ........................... ~line 34
//  2. Supabase client & initial load .......................... ~line 79
//  3. Save (debounced + retry) & flushNow ..................... ~line 157
//  4. Moderation — warnings ................................... ~line 230
//  5. Guild settings & directives ............................. ~line 273
//  6. Server rules + auto-mod (rules/exemptions/violations) ... ~line 319
//  7. Misc guild settings (welcome, log, ghost-ping, autorole)  ~line 496
//  8. Ticket system (config, roles, panel, types, resolution)   ~line 553
//  9. AFK / temp-VC / color roles / seasonal palettes ......... ~line 798
// 10. Access role / verification / trusted users / DM opt-out . ~line 886
// 11. Custom commands ........................................ ~line 963
// 12. Welcome embed, DM welcome, leave messages .............. ~line 1005
// 13. Conversations, channel/server personas, bad words, stats ~line 1063
// 14. Reaction roles, reminders, scheduled tasks, starboard .. ~line 1183
// 15. Birthdays & server whitelist ........................... ~line 1314
// 16. Emotional state — mood, energy, relationships .......... ~line 1425
// 17. Personality (Supabase-synced) .......................... ~line 1474
// 18. Persistent runtime — music queues, temp VC, lockdown ... ~line 1492
// 19. External feeds — RSS / Twitch / TTS / YouTube / GitHub . ~line 1589
// 20. Giveaways, highlights, voice stats, auto-responders .... ~line 1675
// 21. Feature toggles & audit log ............................ ~line 1756
// 22. Invite tracking / temp bans / invite filter / sticky msg ~line 1790
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import config from "./config.js";
// Dual-write target — only invoked when config.dualWritePersistence is true.
// Imported lazily inside _flushSave to avoid a circular module load at boot
// (perEntity.js imports getSupabase from this file).
let _perEntityModule = null;
async function _getPerEntity() {
  if (!_perEntityModule) _perEntityModule = await import("./database/perEntity.js");
  return _perEntityModule;
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE — single source of truth for all reads (synchronous)
// ═══════════════════════════════════════════════════════════════════════════

// ─── In-memory cache ─────────────────────────────────────────────────────────

let data = {
  scrim_stats: {},
  warnings: [],
  guild_settings: {},
  custom_commands: {},
  dm_optout: [],
  _nextWarningId: 1,
  conversations: {},
  reminders: [],
  _nextReminderId: 1,
  scheduled_tasks: [],
  _nextScheduledTaskId: 1,
  starboard_entries: {},
  birthdays: [],
  birthday_announced: {},
  server_whitelist: {},
  saved_queues: {},
  giveaways: [],
  highlights: {},
  // ─── Emotional State (synced with Eris) ───
  mood: { mood_score: 0, energy: 50 },
  relationships: {},  // userId → { affinity_score, interactions_count }
  temp_vcs: {},       // channelId → vcData — top-level to avoid polluting guild_settings
};

export function getScrimStats(guildId, game) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  if (!data.scrim_stats[guildId][game]) data.scrim_stats[guildId][game] = {};
  return { ...data.scrim_stats[guildId][game] };
}

export function updateScrimStats(guildId, game, stats) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  data.scrim_stats[guildId][game] = stats;
  save();
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT & INITIAL LOAD — restores cache from prior process
// ═══════════════════════════════════════════════════════════════════════════

// ─── Supabase client ─────────────────────────────────────────────────────────

let supabase = null;

export function getSupabase() { return supabase; }

export async function initDatabase() {
  if (!config.supabaseEnabled) {
    console.warn("[DB] No SUPABASE_URL/SUPABASE_KEY set — settings won't persist across deploys");
    return;
  }

  try {
    supabase = createClient(config.supabaseUrl, config.supabaseKey);
  } catch (err) {
    console.error("[DB] Invalid Supabase config:", err.message);
    return;
  }

  // Retry up to 3 times — Render cold starts sometimes have transient network delays
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data: row, error } = await supabase
        .from("bot_data")
        .select("data")
        .eq("id", "irene")
        .single();

      if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows found

      if (row?.data) {
        const loaded = row.data;
        if (loaded.guild_settings) data.guild_settings = loaded.guild_settings;
        if (loaded.custom_commands) data.custom_commands = loaded.custom_commands;
        if (loaded.warnings) data.warnings = loaded.warnings;
        if (loaded.dm_optout) data.dm_optout = loaded.dm_optout;
        if (loaded._nextWarningId) data._nextWarningId = loaded._nextWarningId;
        if (loaded.conversations) data.conversations = loaded.conversations;
        if (loaded.reminders) data.reminders = loaded.reminders;
        if (loaded._nextReminderId) data._nextReminderId = loaded._nextReminderId;
        if (loaded.scheduled_tasks) data.scheduled_tasks = loaded.scheduled_tasks;
        if (loaded._nextScheduledTaskId) data._nextScheduledTaskId = loaded._nextScheduledTaskId;
        if (loaded.starboard_entries) data.starboard_entries = loaded.starboard_entries;
        if (loaded.birthdays) data.birthdays = loaded.birthdays;
        if (loaded.birthday_announced) data.birthday_announced = loaded.birthday_announced;
        if (loaded.server_whitelist) data.server_whitelist = loaded.server_whitelist;
        if (loaded.saved_queues) data.saved_queues = loaded.saved_queues;
        if (loaded.scrim_stats) data.scrim_stats = loaded.scrim_stats;
        if (loaded.giveaways) data.giveaways = loaded.giveaways;
        if (loaded.highlights) data.highlights = loaded.highlights;
        if (loaded.mood) {
          data.mood = {
            mood_score: Math.max(-100, Math.min(100, Number(loaded.mood.mood_score) || 0)),
            energy: Math.max(0, Math.min(100, Number(loaded.mood.energy) || 50)),
          };
        }
        if (loaded.relationships) data.relationships = loaded.relationships;
        if (loaded.temp_vcs) data.temp_vcs = loaded.temp_vcs;
        console.log("[DB] Loaded from Supabase");
      } else {
        console.log("[DB] No existing data in Supabase — starting fresh");
      }
      return; // success
    } catch (err) {
      console.error(`[DB] Supabase init attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  console.error("[DB] All Supabase init attempts failed — running without persistence");
}

// ═══════════════════════════════════════════════════════════════════════════
// SAVE PIPELINE — debounced writes, retry/backoff, immediate flush on shutdown
// ═══════════════════════════════════════════════════════════════════════════

// ─── Save — debounced + retry ─────────────────────────────────────────────────
// Coalesces rapid back-to-back writes into one Supabase call (2 s window).
// Retries up to 3 times on failure, then reschedules after 30 s.

let _saveTimer = null;
let _saveRetryCount = 0;
const MAX_SAVE_RETRIES = 10;

function save() {
  if (!supabase) { console.warn("[DB] Write discarded — Supabase not connected (data is in-memory only)"); return; }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 2000);
}

// Immediate flush — call on shutdown to prevent data loss from the 2s debounce window
export async function flushNow() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = null;
  if (!supabase) return;
  await _flushSave();
  // Drain the per-entity coalesce queue too — only matters when dual-write
  // is enabled but cheap to call unconditionally (no-op when nothing pending).
  if (config.dualWritePersistence) {
    try {
      const pe = await _getPerEntity();
      await pe.flushPerEntityNow();
    } catch (err) {
      console.error(`[DB] Per-entity flush failed: ${err.message}`);
    }
  }
}

// Dual-write fanout — splits the sanitized blob into per-entity writes when
// config.dualWritePersistence is on. Iterates per-guild keyed objects so each
// guild gets its own row in the per-entity tables; global state collapses
// into a single row keyed on bot_name.
async function _dualWriteFanout(snapshot) {
  const pe = await _getPerEntity();
  const writes = [];

  // Per-guild fanout — one row per guild for tables keyed on guild_id.
  for (const [gid, gs] of Object.entries(snapshot.guild_settings || {})) {
    writes.push(pe.writeGuildSettings(gid, gs));
  }
  for (const [gid, cmds] of Object.entries(snapshot.custom_commands || {})) {
    writes.push(pe.writeCustomCommands(gid, cmds));
  }
  for (const [gid, stats] of Object.entries(snapshot.scrim_stats || {})) {
    writes.push(pe.writeScrimStats(gid, stats));
  }
  for (const [gid, entries] of Object.entries(snapshot.starboard_entries || {})) {
    writes.push(pe.writeStarboardEntries(gid, entries));
  }
  for (const [gid, q] of Object.entries(snapshot.saved_queues || {})) {
    writes.push(pe.writeSavedQueue(gid, q));
  }

  // Global state — single row each.
  if (snapshot.mood) writes.push(pe.writeMoodState(snapshot.mood));
  if (snapshot.relationships) writes.push(pe.writeRelationships(snapshot.relationships));

  // Catch-all — counters and cross-guild flat collections in one row.
  writes.push(pe.writeGlobalState({
    _nextWarningId: snapshot._nextWarningId,
    _nextReminderId: snapshot._nextReminderId,
    _nextScheduledTaskId: snapshot._nextScheduledTaskId,
    dm_optout: snapshot.dm_optout,
    warnings: snapshot.warnings,
    reminders: snapshot.reminders,
    scheduled_tasks: snapshot.scheduled_tasks,
    birthdays: snapshot.birthdays,
    birthday_announced: snapshot.birthday_announced,
    server_whitelist: snapshot.server_whitelist,
    giveaways: snapshot.giveaways,
    highlights: snapshot.highlights,
    temp_vcs: snapshot.temp_vcs,
    conversations: snapshot.conversations,
  }));

  await Promise.all(writes);
}

async function _flushSave() {
  _saveTimer = null;
  if (!supabase) return;

  // Sanitize before save — strip non-serializable or oversized fields
  let saveData;
  try {
    // Trim conversations to last 10 per channel to prevent payload bloat
    if (data.conversations && typeof data.conversations === "object") {
      for (const [ch, msgs] of Object.entries(data.conversations)) {
        if (Array.isArray(msgs) && msgs.length > 10) {
          data.conversations[ch] = msgs.slice(-10);
        }
      }
    }
    const json = JSON.stringify(data);
    if (!json || json === "null" || json === "undefined" || json.length < 5) {
      console.error(`[DB] Save aborted — data serialized to empty/invalid (${json?.length ?? 0} chars)`);
      return;
    }
    saveData = JSON.parse(json); // round-trip to strip non-serializable values
  } catch (serErr) {
    console.error(`[DB] Save aborted — serialization failed: ${serErr.message}`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase.from("bot_data").upsert({ id: "irene", data: saveData });
      if (!error) {
        _saveRetryCount = 0;
        // Dual-write fanout: when the flag is on, also write each entity to
        // its dedicated per-entity table. Runs AFTER the legacy blob write
        // succeeds so a per-entity bug can never break the existing path.
        // Errors are swallowed at this layer — perEntity.js logs its own.
        if (config.dualWritePersistence) {
          try { await _dualWriteFanout(saveData); }
          catch (dwErr) { console.error(`[DB] Dual-write fanout failed: ${dwErr.message}`); }
        }
        return;
      }
      throw new Error(error.message);
    } catch (err) {
      console.error(`[DB] Save attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (_saveRetryCount >= MAX_SAVE_RETRIES) {
    console.error("[DB] Max retries reached — will try again in 5 min");
    _saveRetryCount = 0;
    _saveTimer = setTimeout(_flushSave, 5 * 60_000);
    return;
  }
  _saveRetryCount++;
  console.error("[DB] All save attempts failed — retrying in 30 s");
  _saveTimer = setTimeout(_flushSave, 30_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// MODERATION — warnings (add/get/delete/clear)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Warnings ────────────────────────────────────────────────────────────────

export function addWarning(guildId, userId, moderatorId, reason) {
  const warning = {
    id: data._nextWarningId++,
    guild_id: guildId,
    user_id: userId,
    moderator_id: moderatorId,
    reason,
    created_at: new Date().toISOString(),
  };
  data.warnings.push(warning);
  save();
  return warning;
}

export function getWarnings(guildId, userId) {
  return data.warnings
    .filter((w) => w.guild_id === guildId && w.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function deleteWarning(id, guildId) {
  const idx = data.warnings.findIndex((w) => w.id === id && w.guild_id === guildId);
  if (idx !== -1) {
    data.warnings.splice(idx, 1);
    save();
    return { changes: 1 };
  }
  return { changes: 0 };
}

export function clearWarnings(guildId, userId) {
  const before = data.warnings.length;
  data.warnings = data.warnings.filter((w) => !(w.guild_id === guildId && w.user_id === userId));
  save();
  return { changes: before - data.warnings.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// GUILD SETTINGS & DIRECTIVES — per-server key/value store + admin directives
// ═══════════════════════════════════════════════════════════════════════════

// ─── Guild Settings ───────────────────────────────────────────────────────────

function ensureGuild(guildId) {
  if (!data.guild_settings[guildId]) data.guild_settings[guildId] = {};
  return data.guild_settings[guildId];
}

export function getGuildSettings(guildId) {
  return data.guild_settings[guildId] || null;
}

export function setGuildSetting(guildId, key, value) {
  const gs = ensureGuild(guildId);
  gs[key] = value;
  save("guild_settings");
}

// ─── Directives: persistent behavioral rules given by admins in natural language ──
export function getDirectives(guildId) {
  return ensureGuild(guildId).directives || [];
}
export function addDirective(guildId, text, channelId = null, addedBy = null) {
  const g = ensureGuild(guildId);
  if (!g.directives) g.directives = [];
  if (g.directives.length >= 50) return { success: false, reason: "max 50 directives per server" };
  // Dedup: don't save if near-identical directive exists
  const lower = text.toLowerCase().trim();
  if (g.directives.some(d => d.text.toLowerCase().trim() === lower)) return { success: false, reason: "duplicate directive" };
  g.directives.push({ text: text.substring(0, 300), channel: channelId || null, addedBy, addedAt: Date.now() });
  save();
  return { success: true, index: g.directives.length - 1 };
}
export function removeDirective(guildId, indexOrKeyword) {
  const g = ensureGuild(guildId);
  if (!g.directives?.length) return { success: false, reason: "no directives saved" };
  const idx = typeof indexOrKeyword === "number" ? indexOrKeyword : g.directives.findIndex(d => d.text.toLowerCase().includes(String(indexOrKeyword).toLowerCase()));
  if (idx < 0 || idx >= g.directives.length) return { success: false, reason: "directive not found" };
  const removed = g.directives.splice(idx, 1)[0];
  save();
  return { success: true, removed: removed.text };
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER RULES & AUTO-MOD — numbered rules, exemptions, violation tracking
// ═══════════════════════════════════════════════════════════════════════════

// ─── Server Rules: structured rules Irene enforces ────────────────────────────
// Mirrors the `directives` pattern but with rule numbers (1, 2, 3 …) and
// severity. Admins use `/rules` to manage. Auto-mod (when enabled) checks
// every message against these rules.
//
// data.guild_settings[guildId].rules         = Rule[]
// data.guild_settings[guildId].rule_exemptions = Exemption[]
// data.guild_settings[guildId].rule_violations = Violation[]   // for escalation
// data.guild_settings[guildId].auto_mod_enabled = boolean      // OFF by default
//
// Rule:        { number, text, severity, addedBy, addedAt }
//   severity ∈ "low" | "medium" | "high" — used by escalation policy
// Exemption:   { userId, ruleNumber|null, reason, addedBy, addedAt, expiresAt|null }
//   ruleNumber=null means exempt from ALL rules
// Violation:   { userId, ruleNumber, messageId, severity, action, ts }

const MAX_RULES_PER_GUILD = 25;
const MAX_EXEMPTIONS_PER_GUILD = 200;
const MAX_VIOLATIONS_RETAINED = 500; // FIFO trim — we only need recent for escalation

export function getRules(guildId) {
  return data.guild_settings[guildId]?.rules ?? [];
}

export function addRule(guildId, text, severity, addedBy) {
  const g = ensureGuild(guildId);
  if (!g.rules) g.rules = [];
  if (g.rules.length >= MAX_RULES_PER_GUILD) {
    return { success: false, reason: `max ${MAX_RULES_PER_GUILD} rules per server` };
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return { success: false, reason: "empty rule text" };
  const sev = ["low", "medium", "high"].includes(severity) ? severity : "medium";
  // Dedup against existing rule text (case-insensitive)
  const lower = trimmed.toLowerCase();
  if (g.rules.some(r => r.text.toLowerCase() === lower)) {
    return { success: false, reason: "duplicate rule" };
  }
  // Auto-number based on existing entries (max+1, so removed numbers don't reset)
  const nextNumber = g.rules.length === 0
    ? 1
    : Math.max(...g.rules.map(r => r.number)) + 1;
  const rule = {
    number: nextNumber,
    text: trimmed.substring(0, 500),
    severity: sev,
    addedBy: addedBy || null,
    addedAt: Date.now(),
  };
  g.rules.push(rule);
  save();
  return { success: true, rule };
}

export function removeRule(guildId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rules?.length) return { success: false, reason: "no rules saved" };
  const idx = g.rules.findIndex(r => r.number === Number(ruleNumber));
  if (idx < 0) return { success: false, reason: `no rule numbered ${ruleNumber}` };
  const removed = g.rules.splice(idx, 1)[0];
  save();
  return { success: true, removed };
}

export function clearRules(guildId) {
  const g = ensureGuild(guildId);
  const count = g.rules?.length ?? 0;
  g.rules = [];
  save();
  return { success: true, count };
}

export function setAutoModEnabled(guildId, enabled) {
  const g = ensureGuild(guildId);
  g.auto_mod_enabled = !!enabled;
  save();
  return g.auto_mod_enabled;
}

export function isAutoModEnabled(guildId) {
  return !!data.guild_settings[guildId]?.auto_mod_enabled;
}

// ─── Rule exemptions ──────────────────────────────────────────────────────────

export function getExemptions(guildId) {
  return data.guild_settings[guildId]?.rule_exemptions ?? [];
}

export function addExemption(guildId, userId, ruleNumber, reason, addedBy, expiresAt = null) {
  const g = ensureGuild(guildId);
  if (!g.rule_exemptions) g.rule_exemptions = [];
  if (g.rule_exemptions.length >= MAX_EXEMPTIONS_PER_GUILD) {
    return { success: false, reason: `max ${MAX_EXEMPTIONS_PER_GUILD} exemptions per server` };
  }
  if (!userId) return { success: false, reason: "missing user" };
  const ruleNum = ruleNumber === null || ruleNumber === undefined ? null : Number(ruleNumber);
  // Dedup: same user + same rule (or both global) → reject
  const dup = g.rule_exemptions.find(e => e.userId === userId && e.ruleNumber === ruleNum);
  if (dup) return { success: false, reason: "exemption already exists" };
  const ex = {
    userId,
    ruleNumber: ruleNum,
    reason: String(reason || "").substring(0, 200) || null,
    addedBy: addedBy || null,
    addedAt: Date.now(),
    expiresAt: expiresAt || null,
  };
  g.rule_exemptions.push(ex);
  save();
  return { success: true, exemption: ex };
}

export function removeExemption(guildId, userId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rule_exemptions?.length) return { success: false, reason: "no exemptions" };
  const ruleNum = ruleNumber === null || ruleNumber === undefined ? null : Number(ruleNumber);
  const idx = g.rule_exemptions.findIndex(e => e.userId === userId && e.ruleNumber === ruleNum);
  if (idx < 0) return { success: false, reason: "exemption not found" };
  const removed = g.rule_exemptions.splice(idx, 1)[0];
  save();
  return { success: true, removed };
}

/**
 * Check whether a user is exempt from a specific rule.
 * Returns true if the user has a global exemption (ruleNumber=null) or a
 * specific exemption for that rule. Auto-prunes expired exemptions.
 */
export function isUserExempt(guildId, userId, ruleNumber, now = Date.now()) {
  const list = data.guild_settings[guildId]?.rule_exemptions ?? [];
  if (list.length === 0) return false;
  // Lazy prune: drop expired entries before checking
  const live = list.filter(e => !e.expiresAt || e.expiresAt > now);
  if (live.length !== list.length) {
    // Mutate in place + persist (cheap — exemptions are small)
    data.guild_settings[guildId].rule_exemptions = live;
    save();
  }
  for (const e of live) {
    if (e.userId !== userId) continue;
    if (e.ruleNumber === null) return true; // global exemption
    if (e.ruleNumber === Number(ruleNumber)) return true;
  }
  return false;
}

// ─── Rule violations (for escalation) ─────────────────────────────────────────

export function recordViolation(guildId, userId, ruleNumber, messageId, severity, action) {
  const g = ensureGuild(guildId);
  if (!g.rule_violations) g.rule_violations = [];
  g.rule_violations.push({
    userId,
    ruleNumber: Number(ruleNumber),
    messageId,
    severity,
    action,
    ts: Date.now(),
  });
  // FIFO trim
  if (g.rule_violations.length > MAX_VIOLATIONS_RETAINED) {
    g.rule_violations = g.rule_violations.slice(-MAX_VIOLATIONS_RETAINED);
  }
  save();
}

export function getRecentViolations(guildId, userId, withinMs = 30 * 86_400_000, now = Date.now()) {
  const list = data.guild_settings[guildId]?.rule_violations ?? [];
  const cutoff = now - withinMs;
  return list.filter(v => v.userId === userId && v.ts >= cutoff);
}

// ═══════════════════════════════════════════════════════════════════════════
// MISC GUILD SETTINGS — GIF style, DM results, welcome channel, ghost-pings,
// log channel, autorole, ticket category root
// ═══════════════════════════════════════════════════════════════════════════

export function setGifEmbed(guildId, enabled) {
  ensureGuild(guildId).gif_embed = enabled;
  save();
}

export function setDmResults(guildId, enabled) {
  ensureGuild(guildId).dm_results = enabled;
  save();
}

export function getDmResults(guildId) {
  return data.guild_settings[guildId]?.dm_results ?? false; // default: OFF
}

export function setWelcomeChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.welcome_channel = channelId;
  if (message) s.welcome_message = message;
  save();
}

// ─── Ghost-Ping on Join ──────────────────────────────────────────────────
export function setGhostPingChannels(guildId, channelIds) {
  ensureGuild(guildId).ghost_ping_channels = channelIds;
  save();
}

export function getGhostPingChannels(guildId) {
  return data.guild_settings[guildId]?.ghost_ping_channels ?? [];
}

export function setLogChannel(guildId, channelId) {
  ensureGuild(guildId).log_channel = channelId;
  save();
}

export function setAutorole(guildId, roleId) {
  ensureGuild(guildId).autorole_id = roleId;
  save();
}

export function setTicketCategory(guildId, categoryId) {
  ensureGuild(guildId).ticket_category_id = categoryId;
  save();
}

function _cleanRoleIds(roleIds) {
  return Array.isArray(roleIds)
    ? roleIds.map(String).filter((id) => /^\d{17,20}$/.test(id))
    : [];
}

// ═══════════════════════════════════════════════════════════════════════════
// TICKET SYSTEM — roles, welcome/panel embeds, types, auto-category resolution
// ═══════════════════════════════════════════════════════════════════════════

// Legacy: both pings AND grants view access in one call. Kept as a shorthand.
// New code should prefer setTicketViewRoles / setTicketPingRoles separately.
export function setTicketModRoles(guildId, roleIds) {
  const clean = _cleanRoleIds(roleIds);
  const gs = ensureGuild(guildId);
  gs.ticket_mod_role_ids  = clean;
  gs.ticket_view_role_ids = clean;
  gs.ticket_ping_role_ids = clean;
  save();
}

// Roles granted ViewChannel + SendMessages on every new ticket. [] = nobody
// beyond the opener + bot. Category-level perms can still grant broader
// access without adding anything here. Also clears the legacy combined
// ticket_mod_role_ids field so once an admin touches the new split settings,
// the old field stops acting as a fallback (which would re-apply old
// ping+view intentions the admin explicitly narrowed).
export function setTicketViewRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_view_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_ping_role_ids)) gs.ticket_ping_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save();
}

// Roles mentioned in the welcome message when a ticket opens. [] = no ping.
// Independent of view access — you can ping without granting view (e.g. alert
// a staff role that then has to react) or grant view without pinging.
export function setTicketPingRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_ping_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_view_role_ids)) gs.ticket_view_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save();
}

// Welcome embed (shown INSIDE each new ticket channel). null = default.
// color accepts hex strings with or without #; stored as integer or null.
export function setTicketWelcome(guildId, { title, description, color } = {}) {
  const gs = ensureGuild(guildId);
  if (title !== undefined) gs.ticket_welcome_title = title ? String(title).slice(0, 256) : null;
  if (description !== undefined) gs.ticket_welcome_description = description ? String(description).slice(0, 4000) : null;
  if (color !== undefined) gs.ticket_welcome_color = _parseColor(color);
  save();
}

// Panel embed (the "Support Tickets / click the button" message posted in a
// channel). null on any field = fall back to the default for that field.
// button_label + button_emoji are bundled here because they ship with the
// embed as one unit.
export function setTicketPanel(guildId, { title, description, color, button_label, button_emoji } = {}) {
  const gs = ensureGuild(guildId);
  if (title        !== undefined) gs.ticket_panel_title        = title        ? String(title).slice(0, 256)   : null;
  if (description  !== undefined) gs.ticket_panel_description  = description  ? String(description).slice(0, 4000) : null;
  if (color        !== undefined) gs.ticket_panel_color        = _parseColor(color);
  if (button_label !== undefined) gs.ticket_panel_button_label = button_label ? String(button_label).slice(0, 80) : null;
  if (button_emoji !== undefined) gs.ticket_panel_button_emoji = button_emoji ? String(button_emoji).slice(0, 64) : null;
  save();
}

// Remember where we last posted a panel so the next "Post Panel" click can
// edit that message instead of spamming duplicates. null clears it.
export function setTicketPanelMessage(guildId, channelId, messageId) {
  const gs = ensureGuild(guildId);
  if (channelId && messageId) {
    gs.ticket_panel_channel_id = String(channelId);
    gs.ticket_panel_message_id = String(messageId);
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save();
}

// Ticket TYPES — each type routes to its own category. Admins can define
// multiple types (e.g. Support/Reports/Appeals) and the panel renders one
// button per type. A ticket opened via a type button lands in that type's
// category. If no types are defined, the panel uses the legacy single-button
// flow with ticket_category_id as the destination.
//
// Type shape:
//   { key, label, emoji?, category_id?, style? }
// - key       — unique identifier within the guild, 1–50 chars, [a-z0-9_-]
// - label     — button text, max 80 chars
// - emoji     — unicode emoji or custom <:name:id>, optional
// - category_id — where tickets of this type go. If null/missing/deleted,
//                falls back to ticket_category_id at ticket-creation time.
// - style     — Discord ButtonStyle name: "Primary"|"Secondary"|"Success"|"Danger"
//                Defaults to Primary. Link is NOT allowed (buttons must be
//                interactive to open a ticket).
const TICKET_TYPE_KEY = /^[a-z0-9_-]{1,50}$/;
const ALLOWED_BUTTON_STYLES = new Set(["Primary", "Secondary", "Success", "Danger"]);

function _sanitizeTicketType(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key || "").trim().toLowerCase();
  if (!TICKET_TYPE_KEY.test(key)) return null;
  const label = String(raw.label || raw.title || key).trim().slice(0, 80);
  if (!label) return null;
  const out = { key, label };
  if (raw.emoji)        out.emoji = String(raw.emoji).trim().slice(0, 64);
  if (raw.category_id)  out.category_id = String(raw.category_id).trim();
  if (raw.style && ALLOWED_BUTTON_STYLES.has(String(raw.style))) out.style = String(raw.style);
  return out;
}

// Replace the entire types list. Pass [] to clear. Duplicate keys are
// deduped (last write wins). Invalid entries are silently dropped so a
// half-bad AI call can still land the good entries.
export function setTicketTypes(guildId, types) {
  const gs = ensureGuild(guildId);
  const seen = new Map();
  if (Array.isArray(types)) {
    for (const t of types) {
      const clean = _sanitizeTicketType(t);
      if (clean) seen.set(clean.key, clean);
    }
  }
  gs.ticket_types = [...seen.values()];
  save();
  return gs.ticket_types;
}

// Add a single type (or update an existing one with the same key).
export function addTicketType(guildId, type) {
  const clean = _sanitizeTicketType(type);
  if (!clean) return null;
  const gs = ensureGuild(guildId);
  const list = Array.isArray(gs.ticket_types) ? [...gs.ticket_types] : [];
  const idx = list.findIndex((t) => t.key === clean.key);
  if (idx >= 0) list[idx] = clean;
  else list.push(clean);
  gs.ticket_types = list;
  save();
  return clean;
}

// Remove by key. Returns true if something was removed.
export function removeTicketType(guildId, key) {
  const k = String(key || "").toLowerCase();
  const gs = ensureGuild(guildId);
  if (!Array.isArray(gs.ticket_types)) return false;
  const before = gs.ticket_types.length;
  gs.ticket_types = gs.ticket_types.filter((t) => t.key !== k);
  if (gs.ticket_types.length !== before) { save(); return true; }
  return false;
}

// Auto-resolve mode: save a CATEGORY KEYWORD instead of frozen role IDs.
// When a ticket opens, the creator resolves this keyword against the live
// guild roles via the categorizer. Effect: add a new role with mod perms
// later and it automatically joins the ticket view/ping set — no need to
// re-run setup. Pass null to clear.
//
// kind: "view" | "ping"
// category: "admin" | "moderator" | "helper" | "staff" | "trusted" | null
export function setTicketAutoCategory(guildId, kind, category) {
  if (kind !== "view" && kind !== "ping") return;
  const gs = ensureGuild(guildId);
  const field = kind === "view" ? "ticket_view_auto_category" : "ticket_ping_auto_category";
  if (category) gs[field] = String(category).toLowerCase();
  else delete gs[field];
  save();
}

// Explicitly pin the panel to a specific channel (without a message yet).
// Used when an admin picks a panel channel up front — Post Panel will then
// post there instead of auto-creating an #open-ticket channel under the
// ticket category. Moving to a different channel invalidates the stored
// message id (can't edit a message that's no longer in-scope).
export function setTicketPanelChannel(guildId, channelId) {
  const gs = ensureGuild(guildId);
  if (channelId) {
    const next = String(channelId);
    if (gs.ticket_panel_channel_id && gs.ticket_panel_channel_id !== next) {
      delete gs.ticket_panel_message_id;
    }
    gs.ticket_panel_channel_id = next;
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save();
}

// Accepts: number, "#RRGGBB", "RRGGBB", "0xRRGGBB". Returns int or null.
function _parseColor(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
  const raw = String(value).trim().replace(/^#|^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  return parseInt(raw, 16);
}

// Resolve the effective settings for a guild.
export function getTicketConfig(guildId) {
  const gs = ensureGuild(guildId);
  return {
    category_id:   gs.ticket_category_id || null,
    types:         Array.isArray(gs.ticket_types) ? gs.ticket_types : [],
    view_role_ids: Array.isArray(gs.ticket_view_role_ids) ? gs.ticket_view_role_ids : [],
    ping_role_ids: Array.isArray(gs.ticket_ping_role_ids) ? gs.ticket_ping_role_ids : [],
    view_auto_category: gs.ticket_view_auto_category || null,
    ping_auto_category: gs.ticket_ping_auto_category || null,
    welcome_title:       gs.ticket_welcome_title || null,
    welcome_description: gs.ticket_welcome_description || null,
    welcome_color:       typeof gs.ticket_welcome_color === "number" ? gs.ticket_welcome_color : null,
    panel_title:         gs.ticket_panel_title || null,
    panel_description:   gs.ticket_panel_description || null,
    panel_color:         typeof gs.ticket_panel_color === "number" ? gs.ticket_panel_color : null,
    panel_button_label:  gs.ticket_panel_button_label || null,
    panel_button_emoji:  gs.ticket_panel_button_emoji || null,
    panel_channel_id:    gs.ticket_panel_channel_id || null,
    panel_message_id:    gs.ticket_panel_message_id || null,
  };
}

// Resolve the effective view/ping role IDs for a guild at THIS moment.
// Takes the explicit pinned IDs and unions them with a live lookup against
// the auto-category (if set). The result is what should be written into the
// ticket channel's permission overwrites / ping content. Pass the guild so
// the categorizer can see the live roles cache.
export async function resolveTicketRoles(guild) {
  const cfg = getTicketConfig(guild.id);
  const { getRolesByCategory } = await import("@defnotean/shared/roleCategorizer");
  const _expand = (explicitIds, autoCat) => {
    const out = new Set();
    for (const id of explicitIds || []) if (guild.roles.cache.has(id)) out.add(id);
    if (autoCat) {
      for (const role of getRolesByCategory(guild, autoCat)) out.add(role.id);
    }
    return [...out];
  };
  return {
    view_role_ids: _expand(cfg.view_role_ids, cfg.view_auto_category),
    ping_role_ids: _expand(cfg.ping_role_ids, cfg.ping_auto_category),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AFK / TEMP-VC / COLOR ROLES / SEASONAL PALETTES — voice & cosmetic config
// ═══════════════════════════════════════════════════════════════════════════

export function setAfkSettings(guildId, channelId, timeoutMinutes) {
  const s = ensureGuild(guildId);
  s.afk_channel_id = channelId;
  s.afk_timeout_minutes = timeoutMinutes;
  save();
}

export function setCreateVcChannel(guildId, channelId) {
  ensureGuild(guildId).create_vc_channel_id = channelId;
  save();
}

export function setVcTemplate(guildId, template) {
  ensureGuild(guildId).vc_template = template;
  save();
}

export function getVcTemplate(guildId) {
  return data.guild_settings[guildId]?.vc_template ?? null; // null = use smart auto mode
}

export function setVcDefaultLimit(guildId, limit) {
  ensureGuild(guildId).vc_default_limit = limit ?? 0;
  save();
}

export function getVcDefaultLimit(guildId) {
  return data.guild_settings[guildId]?.vc_default_limit ?? 0;
}

export function setVcNamingMode(guildId, mode) {
  ensureGuild(guildId).vc_naming_mode = mode;
  save();
}

export function getVcNamingMode(guildId) {
  return data.guild_settings[guildId]?.vc_naming_mode ?? "smart"; // smart | anonymous | random
}

export function setVcRichPresence(guildId, enabled) {
  ensureGuild(guildId).vc_rich_presence = enabled;
  save();
}

export function getVcRichPresence(guildId) {
  return data.guild_settings[guildId]?.vc_rich_presence ?? true;
}

export function setVcTextChannels(guildId, enabled) {
  ensureGuild(guildId).vc_text_channels = enabled;
  save();
}

export function getVcTextChannels(guildId) {
  return data.guild_settings[guildId]?.vc_text_channels ?? false;
}

export function setColorRoles(guildId, roleIds) {
  ensureGuild(guildId).color_role_ids = roleIds;
  save();
}

export function getColorRoles(guildId) {
  return data.guild_settings[guildId]?.color_role_ids ?? [];
}

export function setSeasonalColors(guildId, enabled) {
  ensureGuild(guildId).seasonal_colors = enabled;
  save();
}

export function getSeasonalColors(guildId) {
  return data.guild_settings[guildId]?.seasonal_colors ?? false;
}

export function setLastSeasonalPalette(guildId, paletteName) {
  ensureGuild(guildId).last_seasonal_palette = paletteName;
  save();
}

export function getLastSeasonalPalette(guildId) {
  return data.guild_settings[guildId]?.last_seasonal_palette ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS CONTROL — Irene access role, verification gating, trusted users,
// per-user DM opt-out
// ═══════════════════════════════════════════════════════════════════════════

// ─── Irene Access Role ───────────────────────────────────────────────────────

export function setAccessRole(guildId, roleId) {
  ensureGuild(guildId).irene_access_role_id = roleId;
  save();
}

// ─── Verification Role ──────────────────────────────────────────────────────
// The "verified" role gates access to most channels. Unverified users can only
// see channels explicitly marked as public (rules, verification, etc.)

export function setVerificationRole(guildId, roleId) {
  ensureGuild(guildId).verification_role_id = roleId;
  save();
}

export function getVerificationRole(guildId) {
  return data.guild_settings[guildId]?.verification_role_id ?? null;
}

export function getPublicChannels(guildId) {
  return data.guild_settings[guildId]?.public_channels ?? [];
}

export function setPublicChannels(guildId, channelIds) {
  ensureGuild(guildId).public_channels = channelIds;
  save();
}

// ─── Trusted Users ───────────────────────────────────────────────────────────
// Users added here get full admin-level access to Irene's tools, same as server admins.

export function getTrustedUsers(guildId) {
  return data.guild_settings[guildId]?.trusted_users ?? [];
}

export function addTrustedUser(guildId, userId) {
  const s = ensureGuild(guildId);
  const list = s.trusted_users ?? [];
  if (!list.includes(userId)) {
    s.trusted_users = [...list, userId];
    save();
  }
}

export function removeTrustedUser(guildId, userId) {
  const s = data.guild_settings[guildId];
  if (!s?.trusted_users) return;
  s.trusted_users = s.trusted_users.filter((id) => id !== userId);
  save();
}

// ─── DM Opt-Out ──────────────────────────────────────────────────────────────
// Per-user preference — if opted out, Irene won't DM them anything

export function isDmOptout(userId) {
  return data.dm_optout?.includes(userId) ?? false;
}

export function setDmOptout(userId, optout) {
  if (!data.dm_optout) data.dm_optout = [];
  if (optout) {
    if (!data.dm_optout.includes(userId)) {
      data.dm_optout.push(userId);
      save();
    }
  } else {
    data.dm_optout = data.dm_optout.filter((id) => id !== userId);
    save();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM COMMANDS — user-defined !triggers per guild
// ═══════════════════════════════════════════════════════════════════════════

// ─── Custom Commands ─────────────────────────────────────────────────────────

export function getCustomCommands(guildId) {
  if (!data.custom_commands) data.custom_commands = {};
  return data.custom_commands[guildId] || {};
}

export function getCustomCommand(guildId, trigger) {
  return getCustomCommands(guildId)[trigger.toLowerCase()] || null;
}

export function setCustomCommand(guildId, trigger, command) {
  if (!data.custom_commands) data.custom_commands = {};
  if (!data.custom_commands[guildId]) data.custom_commands[guildId] = {};
  data.custom_commands[guildId][trigger.toLowerCase()] = {
    ...command,
    trigger: trigger.toLowerCase(),
    // Preserve creation timestamp on edits — only set it if not already present
    created_at: command.created_at ?? new Date().toISOString(),
  };
  save();
}

export function deleteCustomCommand(guildId, trigger) {
  if (!data.custom_commands?.[guildId]) return false;
  const key = trigger.toLowerCase();
  if (data.custom_commands[guildId][key]) {
    delete data.custom_commands[guildId][key];
    save();
    return true;
  }
  return false;
}

export function listCustomCommands(guildId) {
  return Object.values(getCustomCommands(guildId));
}

// ═══════════════════════════════════════════════════════════════════════════
// WELCOME / DM-WELCOME / LEAVE — embed customization & message templates
// ═══════════════════════════════════════════════════════════════════════════

// ─── Welcome Embed Customization ─────────────────────────────────────────────

export function getWelcomeEmbed(guildId) {
  return data.guild_settings[guildId]?.welcome_embed ?? null;
}

/**
 * Merge partial embedConfig into the stored config.
 * Pass null to fully reset all customizations.
 */
export function setWelcomeEmbed(guildId, embedConfig) {
  const s = ensureGuild(guildId);
  if (embedConfig === null) {
    delete s.welcome_embed;
  } else {
    s.welcome_embed = { ...(s.welcome_embed ?? {}), ...embedConfig };
  }
  save();
}

// ─── DM Welcome ───────────────────────────────────────────────────────────────

export function setDmWelcome(guildId, enabled, message) {
  const s = ensureGuild(guildId);
  s.dm_welcome_enabled = enabled;
  if (message !== undefined) s.dm_welcome_message = message;
  save();
}

export function getDmWelcome(guildId) {
  const s = data.guild_settings[guildId];
  return {
    enabled: s?.dm_welcome_enabled ?? false,
    message: s?.dm_welcome_message ?? "Welcome to {server}! Feel free to introduce yourself.",
  };
}

// ─── Leave Messages ───────────────────────────────────────────────────────────

export function setLeaveChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.leave_channel = channelId;
  if (message !== undefined) s.leave_message = message;
  save();
}

export function getLeaveSettings(guildId) {
  const s = data.guild_settings[guildId];
  return {
    channelId: s?.leave_channel ?? null,
    message: s?.leave_message ?? "Goodbye, {username}. We hope to see you again!",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS, PERSONALITIES, BAD WORDS, ESCALATION & STATS CHANNELS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Conversation Memory ──────────────────────────────────────────────────────

export function saveConversation(channelKey, history) {
  if (!data.conversations) data.conversations = {};
  // Limit to last 20 messages to avoid bloat
  data.conversations[channelKey] = history.slice(-20);

  // Prevent unbounded growth of the JSON data bundle
  const keys = Object.keys(data.conversations);
  if (keys.length > 5000) {
    // Delete the oldest 100 conversations to free up space
    for (let i = 0; i < 100; i++) {
      delete data.conversations[keys[i]];
    }
  }

  save();
}

export function loadConversations() {
  const result = new Map();
  if (!data.conversations) return result;
  for (const [key, hist] of Object.entries(data.conversations)) {
    if (Array.isArray(hist) && hist.length > 0) result.set(key, hist);
  }
  return result;
}

export function getConversationsData() {
  return data.conversations || {};
}

export function deleteConversation(key) {
  if (!data.conversations) return false;
  if (data.conversations[key]) {
    delete data.conversations[key];
    save();
    return true;
  }
  // Partial match
  let deleted = false;
  for (const k of Object.keys(data.conversations)) {
    if (k.includes(key)) { delete data.conversations[k]; deleted = true; }
  }
  if (deleted) save();
  return deleted;
}

// ─── Per-Channel Personality ──────────────────────────────────────────────────

export function setChannelPersonality(guildId, channelId, prompt) {
  const s = ensureGuild(guildId);
  if (!s.channel_personalities) s.channel_personalities = {};
  if (prompt) {
    s.channel_personalities[channelId] = prompt;
  } else {
    delete s.channel_personalities[channelId];
  }
  save();
}

export function getChannelPersonality(guildId, channelId) {
  return data.guild_settings[guildId]?.channel_personalities?.[channelId] ?? null;
}

// ─── Server Persona ───────────────────────────────────────────────────────────
// Allows each guild to override the bot's name + personality independently.
// { name: string, personality: string } — either field may be absent (falls back to default).

export function setServerPersona(guildId, persona) {
  const s = ensureGuild(guildId);
  if (persona) {
    s.server_persona = persona; // { name, personality }
  } else {
    delete s.server_persona;
  }
  save();
}

export function getServerPersona(guildId) {
  return data.guild_settings[guildId]?.server_persona ?? null;
}

// ─── Bad Word Filter ──────────────────────────────────────────────────────────

export function setBadWords(guildId, words) {
  ensureGuild(guildId).bad_words = words;
  save();
}

export function getBadWords(guildId) {
  return data.guild_settings[guildId]?.bad_words ?? [];
}

// ─── Auto-Escalation ──────────────────────────────────────────────────────────

export function setEscalation(guildId, config) {
  ensureGuild(guildId).escalation = config;
  save();
}

export function getEscalation(guildId) {
  return data.guild_settings[guildId]?.escalation ?? { mute_at: null, kick_at: null, ban_at: null };
}

// ─── Server Stats Channels ────────────────────────────────────────────────────

export function setStatsChannels(guildId, config) {
  ensureGuild(guildId).stats_channels = config;
  save();
}

export function getStatsChannels(guildId) {
  return data.guild_settings[guildId]?.stats_channels ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// REACTION ROLES, REMINDERS, SCHEDULED TASKS & STARBOARD
// ═══════════════════════════════════════════════════════════════════════════

// ─── Reaction Roles ───────────────────────────────────────────────────────────

export function addReactionRole(guildId, messageId, emoji, roleId, exclusive = true) {
  const s = ensureGuild(guildId);
  if (!s.reaction_roles) s.reaction_roles = {};
  if (!s.reaction_roles[messageId]) s.reaction_roles[messageId] = [];
  // Remove existing entry for this emoji on this message
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  s.reaction_roles[messageId].push({ emoji, roleId, exclusive });
  save();
}

export function isReactionRoleExclusive(guildId, messageId) {
  const roles = data.guild_settings[guildId]?.reaction_roles?.[messageId];
  // Default to true — existing roles without the flag are treated as exclusive
  return roles?.[0]?.exclusive ?? true;
}

export function removeReactionRole(guildId, messageId, emoji) {
  const s = data.guild_settings[guildId];
  if (!s?.reaction_roles?.[messageId]) return;
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  if (s.reaction_roles[messageId].length === 0) delete s.reaction_roles[messageId];
  save();
}

export function getReactionRoles(guildId, messageId) {
  return data.guild_settings[guildId]?.reaction_roles?.[messageId] ?? [];
}

export function getAllReactionRoles(guildId) {
  return data.guild_settings[guildId]?.reaction_roles ?? {};
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export function addReminder(userId, guildId, channelId, message, fireAt) {
  if (!data.reminders) data.reminders = [];
  const reminder = {
    id: data._nextReminderId++,
    userId,
    guildId,
    channelId,
    message,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
  };
  data.reminders.push(reminder);
  save();
  return reminder;
}

export function getReminders() {
  return data.reminders ?? [];
}

export function removeReminder(id) {
  if (!data.reminders) return;
  data.reminders = data.reminders.filter((r) => r.id !== id);
  save();
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────
// Deferred tool calls queued via the schedule_task AI tool.

export function addScheduledTask(guildId, channelId, authorId, toolName, toolInput, fireAt, note) {
  if (!data.scheduled_tasks) data.scheduled_tasks = [];
  const task = {
    id: data._nextScheduledTaskId++,
    guildId,
    channelId,
    authorId,
    toolName,
    toolInput,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
    note: note ?? null,
    createdAt: Date.now(),
  };
  data.scheduled_tasks.push(task);
  save();
  return task;
}

export function getScheduledTasks(guildId) {
  const all = data.scheduled_tasks ?? [];
  return guildId ? all.filter((t) => t.guildId === guildId) : all;
}

export function getScheduledTask(id) {
  return (data.scheduled_tasks ?? []).find((t) => t.id === id) ?? null;
}

export function removeScheduledTask(id) {
  if (!data.scheduled_tasks) return { changes: 0 };
  const before = data.scheduled_tasks.length;
  data.scheduled_tasks = data.scheduled_tasks.filter((t) => t.id !== id);
  save();
  return { changes: before - data.scheduled_tasks.length };
}

// ─── Starboard ────────────────────────────────────────────────────────────────

export function setStarboard(guildId, channelId, threshold) {
  const s = ensureGuild(guildId);
  s.starboard_channel = channelId;
  s.starboard_threshold = threshold ?? 3;
  save();
}

export function getStarboard(guildId) {
  const s = data.guild_settings[guildId];
  return {
    channelId: s?.starboard_channel ?? null,
    threshold: s?.starboard_threshold ?? 3,
  };
}

export function addStarboardEntry(guildId, messageId, starboardMessageId) {
  if (!data.starboard_entries) data.starboard_entries = {};
  if (!data.starboard_entries[guildId]) data.starboard_entries[guildId] = {};
  data.starboard_entries[guildId][messageId] = starboardMessageId;
  save();
}

export function getStarboardEntry(guildId, messageId) {
  return data.starboard_entries?.[guildId]?.[messageId] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BIRTHDAYS & SERVER WHITELIST — birthday roster + bot-owner allowlisting
// ═══════════════════════════════════════════════════════════════════════════

// ─── Birthdays ─────────────────────────────────────────────────────────────────

export function setBirthday(userId, guildId, month, day, year) {
  if (!data.birthdays) data.birthdays = [];
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  const entry = { userId, guildId, month, day };
  if (year) entry.year = year;
  data.birthdays.push(entry);
  save();
}

export function removeBirthday(userId, guildId) {
  if (!data.birthdays) return false;
  const before = data.birthdays.length;
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  if (data.birthdays.length !== before) { save(); return true; }
  return false;
}

export function getBirthday(userId, guildId) {
  return (data.birthdays ?? []).find((b) => b.userId === userId && b.guildId === guildId) ?? null;
}

export function getGuildBirthdays(guildId) {
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId);
}

export function getTodaysBirthdays(guildId) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId && b.month === month && b.day === day);
}

export function setBirthdayChannel(guildId, channelId) {
  ensureGuild(guildId).birthday_channel_id = channelId;
  save();
}

export function setBirthdayRole(guildId, roleId) {
  ensureGuild(guildId).birthday_role_id = roleId;
  save();
}

export function setBirthdayMessage(guildId, message) {
  const s = ensureGuild(guildId);
  if (message) s.birthday_message = message;
  else delete s.birthday_message;
  save();
}

export function getBirthdayConfig(guildId) {
  const s = data.guild_settings[guildId];
  return {
    channel_id: s?.birthday_channel_id ?? null,
    role_id: s?.birthday_role_id ?? null,
    message: s?.birthday_message ?? "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉",
  };
}

export function markBirthdayAnnounced(userId, guildId) {
  const currentYear = new Date().getFullYear();
  const key = `${guildId}-${userId}-${currentYear}`;
  if (!data.birthday_announced) data.birthday_announced = {};
  data.birthday_announced[key] = true;

  // Prune entries from previous years to prevent unbounded growth
  let pruned = 0;
  for (const k of Object.keys(data.birthday_announced)) {
    const yearMatch = k.match(/-(\d{4})$/);
    if (yearMatch && parseInt(yearMatch[1]) < currentYear) {
      delete data.birthday_announced[k];
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[DB] Pruned ${pruned} old birthday-announced entries`);

  save();
}

export function wasBirthdayAnnounced(userId, guildId) {
  const key = `${guildId}-${userId}-${new Date().getFullYear()}`;
  return data.birthday_announced?.[key] === true;
}

// ─── Server Whitelist ──────────────────────────────────────────────────────

export function getWhitelist() {
  return data.server_whitelist ?? {};
}

export function isWhitelisted(guildId) {
  return !!data.server_whitelist?.[guildId];
}

export function addToWhitelist(guildId, info) {
  if (!data.server_whitelist) data.server_whitelist = {};
  data.server_whitelist[guildId] = {
    name:       info.name       ?? "Unknown",
    icon_url:   info.icon_url   ?? null,
    members:    info.members    ?? null,
    invited_by: info.invited_by ?? null,
    added_at:   new Date().toISOString(),
  };
  save();
}

// ═══════════════════════════════════════════════════════════════════════════
// EMOTIONAL STATE — global mood/energy + per-user relationship affinity
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mood & Energy (shared emotional state) ──────────────────────────────────

export function getMood() {
  return { ...data.mood };
}

export function updateMood(score, energy) {
  data.mood.mood_score = Math.max(-100, Math.min(100, score));
  data.mood.energy = Math.max(0, Math.min(100, energy));
  save();
}

export function shiftMood(delta, energyDelta = 0) {
  updateMood(data.mood.mood_score + delta, data.mood.energy + energyDelta);
}

export function moodLabel(score) {
  if (score >= 60) return "ecstatic";
  if (score >= 30) return "happy";
  if (score >= 10) return "chill";
  if (score >= -10) return "neutral";
  if (score >= -30) return "annoyed";
  if (score >= -60) return "pissed";
  return "furious";
}

// ─── Relationships (per-user affinity tracking) ──────────────────────────────

export function getRelationship(userId) {
  return data.relationships[userId] || { affinity_score: 0, interactions_count: 0 };
}

export function updateRelationship(userId, affinityDelta) {
  const current = getRelationship(userId);
  data.relationships[userId] = {
    affinity_score: Math.max(-100, Math.min(100, current.affinity_score + affinityDelta)),
    interactions_count: current.interactions_count + 1,
  };
  save();
}

export function getAllRelationships() {
  return Object.entries(data.relationships).map(([uid, r]) => ({ user_id: uid, ...r }));
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALITY (Supabase-synced) — editable from the dashboard
// ═══════════════════════════════════════════════════════════════════════════

// ─── Personality (Supabase-synced for dashboard editor) ─────────────────────

export async function getPersonality() {
  if (!supabase) return null;
  const { data: row } = await supabase.from("irene_personality").select("instructions").eq("id", "irene").single();
  return row?.instructions || null;
}

export async function updatePersonality(instructions) {
  if (!supabase) return false;
  const { error } = await supabase.from("irene_personality").upsert({ id: "irene", instructions });
  return !error;
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT RUNTIME STATE — music queues, temp VCs, lockdown, auto-slowmode
// ═══════════════════════════════════════════════════════════════════════════

// ─── Saved Music Queues (persist across restarts) ────────────────────────────

export function saveQueue(guildId, queueData) {
  if (!data.saved_queues) data.saved_queues = {};
  data.saved_queues[guildId] = { ...queueData, savedAt: Date.now() };
  save();
}

export function getSavedQueues() {
  return data.saved_queues ?? {};
}

export function clearSavedQueue(guildId) {
  if (data.saved_queues?.[guildId]) {
    delete data.saved_queues[guildId];
    save();
  }
}

export function clearAllSavedQueues() {
  data.saved_queues = {};
  save();
}

// ─── Temp VC State (persist across restarts) ─────────────────────────────────
// Stored at top-level data.temp_vcs rather than inside guild_settings["_global"]
// to keep the guild_settings namespace clean and avoid confusion with real guilds.

export function saveTempVc(channelId, vcData) {
  if (!vcData) vcData = {};
  if (!data.temp_vcs) data.temp_vcs = {};
  data.temp_vcs[channelId] = vcData;
  save();
}

export function deleteTempVc(channelId) {
  if (data.temp_vcs?.[channelId]) {
    delete data.temp_vcs[channelId];
    save();
  }
}

export function getAllTempVcs() {
  return data.temp_vcs ?? {};
}

export function clearAllTempVcs() {
  data.temp_vcs = {};
  save();
}

// ─── Lockdown State ──────────────────────────────────────────────────────────

export function saveLockdown(guildId, expiresAt) {
  ensureGuild(guildId).lockdown_expires = expiresAt;
  save();
}

export function clearLockdown(guildId) {
  const s = data.guild_settings[guildId];
  if (s) { delete s.lockdown_expires; save(); }
}

export function getLockdown(guildId) {
  return data.guild_settings[guildId]?.lockdown_expires ?? null;
}

// ─── Auto-Slowmode State ─────────────────────────────────────────────────────

export function saveSlowmode(channelId, guildId, expiresAt) {
  ensureGuild(guildId).auto_slowmode = ensureGuild(guildId).auto_slowmode ?? {};
  ensureGuild(guildId).auto_slowmode[channelId] = expiresAt;
  save();
}

export function clearSlowmode(channelId, guildId) {
  const s = data.guild_settings[guildId];
  if (s?.auto_slowmode?.[channelId]) { delete s.auto_slowmode[channelId]; save(); }
}

export function getAutoSlowmodes(guildId) {
  return data.guild_settings[guildId]?.auto_slowmode ?? {};
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL FEEDS — RSS patch news, Twitch live, TTS, YouTube, GitHub
// ═══════════════════════════════════════════════════════════════════════════

// ─── Patch Feeds (RSS Game News) ─────────────────────────────────────────────

export function getPatchFeeds(guildId) {
  return data.guild_settings[guildId]?.patch_feeds ?? { channel_id: null, feeds: [] };
}

export function setPatchFeeds(guildId, config) {
  ensureGuild(guildId).patch_feeds = config;
  save();
}

export function getPatchLastSeen(guildId) {
  return data.guild_settings[guildId]?.patch_last_seen ?? {};
}

export function setPatchLastSeen(guildId, key, value) {
  const s = ensureGuild(guildId);
  if (!s.patch_last_seen) s.patch_last_seen = {};
  s.patch_last_seen[key] = value;
  save();
}

// ─── Twitch Live Notifications ───────────────────────────────────────────────

export function getTwitchConfig(guildId) {
  return data.guild_settings[guildId]?.twitch ?? { channel_id: null, streamers: [], ping_role_id: null, ping_role_ids: [], auto_detect: false };
}

export function setTwitchConfig(guildId, config) {
  ensureGuild(guildId).twitch = config;
  save();
}

// ─── TTS Channels ────────────────────────────────────────────────────────────

export function getTtsChannels(guildId) {
  return data.guild_settings[guildId]?.tts_channels ?? [];
}

export function setTtsChannels(guildId, channels) {
  ensureGuild(guildId).tts_channels = channels;
  save();
}

export function getTtsVoice(guildId) {
  return data.guild_settings[guildId]?.tts_voice ?? "Kore";
}

export function setTtsVoice(guildId, voice) {
  ensureGuild(guildId).tts_voice = voice;
  save();
}

export function removeFromWhitelist(guildId) {
  if (!data.server_whitelist?.[guildId]) return false;
  delete data.server_whitelist[guildId];
  save();
  return true;
}

// ─── YouTube Feeds ──────────────────────────────────────────────────────────

export function getYoutubeConfig(guildId) {
  return data.guild_settings[guildId]?.youtube ?? [];
}

export function setYoutubeConfig(guildId, config) {
  ensureGuild(guildId).youtube = config;
  save();
}

// ─── GitHub Feeds ───────────────────────────────────────────────────────────

export function getGithubConfig(guildId) {
  return data.guild_settings[guildId]?.github ?? [];
}

export function setGithubConfig(guildId, config) {
  ensureGuild(guildId).github = config;
  save();
}

// ═══════════════════════════════════════════════════════════════════════════
// GIVEAWAYS, HIGHLIGHTS, VOICE STATS & AUTO-RESPONDERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Audit Log ──────────────────────────────────────────────────────────────

// ─── Giveaway Persistence ───────────────────────────────────────────────────

export function getGiveawayDb() {
  return data.giveaways ?? [];
}

export function saveGiveawayDb(giveawayArray) {
  data.giveaways = giveawayArray;
  save();
}

export function getGiveawayPingRoles(guildId) {
  return data.guild_settings[guildId]?.giveaway_ping_role_ids ?? [];
}

export function setGiveawayPingRoles(guildId, roleIds) {
  ensureGuild(guildId).giveaway_ping_role_ids = roleIds;
  save();
}

// ─── Highlight Persistence ──────────────────────────────────────────────────

export function getHighlightDb() {
  return data.highlights ?? {};
}

export function saveHighlightDb(highlightObj) {
  data.highlights = highlightObj;
  save();
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

// ─── Voice Stats ──────────────────────────────────────────────────────────

export function getVoiceStats(guildId) {
  return data.guild_settings[guildId]?.voice_stats ?? {};
}

export function addVoiceTime(guildId, userId, minutes) {
  const s = ensureGuild(guildId);
  if (!s.voice_stats) s.voice_stats = {};
  if (!s.voice_stats[userId]) s.voice_stats[userId] = { total_minutes: 0, sessions: 0 };
  s.voice_stats[userId].total_minutes += minutes;
  s.voice_stats[userId].sessions += 1;
  save();
}

// ─── Auto-Responders ──────────────────────────────────────────────────────

export function getAutoResponders(guildId) {
  return data.guild_settings[guildId]?.auto_responders ?? [];
}

export function addAutoResponder(guildId, trigger, response, createdBy) {
  if (!trigger || typeof trigger !== "string" || !trigger.trim()) return false;
  if (!response || typeof response !== "string" || !response.trim()) return false;
  if (trigger.length > 100) return false; // Max trigger length
  if (response.length > 500) return false; // Max response length
  const s = ensureGuild(guildId);
  if (!s.auto_responders) s.auto_responders = [];
  s.auto_responders.push({ trigger: trigger.toLowerCase(), response, created_by: createdBy, uses: 0 });
  save();
  return true;
}

export function removeAutoResponder(guildId, trigger) {
  const s = ensureGuild(guildId);
  if (!s.auto_responders) return false;
  const before = s.auto_responders.length;
  s.auto_responders = s.auto_responders.filter(a => a.trigger !== trigger.toLowerCase());
  save();
  return s.auto_responders.length < before;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE TOGGLES & AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════

// ─── Feature Toggles ────────────────────────────────────────────────────────

export function isFeatureEnabled(guildId, feature) {
  const s = data.guild_settings[guildId];
  if (!s) return true; // default enabled
  return s[`${feature}_enabled`] !== false;
}

export function setFeatureToggle(guildId, feature, enabled) {
  const s = ensureGuild(guildId);
  s[`${feature}_enabled`] = enabled;
  save();
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export function logAudit(guildId, action, userId, details) {
  const s = ensureGuild(guildId);
  if (!s.audit_log) s.audit_log = [];
  s.audit_log.push({
    action,
    userId,
    details,
    timestamp: new Date().toISOString(),
  });
  // Keep only last 100 entries per guild
  if (s.audit_log.length > 100) s.audit_log = s.audit_log.slice(-100);
  save();
}

// ═══════════════════════════════════════════════════════════════════════════
// INVITE TRACKING, TEMP BANS, INVITE FILTER & STICKY MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

// ─── INVITE TRACKING ───────────────────────────────────────────────────────

/** Record a new member join with invite data */
export function recordInviteJoin(guildId, userId, username, inviteCode, inviterId, inviterTag) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) s.invite_history = [];
  s.invite_history.push({
    userId, username, inviteCode,
    inviterId: inviterId || null,
    inviterTag: inviterTag || null,
    timestamp: new Date().toISOString(),
    left: false,
    leftAt: null,
  });
  if (s.invite_history.length > 500) s.invite_history = s.invite_history.slice(-500);
  save();
}

/** Mark a member as having left the server */
export function markInviteLeave(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) return;
  // Mark the most recent join for this user
  for (let i = s.invite_history.length - 1; i >= 0; i--) {
    if (s.invite_history[i].userId === userId && !s.invite_history[i].left) {
      s.invite_history[i].left = true;
      s.invite_history[i].leftAt = new Date().toISOString();
      save();
      return;
    }
  }
}

/** Get recent invite join history */
export function getInviteHistory(guildId, limit = 20) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).slice(-limit).reverse();
}

/** Get invite leaderboard — top inviters with counts */
export function getInviteLeaderboard(guildId) {
  const s = ensureGuild(guildId);
  const history = s.invite_history || [];
  const counts = {};
  for (const entry of history) {
    if (!entry.inviterId) continue;
    if (!counts[entry.inviterId]) counts[entry.inviterId] = { tag: entry.inviterTag, total: 0, stayed: 0, left: 0 };
    counts[entry.inviterId].total++;
    if (entry.inviterTag) counts[entry.inviterId].tag = entry.inviterTag; // Keep latest tag
    if (entry.left) counts[entry.inviterId].left++;
    else counts[entry.inviterId].stayed++;
  }
  return Object.entries(counts)
    .map(([id, data]) => ({ userId: id, ...data }))
    .sort((a, b) => b.total - a.total);
}

/** Get all joins that came through a specific inviter */
export function getInvitesBy(guildId, userId) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).filter(e => e.inviterId === userId);
}

// ─── TEMP BANS ─────────────────────────────────────────────────────────────
export function addTempBan(guildId, userId, username, duration, reason, moderatorId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) s.temp_bans = [];
  s.temp_bans.push({
    userId, username, reason,
    moderatorId,
    bannedAt: new Date().toISOString(),
    unbanAt: new Date(Date.now() + duration).toISOString(),
  });
  save();
}

export function getExpiredTempBans() {
  const now = new Date().toISOString();
  const expired = [];
  for (const [guildId, settings] of Object.entries(data.guild_settings)) {
    if (!settings.temp_bans?.length) continue;
    const due = settings.temp_bans.filter(b => b.unbanAt <= now);
    const remaining = settings.temp_bans.filter(b => b.unbanAt > now);
    if (due.length) {
      expired.push(...due.map(b => ({ ...b, guildId })));
      settings.temp_bans = remaining;
      save();
    }
  }
  return expired;
}

export function removeTempBan(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) return;
  s.temp_bans = s.temp_bans.filter(b => b.userId !== userId);
  save();
}

// ─── INVITE FILTER ─────────────────────────────────────────────────────────
export function setInviteFilter(guildId, enabled) {
  const s = ensureGuild(guildId);
  s.invite_filter = enabled;
  save();
}

export function setInviteFilterWhitelist(guildId, roleIds) {
  const s = ensureGuild(guildId);
  s.invite_filter_whitelist = roleIds;
  save();
}

// ─── STICKY MESSAGES ───────────────────────────────────────────────────────
export function setStickyMessage(guildId, channelId, content, embedData) {
  const s = ensureGuild(guildId);
  if (!s.sticky_messages) s.sticky_messages = {};
  s.sticky_messages[channelId] = { content, embedData, lastMessageId: null };
  save();
}

export function getStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  return s.sticky_messages?.[channelId] || null;
}

export function updateStickyMessageId(guildId, channelId, messageId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages?.[channelId]) {
    s.sticky_messages[channelId].lastMessageId = messageId;
    save();
  }
}

export function removeStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages) {
    delete s.sticky_messages[channelId];
    save();
  }
}
