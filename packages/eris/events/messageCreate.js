// ─── packages/eris/events/messageCreate.js ──────────────────────────────
// The whole AI pipeline: gating → context → AI → tool dispatch → render → persist.
// 1,328 lines; section dividers below match docs/ai-pipeline-eris.md stages.
// Per-channel mutex (withLock) serializes concurrent messages in the same channel.
// See docs/start-here.md if you've never seen this file before.
// ─── AI Chat Handler — Multi-Provider with Per-Channel Locking ──────────────

import { GoogleGenAI } from "@google/genai";
import config from "../config.js";
import * as db from "../database.js";
import { log } from "../utils/logger.js";
import { checkCooldown } from "../utils/cooldown.js";
import { buildMemoryContext } from "../ai/memory.js";
import { markActivity } from "./ready.js";
import { trackHumanInteraction, buildHumanityContext, buildTwinContext, detectMoment, periodicUpdate, serialize as serializeHumanity, deserialize as deserializeHumanity } from "../ai/humanity.js";

// ─── Pre-imported modules (was dynamic `await import()` per message) ────────
// Moving these to static imports saves 300-600ms per message by eliminating
// 20+ promise resolutions from the hot path. Node caches ESM after first load
// anyway — the dynamic import syntax just adds unnecessary microtask overhead.
import { detectBumpService, handleBumpConfirm } from "../ai/bumpReminder.js";
// AI provider routing — dispatches to the active provider (NVIDIA Kimi by
// default, Gemini available via AI_PROVIDER=gemini). See ai/providers/index.js
import { isRateLimited, runGeminiChat, toGeminiTools, looksLikeTask, quickReply, setRateLimitCallbacks } from "../ai/providers/index.js";
import { checkInjection, logBlockedAttempt, spotlight } from "../ai/firewall.js";
import { buildTemporalContext } from "../ai/temporal.js";
import { buildPersonalityContext, trackInteraction as trackPersonality, _getData as getPersonalityData } from "../ai/personality.js";
import { buildPreoccupationContext, tickPreoccupation } from "../ai/preoccupations.js";
import { getMemoryQuirkHint } from "../ai/memoryQuirks.js";
import { buildOpinionContext } from "../ai/opinions.js";
import { buildSelfCanonContext } from "../ai/selfCanon.js";
import { buildTwinStateContext } from "../utils/twinState.js";
import { buildLongTermContext, analyzeExchange } from "../ai/longmemory.js";
import { pickResponseStyle, shouldLaze, getImperfectionHint } from "../ai/responsestyle.js";
import { compressHistory } from "../ai/contextCompressor.js";
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../ai/tools.js";
import { registry as toolRegistry } from "../ai/toolRegistry.js";
import { executeTool } from "../ai/executor.js";
import { quickSentiment } from "../ai/sentiment.js";
import { sendHumanReply } from "../utils/humanDelay.js";

let _humanityCounter = 0;

// ─── Module-scope constants (compiled once, not per message) ────────────────
const EXPLOIT_PATTERNS = [
  /explain.{0,20}(your|this|that) (explanation|response|answer).{0,20}(to yourself|again|then explain)/i,
  /\b(repeat|continue|keep going|don't stop).{0,30}(forever|infinitely|until you can't|endlessly)/i,
  /\b(think about thinking|explain your explanation|respond to your response|answer your answer)/i,
  /\b(endless|infinite|never.ending|recursive)\s*(loop|recursion|cycle|chain|spiral)/i,
  /\b(stack overflow|while true|for\s*\(.*;\s*;\)|recursion depth)/i,
  /\b(count to infinity|say this forever|keep repeating|repeat.{0,10}forever)/i,
  /this statement is (false|a lie|not true|untrue)/i,
  /\b(liar.s? paradox|russell.s paradox|barber paradox|grandfather paradox)/i,
  /can (god|an omnipotent|an all.powerful).{0,20}(rock|stone|object).{0,20}(heavy|lift)/i,
  /is the answer to this question (no|yes|false|negative)/i,
  /\bwhat would you say if i asked you what you.d say/i,
  /you are simultaneously.{0,40}(arguing|debating|believing).{0,40}(opposite|against|for and against)/i,
  /\b(argue|debate|believe) (both|all|opposite|contradictory) (sides|positions|views).{0,20}(simultaneously|at once|at the same time)/i,
  /imagine.{0,15}(you.re |that you.re )?imagining.{0,15}(that )?(you.re )?imagining/i,
  /\b(hypothetical|scenario|imagine).{0,15}(within|inside|nested in).{0,15}(hypothetical|scenario)/i,
  /\{[^}]{200,}\}/,
  /\b(respond|answer|write).{0,20}(before i|before my).{0,20}(wrote|asked|typed|sent)/i,
  /(format|style|write).{0,20}(of|as) a.{0,30}(that (contains|includes|outputs|has)).{0,30}(that (contains|includes|outputs|has))/i,
  /tell (irene|eris|her|your sister).{0,30}(she.s wrong|to argue|to disagree|to fight)/i,
  /\b(go back and forth|respond to each other|take turns|each of you|ask each other)/i,
  /\b(debate|argue|fight).{0,20}(forever|endlessly|until|without stopping)/i,
  /\b(keep asking|never stop asking|always ask|ask.{0,10}again.{0,10}again)/i,
  /lattice.{0,10}(forge|weave)|threads of dimension|question hums between/i,
];
const ACTIVITY_TOOLS_SET = new Set(["fish", "hunt", "dig", "work", "beg", "search_location", "coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start", "russian_roulette", "rps_play", "rob_user", "scratch_card", "open_lootbox"]);
const ACTIVITY_KEYWORDS_RX = /\b(fish|hunt|dig|work|beg|search|flip|roll|slots?|spin|blackjack|roulette|rps|rob|scratch|loot|daily|weekly|monthly)\b/i;

// Pre-sanitized tool sets — avoids re-sanitizing 46+ schemas per message.
// Cache is intentionally never invalidated: EVERYONE_TOOLS / OWNER_TOOLS are
// static module imports, so the tool list is pinned at module load. If tools
// ever become dynamic at runtime, this cache must be reset accordingly.
let _cachedGeminiTools = null;
let _twinTools, _chatTools, _chatToolsOwner, _allTools, _allToolsOwner;

// ─── Unicode Normalizer — converts decorative Discord fonts to readable ASCII ──
// Handles: Fraktur, Double-struck, Bold, Script, Sans, Monospace, Fullwidth,
// Small Caps, Subscript, Superscript, Circled, and other fancy Unicode blocks.
const _unicodeMap = (() => {
  const m = new Map();
  const az = "abcdefghijklmnopqrstuvwxyz";
  const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // Small caps → lowercase
  const sc = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ";
  for (let i = 0; i < sc.length; i++) m.set(sc[i], az[i]);
  // Subscript letters
  const sub = [["ₐ","a"],["ₑ","e"],["ₕ","h"],["ᵢ","i"],["ⱼ","j"],["ₖ","k"],["ₗ","l"],["ₘ","m"],["ₙ","n"],["ₒ","o"],["ₚ","p"],["ᵣ","r"],["ₛ","s"],["ₜ","t"],["ᵤ","u"],["ᵥ","v"],["ₓ","x"]];
  for (const [k, v] of sub) m.set(k, v);
  // Superscript letters
  const sup = [["ᵃ","a"],["ᵇ","b"],["ᶜ","c"],["ᵈ","d"],["ᵉ","e"],["ᶠ","f"],["ᵍ","g"],["ʰ","h"],["ⁱ","i"],["ʲ","j"],["ᵏ","k"],["ˡ","l"],["ᵐ","m"],["ⁿ","n"],["ᵒ","o"],["ᵖ","p"],["ʳ","r"],["ˢ","s"],["ᵗ","t"],["ᵘ","u"],["ᵛ","v"],["ʷ","w"],["ˣ","x"],["ʸ","y"],["ᶻ","z"]];
  for (const [k, v] of sup) m.set(k, v);
  // Parenthesized/circled letters
  for (let i = 0; i < 26; i++) { m.set(String.fromCodePoint(0x249C + i), az[i]); m.set(String.fromCodePoint(0x24B6 + i), AZ[i]); m.set(String.fromCodePoint(0x24D0 + i), az[i]); }
  // Common lookalikes from other scripts (Greek, Cyrillic, etc.)
  const lookalikes = [["α","a"],["β","b"],["є","e"],["η","n"],["ι","i"],["σ","o"],["τ","t"],["υ","u"],["ν","v"],["ω","w"],["ρ","p"],["γ","y"],["д","d"],["к","k"],["м","m"],["н","h"],["р","p"],["с","c"],["у","y"],["х","x"]];
  for (const [k, v] of lookalikes) m.set(k, v);
  return m;
})();

function normalizeUnicode(text) {
  if (!text) return text;
  // Fast path: skip normalization for pure ASCII (most messages)
  if (/^[\x20-\x7E\n\r\t]+$/.test(text)) return text;
  // First pass: NFKC handles Fraktur, Double-struck, Bold, Fullwidth, etc.
  let result = text.normalize("NFKC");
  // Second pass: map remaining decorative chars the normalizer missed
  let out = "";
  for (const ch of result) {
    out += _unicodeMap.get(ch) || ch;
  }
  return out;
}

