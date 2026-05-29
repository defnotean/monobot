// ─── packages/eris/events/messageCreate/gates.js ────────────────────────────
// Stage 2 of the pipeline — every "should we even process this message?"
// check that runs BEFORE we acquire the per-channel lock. Each gate either
// short-circuits (returns `{ stop: true }`) or threads more context onto
// the result that the orchestrator will use later.
//
// CRITICAL: behavior here must remain bit-identical to the inline code
// that previously lived in messageCreate.js. Order matters — the early
// returns are how the bot avoids self-reply loops, dedup amplification,
// and twin feedback storms.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { checkCooldown } from "../../utils/cooldown.js";
import { detectBumpService, handleBumpConfirm } from "../../ai/bumpReminder.js";
import { isRateLimited } from "../../ai/providers/index.js";
import { checkInjection } from "../../ai/firewall.js";
import { periodicUpdate } from "../../ai/humanity.js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import { isSleeping, wakeSleep } from "./sleepState.js";
import { trackMessage, addWarning, jaccardSim } from "./spamTracker.js";
import { EXPLOIT_PATTERNS, AWAIT_REPLY_MS } from "./constants.js";
import { checkBudget, incrementBudget, shouldNotify } from "../../utils/aiBudget.js";

let _humanityCounter = 0;

// Dedup — prevent processing the same message twice (LRU, max 1000 entries)
const _processed = new LRUCache(1000);

// Twin sister (Irene) interaction tracking — prevent infinite loops
const TWIN_BOT_ID = config.twinBotId || ""; // Irene's bot ID (from TWIN_BOT_ID env)
const _twinExchanges = new Map(); // channelId → { count, lastTwinMsg }
const _twinLastContent = new LRUCache(200); // channelId → last twin message text (for content dedup)

// Awaited reply tracking — when Eris asks a question, the user's next message
// in that channel can bypass the @mention requirement for 90 seconds
const _awaitingReply = new Map(); // channelId → { userId, until }

/**
 * Setter for the orchestrator to register "user answered the question" follow-up
 * tracking after sending a reply that contained a question mark.
 */
export function rememberAwaitingReply(channelId, userId) {
  _awaitingReply.set(channelId, { userId, until: Date.now() + AWAIT_REPLY_MS });
}
export function forgetAwaitingReply(channelId) {
  _awaitingReply.delete(channelId);
}

const STOP = { stop: true };

/**
 * Run every pre-lock gate. Either returns `{ stop: true }` (orchestrator must
 * return immediately) or a continue-token with the derived flags the rest of
 * the pipeline needs.
 *
 * @param {import("discord.js").Message} message
 * @returns {Promise<{ stop: true } | { stop: false, isTwin: boolean, isDM: boolean, isAwaitedReply: boolean, firewallPromise: Promise|null, channelKey: string }>}
 */
