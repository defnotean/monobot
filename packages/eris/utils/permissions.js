import config from "../config.js";
import * as db from "../database.js";
import { log } from "./logger.js";

// Creator — always has full access
export function isOwner(userId) {
  return userId === config.ownerId;
}

// Trusted users — creator can grant trust via "trust this person" command.
// Persisted to bot_data row id="eris_trusted" (data.trusted_users) so grants
// survive restarts. Loaded eagerly at startup by initTrustedUsers() and kept
// in memory for lock-free sync permission checks; mutations re-persist the
// whole set fire-and-forget (same pattern as eris_server_personas).
const _trustedUsers = new Set();
let _trustedLoaded = false;

export async function initTrustedUsers() {
  if (_trustedLoaded) return;
  try {
    const supabase = db.getSupabase();
    const { data } = supabase
      ? await supabase.from("bot_data").select("data").eq("id", "eris_trusted").single()
      : { data: null };
    const list = data?.data?.trusted_users;
    if (Array.isArray(list)) for (const id of list) _trustedUsers.add(String(id));
    log(`[Permissions] Loaded ${_trustedUsers.size} trusted users`);
  } catch (e) {
    log(`[Permissions] Init failed — running with empty trusted set: ${e.message}`);
  }
  _trustedLoaded = true;
}

function persistTrustedUsers() {
  try {
    const supabase = db.getSupabase();
    if (!supabase) return;
    void supabase.from("bot_data").upsert({ id: "eris_trusted", data: { trusted_users: [..._trustedUsers] } })
      .catch((e) => log(`[Permissions] Persist trusted users failed: ${e.message}`));
  } catch { /* offline — nothing to persist to */ }
}

export function isTrusted(userId) {
  return isOwner(userId) || _trustedUsers.has(userId);
}

export function addTrustedUser(userId) {
  _trustedUsers.add(userId);
  persistTrustedUsers();
}

export function removeTrustedUser(userId) {
  _trustedUsers.delete(userId);
  persistTrustedUsers();
}

export function getTrustedUsers() {
  return [..._trustedUsers];
}

// Check if user is server owner in the current guild
export function isServerOwner(userId, guild) {
  if (!guild) return false;
  return guild.ownerId === userId;
}

// Can customize — trusted users, server owners, and creator
export function canCustomize(userId, guild) {
  return isOwner(userId) || isTrusted(userId) || isServerOwner(userId, guild);
}

// Sensitive tools — only creator (terminal, email, github, system, database)
// Customization tools — creator + trusted + server owners (avatar, name, personality, nickname)
export function canUseSensitive(userId) {
  return isOwner(userId);
}

export function denyMessage(variant = "default") {
  const msgs = {
    default: "lol you wish. that's above your pay grade",
    terminal: "you want terminal access?? cute. only boss gets that",
    local: "my pc my rules. only boss touches that",
    personality: "you wanna change my personality? earn trust first bestie",
    customize: "not happening. you're not trusted enough for that one",
  };
  return msgs[variant] || msgs.default;
}
