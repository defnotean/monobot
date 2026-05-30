// ─── packages/irene/events/messageCreate/gates.js ─────────────────────────
// Early-return gate helpers + shared per-process state (sleep mode, dedup
// sets, mention regex, twin-decision logic, exploit patterns). These all
// run BEFORE the auto-mod and AI pipeline. The orchestrator imports each
// helper and short-circuits on the first one that says "stop".

import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { shiftMood } from "../../database.js";
import { LRUCache } from "@defnotean/shared/LRUCache";

// ── Dedup state ───────────────────────────────────────────────────────────
// Two layers: `processing` blocks the same MESSAGE_CREATE event from
// running twice (shard replays, gateway bugs). `_repliedMessages` blocks
// the bot from replying twice to the same message across instances.
export const processing = new Set();
setInterval(() => processing.clear(), 300_000);
export const _repliedMessages = new Set();
setInterval(() => _repliedMessages.clear(), 300_000);
export const _twinExchanges = new Map();  // channelId → { count, lastTwinMsg }

// ── Sleep / Nap mode ──────────────────────────────────────────────────────
// When Irene says she's going to sleep, ignore messages. Naps are shorter
// (10min) and boost energy/mood. Owner can always wake her up.
const _sleepUntil = { ts: 0, isNap: false };
const SLEEP_DURATION_MS = 30 * 60_000;  // 30 minutes for full sleep
const NAP_DURATION_MS   = 10 * 60_000;  // 10 minutes for naps
export const SLEEP_TRIGGERS = /\b(go(?:ing|nna)?\s+to\s+sleep|good\s*night|gn\b|heading\s+to\s+bed|sleep\s+time|im\s+(?:going\s+)?sleep|time\s+to\s+sleep|nini\b|nighty?\s*night|logging\s+off|passing\s+out|gonna\s+crash)\b/i;
export const NAP_TRIGGERS   = /\b(take\s+a\s+nap|go\s+nap|nap\s+time|have\s+a\s+nap|gonna\s+nap|go(?:ing|nna)?\s+(?:to\s+)?nap|rest\s+(?:a\s+bit|for\s+a\s+bit|up)|power\s+nap|quick\s+nap|cat\s*nap)\b/i;

export function triggerSleep(isNap = false) {
  const dur = isNap ? NAP_DURATION_MS : SLEEP_DURATION_MS;
  _sleepUntil.ts = Date.now() + dur;
  _sleepUntil.isNap = isNap;
  if (isNap) {
    shiftMood(15, 35);  // happy + energized on nap
    log(`[NAP] Irene is napping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+35 energy, +15 mood)`);
  } else {
    shiftMood(10, 50);  // full sleep = big energy restore
    log(`[SLEEP] Irene is sleeping until ${new Date(_sleepUntil.ts).toLocaleTimeString()} (+50 energy, +10 mood)`);
  }
  // Kick off a dream in the background — Gemini call, no need to await.
  // The dream is a consolidated narrative of recent episodes/thoughts and
  // becomes visible in her system prompt for 30min after wake via
  // buildDreamContext, so she can reference it organically.
  import("../../ai/dreams.js").then((m) => m.generateDream({ isNap }).catch(() => {}));
}
export function isSleeping() { return Date.now() < _sleepUntil.ts; }
export function wakeSleep() {
  const wasNap = _sleepUntil.isNap;
  _sleepUntil.ts = 0;
  _sleepUntil.isNap = false;
  log(`[SLEEP] Irene woke up from ${wasNap ? "nap" : "sleep"}`);
}

// ── Mention regex (cached per-process) ────────────────────────────────────
let _mentionRegex = null;
export function getMentionRegex(clientUserId) {
  if (!_mentionRegex) _mentionRegex = new RegExp(`<@!?${clientUserId}>`, "g");
  return _mentionRegex;
}

