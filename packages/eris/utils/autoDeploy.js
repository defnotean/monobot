// ─── Auto-deploy slash commands on startup ──────────────────────────────────
// Hashes the command set on every boot. Only calls Discord's REST API to
// re-register commands when the hash has actually changed. This lets us ship
// new commands by just pushing code — no manual `node deploy-commands.js`.
//
// Per-bot tracking: both Eris and Irene share this codebase but have different
// CLIENT_IDs, so we key the stored hash by client ID to keep them independent.

import { REST, Routes } from "discord.js";
import { createHash } from "crypto";
import config from "../config.js";
import { getSupabase } from "../database.js";
import { log } from "./logger.js";

function hashCommands(commandJsons) {
  // Canonical ordering so trivial reorderings don't trigger re-registration
  const sorted = [...commandJsons].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Deploy commands if the hash changed since last boot.
 * Call this AFTER loadCommands() but BEFORE client.login().
 *
 * @param {import("discord.js").Collection<string, any>} commands  client.commands collection from index.js
 * @returns {Promise<{deployed: boolean, count: number, reason: string}>}
 */
export async function maybeAutoDeploy(commands) {
  // Extract command JSONs
  const commandJsons = [...commands.values()]
    .filter(c => c.data)
    .map(c => c.data.toJSON());

  if (!commandJsons.length) {
    return { deployed: false, count: 0, reason: "no commands loaded" };
  }

  const hash = hashCommands(commandJsons);
  const storageKey = `commands_hash_${config.clientId}`;

  // Check stored hash
  const sb = getSupabase();
  let storedHash = null;
  if (sb) {
    try {
      const { data } = await sb.from("bot_data").select("data").eq("id", storageKey).single();
      storedHash = data?.data?.hash ?? null;
    } catch { /* first boot or network hiccup — treat as no-hash */ }
  }

  if (storedHash === hash) {
    log(`[AUTODEPLOY] ${commandJsons.length} commands unchanged (hash ${hash.slice(0, 8)}) — skipping Discord API`);
    return { deployed: false, count: commandJsons.length, reason: "unchanged" };
  }

  // Hash differs — deploy to Discord
  log(`[AUTODEPLOY] Command hash changed (${storedHash?.slice(0, 8) ?? "none"} → ${hash.slice(0, 8)}) — deploying ${commandJsons.length} commands to Discord`);

  try {
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commandJsons });

    // Store the new hash ONLY after successful deploy — so failures retry next boot
    if (sb) {
      await sb.from("bot_data").upsert({ id: storageKey, data: { hash, count: commandJsons.length, deployedAt: Date.now() } });
    }

    log(`[AUTODEPLOY] Deployed ${commandJsons.length} commands successfully`);
    return { deployed: true, count: commandJsons.length, reason: "hash changed" };
  } catch (e) {
    log(`[AUTODEPLOY] Deploy failed: ${e.message} — will retry on next boot`);
    return { deployed: false, count: commandJsons.length, reason: `deploy failed: ${e.message}` };
  }
}
