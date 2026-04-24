import { log } from "../utils/logger.js";

export const name = "guildDelete";

export async function execute(guild) {
  log(`[BOT] Removed from server: "${guild.name}" — ID: ${guild.id}`);
}
