// @ts-check
/**
 * @file packages/irene/ai/resolve.js
 *
 * Member / channel / role lookup helpers for Irene's AI executor, plus the
 * per-guild member-name index cache that backs the member lookups. Extracted
 * verbatim from executor.js as part of the barrel-split — behavior is identical.
 *
 * The lookups (`findMember`, `findMemberDetailed`, `findChannel`, `findRole`,
 * `findRoles`) and `buildPingContent` are re-exported by executor.js so existing
 * importers (advancedExecutor, commandPrefix, etc.) keep working unchanged.
 *
 * `invalidateMemberIndex` is the single owner of the in-memory `_memberIndexes`
 * cache — events (guildMemberAdd/Remove/Update) import it to drop the stale
 * index when membership changes.
 */

import { ChannelType } from "discord.js";

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
    .replace(/[︀-️]/g, "")
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
