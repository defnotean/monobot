import { log } from "../utils/logger.js";
import { markGuildAvailable } from "./guildUnavailable.js";

export const name = "guildAvailable";

export async function execute(guild) {
  const unavailableMs = markGuildAvailable(guild);
  if (unavailableMs === null) return;

  if (unavailableMs >= 5 * 60 * 1000) {
    log(`[OUTAGE RESOLVED] Server "${guild.name}" is back online after ${Math.round(unavailableMs / 1000)}s`);
  }
}
