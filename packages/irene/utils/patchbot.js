// ─── Patch Bot — Game News, Patch Notes & Driver Updates ─────────────────────
// Supports both RSS feeds AND direct page scraping (for sites without RSS).
// Valorant + League use Riot's actual patch note pages with version detection.

import Parser from "rss-parser";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getPatchFeeds, setPatchFeeds, getPatchLastSeen, setPatchLastSeen } from "../database.js";
import { log } from "./logger.js";
import { safeFetch, validateUrlAsync } from "@defnotean/shared/safeFetch";

const parser = new Parser();
const PAGE_MAX_BYTES = 2_000_000;
const FEED_MAX_BYTES = 1_000_000;

export async function validatePatchFeedUrl(url) {
  await validateUrlAsync(url);
  return String(url).trim();
}

async function fetchText(url, { maxBytes = PAGE_MAX_BYTES } = {}) {
  const res = await safeFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    timeoutMs: 10_000,
    maxBytes,
  });
  return res.ok ? res.text : null;
}

async function parseFeedUrl(url) {
  await validatePatchFeedUrl(url);
  const xml = await fetchText(url, { maxBytes: FEED_MAX_BYTES });
  if (!xml || !/<(?:rss|feed|item|entry)[\s>]/i.test(xml)) return { items: [] };
  return parser.parseString(xml);
}

// ─── Known Feeds Library ─────────────────────────────────────────────────────

export const KNOWN_FEEDS = {
  "valorant":  { name: "Valorant",            type: "riot", listingUrl: "https://playvalorant.com/en-us/news/game-updates/", origin: "https://playvalorant.com", color: 0xFF4655, icon: "https://cdn2.steamgriddb.com/icon/f0e52b27a7a5d6a8a19d355e6e5aac78/32/256x256.png", emoji: "🎯" },
  "league":    { name: "League of Legends",   type: "rss",  url: "https://antosik-lol-rss.s3.eu-central-1.amazonaws.com/v4/lol/na/news.en-US.xml", color: 0xC8AA6E, icon: "https://cdn2.steamgriddb.com/icon/c399862d3b9d6b76c8436e924a68c45b/32/256x256.png", emoji: "⚔️" },
  "fortnite":  { name: "Fortnite",            type: "rss",  url: "https://fortnite.com/news/rss",                                                  color: 0x00A0E4, emoji: "🏗️" },
  "minecraft": { name: "Minecraft",           type: "rss",  url: "https://www.minecraft.net/en-us/feeds/community-content/rss",                     color: 0x5D8731, emoji: "⛏️" },
  "apex":      { name: "Apex Legends",        type: "rss",  url: "https://dotesports.com/apex-legends/feed",                                        color: 0xCD3333, emoji: "🔫" },
  "overwatch": { name: "Overwatch 2",         type: "rss",  url: "https://dotesports.com/overwatch/feed",                                           color: 0xFA9C1E, emoji: "🛡️" },
  "csgo":      { name: "Counter-Strike 2",    type: "cs2",  listingUrl: "https://www.counter-strike.net/news/updates", origin: "https://www.counter-strike.net", color: 0xDE9B35, emoji: "💣" },
  "cs2":       { name: "Counter-Strike 2",    type: "cs2",  listingUrl: "https://www.counter-strike.net/news/updates", origin: "https://www.counter-strike.net", color: 0xDE9B35, emoji: "💣" },
  "nvidia":    { name: "NVIDIA",              type: "rss",  url: "https://www.nvidia.com/en-us/geforce/news/rss/",                                  color: 0x76B900, icon: "https://cdn2.steamgriddb.com/icon/f7177163c833dff4b38fc8d2872f1ec6/32/256x256.png", emoji: "🟢" },
  "amd":       { name: "AMD",                 type: "rss",  url: "https://community.amd.com/t5/gaming/bg-p/AMD-Gaming/rss-board",                   color: 0xED1C24, emoji: "🔴" },
  "gaming":    { name: "PC Gaming",           type: "rss",  url: "https://dotesports.com/feed",                                                     color: 0x5865F2, emoji: "🎮" },
};

