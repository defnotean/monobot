/**
 * @file packages/shared/src/twinSign.js
 *
 * HMAC-SHA256 request signing and verification for the twin-bot REST channel
 * that connects Eris and Irene. Both bots import this exact module from the
 * shared workspace package so the signing and verification halves cannot drift.
 *
 * ## Wire protocol
 *   X-Twin-Timestamp:  <unix_ms_at_signing_time>
 *   X-Twin-Signature:  hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 *
 * The signed payload is `${timestamp}.${rawBody}` — concatenating the
 * timestamp binds the signature to a single moment so a captured signature
 * cannot be reused later with the same body.
 *
 * ## Exports
 * - `signTwinRequest(body, secret, now?)` — builds the two header values the
 *   client must attach to its outgoing HTTP request.
 * - `verifyTwinRequest(headers, body, secret, now?)` — verifies an incoming
 *   request. Returns a discriminated `{ok: true} | {ok: false, reason}` so the
 *   caller can log the failure mode without leaking it to the network peer.
 * - `safeStringEqual(a, b)` — constant-time string compare for unrelated
 *   secret/token comparisons (e.g. legacy bearer tokens still in use during
 *   rollout).
 * - `TWIN_MAX_SKEW_MS` — exported window size (60s) so callers can match it
 *   in tests or surface the rule in error messages.
 * - `_REPLAY_CACHE_PRESSURE`, `_resetReplayCacheForTests` — test-only hooks
 *   (underscore-prefixed) so the test suite can simulate flood pressure and
 *   reset cache state between cases without reaching into module internals.
 *
 * ## Secret management & rotation
 * The shared secret is read by each bot from the `TWIN_API_SECRET` environment
 * variable (set via Render / `.env`, never hardcoded). Rotation procedure:
 *   1. Generate a new high-entropy value (`openssl rand -hex 32`).
 *   2. Update `TWIN_API_SECRET` on BOTH bots in the same deploy window. The
 *      twin link is briefly down while one side is ahead — short downtime is
 *      acceptable; mismatched secrets simply reject with "bad signature".
 *   3. Confirm both sides healthy via the dashboard / presence endpoints.
 * The module refuses to sign or verify with an empty secret (fail-loud).
 *
 * ## Replay protection
 * Two layers:
 *   - Timestamp window: requests with `|now - ts| > TWIN_MAX_SKEW_MS` are
 *     rejected. 60 seconds in each direction tolerates clock drift between
 *     hosts but caps the window in which a captured signature is replayable.
 *   - In-memory replay cache: any signature seen previously within the skew
 *     window is rejected as `"replay detected"`. Entries are pruned after
 *     `2 * TWIN_MAX_SKEW_MS` so old sigs cannot recur. Under sustained flood
 *     pressure (`_REPLAY_CACHE_PRESSURE` distinct in-window sigs) the verifier
 *     FAILS LOUD with `"replay-cache-pressure"` rather than evicting earlier
 *     entries — evicting would reopen a replay window for an attacker who
 *     captured a legit sig and then churned the cache.
 *
 * ## Constant-time comparisons
 * Both signature checks (`verifyTwinRequest`) and the public
 * `safeStringEqual` route the final byte compare through Node's
 * `crypto.timingSafeEqual` to prevent attackers from learning the secret one
 * byte at a time via response-time differences. Buffer lengths are equalized
 * before the compare; mismatched lengths return false without timing leak
 * beyond the unavoidable length side-channel.
 *
 * ## What this module does NOT do
 * - No persistent nonce store. The replay cache is in-process memory; on
 *   restart the cache is empty and a signature captured pre-restart could be
 *   replayed until its timestamp ages out of the skew window. The 60s window
 *   bounds this exposure but it is a known limitation — see SECURITY.md audit
 *   findings for the rationale and the conditions that would justify a Redis
 *   or Durable-Object-backed nonce store.
 * - No transport encryption. This module assumes the underlying channel
 *   is HTTPS; raw HTTP would expose body content even though the signature
 *   prevents tampering.
 * - No per-user authentication or authorization. The HMAC only proves
 *   "the caller knows TWIN_API_SECRET". Callers must layer their own
 *   permission checks on top (the dashboard and twin executors do this).
 * - No body parsing. Verification operates on the EXACT raw body string —
 *   any framework middleware that re-serializes JSON before passing it here
 *   will silently break signatures. Capture the raw body upstream.
 *
 * ## Callers (cross-reference)
 *   Eris:
 *     - packages/eris/api/dashboard.js          (dashboard REST endpoints)
 *     - packages/eris/utils/twinState.js        (presence + twin state sync)
 *     - packages/eris/ai/executors/twinExecutor.js (cross-bot AI tool calls)
 *   Irene:
 *     - packages/irene/presence.js              (presence beacon to Eris)
 *     - packages/irene/utils/twinState.js       (presence + twin state sync)
 *     - packages/irene/utils/twinPunish.js      (cross-bot moderation)
 *     - packages/irene/ai/executors/advancedExecutor.js (cross-bot AI calls)
 */

import { createHmac, timingSafeEqual } from "crypto";
import { redactString } from "./logRedact.js";

