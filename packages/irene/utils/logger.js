// ─── Logger — pretty console, plain file + Irene mod-log channel sender ───
// `log` / `redact` come from `@defnotean/shared/logger` (same redaction +
// rotation + ANSI formatting that Eris uses). `sendModLog` stays bot-local
// because it depends on Irene's `database.js` for the per-guild log-channel
// setting and on Irene's `modEmbed` helper for the embed format.

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@defnotean/shared/logger";
import { getGuildSettings, setLogChannel } from "../database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "../bot.log");

const _logger = createLogger({ botPrefix: "IRENE", logFile: LOG_FILE });

export const log = _logger.log;
// Re-export so callers that want to manually redact a structured value (e.g.
// `log(\`tool: \${name}(\${JSON.stringify(redact(args))})\`)`) don't need to
// reach into @defnotean/shared themselves.
export const redact = _logger.redact;

const LOG_CHANNEL_NAMES = [
  "mod-log", "mod-logs", "modlog", "modlogs",
  "audit-log", "audit-logs", "auditlog", "auditlogs",
  "bot-log", "bot-logs", "server-log", "server-logs", "logs",
];

/**
 * Send a mod-log. Accepts either a single embed (legacy) or a payload object
 * `{ embed, components }` for attaching buttons (e.g. undo actions).
 */
export async function sendModLog(guild, embedOrPayload) {
  // Bail if the bot is no longer in this guild (kicked / gatekept / left mid-event).
  // Prevents auto-detecting + persisting log channels in servers we won't stay in.
  if (!guild?.members?.me) return;
  if (!guild.client?.guilds?.cache?.has(guild.id)) return;

  const settings = getGuildSettings(guild.id);
  let channelId = settings?.log_channel;

  if (!channelId) {
    const found = guild.channels.cache.find(
      (c) => c.isTextBased() && LOG_CHANNEL_NAMES.includes(c.name.toLowerCase())
    );
    if (!found) return;
    channelId = found.id;
    setLogChannel(guild.id, found.id);
    log(`[AutoSetup] "${guild.name}": auto-detected log channel #${found.name}`);
  }

  let channel = guild.channels.cache.get(channelId);
  if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Normalize input: single embed → payload shape
  const payload = (embedOrPayload && typeof embedOrPayload === "object" && "embed" in embedOrPayload)
    ? { embeds: [embedOrPayload.embed], components: embedOrPayload.components ?? [] }
    : { embeds: [embedOrPayload] };

  try {
    await channel.send(payload);
  } catch (err) { log(`[ModLog] Failed to send log to #${channel.name}: ${err.message}`); }
}