// ─── Page scraper — extract og tags + content from any URL ──────────────────

async function scrapePage(url) {
  try {
    const html = await fetchText(url);
    if (!html) return null;

    const get = (prop) =>
      html.match(new RegExp(`<meta\\s+(?:property|name)="${prop}"\\s+content="([^"]+)"`, "i"))?.[1]
      ?? html.match(new RegExp(`<meta\\s+content="([^"]+)"\\s+(?:property|name)="${prop}"`, "i"))?.[1]
      ?? null;

    // Extract TL;DR bullet points if present (Valorant format)
    const tldrMatch = html.match(/TL;DR:?\s*<\/\w+>([\s\S]*?)(?:<hr|<\/article|GL HF)/i);
    let bullets = [];
    if (tldrMatch) {
      const listHtml = tldrMatch[1];
      const lis = [...listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
      bullets = lis.map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 8);
    }

    return {
      title: get("og:title"),
      description: get("og:description"),
      image: get("og:image"),
      url: get("og:url") || url,
      bullets,
    };
  } catch {
    return null;
  }
}

// ─── Riot Game Updates — smart listing page scraper ──────────────────────────
// Fetches the game-updates listing page, parses __NEXT_DATA__ JSON embedded
// in the HTML. Gets all articles with titles, URLs, banner images, dates.
// No brute-forcing — works for any version numbering scheme.

async function fetchRiotPatchNotes(listingUrl, baseOrigin) {
  try {
    const html = await fetchText(listingUrl);
    if (!html) return [];

    const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i);
    if (!match) return [];

    let data;
    try {
      data = JSON.parse(match[1]);
    } catch { return []; }
    const blades = data?.props?.pageProps?.page?.blades ?? [];
    const grid = blades.find((b) => b.type === "articleCardGrid");
    if (!grid?.items?.length) return [];

    // Return ALL patch-note articles (filtered by title containing "patch notes")
    return grid.items
      .filter((item) => item.title?.toLowerCase().includes("patch notes"))
      .map((item) => {
        let description = "";
        if (item.description) {
          if (typeof item.description === "string") description = item.description;
          else if (item.description.text) description = item.description.text;
          else if (Array.isArray(item.description)) description = item.description.map((d) => d.text || "").join(" ");
        }
        return {
          title: item.title,
          url: (() => { const path = item.action?.payload?.url; return path ? `${baseOrigin}${path.startsWith("/") ? "" : "/"}${path}` : null; })(),
          image: item.media?.url ?? null,
          description: description.slice(0, 250),
          pubDate: item.publishedAt ?? null,
        };
      });
  } catch (err) {
    log(`[PatchBot] Riot scraper error: ${err?.message ?? err}`);
    return null;
  }
}

// ─── CS2 updates page scraper ────────────────────────────────────────────────
// counter-strike.net/news/updates has ALL updates on one page, no individual URLs.
// We parse the page text to extract each update block.

