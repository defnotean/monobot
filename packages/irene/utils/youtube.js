// ─── YouTube Notifications via RSS Feed ──────────────────────────────────────
// Polls YouTube RSS feeds for configured channels, posts embeds on new videos.

import { EmbedBuilder } from "discord.js";
import { getYoutubeConfig, setYoutubeConfig } from "../database.js";
import { log } from "./logger.js";
import Parser from "rss-parser";
import { safeFetch } from "@defnotean/shared/safeFetch";

const parser = new Parser();

// ─── In-Memory Feed State ───────────────────────────────────────────────────

const _feedState = new Map(); // "guildId:youtubeChannelId" → { lastVideoId, lastChecked, failureCount }
const MAX_RETRIES = 3;
const YOUTUBE_CHANNEL_ID_REGEX = /^[a-zA-Z0-9_-]{24}$/; // YouTube channel IDs are 24 chars
const FEED_MAX_BYTES = 1_000_000;

async function parseFeedUrl(feedUrl) {
  const res = await safeFetch(feedUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeoutMs: 10_000,
    maxBytes: FEED_MAX_BYTES,
  });
  if (!res.text || !/<(?:feed|entry)[\s>]/i.test(res.text)) return { items: [] };
  return parser.parseString(res.text);
}

// ─── YouTube Config Management ─────────────────────────────────────────────

export function initYoutubeData(loaded) {
  // Initialize feed state from loaded config if available
  if (loaded && typeof loaded === "object") {
    Object.entries(loaded).forEach(([key, value]) => {
      _feedState.set(key, value);
    });
  }
}

export function getYoutubeData() {
  const data = {};
  _feedState.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

export function addYoutubeFeed(guildId, youtubeChannelId, discordChannelId) {
  // Validate YouTube channel ID format
  if (!YOUTUBE_CHANNEL_ID_REGEX.test(youtubeChannelId)) {
    return { success: false, error: "Invalid YouTube channel ID format (should be 24 characters)" };
  }

  const configs = getYoutubeConfig(guildId);

  // Max 5 feeds per guild
  if (configs.length >= 5) {
    return { success: false, error: "Maximum 5 YouTube feeds per guild" };
  }

  // Prevent duplicates
  if (configs.some((c) => c.youtubeChannelId === youtubeChannelId)) {
    return { success: false, error: "This YouTube channel is already monitored" };
  }

  configs.push({
    youtubeChannelId,
    discordChannelId,
    lastVideoId: null,
    lastChecked: null,
  });

  setYoutubeConfig(guildId, configs);
  return { success: true };
}

export function removeYoutubeFeed(guildId, youtubeChannelId) {
  const configs = getYoutubeConfig(guildId);
  const filtered = configs.filter((c) => c.youtubeChannelId !== youtubeChannelId);

  if (filtered.length === configs.length) {
    return { success: false, error: "YouTube feed not found" };
  }

  setYoutubeConfig(guildId, filtered);
  // Also clean up feed state
  _feedState.delete(`${guildId}:${youtubeChannelId}`);
  return { success: true };
}

// ─── Feed Checker ──────────────────────────────────────────────────────────

export async function checkYoutubeFeeds(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await checkGuildYoutubeFeeds(guild);
    } catch (err) {
      log(`[YouTube] Error checking ${guild.name}: ${err.message}`);
    }
  }
}

async function checkGuildYoutubeFeeds(guild) {
  const configs = getYoutubeConfig(guild.id);
  if (!configs || configs.length === 0) return;

  for (const feed of configs) {
    try {
      const channel = guild.channels.cache.get(feed.discordChannelId)
        ?? await guild.channels.fetch(feed.discordChannelId).catch(() => null);

      if (!channel) continue;

      const stateKey = `${guild.id}:${feed.youtubeChannelId}`;
      const state = _feedState.get(stateKey) ?? {
        lastVideoId: feed.lastVideoId,
        lastChecked: feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0,
        failureCount: 0,
      };

      // Fetch with retry logic
      let feedData = null;
      let lastError = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.youtubeChannelId}`;
          feedData = await parseFeedUrl(feedUrl);
          state.failureCount = 0; // Reset on success
          break;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
          }
        }
      }

      if (!feedData || !feedData.items || feedData.items.length === 0) {
        state.failureCount = (state.failureCount || 0) + 1;
        if (state.failureCount >= 3) {
          log(`[YouTube] Feed ${feed.youtubeChannelId} failed 3 times: ${lastError?.message || "unknown error"}`);
        }
        _feedState.set(stateKey, state);
        continue;
      }

      // Check the most recent video
      const latestVideo = /** @type {any} */ (feedData.items[0]);
      const videoId = latestVideo.id?.split("yt:video:")[1] || latestVideo.link?.split("v=")[1];

      // Only notify on new video
      if (videoId && videoId !== state.lastVideoId) {
        // Update state
        state.lastVideoId = videoId;
        state.lastChecked = Date.now();
        _feedState.set(stateKey, state);

        // Update database with proper format
        const updatedConfigs = configs.map((c) =>
          c.youtubeChannelId === feed.youtubeChannelId
            ? { ...c, lastVideoId: videoId, lastChecked: new Date().toISOString() }
            : c
        );
        setYoutubeConfig(guild.id, updatedConfigs);

        // Send notification embed
        const embed = new EmbedBuilder()
          .setColor(0xFF0000) // YouTube red
          .setTitle(latestVideo.title)
          .setURL(latestVideo.link)
          .setAuthor({ name: feedData.title || "YouTube Channel" })
          .setDescription(latestVideo.summary ? latestVideo.summary.substring(0, 200) : "")
          .setTimestamp(new Date(latestVideo.pubDate));

        if (latestVideo.enclosure?.url) {
          embed.setThumbnail(latestVideo.enclosure.url);
        }

        const publishedDate = new Date(latestVideo.pubDate).toLocaleString();
        embed.addFields(
          { name: "Published", value: publishedDate, inline: true }
        );

        // Build ping content from feed's ping_role_ids
        const pingIds = Array.isArray(feed.ping_role_ids) ? feed.ping_role_ids : (feed.ping_role_id ? [feed.ping_role_id] : []);
        const pingContent = pingIds.map((id) => `<@&${id}>`).join(" ");

        await channel.send({ content: pingContent || undefined, embeds: [embed] }).catch(() => {});
        log(`[YouTube] 📺 New video from ${feedData.title} in "${guild.name}"`);
      }
    } catch (err) {
      log(`[YouTube] Error checking feed in ${guild.name}: ${err.message}`);
    }
  }
}

// ─── Timer ────────────────────────────────────────────────────────────────

export function startYoutubeTimer(client) {
  // Check immediately on startup
  checkYoutubeFeeds(client).catch(() => {});

  // Then check every 10 minutes
  setInterval(() => checkYoutubeFeeds(client).catch(() => {}), 10 * 60_000);
  log("[YouTube] Feed checker started (every 10 minutes)");
}
