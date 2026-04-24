// ─── Twitch Live Notifications ───────────────────────────────────────────────
// Polls Twitch Helix API for configured streamers, posts embed on offline→live.

import { EmbedBuilder } from "discord.js";
import { getTwitchConfig } from "../database.js";
import config from "../config.js";
import { log } from "./logger.js";

// ─── Token Cache ─────────────────────────────────────────────────────────────

let _accessToken = null;
let _tokenExpiry = 0;

async function getAppAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const clientId = config.twitchClientId;
  const clientSecret = config.twitchClientSecret;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      log(`[Twitch] Token request failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    _accessToken = data.access_token;
    // Expire 5 minutes early to be safe
    _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return _accessToken;
  } catch (err) {
    log(`[Twitch] Token error: ${err.message}`);
    return null;
  }
}

// ─── Live State Tracker ──────────────────────────────────────────────────────

const _liveState = new Map(); // "guildId:username" → boolean

// ─── Stream Checker ──────────────────────────────────────────────────────────

export async function checkStreams(client) {
  const token = await getAppAccessToken();
  if (!token) return;

  const clientId = config.twitchClientId;
  if (!clientId) return;

  await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      const twitchConfig = getTwitchConfig(guild.id);
      if (!twitchConfig.channel_id || !twitchConfig.streamers?.length) return;

      const channel = guild.channels.cache.get(twitchConfig.channel_id);
      if (!channel) return;

      try {
        // Batch check — Helix supports up to 100 user_login params
        const validStreamers = twitchConfig.streamers.filter((s) => s && typeof s === "string" && s.trim().length > 0 && /^[a-zA-Z0-9_]+$/.test(s.trim()));
        if (!validStreamers.length) return;

        const params = validStreamers
          .map((s) => `user_login=${encodeURIComponent(s.trim().toLowerCase())}`)
          .join("&");
        if (!params) return;

        const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
          headers: {
            "Client-ID": clientId,
            "Authorization": `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          if (res.status === 401) {
            // Token expired, force refresh next cycle
            _accessToken = null;
            _tokenExpiry = 0;
          }
          const body = await res.text().catch(() => "");
          log(`[Twitch] API error: ${res.status} — ${body.slice(0, 200)}`);
          return;
        }

        const data = await res.json();
        const streams = data?.data ?? [];
        const liveUsernames = new Set(streams.map((s) => s.user_login.toLowerCase()));

        for (const streamer of twitchConfig.streamers) {
          const key = `${guild.id}:${streamer.toLowerCase()}`;
          const wasLive = _liveState.get(key) ?? false;
          const isLive = liveUsernames.has(streamer.toLowerCase());

          _liveState.set(key, isLive);

          // Only notify on offline → live transition
          if (isLive && !wasLive) {
            const streamData = streams.find((s) => s.user_login.toLowerCase() === streamer.toLowerCase());
            if (!streamData) continue;

            const thumbnailUrl = streamData.thumbnail_url
              ?.replace("{width}", "440")
              .replace("{height}", "248");

            const embed = new EmbedBuilder()
              .setColor(0x9146FF) // Twitch purple
              .setAuthor({ name: `${streamData.user_name} is now LIVE on Twitch!` })
              .setTitle(streamData.title || "Untitled Stream")
              .setURL(`https://twitch.tv/${streamData.user_login}`)
              .addFields(
                { name: "Game", value: streamData.game_name || "Unknown", inline: true },
                { name: "Viewers", value: `${streamData.viewer_count ?? 0}`, inline: true },
              )
              .setTimestamp();

            if (thumbnailUrl) embed.setImage(thumbnailUrl);

            // Per-streamer ping roles take priority, then default roles
            // Supports both legacy single IDs and new arrays
            let pingIds = [];
            const streamerRoles = twitchConfig.streamer_roles?.[streamer.toLowerCase()];
            if (streamerRoles) {
              pingIds = Array.isArray(streamerRoles) ? streamerRoles : [streamerRoles];
            } else if (twitchConfig.ping_role_ids?.length) {
              pingIds = twitchConfig.ping_role_ids;
            } else if (twitchConfig.ping_role_id) {
              pingIds = [twitchConfig.ping_role_id];
            }
            const content = pingIds.map((id) => `<@&${id}>`).join(" ");

            await channel.send({ content: content || undefined, embeds: [embed] }).catch((err) => {
              log(`[Twitch] Failed to post in ${guild.name}: ${err.message}`);
            });
          }
        }
      } catch (err) {
        log(`[Twitch] Error checking streams for ${guild.name}: ${err.message}`);
      }
    })
  );
}
