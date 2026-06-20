// Irene MESSAGE_CREATE orchestrator.
// Gating and passive features stay ordered here; heavy behavior lives in
// ./messageCreate/* modules so the sequence is easier to audit.

import config from "../config.js";
import { log } from "../utils/logger.js";
import {
  loadConversations,
  getServerPersona,
  isAiSilencedChannel,
  setAiSilencedChannel,
} from "../database.js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import { enforceMessage } from "../ai/rulesEnforcer.js";
import { recordMessage as recordEvidenceMessage } from "../utils/messageEvidence.js";
import { checkBudget, shouldNotify } from "../utils/aiBudget.js";

import {
  processing, _repliedMessages, _twinExchanges,
  withLock, _messageQueue, _processingUsers,
  shouldSkipTwinMessage, detectAddressing, detectChannelAiSilenceCommand,
} from "./messageCreate/gates.js";
import {
  detectExploitOrLoop, detectRepeatSpam, shouldDropBotAuthor,
  applyAiCooldown, runSafetyChecks, exceedsLengthGuard, initFirewall,
} from "./messageCreate/autoMod.js";
import {
  handleCustomCommand, memberIsAdmin,
} from "./messageCreate/commandPrefix.js";
import {
  TOOL_CALL_DIRECTIVE, invalidatePersonalityCache,
  collectImages, buildSystemPrompt, buildUserTurn, stripMention,
  resolveDMContext, buildMessageContext,
} from "./messageCreate/contextBuild.js";
import {
  activeProviderNeedsGeminiClient, hasWorkPool,
} from "./messageCreate/aiInvoke.js";
import {
  handleSleepWake, maybeAutoTts, runPassiveSideEffects,
  handleTtsToggleShortcut, maybeFixTikTokLinks,
} from "./messageCreate/passiveFeatures.js";
import { runLockedAiTurn } from "./messageCreate/aiTurn.js";

export { TOOL_CALL_DIRECTIVE, invalidatePersonalityCache };

let _humanityCounter = 0;
let _modHumanity;
const lazyHumanity = async () => (_modHumanity ??= await import("../ai/humanity.js"));
const TYPING_REFRESH_MS = 4_000;
const MAX_TYPING_REFRESH_MS = 11 * 60_000;

function startTypingRefresh(channel, { intervalMs = TYPING_REFRESH_MS, maxMs = MAX_TYPING_REFRESH_MS } = {}) {
  if (!channel || typeof channel.sendTyping !== "function") return () => {};
  let interval = null;
  let timeout = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
    interval = null;
    timeout = null;
  };
  const tick = () => {
    if (!stopped) channel.sendTyping().catch(() => {});
  };

  tick();
  interval = setInterval(tick, intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  timeout = setTimeout(stop, maxMs);
  if (typeof timeout.unref === "function") timeout.unref();
  return stop;
}

let _conversationsLoaded = false;
const conversations = new LRUCache(2000);

export function getConversations() { return conversations; }
export function preloadConversations(map) {
  for (const [k, v] of map) conversations.set(k, v);
  _conversationsLoaded = true;
}

export const name = "messageCreate";

