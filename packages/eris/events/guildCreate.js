import { log } from "../utils/logger.js";
import config from "../config.js";
import { isWhitelisted, addToWhitelist } from "../database.js";

// ─── Owner-only gatekeep (shared whitelist with Irene) ─────────────────
// The bot stays in a server only if ONE of these is true:
//   1. The bot owner is the server owner
//   2. The bot owner is already a member of the server (they invited it)
//   3. The server is in the database whitelist (managed via AI tools)

async function isGuildAllowed(guild) {
  if (guild.ownerId === config.ownerId) return true;
  if (await isWhitelisted(guild.id)) return true;
  const ownerMember = guild.members.cache.get(config.ownerId)
    ?? await guild.members.fetch(config.ownerId).catch(() => null);
  if (ownerMember) return true;
  return false;
}

export default async function guildCreate(guild) {
  log(`[BOT] Joined new server: "${guild.name}" (${guild.memberCount} members) — ID: ${guild.id}`);

  if (await isGuildAllowed(guild)) {
    // Auto-track in whitelist — boss wants the whitelist to be a complete
    // record of every server the bot is currently in. Skip if already there.
    if (!(await isWhitelisted(guild.id))) {
      await addToWhitelist(guild.id, {
        name:       guild.name,
        icon_url:   guild.iconURL?.({ size: 128 }) ?? null,
        members:    guild.memberCount ?? null,
        invited_by: "auto-tracked-on-join",
      });
      log(`[WHITELIST] auto-tracked "${guild.name}" (${guild.id}) on join`);
    }
    return;
  }

  log(`[GATEKEEP] Unauthorized server "${guild.name}" (${guild.id}) — owner: ${guild.ownerId}. Leaving.`);

  // Try to DM whoever added the bot so they know why it left
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: 28, limit: 1 }); // 28 = BOT_ADD
    const entry = auditLogs.entries.first();
    if (entry?.executor) {
      const ownerName = (await guild.client.users.fetch(config.ownerId).catch(() => ({ username: "my owner" }))).username;
      await entry.executor.send(
        `hey! i'm a private bot and only my owner can add me to servers. ` +
        `if you want me in your server, ask **${ownerName}** to add me.`
      ).catch(() => {});
    }
  } catch {}

  await guild.leave().catch((err) => log(`[GATEKEEP] Failed to leave "${guild.name}": ${err.message}`));
}
