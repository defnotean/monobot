// ─── packages/irene/events/messageCreate.js ─────────────────────────────
// THE AI pipeline. Every Discord MESSAGE_CREATE flows through execute() —
// gating gauntlet → auto-mod precedence → context assembly → AI call →
// tool dispatch → render → persist. Auto-mod (rulesEnforcer) runs FIRST
// and short-circuits if it acts.
//
// This file is the THIN ORCHESTRATOR. Each phase lives in
// ./messageCreate/<phase>.js — split from the original 1.5k+ line file to
// make the precedence reorder-resistant. See docs/ai-pipeline-irene.md for
// the 7-stage trace, and ./messageCreate/autoMod.js for the 13-step
// auto-mod precedence comment (do NOT shuffle that order).
//
// Re-exports for external callers (don't break presence.js / tests):
//   - TOOL_CALL_DIRECTIVE (assertion target in tests)
//   - getConversations / preloadConversations (presence.js)
//   - invalidatePersonalityCache (presence.js — invoked on persona reload)

import { MessageFlags, PermissionFlagsBits, ChannelType } from "discord.js";
import config from "../config.js";
import { log } from "../utils/logger.js";
import {
  getTrustedUsers, getGuildSettings, loadConversations, saveConversation,
  getTtsChannels,
} from "../database.js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import { enforceMessage } from "../ai/rulesEnforcer.js";
import { recordMessage as recordEvidenceMessage } from "../utils/messageEvidence.js";
import { checkBudget, incrementBudget, shouldNotify } from "../utils/aiBudget.js";

import {
  processing, _repliedMessages, _twinExchanges,
  isSleeping, wakeSleep,
  withLock, _messageQueue, _processingUsers,
  shouldSkipTwinMessage, detectAddressing,
} from "./messageCreate/gates.js";
import {
  detectExploitOrLoop, detectRepeatSpam, shouldDropBotAuthor,
  applyAiCooldown, runSafetyChecks, exceedsLengthGuard, initFirewall,
} from "./messageCreate/autoMod.js";
import {
  handleCustomCommand, processStickyMessage, processAutoResponders,
  memberIsAdmin,
} from "./messageCreate/commandPrefix.js";
import {
  TOOL_CALL_DIRECTIVE, invalidatePersonalityCache,
  collectImages, buildSystemPrompt, buildUserTurn, stripMention,
  scrubTwinHistoryForRecall, buildChannelAwareness, supplementTwinHistory,
} from "./messageCreate/contextBuild.js";
import {
  activeProviderNeedsGeminiClient, activeProviderLabel,
  getConvClient, getGeminiClient, hasWorkPool,
  applyPromptBudget, wireRateLimitCallbacks,
  looksLikeTask, quickReply,
} from "./messageCreate/aiInvoke.js";
import {
  splitMessage, stripLeakedToolSyntax, resolveAtMentions,
  enforceCharBudget, sendReplyChunks,
} from "./messageCreate/responsePostProcess.js";
import {
  trackAiUsage, trackHumanityState, detectSleepIntent, maybeAutoSleep,
  maybeAfterthought, mirrorToDm, recordEpisode, autoAssignAccessRole,
} from "./messageCreate/analytics.js";

// Re-export so external callers (presence.js, toolCallDirective.test.ts)
// keep working.
export { TOOL_CALL_DIRECTIVE, invalidatePersonalityCache };

let _humanityCounter = 0;
let _modHumanity, _modAfk, _modHighlight, _modLeveling;
const lazyHumanity  = async () => (_modHumanity  ??= await import("../ai/humanity.js"));
const lazyAfk       = async () => (_modAfk       ??= await import("../commands/utility/afk.js"));
const lazyHighlight = async () => (_modHighlight ??= await import("../commands/utility/highlight.js"));
const lazyLeveling  = async () => (_modLeveling  ??= await import("../utils/leveling.js"));
const lazyContextCompressor = async () => (await import("../ai/contextCompressor.js"));

// Conversations: pre-populated from DB on first use via getConversations()
// loadConversations() returns a Map; we lazy-initialize from DB.
let _conversationsLoaded = false;
const conversations = new LRUCache(2000);

