// @ts-check

import { log } from "./logger.js";

/**
 * @param {unknown} error
 */
export function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/**
 * Run a best-effort Discord cleanup/action and log failures instead of silently
 * swallowing them. Returns true on success and false on failure.
 *
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} fn
 * @returns {Promise<boolean>}
 */
export async function safeDiscordAction(label, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    log(`[DiscordAction] ${label} failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Sync variant for cleanup APIs like removeAllListeners().
 *
 * @param {string} label
 * @param {() => unknown} fn
 * @returns {boolean}
 */
export function safeDiscordSync(label, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    log(`[DiscordAction] ${label} failed: ${errorMessage(error)}`);
    return false;
  }
}