async function fetchCS2Updates(url) {
  try {
    const text = await fetchText(url);
    if (!text) return [];

    // The page has updates in a pattern: date heading + "Counter-Strike 2 Update" + bullet sections
    // Split by date pattern like "March 18, 2026" or "January 21, 2026"
    const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/g;
    const dates = [...text.matchAll(datePattern)].map((m) => ({ date: m[0], index: m.index }));

    const updates = [];
    for (let i = 0; i < dates.length; i++) {
      const start = dates[i].index + dates[i].date.length;
      const end = dates[i + 1]?.index ?? text.length;
      const block = text.slice(start, end).trim();

      // Extract the title (usually "Counter-Strike 2 Update")
      const titleMatch = block.match(/^(Counter-Strike 2 Update)/i);
      const title = titleMatch ? `${titleMatch[1]} — ${dates[i].date}` : `CS2 Update — ${dates[i].date}`;

      // Extract section headers like [GAMEPLAY], [MAPS], [MISC]
      const sections = [...block.matchAll(/\[\s*([A-Z\s]+)\s*\]/g)].map((m) => m[1].trim());

      // Extract bullet points (lines that look like content)
      const lines = block.split(/\n/).map((l) => l.trim()).filter((l) =>
        l.length > 10 && !l.match(/^Counter-Strike/) && !l.match(/^\[/)
      );
      const bullets = lines.slice(0, 8);

      updates.push({
        title,
        date: dates[i].date,
        pubDate: new Date(dates[i].date).toISOString(),
        url: `${url}`,
        image: null, // CS2 updates page doesn't have per-update images
        description: sections.length ? `Sections: ${sections.join(", ")}` : "",
        bullets,
      });
    }

    return updates;
  } catch (err) {
    log(`[PatchBot] CS2 scraper error: ${err?.message ?? err}`);
    return [];
  }
}

// ─── Build beautiful patch embed ─────────────────────────────────────────────

function buildPatchEmbed(data, feedName, feedColor, feedMeta) {
  const emoji = feedMeta?.emoji ?? "📰";

  const embed = new EmbedBuilder()
    .setColor(feedColor ?? 0x5865F2)
    .setAuthor({ name: feedName, iconURL: feedMeta?.icon ?? undefined })
    .setTitle(`${emoji}  ${data.title || "New Update"}`)
    .setURL(data.url || undefined);

  // Description — prefer TL;DR bullets, fallback to og:description
  if (data.bullets?.length) {
    const bulletText = data.bullets.map((b) => `> • ${b}`).join("\n");
    embed.setDescription(`**TL;DR**\n${bulletText}`);
  } else if (data.description) {
    const desc = data.description.length > 250 ? data.description.slice(0, 250) + "..." : data.description;
    embed.setDescription(desc);
  }

  // Big banner image — the key visual
  if (data.image) embed.setImage(data.image);

  // Published date
  if (data.pubDate) {
    const ts = Math.floor(new Date(data.pubDate).getTime() / 1000);
    embed.addFields({ name: "📅 Published", value: `<t:${ts}:f> (<t:${ts}:R>)`, inline: false });
  }

  embed.setFooter({ text: `${feedName} • Patch Notes`, iconURL: feedMeta?.icon ?? undefined });
  embed.setTimestamp();

  const components = [];
  if (data.url) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Read Full Patch Notes").setStyle(ButtonStyle.Link).setURL(data.url).setEmoji("📖"),
    ));
  }

  return { embed, components };
}

// ─── Fetch post by index (for test_patch_news tool) ─────────────────────────
// offset=0 → latest, offset=1 → one before that, offset=2 → two before, etc.
// search → find by text in title (e.g. "12.03")

/**
 * @param {string} feedUrl
 * @param {string} feedName
 * @param {number} feedColor
 * @param {{ offset?: number, search?: string|null }} [opts]
 */