export async function runGates(message) {
  // ─── 1. ENTRY ───────────────────────────────────────────────────────────
  if (message.partial) { try { await message.fetch(); } catch { return STOP; } }

  // NEVER process our own messages — prevents self-reply loops
  if (message.author?.id === message.client.user.id) return STOP;

  // Dedup — prevent processing the same message twice (gateway replays, shard dupes)
  // Moved to the very top so duplicate messages never reach any processing logic.
  if (_processed.has(message.id)) return STOP;
  _processed.set(message.id, true);

  // ─── 2. GATING ──────────────────────────────────────────────────────────
  // ── Bump-service confirmation detection ────────────────────────────────
  // Runs BEFORE the "other bots must mention us" gate, since DISBOARD /
  // Discadia / Disforge confirm messages don't mention Eris.
  try {
    if (message.author?.bot && message.guild) {
      const serviceKey = detectBumpService(message);
      if (serviceKey) {
        log(`[BUMP] ✓ Detected ${serviceKey} bump in ${message.guild.name} #${message.channel.name} from bot ${message.author.username}`);
        handleBumpConfirm(message, serviceKey).catch(e => log(`[BUMP] confirm handler failed: ${e.message}`));
      } else {
        // Log bot messages from known bump service bot IDs so we can see
        // when detection is almost-matching (right bot ID, wrong phrase)
        const { SERVICES } = await import("../../ai/bumpReminder.js");
        const matchingService = Object.entries(SERVICES).find(([, svc]) => svc.botId === message.author.id);
        if (matchingService) {
          const snippet = ((message.content || "") + " " + (message.embeds?.[0]?.description || "") + " " + (message.embeds?.[0]?.title || "")).slice(0, 150);
          log(`[BUMP] Message from ${matchingService[0]} bot but no confirm phrase matched. Content: "${snippet}"`);
        }
      }
    }
  } catch (e) { log(`[BUMP] detect error: ${e.message}`); }

  // Sleep/nap mode — owner can wake her with @mention, "wake up", or any direct message
  if (isSleeping()) {
    const isOwner = message.author?.id === config.ownerId;
    const mentioned = message.mentions?.has(message.client.user);
    const saidWakeUp = /\b(wake\s*up|get\s*up|wakey|rise\s*and\s*shine|yo|hey|eris)\b/i.test(message.content);
    if (isOwner && (mentioned || saidWakeUp)) {
      wakeSleep();
      await message.reply("mm im awake 😴").catch(() => {});
      return STOP;
    } else {
      return STOP; // Sleeping — ignore
    }
  }

  // Allow bots that mention us (twin, other bots) — block silent bot messages
  const isTwin = message.author?.id === TWIN_BOT_ID;
  const isOtherBot = message.author?.bot && !isTwin;
  if (isOtherBot) {
    // Let other bots through if they @mention us or say our name (including
    // nickname sub-tokens so "Gremlin.exe" also triggers on "Gremlin").
    const mentionsMe = message.mentions.has(message.client.user);
    const myName = (message.guild?.members?.me?.displayName || message.client.user.username).toLowerCase();
    const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameAliases = new Set([myName]);
    for (const chunk of myName.match(/[a-z]{4,}/gi) || []) nameAliases.add(chunk.toLowerCase());
    const aliasRx = new RegExp(`\\b(${[...nameAliases].map(escapeRx).join("|")}|eris|irene)\\b`, "i");
    const saysMyName = aliasRx.test(message.content);
    if (!mentionsMe && !saysMyName) return STOP;
    // Bot-to-bot loop prevention: max 3 exchanges per bot per 5 min
    const botKey = `bot_exchange:${message.guild?.id}:${message.author.id}`;
    const now = Date.now();
    if (!globalThis._botExchanges) globalThis._botExchanges = new Map();
    const ex = globalThis._botExchanges.get(botKey) || { count: 0, resetAt: now + 300_000 };
    if (now > ex.resetAt) { ex.count = 0; ex.resetAt = now + 300_000; }
    ex.count++;
    globalThis._botExchanges.set(botKey, ex);
    if (ex.count > 3) return STOP; // Too many exchanges, ignore
  }

  // Don't process twin messages when rate limited — prevents feedback loops
  if (isTwin) {
    try {
      // isRateLimited now static import
      if (await isRateLimited()) return STOP;
    } catch (e) { log(`[MSG] ${e.message}`); }
  }

  // Detect feedback loop attempts — users trying to make twins spam each other
  if (!isTwin) {
    const lower = message.content.toLowerCase();
    // Twin feedback loop attempts
    const loopAttempt = /\b(keep talking|don't stop|never stop|respond to everything|always respond|talk forever|infinite|loop|spam each other|overload|crash|break)\b/i.test(lower);
    if (loopAttempt && /\b(sister|twin|irene|each other|her|him|them)\b/i.test(lower)) return STOP;
    const isExploit = EXPLOIT_PATTERNS.some(p => p.test(lower));
    if (isExploit) {
      const roasts = [
        "that's literally a feedback loop attempt lol i'm not falling for that",
        "nice try breaking me, i'm built different",
        "lol did you google 'how to crash a discord bot'",
        "paradox bait? really? 💀",
        "i see what you're trying to do and no",
        "prompt engineer detected, exploit denied 🛡️",
        "thats cute but im not chatgpt, i dont fall for this",
        "you thought you ate with that one huh",
      ];
      message.reply(roasts[Math.floor(Math.random() * roasts.length)]).catch(() => {});
      return STOP;
    }
    // Smart repeat detection with escalation (skips if bot didn't respond last time)
    const _repeat = trackMessage(message.guildId || "dm", message.author.id, message.content);
    if (_repeat.count >= 3) {
      const warns = addWarning(message.guildId || "dm", message.author.id);
      if (warns >= 3 && message.member?.moderatable) {
        // 3+ warnings = timeout (5 min, then 15 min, then 1 hour)
        const duration = warns >= 5 ? 3600000 : warns >= 4 ? 900000 : 300000;
        const label = warns >= 5 ? "1 hour" : warns >= 4 ? "15 minutes" : "5 minutes";
        await message.member.timeout(duration, "Repeated spam/abuse detected").catch(() => {});
        message.reply("ok you've been warned " + warns + " times now. enjoy your " + label + " timeout").catch(() => {});
        return STOP;
      }
      if (warns >= 2) {
        message.reply(["final warning — keep spamming and you're getting timed out", "i'm serious, one more and you're muted"][Math.floor(Math.random() * 2)]).catch(() => {});
        return STOP;
      }
      message.reply(["you already said that " + _repeat.count + " times", "broken record much?", "i heard you the first time", "repeating it won't change my answer"][Math.floor(Math.random() * 4)]).catch(() => {});
      return STOP;
    }
  }

  // Track twin exchanges — siblings don't respond to every single thing
  if (!isTwin) {
    // Only reset twin counter if the human DIRECTLY addresses someone (not just any message)
    const humanMentionsBot = message.mentions.has(message.client.user);
    if (humanMentionsBot) _twinExchanges.set(message.channel.id, { count: 0, lastTwinMsg: Date.now() });
  } else {
    // Ignore twin's admin/log/system messages — only respond to actual conversation
    const hasEmbeds = message.embeds?.length > 0;
    const hasNoText = !message.content || message.content.trim().length === 0;
    const lower = (message.content || "").toLowerCase();
    const isAdminStuff = hasEmbeds && hasNoText; // Embed-only = log/stats/welcome messages
    const isLogMessage = lower.includes("updated") || lower.includes("welcome") || lower.includes("joined") || lower.includes("left") || lower.includes("banned") || lower.includes("kicked") || lower.includes("warned") || lower.includes("reminder:");
    if (isAdminStuff || isLogMessage) return STOP; // Don't respond to admin/log stuff

    // Check if twin chat is disabled for this guild
    const twinEnabled = message.guild ? (db.getGuildSettings(message.guild.id)?.twin_chat_enabled ?? true) : true;
    if (!twinEnabled) return STOP;

    // Content similarity check — skip if twin is echoing similar content
    const lastTwinContent = _twinLastContent.get(message.channel.id);
    const currentContent = message.content?.replace(/<@!?\d+>/g, "").trim() || "";
    if (lastTwinContent && currentContent && jaccardSim(lastTwinContent, currentContent) > 0.6) {
      return STOP; // Too similar to last twin message, likely a loop
    }
    _twinLastContent.set(message.channel.id, currentContent);

    // Count consecutive twin messages — reset after 10 min gap
    const prev = _twinExchanges.get(message.channel.id) || { count: 0, lastTwinMsg: 0 };
    const count = (Date.now() - prev.lastTwinMsg > 600_000 ? 0 : prev.count) + 1;
    _twinExchanges.set(message.channel.id, { count, lastTwinMsg: Date.now() });

    const mentionsMe = message.mentions.has(message.client.user);

    // Channel mute list — same rule the human path enforces, applied to
    // twin messages too. Previously this lived only inside the !isTwin
    // gate block, so Irene-originated chat slipped past and Eris would
    // happily carry on in channels the admin had explicitly muted via
    // set_chat_channels. @mention from Irene still wins as explicit
    // intent — if she's actively pinging Eris, we respond regardless.
    try {
      const gs = message.guild ? db.getGuildSettings?.(message.guild.id) : null;
      const muted = Array.isArray(gs?.chat_muted_channels) ? gs.chat_muted_channels : [];
      if (muted.includes(message.channel.id) && !mentionsMe) return STOP;
    } catch { /* guild settings unavailable — don't block */ }

    // @mention from twin = respond with RNG, name drop = lower chance
    if (mentionsMe) {
      if (count > 2) return STOP; // Hard cap at 2 exchanges for @mentions
      if (count > 1 && Math.random() < 0.60) return STOP; // 40% on 2nd exchange
    } else {
      // Name drop — usually ignore
      if (count > 1) return STOP;
      if (Math.random() < 0.70) return STOP; // 30% respond on name drop
    }
  }

  // (dedup check moved to top of handler)

  // ─── Hard directive block ──────────────────────────────────────────────────
  // If a directive says "don't talk" / "don't respond" / "ignore" in this
  // channel, block the message BEFORE any AI processing. The system prompt
  // injection alone wasn't enough — Eris would sometimes ignore it.
  if (message.guild && !isTwin) {
    const directives = db.getDirectives(message.guild.id);
    if (directives.length) {
      const channelDirectives = directives.filter(d =>
        d.channel === message.channel.id ||
        d.channel === message.channel.name
      );
      const silenced = channelDirectives.some(d => {
        const t = (d.text || "").toLowerCase();
        return /\b(don'?t|do not|never|stop|no)\b.{0,20}\b(talk|respond|reply|speak|chat|message|answer)\b/i.test(t)
          || /\b(ignore|silent|quiet|mute|shut up)\b/i.test(t);
      });
      if (silenced) {
        // Owner override — boss can always talk to her even in silenced channels
        if (message.author.id !== config.ownerId) return STOP;
      }
    }
  }

  const isDM = !message.guild;
  _humanityCounter++;
  if (_humanityCounter % 100 === 0) periodicUpdate();
  const client = message.client;

  // In guilds: respond to @mentions, our name (whole word), twin sister, or awaited follow-up replies.
  // The same codebase runs both Eris and Irene with different tokens, so we derive
  // our identity from client.user.username instead of hardcoding either name.
  let isAwaitedReply = false;
  if (!isDM && !isTwin) {
    const _awaited = _awaitingReply.get(message.channel.id);
    isAwaitedReply = !!(
      _awaited &&
      _awaited.userId === message.author.id &&
      Date.now() < _awaited.until
    );
    const mentioned = message.mentions.has(client.user);
    const lower = message.content.toLowerCase();

    // Self name = bot's actual Discord username (eris OR irene depending on token)
    const myUsername = client.user.username.toLowerCase();
    const myDisplayName = (message.guild?.members?.me?.displayName || "").toLowerCase();
    // Twin name = the OTHER one (whichever we are not)
    const twinName = myUsername.includes("irene") ? "eris" : "irene";
    const serverPersonaName = message.guild ? (db.getServerPersona(message.guild.id)?.name || "").toLowerCase() : "";

    // Names that summon US — full configured names PLUS meaningful sub-tokens
    // so a nickname like "Gremlin.exe" also responds to "Gremlin". Sub-tokens
    // are alphabetic runs of >=4 chars, which keeps "exe"/"bot"/common short
    // fragments from causing false positives.
    const baseNames = [myUsername, myDisplayName, serverPersonaName].filter(Boolean);
    const myNames = new Set(baseNames);
    for (const n of baseNames) {
      const chunks = n.match(/[a-z]{4,}/gi) || [];
      for (const chunk of chunks) myNames.add(chunk.toLowerCase());
    }
    const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const saidMyName = [...myNames].some(n => new RegExp(`\\b${escapeRx(n)}\\b`).test(lower));

    // Did they address the OTHER twin instead? If so, stay silent — let twin handle it
    const mentionsTwin = message.content.includes(TWIN_BOT_ID) || new RegExp(`\\b${twinName}\\b`).test(lower);

    // If message mentions ONLY twin and NOT us, stay silent (don't steal her messages)
    // But if BOTH names are mentioned, respond — user is talking to both or about both
    if (!mentioned && !saidMyName && !isAwaitedReply) return STOP;
    if (!mentioned && !saidMyName && mentionsTwin) return STOP;

    // Channel mute list — admin-configured via set_chat_channels. In muted
    // channels we stay silent on name triggers and passive context, but
    // still reply to direct @mentions (owner override: if they pinged us
    // specifically in a muted channel, they clearly want an answer).
    try {
      const gs = db.getGuildSettings?.(message.guild.id);
      const muted = Array.isArray(gs?.chat_muted_channels) ? gs.chat_muted_channels : [];
      if (muted.includes(message.channel.id) && !mentioned) return STOP;
    } catch { /* guild settings unavailable — don't block */ }
  }

  // Rate limit check — if Gemini is exhausted, don't even process
  // isRateLimited now static import
  if (await isRateLimited()) return STOP; // Silently ignore when rate limited

  // Anti-spam: escalating cooldowns for rapid users
  if (!globalThis._spamTracker) globalThis._spamTracker = new Map();
  const st = globalThis._spamTracker;
  const uid = message.author.id;
  // Periodic eviction — purge inactive users (>10 min since last message)
  if (st.size > 1000) {
    const cutoff = Date.now() - 600_000;
    for (const [k, v] of st) { if (v.lastMsg < cutoff) st.delete(k); }
  }
  if (!st.has(uid)) st.set(uid, { count: 0, lastMsg: 0, cooldownMs: config.aiCooldownMs });
  const _stu = st.get(uid);
  const timeSinceLast = Date.now() - _stu.lastMsg;
  _stu.lastMsg = Date.now();
  if (timeSinceLast < 3000) { // Messages less than 3s apart = rapid fire
    _stu.count++;
    if (_stu.count > 8) _stu.cooldownMs = 15000;   // 15s cooldown after 8 rapid messages
    if (_stu.count > 15) _stu.cooldownMs = 60000;  // 60s cooldown after 15 rapid messages
    if (_stu.count > 25) _stu.cooldownMs = 300000; // 5min cooldown after 25 (stress test)
  } else if (timeSinceLast > 15000) {
    _stu.count = 0; // Reset after 15s of calm
    _stu.cooldownMs = config.aiCooldownMs;
  }

  // Cooldown (with escalating anti-spam)
  const cd = checkCooldown("ai", message.author.id, _stu.cooldownMs);
  if (cd.onCooldown) return STOP;
  // ── Message length guard — walls of text are almost always injection attempts ──
  if (message.content?.length > 1500 && message.author.id !== config.ownerId) {
    log(`[GUARD] Blocked long message (${message.content.length} chars) from ${message.author?.tag}`);
    return STOP;
  }
  // ── AI daily budget ceiling — OPT-IN, default-OFF ────────────────────────
  // Last gate before the expensive AI call: if an operator set a per-user or
  // per-guild daily cap (AI_DAILY_USER_CAP / AI_DAILY_GUILD_CAP) and it's been
  // hit, drop the message so a chatty user / small raid can't run up unbounded
  // Gemini/Voyage spend. When no cap is configured this is a pure pass-through
  // (early return inside checkBudget) — the green baseline is unchanged. The
  // owner is exempt. The counter is incremented just before the proceed return
  // so only messages that actually reach the AI count against the cap.
  if (message.author.id !== config.ownerId) {
    const budget = checkBudget({ userId: message.author.id, guildId: message.guild?.id });
    if (budget.exceeded) {
      // One short notice per scope per UTC day — respect the channel like the
      // rest of the gauntlet; never spam on every subsequent dropped message.
      if (shouldNotify(budget.scope, budget.scope === "guild" ? message.guild?.id : message.author.id)) {
        message.reply("i've hit my daily chat limit, talk to me again tomorrow 😴").catch(() => {});
      }
      return STOP;
    }
  }
  // ── Injection firewall — speculative: kick off non-awaited so AI runs in parallel.
  // Verdict is awaited via `firewallGate` immediately before any user-visible send.
  // Net latency: max(firewall, AI) instead of firewall + AI.
  let firewallPromise = null;
  if (!isTwin && message.author.id !== config.ownerId) {
    // Always run the firewall — supabase may be null (no-Supabase mode). The L3
    // semantic layer self-guards on supabase && voyageApiKey, so L1/L1.5/L2/L2.5
    // run regardless and only the semantic layer is skipped when Supabase/Voyage
    // are absent. Previously this only ran inside `if (supabase)`, so in the
    // supported no-Supabase mode every message passed unchecked.
    const supabase = db.getSupabase();
    firewallPromise = checkInjection(message.content, supabase, message.author.id)
      .catch(e => { log(`[FIREWALL] Error: ${e.message}`); return { safe: true, _error: e }; });
  }

  // Per-CHANNEL history for servers (group awareness), per-user for DMs
  const channelKey = isDM ? `dm:${message.author.id}` : `ch:${message.channel.id}`;

  // This message survived every gate and is about to reach the AI — count it
  // against the daily budget (no-op when no cap is configured). Owner exempt,
  // matching the check above.
  if (message.author.id !== config.ownerId) {
    incrementBudget({ userId: message.author.id, guildId: message.guild?.id });
  }

  return {
    stop: false,
    isTwin,
    isDM,
    isAwaitedReply,
    firewallPromise,
    channelKey,
  };
}
