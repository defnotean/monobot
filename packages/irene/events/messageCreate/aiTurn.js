import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { saveConversation } from "../../database.js";
import { incrementBudget } from "../../utils/aiBudget.js";
import {
  scrubTwinHistoryForRecall,
  buildChannelAwareness,
  supplementTwinHistory,
} from "./contextBuild.js";
import {
  activeProviderNeedsGeminiClient,
  activeProviderLabel,
  getConvClient,
  getGeminiClient,
  applyPromptBudget,
  wireRateLimitCallbacks,
  looksLikeTask,
} from "./aiInvoke.js";
import {
  splitMessage,
  stripLeakedToolSyntax,
  resolveAtMentions,
  enforceCharBudget,
  sendReplyChunks,
} from "./responsePostProcess.js";
import {
  trackAiUsage,
  trackHumanityState,
  detectSleepIntent,
  maybeAutoSleep,
  maybeAfterthought,
  mirrorToDm,
  recordEpisode,
  autoAssignAccessRole,
} from "./analytics.js";
import {
  createAckStatusState,
  startAckTimer,
  createToolStatusHandler,
  cancelAckTimer,
  cleanupAckStatus,
  deleteStatusOnError,
} from "./ackStatus.js";

let _modContextCompressor;
const lazyContextCompressor = async () => (_modContextCompressor ??= await import("../../ai/contextCompressor.js"));

export async function runLockedAiTurn({
  message,
  isDM,
  isTwinMsg,
  isAdmin,
  guild,
  content,
  ERIS_BOT_ID,
  conversations,
  channelKey,
  systemPromptWithMemory,
  ctxResult,
  userText,
  userContent,
  msgCtx,
  firewallPromise,
  firewallGate,
  getFirewallVerdict,
  typingRefresh,
}) {
  if (!conversations.has(channelKey)) {
    conversations.set(channelKey, []);
  }
  const history = conversations.get(channelKey);

  if (isTwinMsg) {
    scrubTwinHistoryForRecall(history);

    if (history.length === 0) {
      await supplementTwinHistory(message, history, ERIS_BOT_ID);
    }
  }

  let channelContextBlock = "";
  let varietyBlock = "";
  if (!isTwinMsg && !isDM) {
    const blocks = await buildChannelAwareness(message, ERIS_BOT_ID);
    channelContextBlock = blocks.channelContextBlock;
    varietyBlock = blocks.varietyBlock;
  }
  if (channelContextBlock) systemPromptWithMemory += channelContextBlock;
  if (varietyBlock) systemPromptWithMemory += varietyBlock;

  const historyLenBeforeTurn = history.length;
  history.push({ role: "user", content: userContent });

  const { compressHistory } = await lazyContextCompressor();
  compressHistory(history, config.historyCharBudget || 8000);

  const ackStatus = createAckStatusState();
  const { tools, sentimentScore, isCreator } = ctxResult;

  try {
    const isTask = looksLikeTask(content);
    const geminiClient = isTask ? getGeminiClient() : (getConvClient() || getGeminiClient());

    if (!geminiClient && activeProviderNeedsGeminiClient()) {
      await message.reply("no AI keys configured — can't respond right now").catch((e) => log(`[Error] ${e.message}`));
      return;
    }

    log(`[Exec] Starting for: ${userText.slice(0, 80)}`);

    startAckTimer(ackStatus, { isTask, isDM, message, guild, systemPromptWithMemory, userText, firewallGate });

    wireRateLimitCallbacks(isTask);
    systemPromptWithMemory = applyPromptBudget(systemPromptWithMemory);
    if (ctxResult.tier2Catalog) systemPromptWithMemory += ctxResult.tier2Catalog;

    if (message.author.id !== config.ownerId) {
      incrementBudget({ userId: message.author.id, guildId: message.guild?.id });
    }

    const { runGeminiChat } = await import("../../ai/providers/index.js");
    let geminiResult;
    const t0Ai = Date.now();
    try {
      geminiResult = await Promise.race([
        runGeminiChat({
          geminiClient,
          systemInstruction: systemPromptWithMemory,
          history,
          tools,
          routerToolNames: ctxResult.tier2ToolNames || [],
          message: msgCtx,
          isAdmin,
          useFastModel: !isTask,
          onToolStatus: createToolStatusHandler(ackStatus, { isTask, isDM, message, content, firewallGate }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("AI generation timed out after 600 seconds")), 600_000)),
      ]);
    } finally {
      cancelAckTimer(ackStatus);
    }

    const aiMs = Date.now() - t0Ai;
    if (aiMs > 5000) log(`[PERF] ${activeProviderLabel()} took ${aiMs}ms (prompt ${systemPromptWithMemory.length} chars, history ${history.length} msgs)`);

    const { text: reply, toolsUsed } = geminiResult;
    if (!reply || !reply.trim()) {
      if (firewallPromise) {
        const v = await getFirewallVerdict();
        if (!v.safe) history.length = historyLenBeforeTurn;
      }
      saveConversation(channelKey, history);
      return;
    }

    trackAiUsage(guild);
    await cleanupAckStatus(ackStatus, toolsUsed);

    const cleanedReply = stripLeakedToolSyntax(reply);
    if (!cleanedReply) {
      if (firewallPromise) {
        const v = await getFirewallVerdict();
        if (!v.safe) history.length = historyLenBeforeTurn;
      }
      saveConversation(channelKey, history);
      return;
    }

    let resolvedReply = resolveAtMentions(cleanedReply, guild, reply);
    resolvedReply = resolvedReply.replace(/\n{2,}/g, "\n");
    resolvedReply = enforceCharBudget(resolvedReply, message._charBudget);

    const chunks = splitMessage(resolvedReply);
    const replyDelivered = await firewallGate(async () => {
      typingRefresh.current?.();
      typingRefresh.current = null;
      await sendReplyChunks(message, chunks);
    });
    if (!replyDelivered) {
      history.length = historyLenBeforeTurn;
      saveConversation(channelKey, history);
      return;
    }

    saveConversation(channelKey, history);

    await trackHumanityState(message, content, reply, sentimentScore, isCreator);
    const userMsg = content || message.content;
    detectSleepIntent({ message, isAdmin, userMsg, resolvedReply, sentimentScore });
    await maybeAutoSleep(message);
    maybeAfterthought({ message, resolvedReply, systemPromptWithMemory, isTwinMsg });
    await mirrorToDm({ toolsUsed, isDM, guild, message, chunks });
    await recordEpisode({ message, content, reply, sentimentScore });
    await autoAssignAccessRole({ isDM, message, guild });
  } catch (error) {
    await deleteStatusOnError(ackStatus);
    const errMsg = error?.message ?? String(error);
    const errStatus = error?.status ?? "";
    const errDetail = error?.error?.error?.message ?? error?.error?.message ?? "";
    log(`[ERROR] ${errStatus} ${errMsg} ${errDetail}`);
    log(`[ERROR STACK] ${error?.stack ?? JSON.stringify(error)}`);
    log(`[ERROR] ${errStatus} ${errMsg} ${errDetail}`);
    const errSent = await message.reply("something went wrong, try again in a sec").catch(() => null);
    if (!errSent) await message.channel.send("something went wrong, try again in a sec").catch(() => {});
  }
}
