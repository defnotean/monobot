import { log } from "../utils/logger.js";

export const name = "guildUnavailable";

export async function execute(guild) {
  log(`[OUTAGE] Server "${guild.name}" went unavailable — possible Discord outage`);
}
