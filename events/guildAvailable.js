import { log } from "../utils/logger.js";

export const name = "guildAvailable";

export async function execute(guild) {
  log(`[OUTAGE RESOLVED] Server "${guild.name}" is back online`);
}