export const TWIN_MAX_SKEW_MS = 60_000; // 60 seconds each direction
const TWIN_HEADER_TIMESTAMP = "x-twin-timestamp";
const TWIN_HEADER_SIGNATURE = "x-twin-signature";

/**
 * Sign a request body with the shared secret.
 * Returns the headers the client should attach to its HTTP request.
 * @param {string} body  The exact raw body string the server will receive.
 * @param {string} secret  The shared HMAC secret.
 * @param {number} [now]  Override for testing.
 */
export function signTwinRequest(body, secret, now = Date.now()) {
  if (!secret) throw new Error("twin secret missing");
  const ts = String(now);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return {
    [TWIN_HEADER_TIMESTAMP]: ts,
    [TWIN_HEADER_SIGNATURE]: sig,
  };
}

// Replay cache: signature → firstSeenAt. Pruned opportunistically.
//
// Eviction is STRICTLY time-based — we never drop an entry that's still inside
// the skew window, because doing so would let a flooder churn the Map, evict
// a captured legit signature, then replay it. If the cache exceeds the
// pressure threshold AND nothing has aged out, we fail-loud (refuse new
// requests) rather than fail-silent (evict legit sigs).
const _seen = new Map();
// Pressure threshold: refuse new requests once the cache holds this many
// entries that are all still inside the skew window. Picked well above any
// realistic legitimate traffic over a single TWIN_MAX_SKEW_MS window so
// healthy operation never trips it; sustained traffic above this rate means
// either misconfiguration or attack, both of which warrant fail-loud.
export const _REPLAY_CACHE_PRESSURE = 10_000;
let _lastPressureWarnAt = 0;

/** @param {number} now */
function _pruneReplay(now) {
  // Always drop aged-out entries (older than 2× skew window).
  for (const [sig, ts] of _seen) {
    if (now - ts > TWIN_MAX_SKEW_MS * 2) _seen.delete(sig);
  }
}

/**
 * Verify the signature on an incoming request.
 * @param {object} headers  Lowercased header map (Node's req.headers works directly).
 * @param {string} body     Exact raw body as received.
 * @param {string} secret   Shared HMAC secret.
 * @param {number} [now]    Override for testing.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyTwinRequest(headers, body, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: "server missing twin secret" };
  // Normalize — some frameworks give case-preserved headers.
  /** @type {Record<string, any>} */
  const norm = {};
  /** @type {Record<string, any>} */
  const rawHeaders = headers;
  for (const k in rawHeaders) norm[k.toLowerCase()] = rawHeaders[k];
  const ts = norm[TWIN_HEADER_TIMESTAMP];
  const sigRaw = norm[TWIN_HEADER_SIGNATURE];
  if (!ts || !sigRaw) return { ok: false, reason: "missing twin signature headers" };
  if (typeof sigRaw !== "string" || !/^[0-9a-f]{64}$/i.test(sigRaw)) {
    return { ok: false, reason: "malformed signature" };
  }
  const sig = sigRaw.toLowerCase();

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(now - tsNum) > TWIN_MAX_SKEW_MS) {
    return { ok: false, reason: "timestamp outside acceptable skew" };
  }

  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  let a, b;
  try {
    a = Buffer.from(sig, "hex");
    b = Buffer.from(expected, "hex");
  } catch { return { ok: false, reason: "bad signature encoding" }; }
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  // Replay check — a valid signature is unique per (timestamp, body), so
  // seeing the same signature twice inside the skew window means replay.
  _pruneReplay(now);
  if (_seen.has(sig)) return { ok: false, reason: "replay detected" };

  // Pressure check — if the cache is overflowing AND every entry is still
  // inside the skew window, we refuse the new request rather than evict a
  // legit prior signature (which would open a replay window for an attacker
  // who flooded us). Fail-loud over fail-silent.
  if (_seen.size >= _REPLAY_CACHE_PRESSURE) {
    // Throttle the warning to once per minute so a sustained flood doesn't
    // also flood the log.
    if (now - _lastPressureWarnAt > 60_000) {
      _lastPressureWarnAt = now;
      // No logger instance is reachable from this leaf crypto module — the
      // shared package only exports a `createLogger` factory that each bot
      // binds to its own bot.log; twinSign is imported by both bots and by
      // their test suites with no logger threaded in. So we keep `console.warn`
      // here but route the line through `redactString` first, closing the
      // documented gap where a console.* call bypasses the last-mile redactor.
      try { console.warn(redactString(`[twinSign] replay cache pressure: ${_seen.size} entries in-window — refusing new requests`)); } catch {}
    }
    return { ok: false, reason: "replay-cache-pressure" };
  }

  _seen.set(sig, now);

  return { ok: true };
}

/**
 * Constant-time string equality for secrets/tokens. Length is checked first
 * (which itself is a tiny side-channel, but unavoidable without padding) and
 * then the bytes are compared via Node's timingSafeEqual so an attacker can't
 * learn the secret one byte at a time from response-time differences.
 *
 * Returns false for non-strings or length mismatch — it's safe to call on
 * untrusted header values.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Test-only: reset the replay cache between tests. Not part of the public
// surface — but exporting it keeps tests from having to reach into module
// internals via dynamic import + eval.
export function _resetReplayCacheForTests() {
  _seen.clear();
  _lastPressureWarnAt = 0;
}
