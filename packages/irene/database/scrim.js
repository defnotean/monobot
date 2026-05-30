/**
 * @file packages/irene/database/scrim.js
 * @module irene/database/scrim
 *
 * Per-guild, per-game scrim statistics. Stored in the top-level
 * data.scrim_stats slice (NOT inside guild_settings) so it fans out to its own
 * irene_scrim_stats per-entity row.
 */

import { data, save, _markEntity } from "./core.js";

export function getScrimStats(guildId, game) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  if (!data.scrim_stats[guildId][game]) data.scrim_stats[guildId][game] = {};
  return { ...data.scrim_stats[guildId][game] };
}

export function updateScrimStats(guildId, game, stats) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  data.scrim_stats[guildId][game] = stats;
  _markEntity("scrim_stats", guildId);
  save("scrim_stats");
}