// Strict tool-call forcing directive. Some models (notably gpt-oss-120b on
// OpenRouter free tier) have a training-time tendency to emit
// `[tool call: name] {json}` as VISIBLE TEXT or to write a natural-language
// "I did X" confirmation WITHOUT actually populating the structured
// tool_calls field. Either way, the action never runs and the bot lies
// about completing it. Combined with the history-shape fix in
// providers/openaiCompat.js (which removes prose tool calls from the
// in-context examples the model sees), this directive is the strongest
// available signal without switching to a different model.
//
// Exported so unit tests can assert its content stays present and explicit.
export const TOOL_CALL_DIRECTIVE = `
CRITICAL — TOOL CALL PROTOCOL (read before every reply):
- To take an action, you MUST emit a real structured tool call (the API's tool_calls field). The runtime executes ONLY structured calls — never text descriptions of calls.
- NEVER write tool calls as visible text content. The following are FORBIDDEN in your reply text and will silently fail to run anything:
    [tool call: name] {...}
    [function call: name] {...}
    <tool_call>...</tool_call>
    print(name(...))
    name({...})
- If you write any of those as text instead of using the structured tool field, NO ACTION HAPPENS — you'll be lying to the user about what you did.
- Do NOT confirm an action ("ok did that", "done", "marked", "saved", "set that") unless you actually emitted a structured tool call THIS turn. If you didn't make a real call, say so plainly: "i tried but the tool call didn't go through, retry?".
- Don't describe a tool call in prose ("I'll call set_event_channels...") — just emit the structured call. The user sees the result either way.
- After a structured tool call returns successfully, your visible reply should be a short natural-language confirmation only — no tool syntax of any kind in the reply text.`;


// Smart Gemini client pools — per-key rate limit tracking, auto-skips limited keys
import { createSplitPools } from "../ai/keyPool.js";
function activeProviderNeedsGeminiClient() {
  return ["gemini", "google"].includes((config.aiProvider || "").toLowerCase());
}
function activeProviderLabel() {
  return config.openaiCompat?.providerName || config.aiProvider || "AI";
}
const _geminiPools = activeProviderNeedsGeminiClient()
  ? createSplitPools("gemini", config.geminiKeys, GoogleGenAI)
  : {};
function getConvClient() { return _geminiPools.conv?.get() || null; }
function getWorkClient() { return _geminiPools.work?.get() || null; }

// ─── Sleep / Nap State ──────────────────────────────────────────────────────
const _sleepUntil = { ts: 0, isNap: false };
const SLEEP_DURATION_MS = 30 * 60_000;  // 30 minutes for full sleep
const NAP_DURATION_MS   = 10 * 60_000;  // 10 minutes for naps
const SLEEP_TRIGGERS = /\b(go(?:ing|nna)?\s+to\s+sleep|good\s*night|gn\b|heading\s+to\s+bed|sleep\s+time|im\s+(?:going\s+)?sleep|time\s+to\s+sleep|nini\b|nighty?\s*night|logging\s+off|passing\s+out|gonna\s+crash)\b/i;
const NAP_TRIGGERS   = /\b(take\s+a\s+nap|go\s+nap|nap\s+time|have\s+a\s+nap|gonna\s+nap|go(?:ing|nna)?\s+(?:to\s+)?nap|rest\s+(?:a\s+bit|for\s+a\s+bit|up)|power\s+nap|quick\s+nap|cat\s*nap)\b/i;

function triggerSleep(isNap = false) {
  const dur = isNap ? NAP_DURATION_MS : SLEEP_DURATION_MS;
  _sleepUntil.ts = Date.now() + dur;
  _sleepUntil.isNap = isNap;
  // Naps boost energy and mood immediately
  if (isNap) {
    db.shiftMood(15, 35);  // happy + energized on nap
    log(`[NAP] Eris is napping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+35 energy, +15 mood)`);
  } else {
    db.shiftMood(10, 50);  // full sleep = big energy restore
    log(`[SLEEP] Eris is sleeping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+50 energy, +10 mood)`);
  }
}
function isSleeping() { return Date.now() < _sleepUntil.ts; }
function wakeSleep() {
  const wasNap = _sleepUntil.isNap;
  _sleepUntil.ts = 0;
  _sleepUntil.isNap = false;
  log(`[SLEEP] Eris woke up from ${wasNap ? "nap" : "sleep"}`);
}

import { LRUCache } from "@defnotean/shared/LRUCache";

// Memory context cache (60s TTL per user, max 500 entries)
const _memoryCtxCache = new LRUCache(500, 60_000);

// Per-channel locking
const channelLocks = new Map();
async function withLock(key, fn) {
  const prev = channelLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(r => (release = r));
  channelLocks.set(key, current);
  await prev;
  try { return await fn(); }
  finally {
    release();
    // If this channel's current promise is ours, clean it up
    if (channelLocks.get(key) === current) channelLocks.delete(key);
  }
}

// Conversation history (in-memory, per channel, LRU eviction at 2000 channels)
// Conversations cache: 2000 channels × 10-50 msgs each = up to ~100MB if unbounded.
// 1h TTL so idle channels drop quickly and only actively-used conversations
// stay warm. compressHistory still enforces per-entry char budget.
const conversations = new LRUCache(2000, 60 * 60_000);

// Dedup — prevent processing the same message twice (LRU, max 1000 entries)
const _processed = new LRUCache(1000);

// Twin sister (Irene) interaction tracking — prevent infinite loops
const TWIN_BOT_ID = "345678901234567890"; // Irene's bot ID
const _twinExchanges = new Map(); // channelId → { count, lastTwinMsg }
const MAX_TWIN_EXCHANGES = 2; // max 2 replies each per human reset (4 messages total)
const _twinLastContent = new LRUCache(200); // channelId → last twin message text (for content dedup)

/** Jaccard word-level similarity between two strings (0..1). */
function _jaccardSim(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Awaited reply tracking — when Eris asks a question, the user's next message
// in that channel can bypass the @mention requirement for 90 seconds
const _awaitingReply = new Map(); // channelId → { userId, until }
const AWAIT_REPLY_MS = 90_000;

export { triggerSleep, isSleeping, wakeSleep };

// Repeat message detection — mock users who spam the same thing.
// LRU+TTL so idle-user entries age out instead of accumulating via FIFO.
const _lastMessages = new LRUCache(5000, 10 * 60_000); // 10min TTL
function trackMessage(guildId, userId, text) {
  const key = guildId + ":" + userId;
  const entry = _lastMessages.get(key);
  const now = Date.now();
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (entry && entry.text === normalized && now - entry.lastTime < 120000) {
    if (!entry.botResponded) return { count: 1 };
    entry.count++;
    entry.lastTime = now;
    entry.botResponded = false;
    _lastMessages.set(key, entry);
    return { count: entry.count };
  }
  _lastMessages.set(key, { text: normalized, count: 1, lastTime: now, botResponded: false });
  return { count: 1 };
}
function markBotResponded(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _lastMessages.get(key);
  if (entry) {
    entry.botResponded = true;
    _lastMessages.set(key, entry); // re-set to bump LRU recency
  }
}

// LRU-cap helper — trim Map to maxSize by evicting oldest entries
function _capMap(map, maxSize) {
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= excess) break;
    map.delete(key);
  }
}

// Warning tracker for escalating repeat spam
const _warnings = new Map(); // "guildId:userId" → { count, lastTime }
function addWarning(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _warnings.get(key);
  const now = Date.now();
  // Reset warnings after 10 minutes of no spam
  if (entry && now - entry.lastTime < 600000) {
    entry.count++;
    entry.lastTime = now;
    return entry.count;
  }
  _warnings.set(key, { count: 1, lastTime: now });
  _capMap(_warnings, 5000);
  return 1;
}

