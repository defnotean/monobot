import config from "../config.js";
import * as db from "../database.js";

// Creator — always has full access
export function isOwner(userId) {
  return userId === config.ownerId;
}

// Trusted users — creator can grant trust via "trust this person" command
// Stored in Supabase shared whitelist (bot_data)
const _trustedUsers = new Set();

export function isTrusted(userId) {
  return isOwner(userId) || _trustedUsers.has(userId);
}

export function addTrustedUser(userId) {
  _trustedUsers.add(userId);
}

export function removeTrustedUser(userId) {
  _trustedUsers.delete(userId);
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