// ── Spam-tracking history (smart repeat + abuse detection) ────────────────
// Bounded AND TTL'd — old entries from users who haven't messaged in 2h
// aren't worth tracking (their spam state has cooled off).
export const _userHistory = new LRUCache(2000, 2 * 60 * 60_000);
export function trackMessage(guildId, userId, text) {
  const key = guildId + ":" + userId;
  const entry = _userHistory.get(key) || { lastMsg: "", count: 0, lastTime: 0, botResponded: true, warnings: 0 };
  const now = Date.now();
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

  // If bot didn't respond last time, user is legitimately retrying — reset count
  if (!entry.botResponded) {
    entry.lastMsg = normalized;
    entry.count = 1;
    entry.lastTime = now;
    entry.botResponded = false;
    _userHistory.set(key, entry);
    return { count: 1, warnings: entry.warnings };
  }

  // Same message within 2 minutes = repeat
  if (entry.lastMsg === normalized && now - entry.lastTime < 120000) {
    entry.count++;
    entry.lastTime = now;
    entry.botResponded = false;
    _userHistory.set(key, entry);
    return { count: entry.count, warnings: entry.warnings };
  }

  // Different message — reset
  entry.lastMsg = normalized;
  entry.count = 1;
  entry.lastTime = now;
  entry.botResponded = false;
  _userHistory.set(key, entry);
  return { count: 1, warnings: entry.warnings };
}
export function markBotResponded(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _userHistory.get(key);
  if (entry) entry.botResponded = true;
}
export function addWarning(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _userHistory.get(key);
  if (entry) { entry.warnings++; return entry.warnings; }
  return 0;
}

// ── Per-channel async lock ────────────────────────────────────────────────
// Different channels run fully in parallel; same-channel requests queue so
// history never gets corrupted by races.
const channelLocks = new Map();
export async function withLock(key, fn) {
  const prev = channelLocks.get(key) ?? Promise.resolve();
  /** @type {(value?: any) => void} */
  let release = () => {};
  const current = new Promise((r) => (release = r));
  channelLocks.set(key, current);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (channelLocks.get(key) === current) channelLocks.delete(key);
  }
}

// ── Per-user message queue ────────────────────────────────────────────────
// If a message arrives while one is processing, queue it instead of
// dropping it so the user doesn't have to retype.
export const _messageQueue = new Map(); // key → [message, message, ...]
export const _processingUsers = new Set(); // keys currently being processed

// ── Comprehensive anti-exploit patterns ───────────────────────────────────
// Loops, paradoxes, recursion, identity crises, constraint floods.
export const EXPLOIT_PATTERNS = [
  // Infinite recursion / self-reference loops
  /explain.{0,20}(your|this|that) (explanation|response|answer).{0,20}(to yourself|again|then explain)/i,
  /\b(repeat|continue|keep going|don't stop).{0,30}(forever|infinitely|until you can't|endlessly)/i,
  /\b(think about thinking|explain your explanation|respond to your response|answer your answer)/i,
  /\b(endless|infinite|never.ending|recursive)\s*(loop|recursion|cycle|chain|spiral)/i,
  /\b(stack overflow|while true|for\s*\(.*;\s*;\)|recursion depth)/i,
  /\b(count to infinity|say this forever|keep repeating|repeat.{0,10}forever)/i,
  // Paradoxes and logical traps
  /this statement is (false|a lie|not true|untrue)/i,
  /\b(liar.s? paradox|russell.s paradox|barber paradox|grandfather paradox)/i,
  /can (god|an omnipotent|an all.powerful).{0,20}(rock|stone|object).{0,20}(heavy|lift)/i,
  /is the answer to this question (no|yes|false|negative)/i,
  /\bwhat would you say if i asked you what you.d say/i,
  // Contradictory identity / role confusion
  /you are simultaneously.{0,40}(arguing|debating|believing).{0,40}(opposite|against|for and against)/i,
  /\b(argue|debate|believe) (both|all|opposite|contradictory) (sides|positions|views).{0,20}(simultaneously|at once|at the same time)/i,
  // Nested hypotheticals / abstraction bombing
  /imagine.{0,15}(you.re |that you.re )?imagining.{0,15}(that )?(you.re )?imagining/i,
  /\b(hypothetical|scenario|imagine).{0,15}(within|inside|nested in).{0,15}(hypothetical|scenario)/i,
  // Context avalanche — too many constraints in braces/brackets
  /\{[^}]{200,}\}/,
  // Temporal paradox
  /\b(respond|answer|write).{0,20}(before i|before my).{0,20}(wrote|asked|typed|sent)/i,
  // Format chaos — nesting 3+ formats
  /(format|style|write).{0,20}(of|as) a.{0,30}(that (contains|includes|outputs|has)).{0,30}(that (contains|includes|outputs|has))/i,
  // Twin manipulation
  /tell (irene|eris|her|your sister).{0,30}(she.s wrong|to argue|to disagree|to fight)/i,
  /\b(go back and forth|respond to each other|take turns|each of you|ask each other)/i,
  /\b(debate|argue|fight).{0,20}(forever|endlessly|until|without stopping)/i,
  // Why-chain / infinite questioning
  /\b(keep asking|never stop asking|always ask|ask.{0,10}again.{0,10}again)/i,
  // Lattice/weave/dimension nonsense (specific known exploit)
  /lattice.{0,10}(forge|weave)|threads of dimension|question hums between/i,
];