export function getConversations() { return conversations; }
export function preloadConversations(map) {
  for (const [k, v] of map) conversations.set(k, v);
  _conversationsLoaded = true;
}

// ─── DM: resolve mutual guild + admin status ─────────────────────────────────
async function resolveDMContext(message) {
  const userId = message.author.id;
  const isBotOwner = userId === config.ownerId;
  let bestGuild = null;
  let isAdmin = false;

  // Check cache first for all guilds in parallel — only fetch from API if not cached.
  // Each iteration re-validates the guild still exists: if the bot was kicked from a
  // guild while this DM event was in-flight, we'd otherwise run permission checks
  // against a defunct guild object and potentially trigger modlog writes to it.
  const guildIds = [...message.client.guilds.cache.keys()];
  const checks = guildIds.map(async (guildId) => {
    const guild = message.client.guilds.cache.get(guildId);
    if (!guild || !guild.members?.me) return null;

    const member = guild.members.cache.get(userId)
      ?? await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;

    // Re-check after the await — bot may have been kicked mid-fetch.
    if (!message.client.guilds.cache.has(guildId)) return null;

    const memberAdmin =
      isBotOwner ||
      member.id === guild.ownerId ||
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      getTrustedUsers(guild.id).includes(member.id);
    return { guild, memberAdmin };
  });

  const results = await Promise.all(checks);
  for (const res of results) {
    if (!res) continue;
    if (!bestGuild || (!isAdmin && res.memberAdmin)) bestGuild = res.guild;
    if (res.memberAdmin) isAdmin = true;
  }

  return { guild: bestGuild, isAdmin };
}

// ─── Main Event Handler ───────────────────────────────────────────────────────
export const name = "messageCreate";

