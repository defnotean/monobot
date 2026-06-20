import { safeFetch as defaultSafeFetch } from "../safeFetch.js";

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);
const SHORT_TIKTOK_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const DEFAULT_MIRROR_HOST = "www.vxtiktok.com";
const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; monobot/1.0; +https://github.com/defnotean/monobot)",
};

/** @param {string} raw */
function cleanUrlCandidate(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^<+/, "").replace(/>+$/, "");
  while (/[)\].,!?:;'"`]+$/.test(text)) text = text.slice(0, -1);
  return text;
}

/** @param {string} rawUrl */
export function isTikTokUrl(rawUrl) {
  try {
    const url = new URL(cleanUrlCandidate(rawUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return TIKTOK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** @param {string} text @param {{ max?: number }} [options] */
export function extractTikTokUrls(text, { max = 3 } = {}) {
  const seen = new Set();
  const urls = [];
  for (const match of String(text || "").matchAll(URL_RE)) {
    const url = cleanUrlCandidate(match[0]);
    if (!isTikTokUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= max) break;
  }
  return urls;
}

/** @param {string} rawUrl @param {{ mirrorHost?: string }} [options] */
export function toTikTokEmbedFixUrl(rawUrl, { mirrorHost = DEFAULT_MIRROR_HOST } = {}) {
  const url = new URL(cleanUrlCandidate(rawUrl));
  url.protocol = "https:";
  url.hostname = mirrorHost;
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString();
}

/** @param {string} rawUrl @param {{ safeFetch?: typeof defaultSafeFetch, timeoutMs?: number, maxRedirects?: number }} [options] */
export async function resolveTikTokUrl(rawUrl, {
  safeFetch = defaultSafeFetch,
  timeoutMs = 5_000,
  maxRedirects = 6,
} = {}) {
  const cleanUrl = cleanUrlCandidate(rawUrl);
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return cleanUrl;
  }
  const host = parsed.hostname.toLowerCase();
  const shouldResolve = SHORT_TIKTOK_HOSTS.has(host) || parsed.pathname.startsWith("/t/");
  if (!shouldResolve || typeof safeFetch !== "function") return cleanUrl;

  const fetchOptions = {
    method: "HEAD",
    maxBytes: 0,
    timeoutMs,
    maxRedirects,
    headers: REQUEST_HEADERS,
  };
  try {
    const res = await safeFetch(cleanUrl, fetchOptions);
    if (res?.url && isTikTokUrl(res.url)) return res.url;
  } catch {
    try {
      const res = await safeFetch(cleanUrl, { ...fetchOptions, method: "GET", maxBytes: 2048 });
      if (res?.url && isTikTokUrl(res.url)) return res.url;
    } catch {
      // Fall through to the original short URL; the mirror may still resolve it.
    }
  }
  return cleanUrl;
}

/** @param {string[]} urls @param {{ safeFetch?: typeof defaultSafeFetch, mirrorHost?: string }} [options] */
export async function buildTikTokFixLinks(urls, options = {}) {
  const fixed = [];
  const seen = new Set();
  for (const url of urls) {
    const resolved = await resolveTikTokUrl(url, options);
    if (!isTikTokUrl(resolved)) continue;
    const fixUrl = toTikTokEmbedFixUrl(resolved, options);
    if (seen.has(fixUrl)) continue;
    seen.add(fixUrl);
    fixed.push(fixUrl);
  }
  return fixed;
}

/** @param {string} text @param {{ safeFetch?: typeof defaultSafeFetch, mirrorHost?: string, max?: number }} [options] */
export async function buildTikTokFixReply(text, options = {}) {
  const urls = extractTikTokUrls(text, { max: options.max ?? 3 });
  if (!urls.length) return null;
  const fixed = await buildTikTokFixLinks(urls, options);
  if (!fixed.length) return null;
  const label = fixed.length === 1 ? "fixed tiktok embed" : "fixed tiktok embeds";
  return {
    content: `${label}:\n${fixed.join("\n")}`,
    allowedMentions: { parse: [] },
  };
}
