import { log } from "../utils/logger.js";
import { setLogChannel, setWelcomeChannel, getGuildSettings, isWhitelisted } from "../database.js";
import config from "../config.js";

const LOG_CHANNEL_NAMES = [
  "mod-log", "mod-logs", "modlog", "modlogs",
  "audit-log", "audit-logs", "auditlog", "auditlogs",
  "bot-log", "bot-logs", "server-log", "server-logs", "logs",
];
const WELCOME_CHANNEL_NAMES = [
  "welcome", "welcomes", "welcome-chat", "welcome-mat",
  "welcome-channel", "greetings", "introductions",
];

// ─── Owner-only gatekeep ────────────────────────────────────────────────────
// The bot will only stay in servers that meet ONE of:
//   1. Bot owner is the server owner
//   2. Bot owner is a member of the server
//   3. Server is in the database whitelist (managed via AI tools)

function isGuildAllowed(guild) {
  // Always allow if the bot owner is the server owner
  if (guild.ownerId === config.userId) return true;
  // Allow servers in the database whitelist
  if (isWhitelisted(guild.id)) return true;
  // Check if the bot owner is a member (they invited it themselves)
  const ownerMember = guild.members.cache.get(config.userId);
  if (ownerMember) return true;
  return false;
}

export const name = "guildCreate";

export async function execute(guild) {
  log(`[BOT] Joined new server: "${guild.name}" (${guild.memberCount} members) — ID: ${guild.id}`);

  // ── Gatekeep: leave if bot owner didn't authorize this server ──────────
  // Fetch members first so we can check if the bot owner is present
  await guild.members.fetch({ user: config.userId }).catch(() => {});
  if (!isGuildAllowed(guild)) {
    log(`[GATEKEEP] Unauthorized server "${guild.name}" (${guild.id}) — owner: ${guild.ownerId}. Leaving.`);
    // Try to DM the person who added it
    try {
      const auditLogs = await guild.fetchAuditLogs({ type: 28, limit: 1 }); // 28 = BOT_ADD
      const entry = auditLogs.entries.first();
      if (entry?.executor) {
        await entry.executor.send(
          `hey! i'm a private bot and only my owner can add me to servers. ` +
          `if you want me in your server, ask **${(await guild.client.users.fetch(config.userId).catch(() => ({ username: "my owner" }))).username}** to add me.`
        ).catch(() => {});
      }
    } catch {}
    await guild.leave();
    return;
  }

  // Fetch channels so the cache is warm before scanning
  await guild.channels.fetch().catch(() => {});

  const settings = getGuildSettings(guild.id);

  const logCh = guild.channels.cache.find(
    (c) => c.isTextBased() && LOG_CHANNEL_NAMES.includes(c.name.toLowerCase())
  );
  if (logCh && !settings?.log_channel) {
    setLogChannel(guild.id, logCh.id);
    log(`[AutoSetup] "${guild.name}": log channel → #${logCh.name}`);
  }

  const welcomeCh = guild.channels.cache.find(
    (c) => c.isTextBased() && WELCOME_CHANNEL_NAMES.includes(c.name.toLowerCase())
  );
  if (welcomeCh && !settings?.welcome_channel) {
    setWelcomeChannel(guild.id, welcomeCh.id, null);
    log(`[AutoSetup] "${guild.name}": welcome channel → #${welcomeCh.name}`);
  }
}
