// ─── Game Update Watcher ───────────────────────────────────────────────────
// Polls Steam news API + RSS feeds for game patch notes / changelogs.
// Watches are stored per-guild in guild_settings.game_watches[].
// Runs every 10 minutes from ready.js; posts rich embeds to the configured channel.

import { EmbedBuilder } from "discord.js";
import { getGuildSettings, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";
import { safeFetch, validateUrlAsync } from "@defnotean/shared/safeFetch";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STEAM_NEWS_URL  = (appId, count = 5) =>
  `https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=${count}&maxlength=600&format=json`;
const STEAM_SEARCH_URL = (query) =>
  `https://store.steampowered.com/api/storeSearch/?term=${encodeURIComponent(query)}&cc=us&l=en`;
const STEAM_HEADER_IMG  = (appId) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
const STEAM_STORE_URL   = (appId) =>
  `https://store.steampowered.com/app/${appId}/`;

// Feeds that are actual patch notes / updates (ignore blog posts, misc)
const RELEVANT_FEEDS = new Set([
  "steam_community_announcements",
  "steam_announcements",
  "patchnotes",
  "patch_notes",
  "updates",
  "update",
  "rss",
]);

const RELEVANT_TITLE_RX = /\b(update|patch|hotfix|fix|changelog|release|v\d|version|\d+\.\d+|dlc|content)\b/i;
const RSS_MAX_BYTES = 1_000_000;

export async function validateGameWatchRssUrl(url) {
  await validateUrlAsync(url);
  return String(url).trim();
}

// ─── Steam helpers ────────────────────────────────────────────────────────────

export async function searchSteam(query) {
  try {
    const res = await fetch(STEAM_SEARCH_URL(query), {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json();
    const items = json?.items ?? [];
    return items
      .filter(i => i.type === "game" || i.type === "app")
      .slice(0, 5)
      .map(i => ({ id: i.id, name: i.name }));
  } catch (e) {
    log(`[GAMEWATCHER] Steam search failed: ${e.message}`);
    return [];
  }
}

async function fetchSteamNews(appId) {
  try {
    const res = await fetch(STEAM_NEWS_URL(appId), {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    return json?.appnews?.newsitems ?? [];
  } catch (e) {
    log(`[GAMEWATCHER] Steam news fetch failed for ${appId}: ${e.message}`);
    return [];
  }
}

// ─── RSS helpers ──────────────────────────────────────────────────────────────

async function fetchRSS(url) {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeoutMs: 10_000,
      maxBytes: RSS_MAX_BYTES,
    });
    const type = res.headers?.get?.("content-type") || "";
    const xml = res.text || "";
    if (type && !/(xml|rss|atom|text\/plain|text\/html)/i.test(type)) return [];
    if (!/<(?:rss|feed|item|entry)[\s>]/i.test(xml)) return [];
    const items = [];
    // Simple XML extraction — no external parser needed
    const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRx.exec(xml)) !== null) {
      const block = match[1];
      const title   = _xmlText(block, "title");
      const link    = _xmlText(block, "link") || _xmlAttr(block, "link", "href");
      const pubDate = _xmlText(block, "pubDate") || _xmlText(block, "published");
      const desc    = _xmlText(block, "description") || _xmlText(block, "content") || _xmlText(block, "summary");
      const guid    = _xmlText(block, "guid") || link;
      if (title && guid) items.push({ gid: guid, title, url: link, contents: desc, date: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0 });
    }
    return items.slice(0, 10);
  } catch (e) {
    log(`[GAMEWATCHER] RSS fetch failed for ${url}: ${e.message}`);
    return [];
  }
}

// Escape regex-special chars in dynamic parts. Current callers pass hard-coded
// tag/attr names, but escaping defends against a future refactor that forwards
// user-influenced values into the regex and triggers a malformed pattern.
function _rxEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function _xmlText(block, tag) {
  const t = _rxEscape(tag);
  const m = block.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>`, "i"))
    || block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, "i"));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
}
function _xmlAttr(block, tag, attr) {
  const t = _rxEscape(tag);
  const a = _rxEscape(attr);
  const m = block.match(new RegExp(`<${t}[^>]+${a}="([^"]+)"`, "i"));
  return m ? m[1] : null;
}

// ─── Strip BBCode / HTML for embed text ──────────────────────────────────────

