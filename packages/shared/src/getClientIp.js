/**
 * @file getClientIp.js
 * @module @defnotean/shared/getClientIp
 *
 * @description
 * Resolve the best-effort client IP for Node HTTP requests.
 *
 * Direct deployments must not trust `X-Forwarded-For`: a client can send any
 * value it likes and forge a unique rate-limit identity per request. Proxy
 * headers are trusted only when explicitly enabled or when Render's platform
 * environment is detected.
 *
 * In a trusted-proxy context, Render and most proxies record the originating
 * client as the leftmost entry and append each subsequent hop to the right:
 *
 *     X-Forwarded-For: <client>, <proxy1>, <proxy2>
 *
 * We still avoid the attacker-controlled leftmost values and use the rightmost
 * non-empty hop, which is the address the closest trusted proxy observed. This
 * fails closed toward grouping traffic by a nearer proxy instead of letting an
 * attacker mint unlimited buckets.
 *
 * Set MONOBOT_TRUST_PROXY_HEADERS=true (or TRUST_PROXY_HEADERS=true) to trust
 * proxy headers outside Render. Set it to false to force direct socket
 * identity.
 *
 * @summary Key exports
 *  - {@link getClientIp} - `(req, options?) => string` best-effort client IP.
 */

/**
 * Return the best-effort real client IP for rate-limiting / logging.
 *
 * Defaults to `req.socket.remoteAddress` for direct/local connections. Uses the
 * rightmost `X-Forwarded-For` hop only behind a trusted proxy.
 *
 * Always returns a non-empty string so callers can use it as a Map key without
 * extra guards; "unknown" is returned only when nothing is available.
 *
 * @param {import("http").IncomingMessage} req
 * @param {{ trustProxy?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function getClientIp(req, options = {}) {
  const socketIp = req?.socket?.remoteAddress || "unknown";
  if (!shouldTrustProxyHeaders(options)) return socketIp;

  const xff = req?.headers?.["x-forwarded-for"];
  if (xff) {
    // Header may be a comma-joined string or (rarely) an array of values.
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    const hops = raw.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) {
      // Rightmost hop = the IP the closest trusted proxy actually saw.
      return hops[hops.length - 1];
    }
  }

  return socketIp;
}

/**
 * @param {{ trustProxy?: boolean, env?: NodeJS.ProcessEnv }} options
 * @returns {boolean}
 */
function shouldTrustProxyHeaders(options) {
  if (typeof options.trustProxy === "boolean") return options.trustProxy;

  const env = options.env || process.env;
  const explicitTrust =
    readEnvBoolean(env.MONOBOT_TRUST_PROXY_HEADERS) ??
    readEnvBoolean(env.TRUST_PROXY_HEADERS);
  if (typeof explicitTrust === "boolean") return explicitTrust;

  return env.RENDER === "true" && (
    env.RENDER_SERVICE_TYPE === "web" ||
    Boolean(env.RENDER_EXTERNAL_URL) ||
    Boolean(env.RENDER_EXTERNAL_HOSTNAME)
  );
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function readEnvBoolean(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}