export async function fetchLatestPost(feedUrl, feedName, feedColor, { offset = 0, search = null } = {}) {
  const meta = Object.values(KNOWN_FEEDS).find((f) => (f.url ?? f.listingUrl) === feedUrl || f.name === feedName);

  // Riot-type: smart scraper — gets all patch notes from listing page
  if (meta?.type === "riot") {
    const listingUrl = meta.listingUrl ?? feedUrl;
    const origin = meta.origin ?? "https://playvalorant.com";
    const allPatches = await fetchRiotPatchNotes(listingUrl, origin);
    if (!allPatches.length) return null;

    // Pick by search term or offset
    let article;
    if (search) {
      const lower = search.toLowerCase();
      article = allPatches.find((a) => a.title?.toLowerCase().includes(lower));
      if (!article) return { notFound: true, available: allPatches.map((a) => a.title) };
    } else {
      if (offset >= allPatches.length) return { notFound: true, available: allPatches.map((a) => a.title) };
      article = allPatches[offset];
    }

    // Scrape article page for TL;DR bullets
    if (article.url) {
      const pageData = await scrapePage(article.url);
      if (pageData?.bullets?.length) article.bullets = pageData.bullets;
      if (pageData?.description && !article.description) article.description = pageData.description;
      if (pageData?.image && !article.image) article.image = pageData.image;
    }

    const { embed, components } = buildPatchEmbed(article, feedName, feedColor, meta);
    return { embed, components, title: article.title, link: article.url };
  }

  // CS2-type: scrape counter-strike.net/news/updates
  if (meta?.type === "cs2") {
    const allUpdates = await fetchCS2Updates(meta.listingUrl);
    if (!allUpdates.length) return null;

    let article;
    if (search) {
      const lower = search.toLowerCase();
      article = allUpdates.find((a) => a.title?.toLowerCase().includes(lower) || a.date?.toLowerCase().includes(lower) || a.bullets?.some((b) => b.toLowerCase().includes(lower)));
      if (!article) return { notFound: true, available: allUpdates.slice(0, 8).map((a) => a.title) };
    } else {
      if (offset >= allUpdates.length) return { notFound: true, available: allUpdates.slice(0, 8).map((a) => a.title) };
      article = allUpdates[offset];
    }

    const { embed, components } = buildPatchEmbed(article, feedName, feedColor, meta);
    return { embed, components, title: article.title, link: article.url };
  }

  // RSS-type: parse feed
  const parsed = await parseFeedUrl(feedUrl);
  if (!parsed.items?.length) return null;

  let item;
  if (search) {
    const lower = search.toLowerCase();
    item = parsed.items.find((i) => i.title?.toLowerCase().includes(lower));
    if (!item) return { notFound: true, available: parsed.items.slice(0, 10).map((i) => i.title) };
  } else {
    if (offset >= parsed.items.length) return { notFound: true, available: parsed.items.slice(0, 10).map((i) => i.title) };
    item = parsed.items[offset];
  }
  if (!item) return null;

  // Scrape the actual article page for banner image + better description
  const scraped = await scrapePage(item.link);

  const data = {
    title: scraped?.title || item.title || "Update",
    description: scraped?.description || (item.contentSnippet || item.content || "").replace(/<[^>]+>/g, "").trim(),
    image: scraped?.image || item.enclosure?.url || item["media:content"]?.$.url || null,
    url: item.link,
    pubDate: item.pubDate,
    bullets: scraped?.bullets || [],
  };

  const { embed, components } = buildPatchEmbed(data, feedName, feedColor, meta);
  return { embed, components, title: data.title, link: data.url };
}

// ─── Tracking — persisted in database so it survives restarts ────────────────
// No more in-memory _lastPostIds — uses getPatchLastSeen/setPatchLastSeen

// ─── Feed Checker (runs every 15 min) ───────────────────────────────────────

