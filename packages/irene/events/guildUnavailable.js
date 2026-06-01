import { log } from "../utils/logger.js";

export const name = "guildUnavailable";

const unavailableSince = new Map();
const OUTAGE_LOG_DELAY_MS = 5 * 60 * 1000;

export async function execute(guild) {
  const guildId = guild.id ?? guild.name;
  if (unavailableSince.has(guildId)) return;

  const startedAt = Date.now();
  const timer = setTimeout(() => {
    const state = unavailableSince.get(guildId);
    if (!state) return;
    log(`[OUTAGE] Server "${guild.name}" has been unavailable for ${Math.round(OUTAGE_LOG_DELAY_MS / 60_000)}m — possible Discord outage`);
  }, OUTAGE_LOG_DELAY_MS);

  if (typeof timer.unref === "function") timer.unref();
  unavailableSince.set(guildId, { startedAt, timer });
}

export function markGuildAvailable(guild) {
  const guildId = guild.id ?? guild.name;
  const state = unavailableSince.get(guildId);
  if (!state) return null;

  clearTimeout(state.timer);
  unavailableSince.delete(guildId);
  return Date.now() - state.startedAt;
}
