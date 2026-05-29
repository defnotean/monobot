// ─── packages/irene/events/messageCreate/autoMod.js ───────────────────────
//
// IRENE AUTO-MOD PRECEDENCE — DO NOT REORDER WITHOUT READING THIS COMMENT.
// =========================================================================
// Irene's defining design choice (vs. Eris): auto-moderation runs BEFORE
// the AI is ever invoked. Every check below short-circuits the pipeline,
// so the order they execute IS the spec. If you shuffle these, behavior
// changes — e.g. moving the firewall before the cooldown would consume
// firewall API quota on rate-limited spammers; moving rulesEnforcer after
// the message-length guard would let injection-bait wall-of-text bypass
// the rules engine entirely.
//
//   1. rulesEnforcer (enforceMessage)        — guild-configurable rules engine
//                                               (cheap regex pre-filter → LLM
//                                               judge → delete/warn/timeout).
//                                               Runs first; if it acted, the
//                                               whole pipeline aborts.
//   2. Sleep mode                            — Irene's "asleep/napping" state
//                                               silently drops messages unless
//                                               owner wakes her.
//   3. Bot-author handling                   — block bots that don't mention
//                                               us; cap bot-to-bot exchanges
//                                               at 3 per 5 min.
//   4. Loop-attempt detection                — block "make twins spam each
//                                               other" / "respond forever".
//   5. Exploit pattern detection             — paradoxes, recursion bait,
//                                               format chaos, lattice nonsense.
//   6. Repeat-spam escalation                — 3+ identical messages → warn →
//                                               final warn → timeout (5m/15m/1h).
//   7. Per-user AI cooldown                  — base 1.5s, escalating to 15s →
//                                               60s → 5m on rapid bursts.
//   8. Word/mention/spam/invite checks       — checkBadWords, checkMentionSpam,
//                                               checkSpam, checkInviteLinks
//                                               (guild only).
//   9. Message length guard                  — >1500 chars from non-owner is
//                                               almost always injection bait;
//                                               silently drop.
//  10. Injection firewall (parallel)         — kicked off in parallel with
//                                               the AI pipeline; verdict
//                                               awaited at firewallGate before
//                                               any output reaches the user.
//  11. Sticky messages                       — re-post sticky at bottom of
//                                               channel (side effect, not a
//                                               gate).
//  12. Auto-responders                       — match-and-reply triggers.
//  13. AFK / Highlights / Leveling           — passive side effects (AFK
//                                               return-check, highlight DMs,
//                                               XP grant).
//
// Steps 1-10 are TRUE gates: if they fire, the orchestrator returns and
// the AI never runs. Steps 11-13 are side effects that always proceed.
// =========================================================================

import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import { checkSpam, checkMentionSpam, checkBadWords } from "../../utils/safety.js";
import { checkInjection, logBlockedAttempt } from "../../ai/firewall.js";
import { addWarning, trackMessage, EXPLOIT_PATTERNS, EXPLOIT_ROASTS } from "./gates.js";

