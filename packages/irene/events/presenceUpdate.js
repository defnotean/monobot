// ─── Presence Update — Auto-rename temp VCs + auto-detect streaming ──────────
// When a member's game changes, queue a rename for their temp VC and refresh
// the control panel so it shows current activity.
// When auto_detect is enabled, also fires a notification when anyone goes live.

import { ActivityType, EmbedBuilder } from "discord.js";
import { tempChannels, manualRenames } from "../utils/tempvc.js";
import { queueRename, isActualGame, sanitizeGameName } from "../utils/vcrenamer.js";
import { updateControlPanel } from "../utils/vcpanel.js";
import { getTwitchConfig } from "../database.js";
import { log } from "../utils/logger.js";

export const name = "presenceUpdate";

// Tracks who we've already notified so we don't fire on every presence tick
// Key: "guildId:userId", value: true while they're live
const _streamingNotified = new Map();

export async function execute(oldPresence, newPresence) {
  const member = newPresence?.member ?? oldPresence?.member;
  if (!member || member.user.bot) return;

  const guild = newPresence?.guild ?? oldPresence?.guild;
  if (!guild) return;

  // ── Auto-detect streaming ──────────────────────────────────────────────────
  const getStream = (p) => p?.activities?.find((a) => a.type === ActivityType.Streaming) ?? null;
  const oldStream = getStream(oldPresence);
  const newStream = getStream(newPresence);
  const key = `${guild.id}:${member.id}`;

  if (newStream && !oldStream) {
    // Just went live — notify if not already notified
    if (!_streamingNotified.get(key)) {
      _streamingNotified.set(key, true);
      const twitchConfig = getTwitchConfig(guild.id);
      if (twitchConfig.auto_detect && twitchConfig.channel_id) {
        const channel = guild.channels.cache.get(twitchConfig.channel_id);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setAuthor({ name: `${member.displayName} is now live!`, iconURL: member.user.displayAvatarURL({ size: 64 }) })
            .setTitle(newStream.state || newStream.name || "Live Stream")
            .setTimestamp();

          if (newStream.url) embed.setURL(newStream.url);
          if (newStream.details) embed.setDescription(newStream.details);

          const pingIds = twitchConfig.ping_role_ids?.length
            ? twitchConfig.ping_role_ids
            : twitchConfig.ping_role_id ? [twitchConfig.ping_role_id] : [];
          const content = pingIds.map((id) => `<@&${id}>`).join(" ");

          await channel.send({ content: content || undefined, embeds: [embed] }).catch((err) => {
            log(`[AutoStream] Failed to post for ${member.user.username}: ${err.message}`);
          });
          log(`[AutoStream] ${member.user.username} went live in ${guild.name}`);
        }
      }
    }
  } else if (!newStream && oldStream) {
    // Stopped streaming — clear so they can trigger again next time
    _streamingNotified.delete(key);
  }

  // ── Temp VC game rename ────────────────────────────────────────────────────
  const getGame = (p) => {
    const act = p?.activities?.find((a) => a.type === ActivityType.Playing && isActualGame(a.name));
    return act ? sanitizeGameName(act.name) : null;
  };

  const oldGame = getGame(oldPresence);
  const newGame = getGame(newPresence);
  if (oldGame === newGame) return;

  const vc = member.voice?.channel;
  if (!vc || !tempChannels.has(vc.id)) return;

  log(`[VC] Game change detected: ${member.user.username} — "${oldGame ?? 'none'}" → "${newGame ?? 'none'}" (in #${vc.name})`);

  // Only queue rename if the owner hasn't manually locked it in the last 30 minutes.
  // The panel always updates regardless — activity display should stay current.
  const MANUAL_LOCK_MS = 30 * 60_000;
  const manualAt = manualRenames.get(vc.id);
  if (!manualAt || Date.now() - manualAt >= MANUAL_LOCK_MS) {
    queueRename(vc, guild);
  }
  await updateControlPanel(vc.id, guild);
}
