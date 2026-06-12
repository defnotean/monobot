/**
 * @file alert.js
 * @module @defnotean/shared/alert
 *
 * @overview
 * Tiny operational-alerting helper that POSTs a compact embed to a Discord
 * webhook. MONITORING.md describes a webhook recipe but nothing in-process
 * ever fired it; this closes that gap so a fatal crash or a durable-store
 * outage actually pages someone instead of just landing in `bot.log`.
 *
 * Design constraints (all load-bearing):
 *   - **No-op when unconfigured.** If `ALERT_WEBHOOK_URL` is unset/blank the
 *     call returns immediately without touching the network. Self-hosters who
 *     don't wire a webhook pay nothing and nothing breaks.
 *   - **Never throws into the caller.** Every code path is wrapped; a failed
 *     POST or a malformed payload is logged via the optional `log` callback
 *     and swallowed. Alerting must never be the thing that takes the bot down.
 *   - **De-duped / rate-limited per kind.** An incident (e.g. a crash loop or
 *     a flapping Supabase connection) can emit the *same* alert dozens of
 *     times a second. We suppress a repeat of the same `kind` within
 *     `MIN_INTERVAL_MS` (default 60s) so the channel isn't buried. The window
 *     is keyed on `kind` alone — a "persistence-unhealthy" alert and its later
 *     "persistence-recovered" counterpart are different kinds and both get
 *     through.
 *   - **SSRF-safe transport.** Reuses `safeFetch` from this package so the
 *     webhook URL goes through the same private-IP / redirect re-validation as
 *     every other outbound fetch. (A misconfigured ALERT_WEBHOOK_URL pointing
 *     at an internal host is refused, not exploited.)
 *   - **Redacted at the source.** The `message` is run through the shared
 *     `redactString()` before it lands in the embed, so a raw error message
 *     that embeds an API key / Authorization header / query-string token never
 *     reaches the webhook channel — even if a caller forgets to redact.
 *
 * @section Usage
 *   import { sendAlert } from "@defnotean/shared/alert";
 *   sendAlert("uncaught-exception", err?.message, { bot: "ERIS", log });
 *
 * @section Infra note
 *   Real delivery requires a live Discord webhook URL in ALERT_WEBHOOK_URL.
 *   With it unset (CI, local dev, tests) every call is a silent no-op.
 */

import { safeFetch } from "./safeFetch.js";
import { redactString } from "./logRedact.js";

// Minimum spacing between two alerts of the SAME kind. Anything sooner is
// dropped as a duplicate so an incident that retriggers in a tight loop can't
// spam the webhook channel (and can't get us rate-limited by Discord).
const MIN_INTERVAL_MS = 60_000;

// kind → epoch-ms of the last alert we actually sent for that kind.
const _lastSent = new Map();

/**
 * POST a compact alert embed to the configured Discord webhook.
 *
 * Silent no-op when `ALERT_WEBHOOK_URL` is unset. De-dupes repeats of the same
 * `kind` inside the rate-limit window. Never throws — failures are logged via
 * `opts.log` (if provided) and swallowed.
 *
 * @param {string} kind - short stable identifier for the alert class (e.g.
 *   `"uncaught-exception"`, `"persistence-unhealthy"`). Used as the dedupe key.
 * @param {string} [message] - human-readable detail line. Always passed
 *   through the shared log redactor before it reaches the webhook payload.
 * @param {object} [opts]
 * @param {string} [opts.bot] - originating bot tag for the embed title (e.g. `"ERIS"`).
 * @param {(msg: string) => void} [opts.log] - optional logger for internal failures.
 * @param {number} [opts.now] - injectable clock (ms) for tests; defaults to Date.now().
 * @param {string} [opts.webhookUrl] - override the env URL (mainly for tests).
 * @param {number} [opts.minIntervalMs] - override the dedupe window (mainly for tests).
 * @returns {Promise<boolean>} - true if a POST was attempted, false if no-op/deduped.
 */
export async function sendAlert(kind, message, opts = {}) {
  try {
    const {
      bot,
      log,
      now = Date.now(),
      webhookUrl = process.env.ALERT_WEBHOOK_URL,
      minIntervalMs = MIN_INTERVAL_MS,
    } = opts;

    // Unconfigured → silent no-op. No network, no log spam.
    if (!webhookUrl || typeof webhookUrl !== "string" || !webhookUrl.trim()) return false;

    const key = String(kind ?? "unknown");

    // De-dupe: drop a repeat of the same kind inside the window.
    const last = _lastSent.get(key);
    if (last !== undefined && now - last < minIntervalMs) return false;
    _lastSent.set(key, now);

    const title = bot ? `[${bot}] ${key}` : key;
    // Redact BEFORE slicing — slicing first could cut a token in half and let
    // the fragment slip past the shape-based patterns.
    const payload = {
      embeds: [{
        title: title.slice(0, 256),
        description: redactString(String(message ?? "")).slice(0, 2000) || "(no detail)",
        color: 0xe74c3c, // red — these are all problem signals
        timestamp: new Date(now).toISOString(),
      }],
    };

    await safeFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (/** @type {any} */ err) {
    // Alerting must never crash the caller — log and move on.
    opts?.log?.(`[ALERT] send failed: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Clear the per-kind dedupe state. Test-only helper so cases don't bleed the
 * rate-limit window into each other.
 */
export function _resetAlertState() {
  _lastSent.clear();
}
