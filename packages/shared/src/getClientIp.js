/**
 * @file getClientIp.js
 * @module @defnotean/shared/getClientIp
 *
 * @description
 * Resolve the real client IP for a Node `http` request, accounting for Render's
 * reverse proxy. On Render every request reaches our process through the
 * platform's load balancer, so `req.socket.remoteAddress` is ALWAYS the proxy's
 * address — using it as a rate-limit key collapses every visitor into a single
 * bucket, so one abuser can exhaust the limit for everyone (or one heavy legit
 * client can lock everyone out).
 *
 * Render (and most proxies) record the originating client as the LEFTMOST entry
 * of `X-Forwarded-For`, appending each subsequent hop to the right:
 *
 *     X-Forwarded-For: <client>, <proxy1>, <proxy2>
 *
 * We do NOT trust the leftmost value: it's fully attacker-controlled (a client
 * can send any `X-Forwarded-For` it likes, and the proxy only appends). Trusting
 * it would let an attacker forge a unique IP per request and sail past per-IP
 * limits. Instead we take the RIGHTMOST entry, which is the address the closest
 * trusted proxy actually observed and prepended-to. With a single proxy hop in
 * front of us (Render's topology) that rightmost entry IS the genuine client IP.
 *
 * Trade-off: if there were additional trusted proxies between Render's edge and
 * the client, the rightmost entry would be an intermediate proxy rather than the
 * end client, and all clients behind that proxy would share a bucket. That is
 * the safe failure mode (over-grouping) versus trusting the leftmost value
 * (which gives an attacker unlimited distinct buckets). Render fronts us with a
 * single hop, so in practice rightmost == real client.
 *
 * When `X-Forwarded-For` is absent we're on a direct/local connection (no
 * proxy), so `req.socket.remoteAddress` is the genuine peer.
 *
 * @summary Key exports
 *  - {@link getClientIp} — `(req) => string` best-effort client IP for keying.
 */

/**
 * Return the best-effort real client IP for rate-limiting / logging.
 *
 * Prefers the rightmost entry of `X-Forwarded-For` (the address the nearest
 * trusted proxy observed — Render sets this), falling back to
 * `req.socket.remoteAddress` for direct/local connections.
 *
 * Always returns a non-empty string so callers can use it as a Map key without
 * extra guards; "unknown" is returned only when nothing is available.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
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
  return req?.socket?.remoteAddress || "unknown";
}
