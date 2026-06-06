/**
 * @file packages/irene/database/guildSettings.js
 * @module irene/database/guildSettings
 *
 * Per-guild key/value settings store plus the features layered directly on it:
 *   - generic get/set settings + admin directives
 *   - server rules + auto-mod (rules / exemptions / violations)
 *   - misc flat settings (gif embed, dm results, welcome channel, ghost-ping,
 *     log channel, autorole, ticket category root)
 *
 * All of these read/write data.guild_settings[guildId] and persist via
 * save("guild_settings"). The `_cleanRoleIds` helper is shared with the
 * ticket-system module.
 */

import { data, save, ensureGuild, _markEntity } from "./core.js";
import { GUILD_SETTINGS_DEFAULTS, withDefaults } from "./schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// GUILD SETTINGS & DIRECTIVES — per-server key/value store + admin directives
// ═══════════════════════════════════════════════════════════════════════════

// ─── Guild Settings ───────────────────────────────────────────────────────────

export function getGuildSettings(guildId) {
  // Merge defaults so callers can rely on the full GUILD_SETTINGS_DEFAULTS
  // shape (channel ids default to null, counters/arrays/flags match the
  // legacy inline `??` fallbacks). Stored fields win; explicit-null in
  // stored is preserved (cleared state); `undefined` in stored does not
  // erase the default. See packages/irene/database/schemas.js.
  return withDefaults(GUILD_SETTINGS_DEFAULTS, data.guild_settings[guildId]);
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
/**
 * @returns {{ success: true, index: number } | { success: false, reason: string }}
 */
export function addDirective(guildId, text, channelId = null, addedBy = null) {
  const g = ensureGuild(guildId);
  if (!g.directives) g.directives = [];
  if (g.directives.length >= 50) return { success: false, reason: "max 50 directives per server" };
  // Dedup: don't save if near-identical directive exists
  const lower = text.toLowerCase().trim();
  if (g.directives.some(d => d.text.toLowerCase().trim() === lower)) return { success: false, reason: "duplicate directive" };
  g.directives.push({ text: text.substring(0, 300), channel: channelId || null, addedBy, addedAt: Date.now() });
  save("guild_settings");
  return { success: true, index: g.directives.length - 1 };
}
export function removeDirective(guildId, indexOrKeyword) {
  const g = ensureGuild(guildId);
  if (!g.directives?.length) return { success: false, reason: "no directives saved" };
  const idx = typeof indexOrKeyword === "number" ? indexOrKeyword : g.directives.findIndex(d => d.text.toLowerCase().includes(String(indexOrKeyword).toLowerCase()));
  if (idx < 0 || idx >= g.directives.length) return { success: false, reason: "directive not found" };
  const removed = g.directives.splice(idx, 1)[0];
  save("guild_settings");
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

/**
 * @returns {{ success: true, rule: { number: number, text: string, severity: string, addedBy: string|null, addedAt: number } } | { success: false, reason: string }}
 */
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
  save("guild_settings");
  return { success: true, rule };
}

export function removeRule(guildId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rules?.length) return { success: false, reason: "no rules saved" };
  const idx = g.rules.findIndex(r => r.number === Number(ruleNumber));
  if (idx < 0) return { success: false, reason: `no rule numbered ${ruleNumber}` };
  const removed = g.rules.splice(idx, 1)[0];
  save("guild_settings");
  return { success: true, removed };
}

export function clearRules(guildId) {
  const g = ensureGuild(guildId);
  const count = g.rules?.length ?? 0;
  g.rules = [];
  save("guild_settings");
  return { success: true, count };
}

export function setAutoModEnabled(guildId, enabled) {
  const g = ensureGuild(guildId);
  g.auto_mod_enabled = !!enabled;
  save("guild_settings");
  return g.auto_mod_enabled;
}

export function isAutoModEnabled(guildId) {
  return !!data.guild_settings[guildId]?.auto_mod_enabled;
}

// ─── Rule exemptions ──────────────────────────────────────────────────────────

export function getExemptions(guildId) {
  return data.guild_settings[guildId]?.rule_exemptions ?? [];
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {number|null} [ruleNumber]
 * @param {string|null} [reason]
 * @param {string|null} [addedBy]
 * @param {number|null} [expiresAt]
 * @returns {{ success: true, exemption: Record<string, any> } | { success: false, reason: string }}
 */
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
  save("guild_settings");
  return { success: true, exemption: ex };
}

export function removeExemption(guildId, userId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rule_exemptions?.length) return { success: false, reason: "no exemptions" };
  const ruleNum = ruleNumber === null || ruleNumber === undefined ? null : Number(ruleNumber);
  const idx = g.rule_exemptions.findIndex(e => e.userId === userId && e.ruleNumber === ruleNum);
  if (idx < 0) return { success: false, reason: "exemption not found" };
  const removed = g.rule_exemptions.splice(idx, 1)[0];
  save("guild_settings");
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
    _markEntity("guild_settings", guildId);
    save("guild_settings");
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
  save("guild_settings");
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
  save("guild_settings");
}

export function setDmResults(guildId, enabled) {
  ensureGuild(guildId).dm_results = enabled;
  save("guild_settings");
}

export function getDmResults(guildId) {
  return data.guild_settings[guildId]?.dm_results ?? false; // default: OFF
}

export function getAiSilencedChannels(guildId) {
  return data.guild_settings[guildId]?.ai_silenced_channels ?? [];
}

export function isAiSilencedChannel(guildId, channelId) {
  if (!guildId || !channelId) return false;
  return getAiSilencedChannels(guildId).includes(channelId);
}

export function setAiSilencedChannel(guildId, channelId, silenced) {
  const s = ensureGuild(guildId);
  const current = new Set(Array.isArray(s.ai_silenced_channels) ? s.ai_silenced_channels : []);
  if (silenced) current.add(channelId);
  else current.delete(channelId);
  s.ai_silenced_channels = [...current];
  save("guild_settings");
}

export function setWelcomeChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.welcome_channel = channelId;
  if (message) s.welcome_message = message;
  save("guild_settings");
}

// ─── Ghost-Ping on Join ──────────────────────────────────────────────────
export function setGhostPingChannels(guildId, channelIds) {
  ensureGuild(guildId).ghost_ping_channels = channelIds;
  save("guild_settings");
}

export function getGhostPingChannels(guildId) {
  return data.guild_settings[guildId]?.ghost_ping_channels ?? [];
}

export function setLogChannel(guildId, channelId) {
  ensureGuild(guildId).log_channel = channelId;
  save("guild_settings");
}

export function setAutorole(guildId, roleId) {
  ensureGuild(guildId).autorole_id = roleId;
  save("guild_settings");
}

export function setTicketCategory(guildId, categoryId) {
  ensureGuild(guildId).ticket_category_id = categoryId;
  save("guild_settings");
}

// Shared with ./tickets.js — keep here next to setTicketCategory which is the
// only ticket setter that lives in this "misc guild settings" section.
export function _cleanRoleIds(roleIds) {
  return Array.isArray(roleIds)
    ? roleIds.map(String).filter((id) => /^\d{17,20}$/.test(id))
    : [];
}