// ── Step 4-5: loop-attempt + exploit pattern detection ────────────────────
// Returns true if the message should be dropped (after replying with a
// roast for exploit patterns; loop attempts silently return).
export function detectExploitOrLoop(message) {
  const lowerContent = message.content.toLowerCase();
  // Twin feedback loop attempts
  const loopAttempt = /\b(keep talking|don't stop|never stop|respond to everything|always respond|talk forever|infinite|loop|spam each other|overload|crash|break)\b/i.test(lowerContent);
  if (loopAttempt && /\b(sister|twin|evil|eris|each other|her|him|them)\b/i.test(lowerContent)) return { drop: true, roast: null };

  const isExploit = EXPLOIT_PATTERNS.some(p => p.test(lowerContent));
  if (isExploit) {
    const roast = EXPLOIT_ROASTS[Math.floor(Math.random() * EXPLOIT_ROASTS.length)];
    message.reply(roast).catch(() => {});
    return { drop: true, roast };
  }
  return { drop: false };
}

// ── Step 6: repeat-spam escalation ────────────────────────────────────────
// Returns true if the message was a repeat that triggered a warning or
// timeout — the orchestrator must drop in that case.
export async function detectRepeatSpam(message) {
  const _repeat = trackMessage(message.guildId || "dm", message.author.id, message.content);
  if (_repeat.count >= 3) {
    const warns = addWarning(message.guildId || "dm", message.author.id);
    if (warns >= 3 && message.member?.moderatable) {
      // 3+ warnings = timeout (5 min, then 15 min, then 1 hour)
      const duration = warns >= 5 ? 3600000 : warns >= 4 ? 900000 : 300000;
      const label = warns >= 5 ? "1 hour" : warns >= 4 ? "15 minutes" : "5 minutes";
      await message.member.timeout(duration, "Repeated spam/abuse detected").catch(() => {});
      message.reply("ok you've been warned " + warns + " times now. enjoy your " + label + " timeout").catch(() => {});
      return true;
    }
    if (warns >= 2) {
      message.reply(["final warning — keep spamming and you're getting timed out", "i'm serious, one more and you're muted"][Math.floor(Math.random() * 2)]).catch(() => {});
      return true;
    }
    message.reply(["you already said that " + _repeat.count + " times", "broken record much?", "i heard you the first time", "repeating it won't change my answer"][Math.floor(Math.random() * 4)]).catch(() => {});
    return true;
  }
  return false;
}

// ── Step 3: bot-author exchange cap ───────────────────────────────────────
// Returns true if the message is from a (non-twin) bot AND we should drop:
// either it didn't mention us, or we've exchanged > 3 times in 5 min.
export function shouldDropBotAuthor(message, isTwinMsg) {
  if (!message.author.bot || isTwinMsg) return false;
  // Let other bots through if they @mention us or say our name
  const mentionsMe = message.mentions.has(message.client.user);
  const myName = (message.guild?.members?.me?.displayName || message.client.user.username).toLowerCase();
  const saysMyName = message.content.toLowerCase().includes(myName) || message.content.toLowerCase().includes("irene");
  if (!mentionsMe && !saysMyName) return true;
  // Bot-to-bot loop prevention: max 3 exchanges per bot per 5 min.
  // Use a bounded LRU so idle periods can't balloon this map unbounded —
  // the old code only pruned when size > 2000, so stale entries for
  // long-gone conversations kept accumulating during quiet hours.
  const botKey = `bot_exchange:${message.guild?.id}:${message.author.id}`;
  const now = Date.now();
  if (!globalThis._botExchanges) globalThis._botExchanges = new LRUCache(500, 300_000);
  const ex = globalThis._botExchanges.get(botKey) || { count: 0, resetAt: now + 300_000 };
  if (now > ex.resetAt) { ex.count = 0; ex.resetAt = now + 300_000; }
  ex.count++;
  globalThis._botExchanges.set(botKey, ex);
  if (ex.count > 3) return true; // Too many exchanges, ignore
  return false;
}

// ── Step 7: per-user AI cooldown + escalating spam protection ─────────────
// Returns true if the user is still on cooldown — drop the message.
export function applyAiCooldown(message) {
  if (!globalThis._aiSpamTracker) globalThis._aiSpamTracker = new Map();
  const _ast = globalThis._aiSpamTracker;
  const _uid = message.author.id;
  if (!_ast.has(_uid)) _ast.set(_uid, { count: 0, lastMsg: 0, cooldownMs: config.aiCooldownMs || 1500 });
  const _stu = _ast.get(_uid);
  const _gap = Date.now() - _stu.lastMsg;
  if (_gap < _stu.cooldownMs) return true; // Still on cooldown — silently ignore
  if (_gap < 3000) {
    _stu.count++;
    if (_stu.count > 8) _stu.cooldownMs = 15000;   // 15s after 8 rapid messages
    if (_stu.count > 15) _stu.cooldownMs = 60000;  // 60s after 15
    if (_stu.count > 25) _stu.cooldownMs = 300000; // 5min after 25 (stress test)
  } else {
    _stu.cooldownMs = config.aiCooldownMs || 1500;
    _stu.count = Math.max(0, _stu.count - 1);
  }
  _stu.lastMsg = Date.now();
  return false;
}

// ── Step 8: word/mention/spam/invite safety checks (guild only) ───────────
// Returns true if any check fired — drop the message.
export async function runSafetyChecks(message) {
  if (await checkBadWords(message)) return true;
  if (await checkMentionSpam(message)) return true;
  if (await checkSpam(message)) return true;
  const { checkInviteLinks } = await import("../../utils/safety.js");
  if (await checkInviteLinks(message)) return true;
  return false;
}

// ── Step 9: message length guard ──────────────────────────────────────────
// Returns true if the message exceeds the injection-bait length cap.
export function exceedsLengthGuard(message) {
  if (message.content?.length > 1500 && message.author.id !== config.ownerId) {
    log(`[GUARD] Blocked long message (${message.content.length} chars) from ${message.author.tag}`);
    return true; // Silently ignore — don't waste AI tokens on wall-of-text attacks
  }
  return false;
}

// ── Step 10: injection firewall (parallel kickoff + gate) ─────────────────
// Kicks off the firewall check in parallel with the AI pipeline. The
// verdict is awaited via the returned `firewallGate` immediately before any
// AI-derived output reaches the user.
//
// Returns:
//   {
//     firewallPromise: Promise<verdict> | null,
//     firewallSupabase: SupabaseClient | null,
//     firewallGate: async (sendCallback) => Promise<boolean>,
//   }
// firewallGate returns true if the callback was invoked (i.e. safe),
// false if it was blocked.
export async function initFirewall(message, { isTwinMsg }) {
  let firewallPromise = null;
  let firewallSupabase = null;
  if (!isTwinMsg && message.author.id !== config.ownerId) {
    try {
      const { getSupabase } = await import("../../database.js");
      // Always run the firewall — firewallSupabase may be null (no-Supabase
      // mode). The L3 semantic layer self-guards on supabase && voyageApiKey, so
      // L1/L1.5/L2/L2.5 run regardless and only the semantic layer is skipped
      // when Supabase/Voyage are absent. Previously this only ran inside
      // `if (firewallSupabase)`, so in the supported no-Supabase mode every
      // message passed unchecked.
      firewallSupabase = getSupabase();
      firewallPromise = checkInjection(message.content, firewallSupabase, message.author.id)
        .catch((e) => { log(`[FIREWALL] Error: ${e.message}`); return { safe: true, _error: e }; });
    } catch (e) {
      log(`[FIREWALL] Error: ${e.message}`);
    }
  }

  let _firewallVerdict = null;
  let _firewallBlockSent = false;
  const firewallGate = async (sendCallback) => {
    if (!firewallPromise) { await sendCallback(); return true; }
    if (!_firewallVerdict) _firewallVerdict = await firewallPromise;
    if (!_firewallVerdict.safe) {
      // Send the block reply + log only once even if firewallGate is called
      // from multiple send sites on the same blocked message.
      if (!_firewallBlockSent) {
        _firewallBlockSent = true;
        await message.reply(_firewallVerdict.reason).catch(() => {});
        if (firewallSupabase) {
          await logBlockedAttempt(firewallSupabase, message.author.id, message.guild?.id, message.channel.id, message.content, _firewallVerdict.matchedPattern, _firewallVerdict.similarity).catch(() => {});
        }
      }
      return false;
    }
    await sendCallback();
    return true;
  };

  // Helper: rewind history if the firewall ultimately blocks.
  const getVerdict = async () => {
    if (!firewallPromise) return { safe: true };
    if (!_firewallVerdict) _firewallVerdict = await firewallPromise;
    return _firewallVerdict;
  };

  return { firewallPromise, firewallSupabase, firewallGate, getVerdict };
}
