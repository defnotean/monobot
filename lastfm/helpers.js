// ─── Last.fm shared helpers ───────────────────────────────────────────────────

// ─── Time periods ─────────────────────────────────────────────────────────────

export const PERIODS = {
  "7d":  { api: "7day",    label: "Last 7 Days",    emoji: "📅" },
  "1m":  { api: "1month",  label: "Last Month",      emoji: "📆" },
  "3m":  { api: "3month",  label: "Last 3 Months",   emoji: "📆" },
  "6m":  { api: "6month",  label: "Last 6 Months",   emoji: "📆" },
  "1y":  { api: "12month", label: "Last Year",        emoji: "🗓️" },
  "all": { api: "overall", label: "All Time",         emoji: "🌐" },
};

export const PERIOD_CHOICES = Object.entries(PERIODS).map(([value, { label }]) => ({
  name: label,
  value,
}));

export function periodApi(period)   { return PERIODS[period]?.api   || "overall"; }
export function periodLabel(period) { return PERIODS[period]?.label || "All Time"; }

// ─── Formatting ───────────────────────────────────────────────────────────────

export function fmtPlays(n) {
  const num = parseInt(n) || 0;
  return `${num.toLocaleString()} ${num === 1 ? "play" : "plays"}`;
}

export function fmtNum(n) {
  return (parseInt(n) || 0).toLocaleString();
}

export function truncate(str, max = 32) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ─── Last.fm image extraction ─────────────────────────────────────────────────
// Last.fm returns an array of { size, #text } objects.
// The placeholder hash indicates "no image" — skip those.

const FM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

export function getImage(images, preferSize = "extralarge") {
  if (!images || !Array.isArray(images)) return null;
  const order = ["extralarge", "large", "medium", "small"];
  const idx = order.indexOf(preferSize);
  const priority = idx >= 0
    ? [...order.slice(idx), ...order.slice(0, idx)]
    : order;

  for (const size of priority) {
    const entry = images.find(i => i.size === size);
    const url = entry?.["#text"];
    if (url && !url.includes(FM_PLACEHOLDER)) return url;
  }
  return null;
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

export function userUrl(username)         { return `https://www.last.fm/user/${encodeURIComponent(username)}`; }
export function artistUrl(artist)         { return `https://www.last.fm/music/${encodeURIComponent(artist)}`; }
export function albumUrl(artist, album)   { return `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`; }
export function trackUrl(artist, track)   { return `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(track)}`; }

// ─── Relative time ────────────────────────────────────────────────────────────

export function relativeTime(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - parseInt(unixTs);
  if (diff < 60)       return "just now";
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000)  return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

// ─── Ordinal ──────────────────────────────────────────────────────────────────

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Strip HTML from Last.fm bios ─────────────────────────────────────────────

export function stripHtml(str) {
  if (!str) return "";
  return str
    .replace(/<a [^>]+>([^<]+)<\/a>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

// ─── Shared embed color ───────────────────────────────────────────────────────

export const FM_COLOR = 0xD51007; // Last.fm red