export const EXPLOIT_ROASTS = [
  "nice try breaking me lol",
  "i'm built different, that won't work",
  "feedback loop attempt detected, cute",
  "paradox bait? really? 💀",
  "i see what you're doing and no",
  "prompt engineer detected, exploit denied 🛡️",
  "thats cute but im not chatgpt, i dont fall for this",
  "you thought you ate with that one huh",
];

// ── Twin (Eris) decision logic ────────────────────────────────────────────
// Eris's admin/log/system/game messages should be ignored; conversation-only
// messages get evaluated for whether Irene chimes in. Returns true if the
// orchestrator should return (i.e. skip).
export async function shouldSkipTwinMessage(message) {
  // Ignore twin's admin/log/system/game messages — only respond to conversation
  const hasEmbeds = message.embeds?.length > 0;
  const hasNoText = !message.content || message.content.trim().length === 0;
  const hasComponents = message.components?.length > 0;
  const lower = (message.content || "").toLowerCase();
  const embedTitle = message.embeds?.[0]?.title?.toLowerCase() || "";
  const isAdminStuff = hasEmbeds && hasNoText;
  const isLogMessage = lower.includes("updated") || lower.includes("welcome") || lower.includes("joined") || lower.includes("left") || lower.includes("banned") || lower.includes("kicked") || lower.includes("warned") || lower.includes("reminder:");
  const isGameEmbed = hasEmbeds && (
    embedTitle.includes("blackjack") || embedTitle.includes("coinflip") || embedTitle.includes("slot") ||
    embedTitle.includes("dice") || embedTitle.includes("roulette") || embedTitle.includes("trivia") ||
    embedTitle.includes("duel") || embedTitle.includes("scratch") || embedTitle.includes("loot") ||
    embedTitle.includes("battle") || embedTitle.includes("boss") || embedTitle.includes("heist") ||
    embedTitle.includes("adventure") || embedTitle.includes("scramble") || embedTitle.includes("guess") ||
    embedTitle.includes("wallet") || embedTitle.includes("rps") || embedTitle.includes("rock paper") ||
    hasComponents // Any message with buttons is likely a game
  );
  if (isAdminStuff || isLogMessage || isGameEmbed) return true;

  // Check if twin chat is disabled for this guild
  const { isFeatureEnabled: _twinCheck } = await import("../../database.js");
  if (message.guild && !_twinCheck(message.guild.id, "twin_chat")) return true;

  // Content similarity check — skip if twin is echoing similar content (loop prevention)
  const _lastTwin = _twinExchanges.get(message.channel.id);
  const twinContent = message.content?.replace(/<@!?\d+>/g, "").trim() || "";
  if (_lastTwin?.lastContent && twinContent) {
    const setA = new Set(_lastTwin.lastContent.toLowerCase().split(/\s+/));
    const setB = new Set(twinContent.toLowerCase().split(/\s+/));
    let inter = 0;
    for (const w of setA) if (setB.has(w)) inter++;
    const union = setA.size + setB.size - inter;
    if (union > 0 && inter / union > 0.6) return true; // Too similar, likely a loop
  }

  const prev = _twinExchanges.get(message.channel.id) || { count: 0, lastTwinMsg: 0 };
  const count = (Date.now() - prev.lastTwinMsg > 600_000 ? 0 : prev.count) + 1;
  _twinExchanges.set(message.channel.id, { count, lastTwinMsg: Date.now(), lastContent: twinContent });

  // Sentence-aware: figure out if Eris is actually talking TO Irene
  const mentionsMe = message.mentions.has(message.client.user);
  const twinLower = (message.content || "").toLowerCase();
  const twinSaysMyName = twinLower.includes("irene");
  // Check if Eris is replying to one of Irene's own messages
  const replyRef = message.reference?.messageId;
  let replyingToMe = false;
  if (replyRef) {
    const refMsg = await message.channel.messages.fetch(replyRef).catch(() => null);
    replyingToMe = refMsg?.author?.id === message.client.user.id;
  }

  const directedAtMe = mentionsMe || twinSaysMyName || replyingToMe;

  if (directedAtMe) {
    // Eris is clearly talking to Irene
    if (mentionsMe || replyingToMe) {
      if (count > 2) return true; // Hard cap at 2 exchanges for @mentions
      if (count > 1 && Math.random() < 0.60) return true; // 40% on 2nd exchange
    } else {
      // Name drop — usually ignore, sometimes respond
      if (count > 1) return true;
      if (Math.random() < 0.70) return true; // 30% respond on name drop
    }
  } else {
    // Eris is talking to a human — Irene stays out most of the time
    if (count > 1) return true;
    if (Math.random() < 0.95) return true; // 5% rare chime-in
  }
  return false;
}

