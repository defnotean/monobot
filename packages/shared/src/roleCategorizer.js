/**
 * @file roleCategorizer.js
 * @module @defnotean/shared/roleCategorizer
 *
 * Permission-based classifier that buckets every Discord guild role into a
 * small, stable taxonomy so other features ("grant access to staff", "ping
 * the mods", "let any trusted role open tickets") can resolve fuzzy role
 * hints without trusting role NAMES. Role names are user-controlled and
 * trivially spoofable — a cosmetic role called "🎭 Moderator" with zero
 * permissions must never end up in the mod set. Categorization is derived
 * exclusively from the role's `.permissions` bitfield, with two structural
 * overrides: `everyone` (role.id === guild.id) and `bot` (role.managed).
 *
 * Categories (stored labels):
 *   - everyone   — the @everyone role
 *   - bot        — integration-managed role (Discord application/webhook)
 *   - admin      — Administrator OR ManageGuild
 *   - moderator  — Ban/Kick/Timeout/ManageRoles/ManageChannels (no admin)
 *   - helper     — softer powers (ManageMessages, ManageThreads, MuteMembers,
 *                  ViewAuditLog, etc.) — can act, can't remove members
 *   - cosmetic   — no dangerous perms (color tags, pingables, vanity)
 *
 * Meta-categories (query-only, expanded inside _expandCategory):
 *   - staff      = admin ∪ moderator
 *   - any_staff / trusted = admin ∪ moderator ∪ helper
 *
 * Exports:
 *   - categorizeRole(role, guild)        — single role → category string
 *   - categorizeAllRoles(guild)          — { roleId: category } snapshot
 *   - getRolesByCategory(guild, cat)     — Role[] sorted by position desc
 *   - asCategoryKeyword(input)           — string → canonical keyword | null
 *   - resolveRoleHints(guild, hints)     — flexible ID|name|keyword resolver
 *
 * Heuristics: name matching is ONLY used by `resolveRoleHints` as a step in
 * the ID → exact-name → category fallback chain, and even then the category
 * step still goes through permission-based bucketing. There is no fuzzy or
 * substring name matching anywhere in this module.
 *
 * False-positive risks to keep in mind:
 *   - A "helper" role granted MentionEveryone or ManageWebhooks can still
 *     cause real damage; the label only reflects relative privilege, not
 *     safety.
 *   - Discord may add new permission bits over time — anything not listed
 *     in ADMIN_PERMS / MOD_PERMS / HELPER_PERMS falls through to cosmetic.
 *
 * Consumers: irene's ticket setup, role auditing (roleCreate/roleUpdate
 * events), eris admin executor, and any AI executor that needs to translate
 * an admin's loose "give the mods access" instruction into concrete role IDs.
 */

// ─── Role Categorizer ────────────────────────────────────────────────────────
// Classify every guild role by its ACTUAL permissions, not by name. This way
// a cosmetic role called "🎭 Moderator" with no perms gets bucketed as
// `cosmetic`, and a real mod role called "Staff Team" with BanMembers gets
// bucketed as `moderator` — exactly what we want when an admin says "give
// mods access to tickets" without spelling out the role name.
//
// Categories:
//   everyone   — the @everyone role (role.id === guild.id)
//   bot        — integration-managed role (role.managed)
//   owner      — roles held only by the guild owner (rarely meaningful)
//   admin      — has Administrator OR ManageGuild (effectively full control)
//   moderator  — can punish members (Ban/Kick/Timeout) or restructure the
//                server (ManageRoles/ManageChannels), but no admin perms
//   helper     — softer perms only (ManageMessages, ManageThreads, MuteMembers,
//                ViewAuditLog, etc.) — not enough to ban, but enough to act
//   cosmetic   — no dangerous perms. Decorative roles, color tags, pings.
//
// Meta-categories (query-only, not a stored label):
//   staff      = admin ∪ moderator
//   any_staff  = admin ∪ moderator ∪ helper
//
// These labels are never applied by name — they're always derived from the
// role's `.permissions` bitfield. Someone spoofing the name of a role they
// don't have perms on can't elevate themselves through this.

import { PermissionFlagsBits as P } from "discord.js";

// Any ONE of these → admin.
const ADMIN_PERMS = [P.Administrator, P.ManageGuild];

// Any ONE of these (and no admin perms) → moderator.
// These are the perms that let a role actually punish or restructure.
const MOD_PERMS = [
  P.BanMembers,
  P.KickMembers,
  P.ModerateMembers,   // timeout
  P.ManageRoles,
  P.ManageChannels,
];

// Any ONE of these (and no mod/admin perms) → helper.
// Softer powers — can act on messages / voice but not remove members.
const HELPER_PERMS = [
  P.ManageMessages,
  P.ManageThreads,
  P.ManageNicknames,
  P.ManageEvents,
  P.ManageWebhooks,
  P.ManageEmojisAndStickers,
  P.MentionEveryone,
  P.MuteMembers,
  P.DeafenMembers,
  P.MoveMembers,
  P.ViewAuditLog,
];