function cleanBody(text, maxLen = 280) {
  if (!text) return "";
  return text
    .replace(/\[url=[^\]]+\]/gi, "").replace(/\[\/url\]/gi, "")
    .replace(/\[img\][^\[]*\[\/img\]/gi, "")
    .replace(/\[b\]|\[\/b\]|\[i\]|\[\/i\]|\[u\]|\[\/u\]|\[h[0-9]\]|\[\/h[0-9]\]/gi, "")
    .replace(/\[list\]|\[\/list\]|\[\*\]/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim()
    .substring(0, maxLen) + (text.length > maxLen ? "…" : "");
}

// ─── Watch CRUD ───────────────────────────────────────────────────────────────

export function getWatches(guildId) {
  const s = getGuildSettings(guildId);
  return Array.isArray(s.game_watches) ? s.game_watches : [];
}

export function addWatch(guildId, { channelId, gameName, steamAppId = null, rssUrl = null, addedBy }) {
  const watches = getWatches(guildId);
  const id = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  watches.push({ id, channelId, gameName, steamAppId, rssUrl, addedBy, addedAt: Date.now(), seenGids: [] });
  setGuildSetting(guildId, "game_watches", watches);
  log(`[GAMEWATCHER] Added watch "${gameName}" (${steamAppId ?? rssUrl}) in guild ${guildId}`);
  return id;
}

export function removeWatch(guildId, watchId) {
  const watches = getWatches(guildId);
  const idx = watches.findIndex(w => w.id === watchId);
  if (idx === -1) return false;
  watches.splice(idx, 1);
  setGuildSetting(guildId, "game_watches", watches);
  return true;
}

// ─── Build Discord embed for an update ───────────────────────────────────────

function buildEmbed(watch, article) {
  const body = cleanBody(article.contents);
  const embed = new EmbedBuilder()
    .setColor(0x1b2838) // Steam dark blue
    .setAuthor({ name: `📋 ${watch.gameName} — Update` })
    .setTitle(article.title.substring(0, 256))
    .setTimestamp(article.date ? new Date(article.date * 1000) : new Date());

  if (article.url) embed.setURL(article.url);
  if (body) embed.setDescription(body);
  if (watch.steamAppId) embed.setThumbnail(STEAM_HEADER_IMG(watch.steamAppId));

  embed.setFooter({ text: watch.steamAppId ? "Steam" : "RSS Feed" });
  return embed;
}

// ─── Core polling function ────────────────────────────────────────────────────

export async function pollAllWatches(client) {
  const guilds = [...client.guilds.cache.values()];
  let posted = 0;

  for (const guild of guilds) {
    const watches = getWatches(guild.id);
    if (!watches.length) continue;

    for (const watch of watches) {
      try {
        // Fetch articles from the right source
        let articles = [];
        if (watch.steamAppId) {
          articles = await fetchSteamNews(watch.steamAppId);
          // Filter to patch-note-relevant feeds/titles only
          articles = articles.filter(a =>
            RELEVANT_FEEDS.has(a.feedname?.toLowerCase()) ||
            RELEVANT_TITLE_RX.test(a.title)
          );
        } else if (watch.rssUrl) {
          articles = await fetchRSS(watch.rssUrl);
        }

        if (!articles.length) continue;

        // Find articles we haven't posted yet
        const seenGids = new Set(watch.seenGids ?? []);
        const newArticles = articles.filter(a => !seenGids.has(String(a.gid)));
        if (!newArticles.length) continue;

        // Fetch the channel
        const channel = guild.channels.cache.get(watch.channelId)
          ?? await guild.channels.fetch(watch.channelId).catch(() => null);
        if (!channel?.isTextBased()) continue;

        // Post newest-first (articles come newest first from Steam)
        const toPost = newArticles.slice(0, 3); // cap at 3 per poll to avoid spam
        for (const article of toPost.reverse()) { // oldest first so they read in order
          const embed = buildEmbed(watch, article);
          await channel.send({ embeds: [embed] });
          posted++;
        }

        // Update seenGids — keep last 50 to avoid unbounded growth.
        // Prioritize the NEW article IDs (we definitely don't want to re-post
        // them) and only then backfill with the most recent prior seen IDs.
        // The old code prepended all prior IDs then sliced, which could drop
        // recent new IDs if many articles arrived in one poll.
        const newIds = newArticles.map((a) => String(a.gid));
        const priorRoom = Math.max(0, 50 - newIds.length);
        const priorKeep = [...seenGids].slice(-priorRoom);
        watch.seenGids = [...priorKeep, ...newIds];

      } catch (e) {
        log(`[GAMEWATCHER] Poll error for watch ${watch.id} (${watch.gameName}): ${e.message}`);
      }
    }

    // Persist updated seenGids back if anything changed
    if (watches.some(w => w.seenGids?.length)) {
      setGuildSetting(guild.id, "game_watches", watches);
    }
  }

  if (posted) log(`[GAMEWATCHER] Poll complete — posted ${posted} update(s)`);
}

// ─── Start polling loop ───────────────────────────────────────────────────────

export function startGameWatcher(client) {
  // Initial poll after 60s (let bot fully settle on startup)
  setTimeout(() => {
    pollAllWatches(client).catch(e => log(`[GAMEWATCHER] Initial poll failed: ${e.message}`));
  }, 60_000);

  setInterval(() => {
    pollAllWatches(client).catch(e => log(`[GAMEWATCHER] Poll failed: ${e.message}`));
  }, POLL_INTERVAL_MS);

  log("[GAMEWATCHER] Started — polling every 10 minutes");
}
