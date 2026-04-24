import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "guildBanRemove";

export async function execute(ban) {
  let moderator = null;

  try {
    const audit = await ban.guild.fetchAuditLogs({ type: 23, limit: 1 });
    const entry = audit.entries.first();
    if (entry && entry.target?.id === ban.user.id && Date.now() - entry.createdTimestamp < 5000) {
      moderator = entry.executor;
    }
  } catch {}

  await sendModLog(ban.guild, logEvent({
    kind: "unban",
    target: ban.user,
    actor: moderator,
  }));
}