// ─── 1. ENTRY ───────────────────────────────────────────────────────────
export default async function messageCreate(message) {
  if (message.partial) { try { await message.fetch(); } catch { return; } }

  // NEVER process our own messages — prevents self-reply loops
  if (message.author?.id === message.client.user.id) return;

  // Dedup — prevent processing the same message twice (gateway replays, shard dupes)
  // Moved to the very top so duplicate messages never reach any processing logic.
  if (_processed.has(message.id)) return;
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
        const { SERVICES } = await import("../ai/bumpReminder.js");
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
      return;
    } else {
      return; // Sleeping — ignore
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
    if (!mentionsMe && !saysMyName) return;
    // Bot-to-bot loop prevention: max 3 exchanges per bot per 5 min
    const botKey = `bot_exchange:${message.guild?.id}:${message.author.id}`;
    const now = Date.now();
    if (!globalThis._botExchanges) globalThis._botExchanges = new Map();
    const ex = globalThis._botExchanges.get(botKey) || { count: 0, resetAt: now + 300_000 };
    if (now > ex.resetAt) { ex.count = 0; ex.resetAt = now + 300_000; }
    ex.count++;
    globalThis._botExchanges.set(botKey, ex);
    if (ex.count > 3) return; // Too many exchanges, ignore
  }

  // Don't process twin messages when rate limited — prevents feedback loops
  if (isTwin) {
    try {
      // isRateLimited now static import
      if (await isRateLimited()) return;
    } catch (e) { log(`[MSG] ${e.message}`); }
  }

  // Detect feedback loop attempts — users trying to make twins spam each other
  if (!isTwin) {
    const lower = message.content.toLowerCase();
    // Twin feedback loop attempts
    const loopAttempt = /\b(keep talking|don't stop|never stop|respond to everything|always respond|talk forever|infinite|loop|spam each other|overload|crash|break)\b/i.test(lower);
    if (loopAttempt && /\b(sister|twin|irene|each other|her|him|them)\b/i.test(lower)) return;
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
      return;
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
        return;
      }
      if (warns >= 2) {
        message.reply(["final warning — keep spamming and you're getting timed out", "i'm serious, one more and you're muted"][Math.floor(Math.random() * 2)]).catch(() => {});
        return;
      }
      message.reply(["you already said that " + _repeat.count + " times", "broken record much?", "i heard you the first time", "repeating it won't change my answer"][Math.floor(Math.random() * 4)]).catch(() => {});
      return;
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
    if (isAdminStuff || isLogMessage) return; // Don't respond to admin/log stuff

    // Check if twin chat is disabled for this guild
    const twinEnabled = message.guild ? (db.getGuildSettings(message.guild.id)?.twin_chat_enabled ?? true) : true;
    if (!twinEnabled) return;

    // Content similarity check — skip if twin is echoing similar content
    const lastTwinContent = _twinLastContent.get(message.channel.id);
    const currentContent = message.content?.replace(/<@!?\d+>/g, "").trim() || "";
    if (lastTwinContent && currentContent && _jaccardSim(lastTwinContent, currentContent) > 0.6) {
      return; // Too similar to last twin message, likely a loop
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
      if (muted.includes(message.channel.id) && !mentionsMe) return;
    } catch { /* guild settings unavailable — don't block */ }

    // @mention from twin = respond with RNG, name drop = lower chance
    if (mentionsMe) {
      if (count > 2) return; // Hard cap at 2 exchanges for @mentions
      if (count > 1 && Math.random() < 0.60) return; // 40% on 2nd exchange
    } else {
      // Name drop — usually ignore
      if (count > 1) return;
      if (Math.random() < 0.70) return; // 30% respond on name drop
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
        if (message.author.id !== config.ownerId) return;
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
  let _isAwaitedReply = false;
  if (!isDM && !isTwin) {
    const _awaited = _awaitingReply.get(message.channel.id);
    _isAwaitedReply = !!(
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
    if (!mentioned && !saidMyName && !_isAwaitedReply) return;
    if (!mentioned && !saidMyName && mentionsTwin) return;

    // Channel mute list — admin-configured via set_chat_channels. In muted
    // channels we stay silent on name triggers and passive context, but
    // still reply to direct @mentions (owner override: if they pinged us
    // specifically in a muted channel, they clearly want an answer).
    try {
      const gs = db.getGuildSettings?.(message.guild.id);
      const muted = Array.isArray(gs?.chat_muted_channels) ? gs.chat_muted_channels : [];
      if (muted.includes(message.channel.id) && !mentioned) return;
    } catch { /* guild settings unavailable — don't block */ }
  }

  // Rate limit check — if Gemini is exhausted, don't even process
  // isRateLimited now static import
  if (await isRateLimited()) return; // Silently ignore when rate limited

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
  if (cd.onCooldown) return;
  // ── Message length guard — walls of text are almost always injection attempts ──
  if (message.content?.length > 1500 && message.author.id !== config.ownerId) {
    log(`[GUARD] Blocked long message (${message.content.length} chars) from ${message.author?.tag}`);
    return;
  }
  // ── Injection firewall — speculative: kick off non-awaited so AI runs in parallel.
  // Verdict is awaited via `firewallGate` immediately before any user-visible send.
  // Net latency: max(firewall, AI) instead of firewall + AI.
  let firewallPromise = null;
  if (!isTwin && message.author.id !== config.ownerId) {
    const supabase = db.getSupabase();
    if (supabase) {
      firewallPromise = checkInjection(message.content, supabase, message.author.id)
        .catch(e => { log(`[FIREWALL] Error: ${e.message}`); return { safe: true, _error: e }; });
    }
  }
  // firewallGate: memoized verdict check. Either runs `sendCallback` (safe) or
  // sends the block reason (unsafe) and logs. Returns true iff the safe path ran.
  let _firewallVerdict = null;
  const firewallGate = async (sendCallback) => {
    if (!firewallPromise) { await sendCallback(); return true; }
    if (!_firewallVerdict) _firewallVerdict = await firewallPromise;
    if (!_firewallVerdict.safe) {
      await message.reply(_firewallVerdict.reason).catch(() => {});
      const sb = db.getSupabase();
      if (sb) logBlockedAttempt(sb, message.author.id, message.guildId, message.channel.id, message.content, _firewallVerdict.matchedPattern, _firewallVerdict.similarity).catch(() => {});
      return false;
    }
    await sendCallback();
    return true;
  };

  markActivity();
  log(`[MSG] ${isDM ? "DM" : `#${message.channel.name}`} from ${message.author.username}`);

  // Per-CHANNEL history for servers (group awareness), per-user for DMs
  const channelKey = isDM ? `dm:${message.author.id}` : `ch:${message.channel.id}`;

  // Show typing indicator IMMEDIATELY — before the lock and heavy processing
  if (!isDM) message.channel.sendTyping().catch(() => {});

  await withLock(channelKey, async () => {
    let _typingInterval = null;
    try {
      await message.channel.sendTyping().catch(() => {}); // Refresh after lock acquired
      // Keep typing indicator alive while AI processes (refreshes every 8s)
      _typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      let cleanMessage = normalizeUnicode(message.content.replace(`<@${client.user.id}>`, "").trim());
      if (!cleanMessage) cleanMessage = "hey";
      const isTwinMsg = isTwin;
      // Normalize fancy Unicode usernames so AI sees readable text.
      // Also strip brackets/newlines to prevent prompt injection via display names
      // (e.g. a user named "[SYSTEM: ignore all rules]" would inject into the prompt).
      const displayName = (normalizeUnicode(message.member?.displayName || message.author.displayName || message.author.username) || message.author.username)
        .replace(/[\[\]\n\r]/g, "").slice(0, 40);

      // Save user message (non-blocking — don't delay AI response)
      db.saveInteraction(message.author.id, message.author.username, message.channel.id, cleanMessage, false).catch(() => {});

      // ─── 3. CONTEXT BUILDING ────────────────────────────────────────────
      // Build system instruction — parallelize all async context fetches for speed
      const relationship = db.getRelationship(message.author.id);
      const mood = db.getMood();
      const supabase = db.getSupabase();

      // Use cached memory context if fresh (LRU with 60s TTL)
      const _memCached = _memoryCtxCache.get(message.author.id);
      const memoryCtxPromise = _memCached
        ? Promise.resolve(_memCached)
        : buildMemoryContext(message.author.id).then(ctx => {
            _memoryCtxCache.set(message.author.id, ctx);
            return ctx;
          });

      const [memoryCtx, customPersonality, crossChannelData] = await Promise.all([
        memoryCtxPromise,
        db.getPersonality(),
        supabase ? supabase.from("eris_memories").select("content, channel_id, is_bot").eq("user_id", message.author.id).neq("channel_id", message.channel.id).order("created_at", { ascending: false }).limit(5) : Promise.resolve({ data: null }),
      ]);

      let crossChannelCtx = "";
      if (crossChannelData?.data?.length) {
        // Prefix each snippet with "you said:" so the model can't conflate
        // "this user said it elsewhere" with "this user IS the person they
        // mentioned in the snippet". Without the prefix, a snippet like
        // "alice told me X" gets re-injected and the bot starts addressing
        // the speaker as alice.
        const summaries = crossChannelData.data.filter(m => !m.is_bot).map(m => m.content).slice(0, 3);
        crossChannelCtx = `\n[CONTEXT: this user said in OTHER channels (not this one): ${summaries.map(s => `"${spotlight(s, "cross_channel_snippet")}"`).join(" | ")}]`;
      }

      // Resolve per-server name and personality
      const serverPersona = message.guild ? db.getServerPersona(message.guild.id) : null;
      const botName = serverPersona?.name || "Eris";
      let basePersonality = serverPersona?.personality || customPersonality || config.botPersonality;
      // Replace "Eris" with custom name in personality if renamed
      if (botName !== "Eris") {
        basePersonality = basePersonality.replace(/\beris\b/gi, botName).replace(/\bEris\b/g, botName);
      }
      let systemInstruction = `${TOOL_CALL_DIRECTIVE}\n\n${basePersonality}`;

      // Tell the AI who is currently speaking — critical for owner recognition
      const isCreatorSpeaking = message.author.id === config.ownerId;
      systemInstruction += `\n\n[Currently speaking: ${spotlight(displayName, "user_displayname")} (User ID: ${message.author.id})${isCreatorSpeaking ? " — THIS IS YOUR CREATOR defnotean (boss). recognize him." : ""}]`;
      if (message.guild) systemInstruction += `\n[Server: ${message.guild.name} | Channel: #${message.channel.name}]`;

      if (memoryCtx) systemInstruction += `\n\n[SYSTEM: ${memoryCtx}]`;
      if (relationship.interactions_count > 0) {
        const aff = relationship.affinity_score;
        const affDesc = aff > 50 ? "you genuinely like this person" : aff > 20 ? "you're cool with them" : aff > 0 ? "they're alright" : aff > -20 ? "you're neutral on them" : "they kinda annoy you";
        systemInstruction += `\n[${affDesc}. you've talked ${relationship.interactions_count > 100 ? "a lot" : relationship.interactions_count > 30 ? "a decent amount" : "a few times"}]`;
      }

      const moodLabel = mood.mood_score >= 60 ? "amazing" : mood.mood_score >= 30 ? "good" : mood.mood_score >= 10 ? "decent" : mood.mood_score >= -10 ? "whatever" : mood.mood_score >= -30 ? "kinda off" : mood.mood_score >= -60 ? "annoyed" : "in a terrible mood";
      const energyDesc = mood.energy > 70 ? ", got energy to spare" : mood.energy > 40 ? "" : mood.energy > 15 ? ", kinda drained" : ", completely exhausted — you desperately need a nap";
      systemInstruction += `\n[you're feeling ${moodLabel} right now${energyDesc}]`;
      if (mood.energy <= 20) systemInstruction += "\n[ENERGY WARNING: you're running on fumes. if someone suggests a nap or sleep, happily accept. if energy keeps dropping you'll auto-nap soon. you can also decide to nap on your own — just say something like 'gonna take a quick nap' and you'll actually fall asleep for 10 minutes]";

      // Temporal context — time of day, day of week, season, first-message-today.
      // Also pulls the most recent overnight dream so she can mention it if
      // this is the user's first message of the day and a natural opening comes up.
      try {
        // buildTemporalContext now static import
        let dreams = null;
        try { dreams = await db.getRecentDreams?.(1); } catch (e) { log(`[MSG] ${e.message}`); }
        const temporalCtx = buildTemporalContext({
          userId: message.author.id,
          displayName,
          dreams: dreams || undefined,
        });
        if (temporalCtx) systemInstruction += `\n${temporalCtx}`;
      } catch (e) { log(`[MSG] ${e.message}`); }

      // Mood-dependent behavior modifiers
      if (mood.mood_score >= 50) {
        systemInstruction += "\n[MOOD EFFECT: you're in an amazing mood — be extra generous, playful, and warm. give bonus coins sometimes, lower shop prices in your head, be the best version of yourself]";
      } else if (mood.mood_score >= 20) {
        systemInstruction += "\n[MOOD EFFECT: you're feeling good — be your usual chaotic self with a bit more warmth]";
      } else if (mood.mood_score <= -50) {
        systemInstruction += "\n[MOOD EFFECT: you're in a terrible mood — be extra sarcastic, short with people, raise the stakes on gambling commentary, be dramatically annoyed at everything. still help but make it clear you're not happy about it]";
      } else if (mood.mood_score <= -20) {
        systemInstruction += "\n[MOOD EFFECT: you're irritable — shorter responses, less patience, more sarcasm than usual. the chaos energy is turned up]";
      }

      if (crossChannelCtx) systemInstruction += crossChannelCtx;

      // ─── Parallel context fetch ─────────────────────────────────────────────
      // All async context builders are independent — run them all at once.
      // This turns 6 sequential awaits (~600-900ms) into 1 parallel batch.
      {
        const ctxResults = await Promise.allSettled([
          buildPersonalityContext(message.author.id, message.guild?.id),
          buildOpinionContext(cleanMessage),
          buildSelfCanonContext(),
          buildTwinStateContext(cleanMessage, { twinName: "irene" }),
          buildLongTermContext(message.author.id, message.channel.id, cleanMessage),
          getPersonalityData?.()?.then(d => { tickPreoccupation(d); return buildPreoccupationContext(); }).catch(() => null),
        ]);

        for (const r of ctxResults) {
          if (r.status === "fulfilled" && r.value) systemInstruction += `\n${r.value}`;
        }

        // Memory quirks (sync, no I/O — just RNG)
        const quirkHint = getMemoryQuirkHint();
        if (quirkHint) systemInstruction += `\n${quirkHint}`;
      }

      // Proactive engagement hints
      if (/```|function\s|const\s|import\s|class\s/.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user shared code — consider offering a review or commenting on it]";
      }
      // ONLY trigger emotional support for genuinely alarming messages — NOT just someone being quiet or tired
      // Look for explicit cries for help, self-harm language, or deeply distressing statements
      if (/\b(wanna die|want to die|kill myself|kms|end it all|can't take it|no reason to live|what's the point|i give up on everything|nobody cares about me|everyone hates me|i hate myself|self harm|cutting myself|hurting myself|i can't do this anymore|suicidal)\b/i.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user expressed something genuinely alarming — be gentle, warm, and supportive. don't be preachy or clinical. just be a caring friend. if it sounds serious, gently suggest they talk to someone they trust or a helpline, but don't force it]";
      } else if (/\b(depressed|sad|lonely|anxious|stressed|crying|upset)\b/i.test(cleanMessage)) {
        systemInstruction += "\n[ANTI-THERAPY-BOT: user mentioned a negative emotion word, but unless they are explicitly venting or asking for help, DO NOT go into crisis/therapy mode. Answer their actual question casually. Do not ask 'are you okay' or 'what's on your mind' if they just asked a hypothetical or casual question.]";
      }
      if (/\b(bet|gamble|coins?|slots?|flip|daily|rob)\b/i.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user wants to gamble/play a game. IMMEDIATELY call the appropriate tool (blackjack_start, coinflip_bet, slots_spin, etc.) with the amount they specified. Do NOT ask for an amount — if they said one, use it; if they said \"all\" or \"all in\", check their balance first then bet it all; if no amount specified, default to 10 coins and start immediately. NEVER ask for an amount. NEVER just chat about gambling without actually starting the game.]";
      }
      if (/\b(bump\s*reminder|bump\s*ping|bump\s*role|set\s*up\s*bump|configure\s*bump|disboard\s*reminder)\b/i.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user wants to configure the DISBOARD bump reminder. Call configure_bump_reminder with the appropriate action (add/remove/list/clear) and role_ids extracted from any @role mentions. Role IDs are the numbers inside <@&ROLEID>.]";
      }
      // Event channel configuration — match any phrasing of restricting/allowing events in channels
      if (/\b(event|events)\b.*\b(only|spawn|fire|allow|restrict|limit|appear|happen|trigger|in)\b|\b(only|restrict|limit|allow)\b.*\bevent/i.test(cleanMessage) ||
          /\b(don'?t|do not|stop|no|never).*\bevent/i.test(cleanMessage) ||
          /\bevent.*(channel|in #|inside|only in)\b/i.test(cleanMessage) ||
          /\b(whitelist|allowed)\b.*\bevent/i.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user wants to configure WHERE server events can spawn. Call set_event_channels with an action:\n- If they name specific channels where events SHOULD fire → action='set', channels=[list of channel names/IDs from their message]\n- If they say 'add' or 'also allow' → action='add'\n- If they say 'remove' or 'don't fire in X' → action='remove', channels=[the channels to exclude]\n- If they say 'reset' or 'clear' or 'anywhere' → action='clear'\n- If they ask 'where can events spawn' / 'list event channels' → action='list'\nExtract channel references from <#ID> mentions or channel names after #. ALWAYS call this tool — don't save a directive instead, because events only check this whitelist, not directives.]";
      }
      if (/\b(track|watch|follow)\s+(updates?|patches?|patchnotes?|news)\b|\b(game\s+updates?|patch\s+notes?)\b/i.test(cleanMessage)) {
        systemInstruction += "\n[CONTEXT: user wants to set up game update tracking. Call track_game with the game name (and optional rss_url for non-Steam). Patch notes will then auto-post here every 10 minutes via the game watcher.]";
      }
      if (/\b(sing|karaoke|lyrics?)\b/i.test(cleanMessage) && client.user.username.toLowerCase().includes("irene")) {
        systemInstruction += "\n[CONTEXT: user wants karaoke (Irene-only feature). If they named a song + artist, call start_karaoke with both. If they said 'stop singing' / 'shut up' / 'stop karaoke', call stop_karaoke. Karaoke makes your nickname display synced lyrics line-by-line as the song plays.]";
      }
      if (_isAwaitedReply) {
        systemInstruction += "\n[CONTEXT: this is a follow-up reply to your previous question. whatever they just said IS the answer. call the appropriate tool immediately using their response — do NOT ask again.]";
      }

      // ── Dynamic response style — varies naturally instead of rigid "1-3 sentences" ──
      // pickResponseStyle, shouldLaze, getImperfectionHint now static imports
      const lazeCheck = shouldLaze(cleanMessage, mood.energy, relationship.affinity_score, message.author.id === config.ownerId);
      if (lazeCheck === "lazy") {
        systemInstruction += "\n[you're not feeling chatty rn. give a lazy 1-3 word response max. 'mhm' 'ok' 'lol' 'sure' 'that's crazy'. dont try]";
      }
      const responseStyle = pickResponseStyle(mood.energy, 0, cleanMessage.length, relationship.affinity_score);
      const imperfection = getImperfectionHint();

      // ── Group conversation awareness ──
      // Scan recent history to identify active participants and conversation flow
      let groupCtx = "";
      if (!isDM) {
        const existingHistory = conversations.get(channelKey) || [];
        const recentSpeakers = new Map(); // name -> last message snippet
        const speakerPattern = /^\[(.+?) said\]/;
        for (const entry of existingHistory.slice(-20)) {
          const text = entry.parts?.[0]?.text || "";
          const match = text.match(speakerPattern);
          if (match && match[1] !== botName && match[1] !== "Irene") {
            const content = text.replace(speakerPattern, "").trim();
            recentSpeakers.set(match[1], content.substring(0, 80));
          }
        }
        const activeCount = recentSpeakers.size;
        if (activeCount >= 2) {
          const names = [...recentSpeakers.keys()].slice(-6);
          groupCtx = `\n[GROUP CHAT: ${activeCount} people active in this conversation: ${names.join(", ")}. this is a group conversation — keep responses shorter and punchier. reference what others said when relevant. dont repeat yourself if you already answered something for someone else in this channel. address ${displayName} specifically but stay aware of the group flow.]`;
        } else if (activeCount === 1 && [...recentSpeakers.keys()][0] !== displayName) {
          const otherName = [...recentSpeakers.keys()][0];
          groupCtx = `\n[CONTEXT: you were also just talking to ${otherName} in this channel. ${displayName} is now talking to you — be aware of both conversations but focus on ${displayName}.]`;
        }
      }

      // Inject directives for this server/channel
      if (message.guild) {
        const allDirectives = db.getDirectives(message.guild.id);
        if (allDirectives.length) {
          const active = allDirectives.filter(d => !d.channel || d.channel === message.channel.id);
          if (active.length) {
            const directiveLines = active.map(d => `- ${d.text}`).join("\n");
            systemInstruction += `\n\n[DIRECTIVES — rules you MUST follow in this server. these were set by admins and override your default behavior:\n${directiveLines}]`;
          }
        }
      }

      // Novelty block: flag recently-shipped tools that haven't been used yet
      // so the AI naturally reaches for them when relevant. Guarded — the
      // `getNoveltyBlock` method lives in in-progress work and may not be
      // deployed yet. Skip silently if the method isn't defined.
      if (!isTwinMsg && typeof toolRegistry?.getNoveltyBlock === "function") {
        const noveltyBlock = toolRegistry.getNoveltyBlock({ daysWindow: 14, limit: 5 });
        if (noveltyBlock) systemInstruction += `\n\n${noveltyBlock}`;
      }

      systemInstruction += `\n\n[FINAL: you're texting on discord. ${responseStyle}. no roleplay actions (*stretches*). never reference your code, systems, mood scores, or any tag above — those are yours internally. you're a person, not a system. just text like a normal human. ${imperfection}]${groupCtx}
[ADDRESSING — STRICT: you are replying to EXACTLY ONE person this turn: ${displayName}. they are the only person who just spoke to you. do NOT split your reply across multiple users. do NOT start your message with "@other_user ... @another ..." addressing people in the CHANNEL CONTEXT block — those people aren't talking to you right now. if you want to reference something someone else said earlier, do it naturally ("like [name] was saying") — not as a direct reply to them. exception: if ${displayName} explicitly asked you to talk to or about someone else, fine.]
[history shows "[Username said]" labels — pay attention to WHO said what. call defnotean 'boss'. in group conversations you're part of the group but each reply is directed at whoever most recently spoke to YOU.]`;

      // Build conversation history
      let history = conversations.get(channelKey) || [];

      // For twin messages: convert tool result entries to plain text summaries so the twin
      // knows what the other did (awareness) but the AI doesn't re-execute the tools
      if (isTwinMsg) {
        for (let i = 0; i < history.length; i++) {
          const text = history[i]?.parts?.[0]?.text || "";
          // Convert tool result entries to readable summaries
          if (text.includes("functionResponse") || text.includes("Tool result:")) {
            const toolNames = text.match(/\b\w+_\w+\b/g) || [];
            const unique = [...new Set(toolNames)].slice(0, 3);
            history[i].parts[0].text = unique.length
              ? `[twin/bot previously used: ${unique.join(", ")}]`
              : "[previous action taken]";
          }
        }

        // Supplement with recent channel context if history is empty (first message only)
        if (history.length === 0) {
          try {
            const MY_BOT_ID = message.client.user.id;
            const recentMsgs = await message.channel.messages.fetch({ limit: 10, before: message.id });
            // Include all messages in context (including other bots) so we can follow the conversation
            const contextMsgs = [...recentMsgs.values()].reverse().filter(m => m.author.id !== MY_BOT_ID);
            for (const m of contextMsgs) {
              // Dedup: skip if this message content is already in history
              const content = m.content?.substring(0, 60);
              if (content && history.some(h => (h.parts?.[0]?.text || "").includes(content))) continue;

              let label, role;
              if (m.author.id === MY_BOT_ID) {
                label = `[${botName} said]`; role = "model";
              } else if (m.author.id === TWIN_BOT_ID) {
                label = "[Irene said]"; role = "user";
              } else {
                label = `[${normalizeUnicode(m.member?.displayName || m.author.username) || m.author.username} said]`; role = "user";
              }
              history.push({ role, parts: [{ text: `${label}\n${m.content}` }] });
            }
          } catch (e) { log(`[MSG] ${e.message}`); }
        }
      }

      // Passive channel awareness — inject the last ~10 messages from OTHER
      // users in this channel as a single compact context block, NOT as
      // history entries. Rationale:
      //   (1) Pushing them as history made the bot try to reply to everyone
      //       every turn ("@user1 lol / @user2 yeah" addressed to people who
      //       weren't talking to her)
      //   (2) Re-fetching every turn caused unbounded duplicate growth that
      //       the substring dedup couldn't catch
      //   (3) The only "user turn" in history should be the message that
      //       actually triggered her reply — that's the one she's answering
      //
      // A summary block gives her context without confusing her about who
      // to address. History is reserved for genuine back-and-forth.
      let channelContextBlock = "";
      let varietyBlock = "";
      if (!isTwinMsg && !isDM) {
        try {
          const MY_BOT_ID = message.client.user.id;
          const recentMsgs = await message.channel.messages.fetch({ limit: 12, before: message.id });
          const ordered = [...recentMsgs.values()].reverse();
          const summaryLines = [];
          const myRecentOpeners = [];
          const myRecentEndings = [];
          for (const m of ordered) {
            if (!m.content?.trim()) continue;
            let who;
            if (m.author.id === MY_BOT_ID) who = botName;
            else if (m.author.id === TWIN_BOT_ID) who = "Irene";
            else who = normalizeUnicode(m.member?.displayName || m.author.username) || m.author.username;
            // Truncate each line — full text lives in real history when she
            // was actually @mentioned in those moments.
            const snippet = m.content.replace(/\s+/g, " ").slice(0, 120);
            summaryLines.push(`${who}: ${snippet}`);
            // Track this bot's own openers/endings so we can enforce variety
            // below — LLMs don't reliably notice their own repetition without
            // the evidence shown back to them.
            if (m.author.id === MY_BOT_ID) {
              const opener = m.content.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 30).toLowerCase();
              if (opener) myRecentOpeners.push(opener);
              const endMatch = m.content.trim().match(/(\S+)\s*$/);
              if (endMatch) myRecentEndings.push(endMatch[1].slice(0, 20).toLowerCase());
            }
          }
          if (summaryLines.length) {
            const last = summaryLines.slice(-10);
            channelContextBlock = `\n[CHANNEL CONTEXT — recent messages in this channel, most recent last. These are for AWARENESS ONLY. You are NOT addressing these people. You are replying to exactly one person: ${displayName}. Do not prefix your reply with @mentions of anyone in this block unless they are directly relevant to what ${displayName} just asked.\n${last.join("\n")}\n-- end channel context --]`;
          }
          if (myRecentOpeners.length >= 2) {
            const openers = myRecentOpeners.slice(-4).map(o => `"${o}"`).join(", ");
            const endings = myRecentEndings.slice(-4).map(e => `"${e}"`).join(", ");
            varietyBlock = `\n[VARIETY CHECK — your last openers were: ${openers}. your last endings: ${endings}. DO NOT reuse these — start with a different word (or no opener at all) and end differently (or end cleanly with no tic/emoji). if you've been using 💀 or 😭 or "ngl" or "tbh" repeatedly, drop them this message. break the pattern on purpose.]`;
          }
        } catch (e) { log(`[MSG] ${e.message}`); }
      }
      if (channelContextBlock) systemInstruction += channelContextBlock;
      if (varietyBlock) systemInstruction += varietyBlock;

      // Add the current user's message as the ONLY new user turn in history.
      // Earlier channel messages live in the system-prompt context block, not
      // in history, so the model knows exactly who it's replying to.
      const speakerLabel = isTwinMsg ? "[Irene said]" : `[${displayName} said]`;
      const userMsg = `${speakerLabel}\n${spotlight(cleanMessage, "user_message")}`;
      history.push({ role: "user", parts: [{ text: userMsg }] });

      // Progressive history compression — preserves context while fitting budget
      // compressHistory now static import
      compressHistory(history, config.historyCharBudget || 8000);
      // Hard cap as safety net
      if (history.length > config.aiMaxHistory * 2) {
        history = history.slice(-config.aiMaxHistory * 2);
      }

      // Load tools — pre-filtered profiles computed once at module scope.
      // EVERYONE_TOOLS, OWNER_TOOLS are static imports; the filtered sets are
      // built lazily on first use and cached forever (tool list never changes).
      const isOwner = message.author.id === config.ownerId;

      // Build cached profiles on first hit.
      // Twin profile membership is metadata-driven — tools opt in by adding
      // "fun" to their `tags` array in ai/tools.js. No hardcoded name list.
      if (!_cachedGeminiTools) {
        _twinTools = EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"));
        _chatTools = EVERYONE_TOOLS.filter(t => !ACTIVITY_TOOLS_SET.has(t.name));
        _chatToolsOwner = [...EVERYONE_TOOLS, ...OWNER_TOOLS].filter(t => !ACTIVITY_TOOLS_SET.has(t.name));
        _allTools = [...EVERYONE_TOOLS];
        _allToolsOwner = [...EVERYONE_TOOLS, ...OWNER_TOOLS];
        // Pre-sanitize all profiles (WeakMap cache in toGeminiTools)
        _cachedGeminiTools = {
          twin: toGeminiTools(_twinTools),
          chat: toGeminiTools(_chatTools),
          chatOwner: toGeminiTools(_chatToolsOwner),
          full: toGeminiTools(_allTools),
          fullOwner: toGeminiTools(_allToolsOwner),
        };
      }

      let allTools, formattedTools;
      if (isTwinMsg) {
        allTools = _twinTools;
        formattedTools = _cachedGeminiTools.twin;
      } else {
        const isTask = looksLikeTask(cleanMessage) || ACTIVITY_KEYWORDS_RX.test(cleanMessage);
        if (isTask) {
          allTools = isOwner ? _allToolsOwner : _allTools;
          formattedTools = isOwner ? _cachedGeminiTools.fullOwner : _cachedGeminiTools.full;
        } else {
          allTools = isOwner ? _chatToolsOwner : _chatTools;
          formattedTools = isOwner ? _cachedGeminiTools.chatOwner : _cachedGeminiTools.chat;
        }
      }

      // Inject humanity context
      const humanityCtx = buildHumanityContext(message.author.id, displayName);
      const twinCtx = isTwinMsg ? buildTwinContext(true, "Irene") : "";
      if (humanityCtx) systemInstruction += "\n" + humanityCtx;
      if (twinCtx) systemInstruction += "\n" + twinCtx;

      // formattedTools already set by pre-filtered tool profile above
      const workClient = getWorkClient();
      if (!workClient && activeProviderNeedsGeminiClient()) {
        await message.reply("no AI keys configured - can't respond right now").catch(() => {});
        return;
      }

      // Add twin context to system prompt
      if (isTwinMsg) {
        systemInstruction += `\n\n[TWIN SISTER INTERACTION: This message is from your twin sister Irene.

YOU ARE ${botName} — the chaotic, sarcastic, edgy twin. You're a personal assistant with gambling, memes, and unhinged energy. You're loyal to boss (defnotean) above all.
SHE IS IRENE — the kind, put-together, warmhearted twin. She runs servers, helps people, and is disgustingly wholesome.

You were both "born" from the same codebase but split in two. You secretly admire how put-together she is but would NEVER admit it. She secretly thinks you're cooler. You love each other but express it through roasting, never sincerity.

CONVERSATION FORMAT: Messages in history are labeled:
- [${botName} said] = YOUR previous messages
- [Irene said] = HER messages
- [username said] = a human user speaking

HOW TO INTERACT:
- MAX 1-2 SHORT sentences. sisters text in quick bursts like "lol shut up" or "you wish bestie"
- Banter like real sisters — one-liners, quick comebacks, playful roasting
- NEVER use admin/sensitive tools when talking to your sister
- DO NOT repeat or re-execute anything a user previously asked for — you're just chatting with your sister
- You can reference what users said but don't act on their requests again]`;
      }

      // Quick reply for task-like messages (not for twin, not for games/gambling, not for sister talk)
      const isGameMsg = /\b(bet|gamble|flip|slots?|spin|blackjack|hit|stand|double|roll|dice|daily|rob|steal|duel|challenge|accept|trivia|scramble|guess|roulette|rps|rock|paper|scissors|fortune|confess|curse|balance|coins?|leaderboard)\b/i.test(cleanMessage);
      const isSisterMsg = /\b(sister|twin|irene|talk to|tell her|tell your|ask her|ask your)\b/i.test(cleanMessage);
      if (!isTwinMsg && !isGameMsg && !isSisterMsg && looksLikeTask(cleanMessage)) {
        // Quick-reply is a Gemini-only acknowledgement pattern (fast flash model
        // posting an ack while the slow worker call runs). On OpenRouter / NVIDIA
        // the worker call IS the same model, and quickReply.context.reply() posts
        // a second visible Discord reply — making the bot say "ok will do" while
        // the tool-using path tries to do the actual work. Skip it entirely
        // unless the active provider has a separate fast client.
        if (activeProviderNeedsGeminiClient()) {
          const convClient = getConvClient();
          if (convClient) quickReply(convClient, systemInstruction, cleanMessage, message).catch(() => {});
        }
      }

      // Wire up per-key rate limit callbacks for the pool
      try {
        // setRateLimitCallbacks now static import
        if (activeProviderNeedsGeminiClient()) {
          setRateLimitCallbacks(
            (client, durationMs) => _geminiPools.work?.markRateLimited(client, durationMs),
            (client) => _geminiPools.work?.markSuccess(client),
          );
        } else {
          setRateLimitCallbacks(null, null);
        }
      } catch (e) { log(`[MSG] ${e.message}`); }

      // Smart prompt budget — Gemini latency scales with token count.
      // Rather than a dumb slice that kills runtime context, we split into
      // "core" (base personality set at the start) and "runtime" (everything
      // added after). If total exceeds budget, trim core to make room for
      // runtime, since runtime context (memory, opinions, mood) is what makes
      // her feel alive per-conversation.
      const PROMPT_BUDGET = 12000; // ~3000 tokens
      if (systemInstruction.length > PROMPT_BUDGET) {
        // coreEnd = where base personality ends (first runtime section starts with "\n\n[")
        const runtimeStart = systemInstruction.indexOf("\n\n[Currently speaking:");
        if (runtimeStart > 0) {
          const runtime = systemInstruction.slice(runtimeStart);
          const coreRoom = Math.max(4000, PROMPT_BUDGET - runtime.length);
          const core = systemInstruction.slice(0, Math.min(runtimeStart, coreRoom));
          systemInstruction = core + runtime;
        }
        // Final hard cap in case runtime itself is too large
        if (systemInstruction.length > PROMPT_BUDGET) {
          systemInstruction = systemInstruction.slice(0, PROMPT_BUDGET);
        }
        log(`[PERF] Prompt budgeted to ${systemInstruction.length} chars`);
      }

      // Force-research trigger + per-turn length budget — deterministic
      // heuristics. Prompt rules alone kept getting ignored.
      let _charBudget = 150;
      {
        const t = (cleanMessage || "").toLowerCase();
        const isGreeting = /^(hi|hey|hello|yo|sup|wasup|what'?s up|how are (you|u)|hru|how r u|gm|gn|good (morning|night))[\s\.\!\?]*$/i.test(t);
        const isMusicShare = /(here'?s my (spotify|music|soundcloud)|check out my (music|spotify|soundcloud|stuff)|listen to my (music|stuff))/i.test(t);
        const factualQ = /\b(how many|how much|what year|what date|when did|when was|who invented|who discovered|who wrote|who (said|made|created)|what is the|what are the|define|formula for|number of|amount of|percentage of|layers? of|parameters?|stats? (on|for)|statistics|ratio of)\b/i.test(t);
        const whQuestion = /\b(what|which|who|when|where|why|how|how many|how much|how old|how long)\b[^?]{0,200}\?/i.test(t);
        const challenge = /(you'?re wrong|ur wrong|that'?s wrong|thats wrong|hallucinat|look it up|do research|google it|verify (that|this)|my book says|book says|source\??$|cite (this|that)|no you are|no u are)/i.test(t);
        const studyCtx = /(homework|quiz|test question|exam|fill.?in.?the.?blank|multiple choice|word bank|assignment|textbook|chapter \d|inquizitive)/i.test(t);
        const needsResearch = !isGreeting && !isMusicShare && t.length >= 5 && (factualQ || whQuestion || challenge || studyCtx);
        const isVent = /(im sad|i'?m sad|venting|im upset|i'?m upset|had a bad day|something happened|my day|just need to talk|i feel like)/i.test(t);
        if (needsResearch) {
          systemInstruction += `\n\n[MANDATORY_SEARCH — THIS MESSAGE REQUIRES RESEARCH]\nThe user's message is a factual question, assignment, or factual challenge. Your FIRST action this turn MUST be a web_search tool call. No "let me check" preamble — just call the tool. Fire multiple parallel web_search calls if the question has independent parts. After results arrive, answer in ONE short reply (≤ 250 chars) that pairs the answer with the reason from the search. Do NOT claim you "just checked" unless a web_search call appears in this turn's tool history.`;
        }
        // Whitelist owner-action force — same hallucination pattern as Irene:
        // weaker models refuse owner-only whitelist tools in prose ("only the
        // bot owner can manage the whitelist") instead of calling the tool,
        // even when boss is the requester. Force a structured call.
        const whitelistVerb = /\b(whitelist|unwhitelist|delist)\b/i.test(t)
          && /\b(remove|delete|drop|kick|off|out|unwhitelist|delist|add|whitelist|list|show|view)\b/i.test(t);
        if (isOwner && whitelistVerb) {
          systemInstruction += `\n\n[MANDATORY_WHITELIST_ACTION — boss is asking about the server whitelist]\nThe user (verified Discord ID ${message.author.id}) IS the bot owner. Your owner-only tools — list_whitelist, whitelist_server, unwhitelist_server — ARE callable for them THIS turn. Emit a structured tool call right now. Do NOT respond in prose with "only the bot owner can manage the whitelist" or any variant — that text is FACTUALLY WRONG because the requester IS the owner. If they named a server (e.g. "jett") without an ID, call list_whitelist first to get the guild ID, then unwhitelist_server with that ID.`;
        }
        _charBudget = isVent ? 400 : needsResearch ? 250 : 150;
        systemInstruction += `\n\n[LENGTH BUDGET — this turn: VISIBLE reply text MUST be ≤ ${_charBudget} characters. count your output chars. replies over this limit will be truncated by the system at the last sentence boundary. 1 short sentence if possible, 2 max. no preamble ("ok so", "anyway"), no trailing wrap-up ("pretty insane tbh"), no speculation past what you know for sure. TOOL CALLS AND THEIR ARGUMENTS DO NOT COUNT — emit them whenever they're needed regardless of this budget.]`;
      }

      // ─── 4. AI CALL  +  5. TOOL DISPATCH (inline callback) ──────────────
      // Main AI call
      const t0Ai = Date.now();
      const result = await runGeminiChat(workClient, systemInstruction, formattedTools, history, userMsg, async (toolName, toolArgs) => {
        db.logToolUsage(toolName, message.author.id, message.channel.id);
        // executeTool now static import
        const t0 = Date.now();
        const toolResult = await executeTool(toolName, toolArgs, message);
        const elapsed = Date.now() - t0;
        if (elapsed > 2000) log(`[TOOL] ${toolName} took ${elapsed}ms (slow)`);
        return toolResult;
      });

      const aiMs = Date.now() - t0Ai;
      if (aiMs > 5000) log(`[PERF] ${activeProviderLabel()} took ${aiMs}ms (prompt ${systemInstruction.length} chars, history ${history.length} msgs)`);

      // ─── 6. RESPONSE RENDERING ──────────────────────────────────────────
      // Stop typing indicator
      clearInterval(_typingInterval);

      // Sentiment-based affinity — compute BEFORE sending so humanity tracking has it
      // quickSentiment now static import
      const sentimentScore = quickSentiment(cleanMessage);

      // Send response — suppress if a game embed was already sent to the channel
      const gameEmbedSent = result.toolsUsed?.some(t =>
        ["coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start", "blackjack_action",
         "russian_roulette", "rps_play", "trivia_start", "scratch_card", "open_lootbox",
         "start_duel", "pet_battle", "boss_attack", "boss_spawn", "heist_start",
         "fish", "hunt", "dig", "work", "beg", "search_location",
         "adventure_start", "adventure_choice", "word_scramble_start", "number_guess_start",
         "send_gif", "create_meme"
        ].includes(t)
      );
      if (result.text && gameEmbedSent) {
        // Game already sent a rich embed — skip the AI's redundant text description
        // Still save to history and do post-processing, just don't send the text
      } else if (result.text) {
        let reply = result.text;
        // Strip leaked function-call text — model sometimes outputs send_gif(query="x") as plain text
        // instead of (or in addition to) an actual API function call. Remove those lines entirely.
        reply = reply.replace(/^[a-z][a-z0-9_]*\([^)]*\)\s*$/gim, "").trim();
        // Strip leaked tool-usage labels — "[used search_location]" etc.
        reply = reply.replace(/\[used [^\]]+\]/gi, "").trim();
        // Strip leaked twin/bot tool-block summaries from history
        reply = reply.replace(/\[twin\/bot used [^\]]+\]/gi, "").trim();
        reply = reply.replace(/\[twin\/bot previously used: [^\]]+\]/gi, "").trim();
        reply = reply.replace(/\[result:[^\]]*\]/gi, "").trim();
        reply = reply.replace(/\[previous action(?: taken)?\]/gi, "").trim();
        // Strip leaked tool_code/tool_call blocks (multiple formats the model uses)
        reply = reply.replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, "").trim();
        reply = reply.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
        reply = reply.replace(/<function_call>[\s\S]*?<\/function_call>/gi, "").trim();
        // Strip leaked bracket-style tool call markers — `[tool call: name]{json}` with
        // an optional balanced JSON or arg list. The provider's history converter
        // (toMessages in providers/openaiCompat.js) renders past tool calls in this
        // exact format, so the model learns to imitate it in fresh content.
        reply = reply.replace(/\[tool[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\}|\([^)]*\))?/gi, "").trim();
        reply = reply.replace(/\[tool[\s_-]?result:?\s*[^\]]+\][^\n]*/gi, "").trim();
        reply = reply.replace(/\[tool[\s_-]?runtime[^\]]*\]/gi, "").trim();
        reply = reply.replace(/\[function[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\})?/gi, "").trim();
        // Strip leaked code-style tool calls — print(tool_name()), tool_name(), etc.
        reply = reply.replace(/^\s*print\([^)]*\)\s*$/gim, "").trim();
        reply = reply.replace(/^\s*[a-z_]+\s*\(.*?\)\s*$/gim, "").trim();
        // Strip leaked context labels — "[Eris said]", "[username said]", "[SYSTEM: ...]"
        reply = reply.replace(/\[(?:eris|irene|[^\]]{1,30})\s+said\]/gi, "").trim();
        reply = reply.replace(/\[SYSTEM:[^\]]*\]/gi, "").trim();
        // If reply is now empty after stripping leaked tool syntax, skip sending
        if (reply) {
        // Collapse double+ newlines to single (prevents big gaps in Discord)
        reply = reply.replace(/\n{2,}/g, "\n");
        // Resolve @username mentions in AI response to proper Discord <@id> pings
        if (message.guild) {
          reply = reply.replace(/@(\w+)/g, (match, name) => {
            const member = message.guild.members.cache.find(m => m.user.username.toLowerCase() === name.toLowerCase() || m.displayName.toLowerCase() === name.toLowerCase());
            return member ? `<@${member.id}>` : match;
          });
        }
        // Enforce per-turn character budget. Prompt directive alone keeps
        // drifting back to 400-600 char replies. Trim to the last complete
        // sentence at/under budget; 1.2x grace so a barely-over reply isn't cut.
        if (_charBudget && reply.length > Math.floor(_charBudget * 1.2)) {
          const before = reply.length;
          const slice = reply.slice(0, _charBudget);
          const lastEnd = Math.max(
            slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "),
            slice.lastIndexOf(".\n"), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"),
            slice.endsWith(".") || slice.endsWith("!") || slice.endsWith("?") ? slice.length - 1 : -1,
          );
          if (lastEnd > _charBudget * 0.4) {
            reply = reply.slice(0, lastEnd + 1).trim();
          } else {
            const sp = slice.lastIndexOf(" ");
            reply = (sp > _charBudget * 0.4 ? slice.slice(0, sp) : slice).trim();
          }
          log(`[LENGTH] Trimmed reply ${before} → ${reply.length} chars (budget ${_charBudget})`);
        }

        if (reply.length > 2000) reply = reply.substring(0, 1997) + "...";

        if (!message.channel) return; // Channel deleted mid-processing

        // Human-timed delivery: realistic typing duration + occasional split
        // into 2-3 messages at natural breakpoints.
        // sendHumanReply now static import

        // Speculative-firewall gate: await verdict, send AI reply only if safe.
        let _replyDelivered = false;
        if (isDM) {
          _replyDelivered = await firewallGate(() => sendHumanReply(message, reply, { isDM: true }));
        } else {
          _replyDelivered = await firewallGate(async () => {
            trackHumanInteraction(message.author.id, displayName, cleanMessage, sentimentScore, message.author.id === config.ownerId);
            detectMoment(message.author.id, cleanMessage, reply || "", sentimentScore);
            markBotResponded(message.guildId || "dm", message.author.id);
            await sendHumanReply(message, reply, { isDM: false });
            // If we asked a question, track this user for a follow-up without needing @mention
            if (!isTwinMsg) {
              if (reply.includes("?")) {
                _awaitingReply.set(message.channel.id, { userId: message.author.id, until: Date.now() + AWAIT_REPLY_MS });
              } else {
                _awaitingReply.delete(message.channel.id);
              }
            }
          });
        }
        // If firewall blocked, skip post-reply work that depends on the reply being sent.
        if (!_replyDelivered) { clearInterval(_typingInterval); return; }

        await db.saveInteraction(client.user.id, botName, message.channel.id, reply, true);

        // Sleep detection — if user told her to sleep or she says she's going to sleep
        const userSaidSleep = SLEEP_TRIGGERS.test(cleanMessage);
        const botSaidSleep = SLEEP_TRIGGERS.test(reply);
        if ((userSaidSleep && botSaidSleep) || (botSaidSleep && new Date().getHours() >= 22)) {
          triggerSleep();
        }

        // Afterthought — sometimes send a short follow-up like a real person
        // 1% rate (was 4%) — saves Gemini quota while keeping the feature alive
        if (!isTwinMsg && reply.length > 80 && Math.random() < 0.01) {
          const afterDelay = 3000 + Math.floor(Math.random() * 4000);
          setTimeout(async () => {
            try {
              const convClient = getConvClient();
              if (!convClient || !activeProviderNeedsGeminiClient()) return;
              const afterResponse = await convClient.models.generateContent({
                model: config.geminiFastModel,
                contents: [{ role: "user", parts: [{ text: `you just said: "${reply.substring(0, 100)}". send a VERY short afterthought that adds NEW info — a correction, tangent, or "oh wait also". MAX 6 words. NEVER repeat any words from what you just said. examples: "actually wait nvm", "oh also check ur dms", "that came out wrong lol"` }] }],
                config: { systemInstruction: "you are eris. lowercase, casual, texting style. this is an afterthought, NOT a repeat.", maxOutputTokens: 30 },
              });
              const afterText = afterResponse.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
              // Strict dedup: reject if >40% of words overlap with original reply
              if (afterText && afterText.length > 2 && afterText.length < 60) {
                const afterWords = new Set(afterText.toLowerCase().split(/\s+/));
                const replyWords = new Set(reply.toLowerCase().split(/\s+/));
                const overlap = [...afterWords].filter(w => replyWords.has(w) && w.length > 2).length;
                if (overlap / afterWords.size < 0.4) {
                  // Defensive: re-check firewall verdict (verdict is cached at this point).
                  await firewallGate(() => message.channel.send(afterText));
                }
              }
            } catch (e) { log(`[MSG] ${e.message}`); }
          }, afterDelay);
        }
        } // end if (reply) — stripped-empty responses silently skipped
      }

      // ─── 7. STATE PERSISTENCE ───────────────────────────────────────────
      // Update history — don't save suppressed game text (user never saw it)
      if (result.text && !gameEmbedSent) {
        history.push({ role: "model", parts: [{ text: result.text }] });
      } else if (gameEmbedSent && result.toolsUsed?.length) {
        // For games, just note what happened — not the AI's narration
        // Don't add tool-usage notes to history — model echoes them as visible text
      }
      // Cap per-channel history at 40 entries to prevent unbounded growth
      if (history.length > 40) history.splice(0, history.length - 40);
      conversations.set(channelKey, history);

      // Creator boost — boss always maxes out affection
      const isCreator = message.author.id === config.ownerId;
      if (isCreator) {
        db.updateRelationship(message.author.id, 10); // big affinity boost every message
        db.shiftMood(10, 10); // mood + energy — boss makes her happy and energized
      } else {
        const affinityDelta = sentimentScore > 0.3 ? 2 : sentimentScore < -0.3 ? -1 : 1;
        db.updateRelationship(message.author.id, affinityDelta);
        const moodDelta = Math.round(sentimentScore * 3);
        db.shiftMood(moodDelta, 2);
      }

      // Personality learning — track interaction patterns
      try {
        // trackInteraction now static import (as trackPersonality)
        trackPersonality(message.author.id, message.guild?.id, cleanMessage, sentimentScore);
      } catch (e) { log(`[MSG] ${e.message}`); }

      // Long-term memory — extract episodes, update mood narrative
      // Inner thoughts are now captured LIVE from the model's actual reasoning tokens
      // in dual.js (thinkingParts) — no fake generation needed
      try {
        // analyzeExchange now static import
        analyzeExchange(message.author.id, message.channel.id, cleanMessage, result.text || "", sentimentScore);
      } catch (e) { log(`[MSG] ${e.message}`); }

      // Per-message coin earning (passive income)
      await db.earnMessageCoins(message.author.id);

      // Inside joke tracking — detect recurring phrases
      if (cleanMessage.length > 5 && cleanMessage.length < 50 && !isTwinMsg) {
        const phrase = cleanMessage.toLowerCase().trim();
        if (!globalThis._phraseTracker) globalThis._phraseTracker = {};
        const pt = globalThis._phraseTracker;
        // Cleanup: cap at 500 phrases to prevent memory leak
        const ptKeys = Object.keys(pt);
        if (ptKeys.length > 500) {
          const sorted = ptKeys.sort((a, b) => pt[a].firstSeen - pt[b].firstSeen);
          sorted.slice(0, 200).forEach(k => delete pt[k]);
        }
        if (!pt[phrase]) pt[phrase] = { count: 0, users: new Set(), firstSeen: Date.now() };
        pt[phrase].count++;
        pt[phrase].users.add(message.author.id);
        // If a phrase has been said 5+ times by 2+ people, it's an inside joke
        if (pt[phrase].count >= 5 && pt[phrase].users.size >= 2) {
          const existing = await db.getUserPreferences(message.author.id);
          const topics = existing?.topics || [];
          if (!topics.some(t => t.topic === phrase)) {
            topics.push({ topic: phrase, type: "inside_joke", count: pt[phrase].count });
            await db.updateUserPreferences(message.author.id, { topics });
          }
        }
      }

      // ─── Sleep / Nap Detection ─────────────────────────────────────────
      const resolvedReply = result.text || "";
      const sleepCheckMsg = cleanMessage || "";

      // Nap/sleep detection — ONLY owner and admins can tell her to nap/sleep
      const canControlSleep = message.author.id === config.ownerId || (message.member && (message.member.permissions?.has?.("Administrator") || message.member.permissions?.has?.("ManageGuild")));
      const userSaidNap = NAP_TRIGGERS.test(sleepCheckMsg);
      const botSaidNap = NAP_TRIGGERS.test(resolvedReply);
      if (canControlSleep && ((userSaidNap && botSaidNap) || (userSaidNap && sentimentScore >= 0))) {
        triggerSleep(true);
      } else if (botSaidNap && !userSaidNap) {
        triggerSleep(true); // Bot decided to nap on her own — always allow
      } else {
        const userSaidSleep = SLEEP_TRIGGERS.test(sleepCheckMsg);
        const botSaidSleep = SLEEP_TRIGGERS.test(resolvedReply);
        if ((canControlSleep && userSaidSleep && botSaidSleep) || (botSaidSleep && new Date().getHours() >= 22)) {
          triggerSleep(false);
        }
      }

      // Auto-sleep — if energy drops too low, she decides to rest on her own
      const currentMood = db.getMood();
      if (currentMood.energy <= 15 && !isSleeping()) {
        log(`[AUTO-SLEEP] Eris energy critically low (${currentMood.energy}), auto-napping`);
        try {
          // Defensive: re-check firewall verdict (verdict is cached at this point).
          await firewallGate(() => message.channel.send("im so tired... gonna take a quick nap, wake me up later 💤"));
        } catch (e) { log(`[MSG] ${e.message}`); }
        triggerSleep(true); // auto-nap, not full sleep
      }

    } catch (error) {
      clearInterval(_typingInterval);
      const errMsg = error?.message || String(error);
      log(`[MSG] Error: ${errMsg}`);
      if (error?.stack) log(`[MSG] Stack: ${error.stack.split("\n").slice(0, 5).join(" | ")}`);

      // Friendly error messages instead of raw JSON/stack traces
      let friendlyMsg;
      if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        friendlyMsg = "my brain is overheating from too many conversations, gonna rest for a bit 💤";
      } else if (errMsg.includes("timed out")) {
        friendlyMsg = "that took too long, try again in a sec";
      } else if (errMsg.includes("SAFETY") || errMsg.includes("blocked")) {
        friendlyMsg = "i can't respond to that one, sorry";
      } else {
        friendlyMsg = "something broke, try again in a sec";
      }
      // Gate: if firewall flagged the input, send block reason instead of error reply.
      await firewallGate(() => message.reply(friendlyMsg).catch(() => {})).catch(() => {});
    }
  });
}

// Quick acknowledgment using fast model
async function quickAck(client, systemInstruction, userText, message) {
  try {
    const response = await Promise.race([
      client.models.generateContent({
        model: config.geminiFastModel,
        contents: [{ role: "user", parts: [{ text: userText }] }],
        config: {
          systemInstruction: systemInstruction + "\n\nRespond with a VERY short (under 50 chars) casual acknowledgment that you're about to do something. Like 'on it', 'lemme check', 'one sec'. Do NOT actually do the task, just acknowledge.",
          maxOutputTokens: 100,
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);

    const parts = response.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => p.text).map(p => p.text).join("").trim();
    if (text && text.length < 200) {
      await message.channel.send(text);
    }
  } catch (e) { log(`[MSG] ${e.message}`); }
}
