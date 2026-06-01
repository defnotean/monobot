const DEFAULT_BASE_URL = "http://localhost";

/**
 * @param {string | undefined | null} baseUrl
 * @returns {URL}
 */
function safeBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl || DEFAULT_BASE_URL);
  } catch {
    return new URL(DEFAULT_BASE_URL);
  }
}

/**
 * Parse Node's IncomingMessage.url without letting malformed absolute-form
 * request targets escape the HTTP handler.
 *
 * Most clients send origin-form paths (`/api/health`). Proxies and fuzzers can
 * send absolute-form targets (`http://host/path`), and malformed variants make
 * `new URL(req.url, base)` throw. HTTP routes should degrade to the root path,
 * not crash the bot process.
 *
 * @param {string | undefined | null} rawUrl
 * @param {string} [baseUrl]
 * @returns {URL}
 */
export function parseRequestUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  const base = safeBaseUrl(baseUrl);
  const input = typeof rawUrl === "string" && rawUrl.length > 0 ? rawUrl : "/";
  try {
    if (input.startsWith("/")) return new URL(`${base.origin}${input}`);
    return new URL(input, base);
  } catch {
    return new URL("/", base);
  }
}

/**
 * Collapse duplicate slashes in the path component only. Query strings are left
 * untouched so values like `https://example.com//asset` are not corrupted.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function normalizeRequestPathname(pathname) {
  const normalized = String(pathname || "/").replace(/\/{2,}/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