/** @param {any} perms @param {any[]} list */
function _hasAny(perms, list) {
  for (const p of list) {
    try { if (perms.has(p)) return true; } catch { /* invalid perm id — skip */ }
  }
  return false;
}

/**
 * Classify a single role. Returns one of:
 *   "everyone" | "bot" | "admin" | "moderator" | "helper" | "cosmetic"
 *
 * Name is ignored. Position is ignored. Only the permission bitfield is
 * consulted, so self-made aesthetic roles can't be miscategorized.
 * @param {any} role
 * @param {any} [guild]
 */
export function categorizeRole(role, guild) {
  if (!role) return "cosmetic";
  if (guild && role.id === guild.id) return "everyone";
  if (role.managed) return "bot";
  const perms = role.permissions;
  if (!perms) return "cosmetic";
  if (_hasAny(perms, ADMIN_PERMS))  return "admin";
  if (_hasAny(perms, MOD_PERMS))    return "moderator";
  if (_hasAny(perms, HELPER_PERMS)) return "helper";
  return "cosmetic";
}

/**
 * Snapshot every role in the guild → category. Returns a plain object
 * keyed by role ID for easy serialization.
 * @param {any} guild
 */
export function categorizeAllRoles(guild) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!guild?.roles?.cache) return out;
  for (const [id, role] of guild.roles.cache) {
    out[id] = categorizeRole(role, guild);
  }
  return out;
}

/**
 * Get all roles matching a category (or meta-category). Returns an array
 * of Role objects, sorted by position descending (highest first) so the
 * caller can prefer the most privileged mod when using just one.
 * @param {any} guild
 * @param {string} category
 */
export function getRolesByCategory(guild, category) {
  if (!guild?.roles?.cache) return [];
  const target = _expandCategory(category);
  if (!target) return [];
  const matches = [];
  for (const [, role] of guild.roles.cache) {
    if (target.has(categorizeRole(role, guild))) matches.push(role);
  }
  matches.sort((a, b) => b.position - a.position);
  return matches;
}

/** @param {string} category */
function _expandCategory(category) {
  if (!category) return null;
  const key = String(category).toLowerCase();
  switch (key) {
    case "everyone":  return new Set(["everyone"]);
    case "bot":       return new Set(["bot"]);
    case "admin":
    case "admins":
    case "administrator":
    case "administrators":  return new Set(["admin"]);
    case "mod":
    case "mods":
    case "moderator":
    case "moderators":      return new Set(["moderator"]);
    case "helper":
    case "helpers":         return new Set(["helper"]);
    case "cosmetic":
    case "aesthetic":       return new Set(["cosmetic"]);
    case "staff":
    case "staffs":          return new Set(["admin", "moderator"]);
    case "any_staff":
    case "anystaff":
    case "trusted":         return new Set(["admin", "moderator", "helper"]);
    default: return null;
  }
}

/**
 * Parse a name/keyword and decide whether it's a category lookup. Returns
 * the canonical category name (one accepted by getRolesByCategory) or null
 * if the input doesn't look like a category keyword.
 *
 * Handles common prefixes like "@" and plural/casing variants.
 * @param {any} input
 */
export function asCategoryKeyword(input) {
  if (!input || typeof input !== "string") return null;
  const stripped = input.trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, "_");
  return _expandCategory(stripped) ? stripped : null;
}

/**
 * High-level helper for the ticket flow (or any other "grant access to
 * staff" feature): given a user-supplied role hint (string, array, or
 * single name/ID), resolve to an array of Role objects. Order of checks:
 *   1. Raw role ID in guild.roles.cache.
 *   2. Exact case-insensitive name match.
 *   3. Category keyword (mods, admins, staff, helpers, trusted).
 * If the hint resolves to nothing at all, returns []. Caller is expected
 * to surface the miss; this function doesn't throw.
 * @param {any} guild
 * @param {any} hints
 */
export function resolveRoleHints(guild, hints) {
  if (!guild?.roles?.cache) return [];
  const list = Array.isArray(hints) ? hints : [hints];
  const raw = list
    .flatMap((h) => (typeof h === "string" ? h.split(",") : []))
    .map((s) => s.trim())
    .filter(Boolean);

  const ids = new Set();
  for (const hint of raw) {
    // 1. Raw ID
    const byId = guild.roles.cache.get(hint);
    if (byId) { ids.add(byId.id); continue; }

    // 2. Exact name (case-insensitive, allow leading @)
    const normalized = hint.toLowerCase().replace(/^@/, "");
    const byName = guild.roles.cache.find(
      (/** @type {any} */ r) => r.name.toLowerCase() === normalized && r.id !== guild.id
    );
    if (byName) { ids.add(byName.id); continue; }

    // 3. Category keyword → collect every matching role
    const cat = asCategoryKeyword(hint);
    if (cat) {
      for (const role of getRolesByCategory(guild, cat)) ids.add(role.id);
    }
  }
  return [...ids].map((id) => guild.roles.cache.get(id)).filter(Boolean);
}