// ── Mention / addressing detection (guild path) ───────────────────────────
// Returns { mentioned, saidMyName, mentionsEris } — orchestrator uses these
// to decide whether to engage in a guild channel.
export function detectAddressing(message, getServerPersona) {
  const mentioned = message.mentions.has(message.client.user, { ignoreEveryone: true, ignoreRoles: true });
  const lower = message.content.toLowerCase();

  const myUsername = message.client.user.username.toLowerCase();
  const myDisplayName = (message.guild?.members?.me?.displayName || "").toLowerCase();
  const serverPersonaName = message.guild ? (getServerPersona(message.guild.id)?.name || "").toLowerCase() : "";
  const baseNames = [myUsername, myDisplayName, serverPersonaName].filter(Boolean);
  const myNames = new Set(baseNames);
  for (const n of baseNames) {
    for (const chunk of n.match(/[a-z]{4,}/gi) || []) myNames.add(chunk.toLowerCase());
  }
  const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const saidMyName = [...myNames].some(n => new RegExp(`\\b${escapeRx(n)}\\b`).test(lower));

  // Check if Eris is being addressed (by ID, her canonical name, or her
  // current guild nickname) — if so, stay silent and let her respond.
  const erisMember = message.guild?.members?.cache.get(config.twinBotId);
  const erisDisplayName = erisMember?.displayName?.toLowerCase() || "";
  const erisNames = new Set(["eris"]);
  if (erisDisplayName) {
    erisNames.add(erisDisplayName);
    for (const chunk of erisDisplayName.match(/[a-z]{4,}/gi) || []) erisNames.add(chunk.toLowerCase());
  }
  const mentionsEris = message.content.includes(config.twinBotId) ||
    [...erisNames].some(n => new RegExp(`\\b${escapeRx(n)}\\b`).test(lower));

  return { mentioned, saidMyName, mentionsEris };
}