export async function checkFeeds(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = getPatchFeeds(guild.id);
    if (!config.channel_id || !config.feeds?.length) continue;

    const channel = guild.channels.cache.get(config.channel_id);
    if (!channel) continue;

    await Promise.allSettled(
      config.feeds.map(async (feed) => {
        try {
          // Resolve feed metadata in case the database doesn't store the .type (defaults to "rss" if unknown)
          const feedMeta = Object.values(KNOWN_FEEDS).find((f) => f.name === feed.name || f.url === feed.url || f.listingUrl === feed.url);
          const feedType = feedMeta?.type || feed.type || "rss";

          // Riot-type: smart listing page check
          if (feedType === "riot") {
            const listingUrl = feedMeta?.listingUrl || feed.url;
            const origin = feedMeta?.origin ?? "https://playvalorant.com";
            if (!listingUrl) return;

            const allPatches = await fetchRiotPatchNotes(listingUrl, origin);
            const article = allPatches[0];
            if (!article?.url) return;

            const feedKey = `riot:${feed.name}`;
            const lastSeen = getPatchLastSeen(guild.id);
            if (lastSeen[feedKey] === article.url) return; // already posted
            setPatchLastSeen(guild.id, feedKey, article.url);

            // Scrape article for TL;DR bullets
            const pageData = await scrapePage(article.url);
            if (pageData?.bullets?.length) article.bullets = pageData.bullets;

            const { embed, components } = buildPatchEmbed(article, feed.name, feed.color, feedMeta);
            const patchPingIds = feed.ping_role_ids ?? config.ping_role_ids ?? [];
            const patchPingContent = patchPingIds.map((id) => `<@&${id}>`).join(" ");
            await channel.send({ content: patchPingContent || undefined, embeds: [embed], components }).catch((e) => log(`[PatchBot] Send error: ${e.message}`));
            log(`[PatchBot] New ${feed.name} patch: ${article.title}`);
            return;
          }

          // CS2-type: scrape updates page
          if (feedType === "cs2") {
            const feedMeta = Object.values(KNOWN_FEEDS).find((f) => f.name === feed.name);
            if (!feedMeta?.listingUrl) return;

            const allUpdates = await fetchCS2Updates(feedMeta.listingUrl);
            if (!allUpdates.length) return;

            const latest = allUpdates[0];
            const feedKey = `cs2:${feed.name}`;
            const lastSeen = getPatchLastSeen(guild.id);
            if (lastSeen[feedKey] === latest.title) return;
            setPatchLastSeen(guild.id, feedKey, latest.title);

            const { embed, components } = buildPatchEmbed(latest, feed.name, feed.color, feedMeta);
            const cs2PingIds = feed.ping_role_ids ?? config.ping_role_ids ?? [];
            const cs2PingContent = cs2PingIds.map((id) => `<@&${id}>`).join(" ");
            await channel.send({ content: cs2PingContent || undefined, embeds: [embed], components }).catch((e) => log(`[PatchBot] Send error: ${e.message}`));
            log(`[PatchBot] New CS2 update: ${latest.title}`);
            return;
          }

          // RSS feeds
          if (!feed.url) return;
          const parsed = await parseFeedUrl(feed.url);
          if (!parsed.items?.length) return;

          const latest = parsed.items[0];
          const postId = latest.guid || latest.link || latest.title;
          const feedKey = `rss:${feed.url}`;
          const lastSeen = getPatchLastSeen(guild.id);
          if (lastSeen[feedKey] === postId) return;
          setPatchLastSeen(guild.id, feedKey, postId);

          const scraped = await scrapePage(latest.link);
          const data = {
            title: scraped?.title || latest.title,
            description: scraped?.description || (latest.contentSnippet || "").replace(/<[^>]+>/g, "").trim(),
            image: scraped?.image || latest.enclosure?.url || null,
            url: latest.link,
            pubDate: latest.pubDate,
            bullets: scraped?.bullets || [],
          };

          const meta = Object.values(KNOWN_FEEDS).find((f) => f.url === feed.url);
          const { embed, components } = buildPatchEmbed(data, feed.name, feed.color, meta);

          const rssPingIds = feed.ping_role_ids ?? config.ping_role_ids ?? [];
          const rssPingContent = rssPingIds.map((id) => `<@&${id}>`).join(" ");
          await channel.send({ content: rssPingContent || undefined, embeds: [embed], components }).catch((e) => log(`[PatchBot] Send error: ${e.message}`));
          log(`[PatchBot] New post: ${data.title}`);
        } catch (err) {
          log(`[PatchBot] Error "${feed.name}" in ${guild.name}: ${err?.message ?? err}`);
        }
      })
    );
  }
}
