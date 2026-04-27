// ─── Cross-bot punish signal ─────────────────────────────────────────────────
// When Irene bans or kicks a user, send a signal to Eris so her economy
// enforcement (zero the user's balance) can fire automatically. Opt-in per
// guild via a guild setting in Eris (`cross_bot_punish`). Irene doesn't
// store that setting — she just fires and Eris decides whether to act.
//
// Fire-and-forget: failures are logged but never block the ban/kick flow.

import config from "../config.js";
import { log } from "./logger.js";
import { signTwinRequest } from "@defnotean/shared/twinSign";

export async function firePunishSignal({ guildId, userId, action, reason }) {
  const url = config.twinApiUrl;
  const secret = config.twinApiSecret;
  if (!url || !secret) return; // twin integration not configured

  // Validate inputs early so we don't send junk that Eris rejects (or worse,
  // that injects odd values into her log).
  if (!/^\d{5,20}$/.test(String(guildId || "")) || !/^\d{5,20}$/.test(String(userId || ""))) {
    log(`[TwinPunish] rejected — invalid snowflake (${guildId}/${userId})`);
    return;
  }
  if (typeof action !== "string" || !/^[a-z_]{2,32}$/.test(action)) {
    log(`[TwinPunish] rejected — invalid action "${action}"`);
    return;
  }

  // Canonical body — signer + verifier must agree byte-for-byte, so JSON is
  // built once and reused.
  const body = JSON.stringify({
    guild_id: String(guildId),
    user_id: String(userId),
    action,
    reason: reason ? String(reason).slice(0, 500) : null,
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });

  let sigHeaders;
  try { sigHeaders = signTwinRequest(body, secret); }
  catch (err) { log(`[TwinPunish] sign failed: ${err.message}`); return; }

  try {
    const res = await fetch(`${url}/api/twin/punish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sigHeaders },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log(`[TwinPunish] ${action} signal for ${userId} failed: HTTP ${res.status}`);
      return;
    }
    const result = await res.json().catch(() => null);
    // Log every response — applied OR not — so operators can debug why a
    // punish signal didn't translate into economy enforcement. The two
    // common "not applied" reasons (guild not opted in vs action not in
    // Eris's allowlist) look identical in the wire response, so logging
    // the reason verbatim is the only way to tell them apart in the field.
    if (!result || typeof result !== "object") {
      log(`[TwinPunish] ${action} signal for ${userId} returned no parseable body`);
    } else if (result.applied) {
      log(`[TwinPunish] Eris applied ${action} consequence for ${userId} — confiscated ${result.confiscated ?? 0}`);
    } else {
      log(`[TwinPunish] Eris declined ${action} for ${userId} — reason: ${result.reason ?? "(none given)"}`);
    }
  } catch (err) {
    log(`[TwinPunish] signal failed: ${err.message}`);
  }
}