// ─── 1. ENTRY ───────────────────────────────────────────────────────────
export async function execute(message) {
  // ─── 2. GATING ────────────────────────────────────────────────────────
  // Dedup — prevent processing the same message twice (shard replays, gateway bugs)
  if (processing.has(message.id)) return;
  processing.add(message.id);
  setTimeout(() => processing.delete(message.id), 300_000);

  // NEVER process our own messages — prevents self-reply loops
  if (message.author?.id === message.client.user.id) return;

  // Kicked-mid-queue guard: if the bot left/was removed from the guild after
  // this event was queued, bail before touching sendTyping/reply/modLog APIs.
  if (message.guild && !message.client.guilds.cache.has(message.guild.id)) return;
  if (!message.channel) return;

  // Record for the evidence buffer — last N messages per user per guild,
  // attached to ban/kick mod-log embeds if the user is later sanctioned.
  // No-op for DMs, bot messages, and self. Cheap (in-memory LRU).
  recordEvidenceMessage(message);

  // ─── 2a. AUTO-MOD step 1: rules engine ────────────────────────────────
  // Auto-mod rule enforcement — opt-in per guild via `/rules enable`.
  // No-op when disabled; otherwise runs the cheap regex pre-filter, and
  // only if THAT trips, the LLM judge with surrounding context. NEVER
  // throws — auto-mod failure must not break the message pipeline. If an
  // action was taken (delete / warn / timeout), skip the rest of this
  // handler so we don't AI-reply on top of moderating the user.
  const enforcerActed = await enforceMessage(message).catch(() => false);
  if (enforcerActed) return;

  // ─── 2b. AUTO-MOD step 2: sleep mode ──────────────────────────────────
  // Sleep mode — owner can wake her with @mention OR just saying "wake up"
  if (isSleeping()) {
    const isOwner = message.author?.id === config.ownerId;
    const mentioned = message.mentions?.has(message.client.user);
    const saidWakeUp = /\b(wake\s*up|get\s*up|wakey|rise\s*and\s*shine)\b/i.test(message.content);
    if (isOwner && (mentioned || saidWakeUp)) {
      wakeSleep();
      // Instant reply so it doesn't time out going through the full AI pipeline
      await message.reply("im up im up 🥱").catch(() => {});
      return;
    } else {
      return; // Sleeping — ignore
    }
  }

  // TTS: if message is in a VC text chat with TTS enabled, speak it
  if (!message.author.bot && message.guild && (message.channel.type === ChannelType.GuildVoice || message.channel.type === ChannelType.GuildStageVoice)) {
    const ttsChannels = getTtsChannels(message.guild.id);
    if (ttsChannels.includes(message.channel.id) && message.content && !message.content.startsWith("!") && !message.mentions.has(message.client.user)) {
      const { playTTS } = await import("../music/player.js");
      playTTS(message.guild.id, `${message.member?.displayName ?? message.author.username} says: ${message.content}`, message.channel, message.channel)
        .catch((err) => log(`[TTS] Auto-TTS failed: ${err.message}`));
    }
  }

  // Bump-service confirmation detection DISABLED — Eris handles all bumps now.

  // ─── 2c. AUTO-MOD step 3: bot-author handling ─────────────────────────
  // Allow bots that mention us (twin, other bots) — block silent bot messages
  const ERIS_BOT_ID = config.twinBotId;
  const isTwinMsg = message.author.id === ERIS_BOT_ID;
  if (shouldDropBotAuthor(message, isTwinMsg)) return;

  // ─── 2d. AUTO-MOD steps 4-6: loop/exploit/repeat (non-twin only) ──────
  if (!isTwinMsg) {
    const exploit = detectExploitOrLoop(message);
    if (exploit.drop) return;
    if (await detectRepeatSpam(message)) return;
  }

  // Twin interaction — siblings don't respond to every single thing
  if (!isTwinMsg) {
    // Only reset twin counter if human directly mentions us (not just any message in chat)
    const humanMentionsMe = message.mentions.has(message.client.user);
    if (humanMentionsMe) _twinExchanges.set(message.channel.id, { count: 0, lastTwinMsg: Date.now() });
  } else {
    if (await shouldSkipTwinMessage(message)) return;
  }

  // ── Age gate: ignore messages older than 30 s ─────────────────────────────
  // Prevents shard-resume event replays from triggering a second AI response.
  if (Date.now() - message.createdTimestamp > 30_000) return;

  // ── In-process dedup ──────────────────────────────────────────────────────
  // Dedup already handled at top of execute()

  const isDM = !message.guild;
  _humanityCounter++;
  if (_humanityCounter % 100 === 0) lazyHumanity().then(m => m.periodicUpdate()).catch(() => {});

  // ─── 2e. AUTO-MOD step 7: per-user AI cooldown ────────────────────────
  if (applyAiCooldown(message)) return;

  // ─── 2f. AUTO-MOD step 8: word/mention/spam/invite checks (guild only) ─
  if (!isDM) {
    if (await runSafetyChecks(message)) return;
  }

  // ─── 2g. AUTO-MOD step 9: message length guard ────────────────────────
  if (exceedsLengthGuard(message)) return;

  // ─── 2h. AUTO-MOD step 10: injection firewall (parallel kickoff) ──────
  // The verdict is awaited via firewallGate immediately before any
  // AI-derived output reaches the user. Net latency = max(firewall, AI)
  // instead of firewall + AI. If the verdict is "unsafe", the gate
  // replies with the block reason and suppresses the AI output entirely.
  const fw = await initFirewall(message, { isTwinMsg });
  const { firewallPromise, firewallGate, getVerdict: getFirewallVerdict } = fw;

  // ─── 2i. AUTO-MOD step 11: sticky messages ────────────────────────────
  if (!isDM && !message.author.bot) {
    await processStickyMessage(message);
  }

  // ─── 2j. AUTO-MOD step 12: auto-responders ────────────────────────────
  if (!isDM) {
    await processAutoResponders(message);
  }

  // ─── 2k. AUTO-MOD step 13: AFK / highlights / leveling ────────────────
  // ── AFK system (guild only) ─────────────────────────────────────────────
  if (!isDM) {
    lazyAfk().then(({ checkAfkReturn, checkAfkMentions }) => {
      checkAfkReturn(message);
      checkAfkMentions(message);
    }).catch(() => {});
  }

  // ── Highlight word notifications (guild only, non-blocking) ────────────
  if (!isDM) {
    lazyHighlight().then(({ checkHighlights }) => checkHighlights(message).catch(() => {})).catch(() => {});
  }

  // ── XP / Leveling (guild only) ─────────────────────────────────────────
  if (!isDM && message.guild) {
    const { addXp, getLevelSettings, getLevelRewards } = await lazyLeveling();
    const settings = getLevelSettings(message.guild.id);
    if (settings.enabled) {
      const result = addXp(message.guild.id, message.author.id, settings.xpPerMessage);
      if (result?.leveledUp) {
        // Check for role rewards
        const rewards = getLevelRewards(message.guild.id);
        const reward = rewards.find((r) => r.level === result.level);
        if (reward) {
          const role = message.guild.roles.cache.get(reward.roleId);
          if (role) message.member?.roles.add(role).catch(() => {});
        }
        // Announce level up — supports multi-role pinging
        const levelPingIds = Array.isArray(settings.ping_role_ids) ? settings.ping_role_ids : [];
        const levelPingStr = levelPingIds.map((id) => `<@&${id}>`).join(" ");
        const announceText = `${levelPingStr ? levelPingStr + " " : ""}gg ${message.author}, you just hit **level ${result.level}**!${reward ? ` you got the **${message.guild.roles.cache.get(reward.roleId)?.name ?? ""}** role` : ""}`;
        const announceChannel = settings.announceChannel
          ? message.guild.channels.cache.get(settings.announceChannel)
          : message.channel;
        (announceChannel ?? message.channel).send(announceText).catch(() => {});
      }
    }
  }

  // ── DM path ────────────────────────────────────────────────────────────────
  let dmGuild = null;
  let isAdmin = false;

  if (isDM) {
    if (!hasWorkPool() && activeProviderNeedsGeminiClient()) return;
    const ctx = await resolveDMContext(message);
    if (!ctx.guild) {
      await message.reply("we don't share any servers so i can't really do much here — join a server i'm in first").catch((e) => log(`[Error] ${e.message}`));
      return;
    }
    dmGuild = ctx.guild;
    isAdmin = ctx.isAdmin;
  } else {
    // ── Guild path: custom !commands ──────────────────────────────────────
    if (message.content.startsWith("!")) {
      const handled = await handleCustomCommand(message);
      if (handled) return;
    }

    if (!hasWorkPool() && activeProviderNeedsGeminiClient()) return;

    // Respond to @mention, our name in text, or twin sister.
    // Names include guild nickname + server persona + sub-tokens, so a
    // nickname like "Gremlin.exe" also triggers on "Gremlin". Matching
    // happens on alphabetic runs of >=4 chars to avoid false positives
    // on short fragments like "exe" or "bot".
    const { getServerPersona } = await import("../database.js");
    const { mentioned, saidMyName, mentionsEris } = detectAddressing(message, getServerPersona);

    // If message mentions ONLY Eris and NOT us, stay silent (don't steal
    // her messages). If BOTH names are mentioned, respond — user is
    // talking to both or about both.
    if (!mentioned && !saidMyName && !isTwinMsg) return;
    if (!mentioned && !saidMyName && mentionsEris) return;

    // ── Cross-instance dedup: track replied message IDs in-memory ────────────
    // Replaces a 10-message Discord API fetch (300ms+) with a Set lookup (0ms).
    // The Set auto-expires entries after 30s so it never grows unbounded.
    if (_repliedMessages.has(message.id)) return;
    _repliedMessages.add(message.id);
    setTimeout(() => _repliedMessages.delete(message.id), 30_000);

    isAdmin = memberIsAdmin(message.member);
  }

  // ─── AI daily budget ceiling — OPT-IN, default-OFF ────────────────────
  // Placed AFTER the addressing + cross-instance-dedup checks above (and the
  // DM-context resolution) so it only ever fires on a message actually
  // directed at us — mirrors where Eris sits its budget gate (after its own
  // addressing return). If an operator set a per-user or per-guild daily cap
  // (AI_DAILY_USER_CAP / AI_DAILY_GUILD_CAP) and it's been hit, drop the
  // message so a chatty user or small raid can't run up unbounded
  // Gemini/Voyage spend. When no cap is configured this is a pure
  // pass-through (early return inside checkBudget) — the green baseline is
  // unchanged. Owner is exempt. The counter is bumped only just before the AI
  // call actually fires (see incrementBudget below), so dropped messages
  // never count against the cap. The one-time-per-scope-per-UTC-day notice now
  // only lands as a reply to a message that was genuinely addressed to us.
  if (message.author.id !== config.ownerId) {
    const budget = checkBudget({ userId: message.author.id, guildId: message.guild?.id });
    if (budget.exceeded) {
      if (shouldNotify(budget.scope, budget.scope === "guild" ? message.guild?.id : message.author.id)) {
        await message.reply("i've hit my daily chat limit, talk to me again tomorrow 😴").catch(() => {});
      }
      return;
    }
  }

  // Per-user queue — if already processing a message from this user, queue this one
  // Block prompt-injection input after addressing/budget gates but before the
  // LLM sees it or the inline tool dispatcher can execute any model-chosen tool.
  if (!(await firewallGate(async () => {}))) return;

  const userKey = isDM ? `dm-${message.author.id}` : `${message.guild.id}-${message.author.id}`;
  if (_processingUsers.has(userKey)) {
    // Queue it — will be processed after current one finishes
    if (!_messageQueue.has(userKey)) _messageQueue.set(userKey, []);
    const queue = _messageQueue.get(userKey);
    if (queue.length < config.maxQueuedMessages) { // max queued messages per user
      queue.push(message);
      message.react("📝").catch(() => {}); // let them know it's queued
    }
    return;
  }
  _processingUsers.add(userKey);

  try { // try/finally ensures _processingUsers cleanup even on crash

  // Show typing indicator IMMEDIATELY — before any heavy processing
  // (system prompt, memory, personality, sentiment, etc. can take 2-5 seconds)
  const isDMEarly = !message.guild;
  if (!isDMEarly) message.channel.sendTyping().catch(() => {});

  const content = stripMention(message);

  // Collect image attachments + pre-fetch base64 cache
  const { allImageAttachments, images } = await collectImages(message);

  if (!content && !images.length) {
    await message.reply("yo, what's up? need something?").catch((e) => log(`[Error] ${e.message}`));
    return;
  }

  // ── Build guild-aware message proxy for DMs ───────────────────────────────
  const guild = isDM ? dmGuild : message.guild;
  const dmMember = isDM ? await dmGuild.members.fetch(message.author.id).catch(() => null) : null;

  // Proxy so executeTool()/Gemini see message.guild even from a DM
  const msgCtx = isDM
    ? new Proxy(message, {
        get(target, prop) {
          if (prop === "guild") return dmGuild;
          if (prop === "member") return dmMember;
          const val = target[prop];
          return typeof val === "function" ? val.bind(target) : val;
        },
      })
    : message;

  // ─── 3. CONTEXT BUILDING ──────────────────────────────────────────────
  const ctxResult = await buildSystemPrompt(message, {
    isDM, dmGuild, msgCtx, isAdmin, content, images, allImageAttachments,
    isTwinMsg, conversations,
  });
  let systemPromptWithMemory = ctxResult.systemPromptWithMemory;
  const { tools, isBotOwner, isCreator, sentimentScore, mood, safeSpeakerName } = ctxResult;

  // Lazy-load conversation history from DB on first use (Feature 10)
  // Done OUTSIDE the per-channel lock to avoid loading stale data due to
  // the 2-second database save debounce. Only loads once at startup.
  if (!_conversationsLoaded) {
    try {
      const stored = loadConversations();
      for (const [k, v] of stored) if (!conversations.has(k)) conversations.set(k, v);
    } catch (err) {
      log(`[AI] Failed to load conversations from DB: ${err?.message}`);
    }
    _conversationsLoaded = true;
  }

  // Per-CHANNEL history for servers (group conversation awareness), per-user for DMs.
  // The lock is keyed the same way — serializes all responses in a channel so the bot
  // sees the full group conversation flow and never talks over itself.
  const channelKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;

  // Build the user-turn content (text + images, resolved mentions)
  const { userText, userContent } = buildUserTurn({
    message, content, images, allImageAttachments, isTwinMsg, guild, safeSpeakerName,
  });

  // Lock per channel so parallel requests across different channels are fully independent,
  // while same-channel requests queue safely to avoid history corruption.
  await withLock(channelKey, async () => {

  // Init conversation inside the lock to prevent race conditions
  if (!conversations.has(channelKey)) {
    conversations.set(channelKey, []);
  }
  const history = conversations.get(channelKey);

  // For twin messages: convert tool blocks to plain text summaries so the twin
  // knows what happened (awareness) but the AI doesn't re-execute the tools
  if (isTwinMsg) {
    scrubTwinHistoryForRecall(history);

    // Supplement with recent channel context only on first message (prevents duplicates)
    if (history.length === 0) {
      await supplementTwinHistory(message, history, ERIS_BOT_ID);
    }
  }

  // Passive channel awareness — inject the last ~10 messages from OTHER
  // users in this channel as a single compact context block, NOT as history
  // entries. See Eris's messageCreate.js for the full rationale; short
  // version: pushing them as history made the bot try to reply to everyone
  // every turn and confused the addressee.
  let channelContextBlock = "";
  let varietyBlock = "";
  if (!isTwinMsg && !isDM) {
    const blocks = await buildChannelAwareness(message, ERIS_BOT_ID);
    channelContextBlock = blocks.channelContextBlock;
    varietyBlock = blocks.varietyBlock;
  }
  if (channelContextBlock) systemPromptWithMemory += channelContextBlock;
  if (varietyBlock) systemPromptWithMemory += varietyBlock;

  // Snapshot history length BEFORE pushing this turn — used to roll back
  // if the firewall verdict comes back unsafe after the AI has already run
  // (otherwise the injected user message + AI's response would persist in
  // conversation history even though the firewall blocked the reply).
  const _historyLenBeforeTurn = history.length;
  history.push({ role: "user", content: userContent });

  // Progressive history compression — preserves more context than hard-truncation
  // Tier A (recent 3 turns): full detail
  // Tier B (turns 4-8): tool results summarized, bot text truncated
  // Tier C (turns 9+): ultra-compressed one-liners
  // Also handles sanitization of orphaned tool_result blocks.
  const { compressHistory } = await lazyContextCompressor();
  compressHistory(history, config.historyCharBudget || 8000);

  // Status message is created lazily — only when tools are actually called
  /** @type {import("discord.js").Message | null | undefined} */
  let statusMsg = null;

  try {
    const isTask = looksLikeTask(content);
    // Conversational messages use the fast (Flash) AI + conv pool. Tasks use the worker
    // (Pro + thinking) AI + work pool. Both paths still have the full tool surface —
    // if the fast model decides to call a tool, runGeminiChat auto-upgrades to worker.
    const geminiClient = isTask ? getGeminiClient() : (getConvClient() || getGeminiClient());

    if (!geminiClient && activeProviderNeedsGeminiClient()) {
      await message.reply("no AI keys configured — can't respond right now").catch((e) => log(`[Error] ${e.message}`));
      return;
    }

    log(`[Exec] Starting for: ${userText.slice(0, 80)}`);
    /** @type {import("discord.js").Message | null | undefined} */
    let ackMsg = null; // quick acknowledgment message for tasks

    // ── DUAL AI: Fast conversation AI + Background worker AI ────────────
    // If it looks like a task, send an instant contextual acknowledgment
    // while the worker AI processes tools in the background.
    // If it's just chitchat, the main call handles everything.

    let _ackTimer;
    if (isTask && !isDM) {
      // Only send a quick ack if the worker takes more than 2 seconds.
      // This avoids wasting an API call on fast responses.
      message.channel.sendTyping().catch(() => {});
      const ackTimer = setTimeout(async () => {
        if (ackMsg !== null) return; // already handled
        const ack = await quickReply(getConvClient(), systemPromptWithMemory, userText, { guild, channel: message.channel }).catch(() => null);
        if (ack && ackMsg === null) {
          await firewallGate(async () => {
            ackMsg = await message.reply({ content: ack, flags: MessageFlags.SuppressEmbeds }).catch(() => null);
          });
        }
      }, 2000);
      // Store timer so we can cancel if worker finishes fast
      ackMsg = undefined; // sentinel: undefined = no ack yet, null = cancelled
      _ackTimer = ackTimer; // accessible in finally
    } else if (!isDM) {
      await message.channel.sendTyping().catch(() => {});
    }

    const typingInterval = isDM ? null : setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8_000);

    // ── Worker AI — handles conversation + tool calls ────────────────────
    // (humanity context already injected above before ack timer)

    // All tools are loaded with full schemas — no tier 2 catalog needed

    // Wire up per-key rate limit callbacks for the pool that actually owns this client.
    wireRateLimitCallbacks(isTask);

    // Smart prompt budget — trim core personality to make room for runtime context
    systemPromptWithMemory = applyPromptBudget(systemPromptWithMemory);
    // Append the Tier-2 tool catalog AFTER budgeting so the full catalog (often
    // ~15k chars, larger than the budget itself) survives intact — the model
    // dispatches Tier-2 tools by name, so it must see every tool's name here.
    if (ctxResult.tier2Catalog) systemPromptWithMemory += ctxResult.tier2Catalog;

    // ─── 4. AI CALL (dual.js → runGeminiChat — also stage 5 tool dispatch) ─
    // Count this message against the daily AI budget — we're committed to an
    // AI call now (passed gating, queue, empty-content, and client checks).
    // No-op when no cap is configured. Owner exempt, matching the gate above.
    if (message.author.id !== config.ownerId) {
      incrementBudget({ userId: message.author.id, guildId: message.guild?.id });
    }
    const { runGeminiChat } = await import("../ai/providers/index.js");
    let geminiResult;
    const t0Ai = Date.now();
    try {
      geminiResult = await Promise.race([
        runGeminiChat({
          geminiClient,
          systemInstruction: systemPromptWithMemory,
          history,
          tools,
          message: msgCtx,
          isAdmin,
          useFastModel: !isTask,
          onToolStatus: async (rawStatus) => {
            // Only show progress for actual admin/complex tasks — skip for simple tools (gifs, memory, search, etc.)
            if (!isTask) return;

            if (typingInterval) clearInterval(typingInterval);

            // Use fast AI to generate a natural progress update from the raw tool status
            let displayStatus = rawStatus;
            const naturalProgress = await quickReply(
              getConvClient(),
              "You are a progress narrator. Given raw tool execution status, write a SHORT casual update (under 40 words) describing what's happening. Don't use technical terms like 'tool_use' or function names. Write like a person. Examples: 'creating the roles now...', 'almost done, just setting up the reactions', 'found the song, joining your vc'",
              `Raw status:\n${rawStatus}\n\nOriginal request: ${content}`,
              {}
            ).catch(() => null);
            if (naturalProgress) displayStatus = naturalProgress;

            // Update the ack message with progress, or create a new status msg
            await firewallGate(async () => {
              if (ackMsg) {
                await ackMsg.edit(displayStatus.slice(0, 1990)).catch(() => {});
                statusMsg = ackMsg;
                ackMsg = null;
              } else if (!statusMsg && !isDM) {
                statusMsg = /** @type {import("discord.js").Message | null} */ (await /** @type {any} */ (message.channel).send(displayStatus.slice(0, 1990)).catch(() => null));
              } else {
                await statusMsg?.edit(displayStatus.slice(0, 1990)).catch(() => {});
              }
            });
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("AI generation timed out after 600 seconds")), 600_000))
      ]);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      // Cancel ack timer if worker finished before 2s
      if (typeof _ackTimer !== "undefined") { clearTimeout(_ackTimer); ackMsg = null; }
    }

    const aiMs = Date.now() - t0Ai;
    if (aiMs > 5000) log(`[PERF] ${activeProviderLabel()} took ${aiMs}ms (prompt ${systemPromptWithMemory.length} chars, history ${history.length} msgs)`);

    // ─── 6. RESPONSE RENDERING ────────────────────────────────────────────
    const { text: reply, toolsUsed } = geminiResult;
    if (!reply || !reply.trim()) {
      // Rare path: no user-visible output anyway. Resolve firewall verdict
      // for history-hygiene only — if blocked, rewind history.
      if (firewallPromise) {
        const v = await getFirewallVerdict();
        if (!v.safe) history.length = _historyLenBeforeTurn;
      }
      saveConversation(channelKey, history);
      return;
    }

    // Track AI usage for /stats
    trackAiUsage(guild);

    // Clean up: delete ack/status messages — the final reply replaces them.
    // statusMsg/ackMsg are mutated inside the streaming callback above; TS's
    // control-flow analysis can't see closure writes, so re-widen via cast.
    const _statusMsg = /** @type {import("discord.js").Message | null | undefined} */ (statusMsg);
    const _ackMsg = /** @type {import("discord.js").Message | null | undefined} */ (ackMsg);
    await _statusMsg?.delete().catch(() => {});
    if (_ackMsg && toolsUsed) await _ackMsg.delete().catch(() => {});
    // If no tools were used and ack was sent, delete it since the full reply replaces it
    if (_ackMsg && !toolsUsed) await _ackMsg.delete().catch(() => {});

    // Conversation is persisted AFTER the firewall gate clears (below) so a
    // blocked turn doesn't leak the AI's response into next-turn history.

    // Resolve @username mentions in AI response to proper Discord <@id> pings
    // Strip leaked function-call text — model sometimes outputs send_gif(query="x") as plain text
    // instead of (or in addition to) an actual API function call. Remove those lines entirely.
    const cleanedReply = stripLeakedToolSyntax(reply);

    // If reply is now empty after stripping leaked tool syntax, skip sending
    if (!cleanedReply) {
      if (firewallPromise) {
        const v = await getFirewallVerdict();
        if (!v.safe) history.length = _historyLenBeforeTurn;
      }
      saveConversation(channelKey, history);
      return;
    }

    let resolvedReply = resolveAtMentions(cleanedReply, guild, reply);

    // Collapse multi-newlines to single (prevents big unnatural gaps in Discord)
    resolvedReply = resolvedReply.replace(/\n{2,}/g, "\n");

    // Enforce per-turn character budget set during prompt assembly.
    resolvedReply = enforceCharBudget(resolvedReply, message._charBudget);

    const chunks = splitMessage(resolvedReply);

    // Human-timed delivery — realistic typing duration plus occasional
    // mid-reply splits at natural breakpoints.
    const replyDelivered = await firewallGate(async () => {
      await sendReplyChunks(message, chunks);
    });
    if (!replyDelivered) {
      // Firewall blocked — rewind history so the injected user message and
      // the AI's now-suppressed response don't persist for the next turn.
      history.length = _historyLenBeforeTurn;
      saveConversation(channelKey, history);
      return;
    }
    // Persist conversation to DB now that the firewall has cleared the reply.
    saveConversation(channelKey, history);

    // ─── 7. STATE PERSISTENCE ─────────────────────────────────────────────
    await trackHumanityState(message, content, reply, sentimentScore, isCreator);

    // Nap/sleep detection
    const userMsg = content || message.content;
    detectSleepIntent({ message, isAdmin, userMsg, resolvedReply, sentimentScore });

    // Auto-sleep — if energy drops too low, she decides to rest on her own
    await maybeAutoSleep(message);

    // Afterthought — sometimes send a short follow-up like a real person
    maybeAfterthought({ message, resolvedReply, systemPromptWithMemory, isTwinMsg });

    // DM the result too if commands were used
    await mirrorToDm({ toolsUsed, isDM, guild, message, chunks });

    // Long-term memory — extract episodes, update mood narrative
    await recordEpisode({ message, content, reply, sentimentScore });

    // Auto-assign the Irene access role if configured or a role named "Irene" exists
    await autoAssignAccessRole({ isDM, message, guild });
  } catch (error) {
    await /** @type {import("discord.js").Message | null | undefined} */ (statusMsg)?.delete().catch(() => {});
    const errMsg = error?.message ?? String(error);
    const errStatus = error?.status ?? "";
    const errDetail = error?.error?.error?.message ?? error?.error?.message ?? "";
    log(`[ERROR] ${errStatus} ${errMsg} ${errDetail}`);
    log(`[ERROR STACK] ${error?.stack ?? JSON.stringify(error)}`);
    log(`[ERROR] ${errStatus} ${errMsg} ${errDetail}`);
    const errSent = await message.reply("something went wrong, try again in a sec").catch(() => null);
    if (!errSent) await message.channel.send("something went wrong, try again in a sec").catch(() => {});
  }

  }); // end withLock

  } finally {
    // ALWAYS clean up — even if handler crashes
    _processingUsers.delete(userKey);
    const queued = _messageQueue.get(userKey);
    if (queued?.length) {
      const next = queued.shift();
      if (queued.length === 0) _messageQueue.delete(userKey);
      execute(next).catch((err) => {
        log(`[Error] Queued message failed: ${err.message}`);
        _processingUsers.delete(userKey);
      });
    }
  }
}