export async function execute(message) {
  if (processing.has(message.id)) return;
  processing.add(message.id);
  setTimeout(() => processing.delete(message.id), 300_000);

  if (message.author?.id === message.client.user.id) return;
  if (message.guild && !message.client.guilds.cache.has(message.guild.id)) return;
  if (!message.channel) return;

  recordEvidenceMessage(message);

  const enforcerActed = await enforceMessage(message).catch(() => false);
  if (enforcerActed) return;

  if (await handleSleepWake(message)) return;
  await maybeAutoTts(message);

  const ERIS_BOT_ID = config.twinBotId;
  const isTwinMsg = message.author.id === ERIS_BOT_ID;
  if (shouldDropBotAuthor(message, isTwinMsg)) return;

  if (!isTwinMsg) {
    const exploit = detectExploitOrLoop(message);
    if (exploit.drop) return;
    if (await detectRepeatSpam(message)) return;
  }

  if (!isTwinMsg) {
    const humanMentionsMe = message.mentions.has(message.client.user);
    if (humanMentionsMe) _twinExchanges.set(message.channel.id, { count: 0, lastTwinMsg: Date.now() });
  } else if (await shouldSkipTwinMessage(message)) {
    return;
  }

  if (Date.now() - message.createdTimestamp > 30_000) return;

  const isDM = !message.guild;
  if (!isDM) {
    const silenceAction = detectChannelAiSilenceCommand(message, getServerPersona);
    const canControlChannelAi = message.author.id === config.ownerId || memberIsAdmin(message.member);
    if (silenceAction) {
      if (canControlChannelAi) {
        setAiSilencedChannel(message.guild.id, message.channel.id, silenceAction === "silence");
        await message.react("✅").catch(() => {});
      }
      return;
    }
    if (isAiSilencedChannel(message.guild.id, message.channel.id)) return;
  }

  if (await maybeFixTikTokLinks(message)) return;

  _humanityCounter++;
  if (_humanityCounter % 100 === 0) lazyHumanity().then(m => m.periodicUpdate()).catch(() => {});

  if (applyAiCooldown(message)) return;
  if (!isDM && await runSafetyChecks(message)) return;
  if (exceedsLengthGuard(message)) return;

  const fw = await initFirewall(message, { isTwinMsg });
  const { firewallPromise, firewallGate, getVerdict: getFirewallVerdict } = fw;

  await runPassiveSideEffects({ message, isDM });

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
    if (message.content.startsWith("!")) {
      const handled = await handleCustomCommand(message);
      if (handled) return;
    }

    if (!hasWorkPool() && activeProviderNeedsGeminiClient()) return;

    const { mentioned, saidMyName, mentionsEris } = detectAddressing(message, getServerPersona);
    if (!mentioned && !saidMyName && !isTwinMsg) return;
    if (!mentioned && !saidMyName && mentionsEris) return;

    if (_repliedMessages.has(message.id)) return;
    _repliedMessages.add(message.id);
    setTimeout(() => _repliedMessages.delete(message.id), 30_000);

    isAdmin = memberIsAdmin(message.member);
  }

  if (message.author.id !== config.ownerId) {
    const budget = checkBudget({ userId: message.author.id, guildId: message.guild?.id });
    if (budget.exceeded) {
      if (shouldNotify(budget.scope, budget.scope === "guild" ? message.guild?.id : message.author.id)) {
        await message.reply("i've hit my daily chat limit, talk to me again tomorrow 😴").catch(() => {});
      }
      return;
    }
  }

  if (!(await firewallGate(async () => {}))) return;

  const userKey = isDM ? `dm-${message.author.id}` : `${message.guild.id}-${message.author.id}`;
  if (_processingUsers.has(userKey)) {
    if (!_messageQueue.has(userKey)) _messageQueue.set(userKey, []);
    const queue = _messageQueue.get(userKey);
    if (queue.length < config.maxQueuedMessages) {
      queue.push(message);
      message.react("📝").catch(() => {});
    }
    return;
  }
  _processingUsers.add(userKey);

  /** @type {{ current: null | (() => void) }} */
  const typingRefresh = { current: null };
  try {
    typingRefresh.current = startTypingRefresh(message.channel);

    const content = stripMention(message);
    if (await handleTtsToggleShortcut({ message, content, isDM, isAdmin })) return;

    const { allImageAttachments, images, imageDescriptions, imageDescriptionBlock } = await collectImages(message);
    if (!content && !allImageAttachments.length) {
      await message.reply("yo, what's up? need something?").catch((e) => log(`[Error] ${e.message}`));
      return;
    }

    const { guild, msgCtx } = await buildMessageContext(message, { isDM, dmGuild });
    const ctxResult = await buildSystemPrompt(message, {
      isDM, dmGuild, msgCtx, isAdmin, content, images, allImageAttachments,
      imageDescriptions, imageDescriptionBlock, isTwinMsg, conversations,
    });

    let systemPromptWithMemory = ctxResult.systemPromptWithMemory;
    const { safeSpeakerName } = ctxResult;

    if (!_conversationsLoaded) {
      try {
        const stored = loadConversations();
        for (const [k, v] of stored) if (!conversations.has(k)) conversations.set(k, v);
      } catch (err) {
        log(`[AI] Failed to load conversations from DB: ${err?.message}`);
      }
      _conversationsLoaded = true;
    }

    const channelKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;
    const { userText, userContent } = buildUserTurn({
      message, content, images, allImageAttachments, imageDescriptionBlock, isTwinMsg, guild, safeSpeakerName,
    });

    await withLock(channelKey, async () => {
      await runLockedAiTurn({
        message, isDM, isTwinMsg, isAdmin, guild, content, ERIS_BOT_ID,
        conversations, channelKey, systemPromptWithMemory, ctxResult,
        userText, userContent, msgCtx, firewallPromise, firewallGate,
        getFirewallVerdict, typingRefresh,
      });
    });
  } finally {
    typingRefresh.current?.();
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
