// Generic OpenAI-compatible chat-completions provider.

import { classifyProviderError, createOpenAICompatProvider } from "@defnotean/shared/openaiCompat";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { executeTool, postDeferralIfNeeded } from "../executor.js";
import { TOOL_ALIASES } from "../toolAliases.js";
import { registry } from "../toolRegistry.js";
import { toolCoachingBlock } from "../toolCoaching.js";

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder|karaoke|lyrics|music|queue|volume|filter)\b/i;

const provider = createOpenAICompatProvider({
  getConfig: () => config,
  log,
  resolveAlias: (name) => Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name,
  getDeclaration: (name) => registry.getDeclaration(name),
  taskKeywordPattern: TASK_KEYWORDS,
  historyFlavor: "anthropic",
  defaultExecutor: (toolName, toolArgs, msgCtx) => executeTool(toolName, toolArgs, msgCtx, { aiInitiated: true }),
  postProcessToolResult: (raw, { message }) => postDeferralIfNeeded(raw, message?.channel),
  toolCoachingBlock,
  botLabel: "Irene",
});

export { classifyProviderError };
export const quickReply = provider.quickReply;
export const toOpenAICompatTools = provider.toOpenAICompatTools;
export const toGeminiTools = provider.toOpenAICompatTools;
export const looksLikeTask = provider.looksLikeTask;
export const setRateLimitCallbacks = provider.setRateLimitCallbacks;
export const isRateLimited = provider.isRateLimited;

export function runOpenAICompatChat(arg1, ...rest) {
  if (typeof arg1 === "object" && arg1 && (arg1.systemInstruction || arg1.history)) {
    return provider.runOpenAICompatChat({ ...arg1, persistHistory: true });
  }

  const legacyOptions = rest[5] || {};
  return provider.runOpenAICompatChat({
    systemInstruction: rest[0],
    tools: rest[1],
    history: rest[2],
    message: { userMessage: rest[3] },
    executor: rest[4],
    useFastModel: legacyOptions.useFastModel,
    routerToolNames: legacyOptions.routerToolNames,
    onToolStatus: legacyOptions.onToolStatus,
    persistHistory: false,
  });
}

export const runGeminiChat = runOpenAICompatChat;
