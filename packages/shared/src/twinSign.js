// ─── Twin API HMAC Signing ──────────────────────────────────────────────────
// Both Eris and Irene share a copy of this module. The protocol:
//
//   X-Twin-Timestamp:  <unix_ms_at_signing_time>
//   X-Twin-Signature:  hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
//
// Verifier rejects requests whose timestamp is outside ±TWIN_MAX_SKEW_MS and
// requires the signature to match in constant time. A replay cache rejects
// identical signatures seen within the skew window.

import { createHmac, timingSafeEqual } from "crypto";

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
  const norm = {};
  for (const k in headers) norm[k.toLowerCase()] = headers[k];
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
      try { console.warn(`[twinSign] replay cache pressure: ${_seen.size} entries in-window — refusing new requests`); } catch {}
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
