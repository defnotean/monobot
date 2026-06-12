// Generic OpenAI-compatible chat-completions provider.

import { createOpenAICompatProvider } from "@defnotean/shared/openaiCompat";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { TOOL_ALIASES } from "../executor.js";
import { registry } from "../toolRegistry.js";
import { toolCoachingBlock } from "../toolCoaching.js";

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder)\b/i;

const provider = createOpenAICompatProvider({
  getConfig: () => config,
  log,
  resolveAlias: (name) => Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name,
  getDeclaration: (name) => registry.getDeclaration(name),
  taskKeywordPattern: TASK_KEYWORDS,
  quickReplyAutoSend: true,
  historyFlavor: "gemini",
  toolCoachingBlock,
  botLabel: "Eris",
  chatFailureMode: "auth-message",
  toolTimeoutKeys: ["slowTool", "toolSlow", "workerSlow", "worker"],
  chatTimeoutKeys: ["worker"],
});

export const quickReply = provider.quickReply;
export const toOpenAICompatTools = provider.toOpenAICompatTools;
export const toGeminiTools = provider.toOpenAICompatTools;
export const looksLikeTask = provider.looksLikeTask;
export const setRateLimitCallbacks = provider.setRateLimitCallbacks;
export const isRateLimited = provider.isRateLimited;

export function runOpenAICompatChat(_client, systemInstruction, tools, history, userMessage, executor, options = {}) {
  return provider.runOpenAICompatChat({
    systemInstruction,
    tools,
    history,
    message: { userMessage },
    executor,
    useFastModel: options?.useFastModel,
    routerToolNames: options?.routerToolNames,
    onToolStatus: options?.onToolStatus,
    persistHistory: true,
  });
}

export const runGeminiChat = runOpenAICompatChat;
