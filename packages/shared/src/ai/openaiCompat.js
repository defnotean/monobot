// @ts-nocheck - This factory intentionally accepts bot-local message, tool,
// history, and executor shapes; focused provider tests cover the public contract.
// Generic OpenAI-compatible chat-completions provider factory.

import { stripReasoning } from "./stripReasoning.js";
import { routeCatalogTool, routeRescuedToolCall, withRouterTool } from "./toolRouter.js";

const DEFAULT_TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder)\b/i;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

const WEB_SEARCH_INTENT_WORDS = new Set([
  "a", "an", "about", "account", "are", "called", "creator", "define", "definition",
  "does", "for", "from", "get", "info", "information", "is", "lookup", "meaning",
  "named", "of", "on", "person", "profile", "search", "slang", "someone", "somebody",
  "the", "to", "user", "was", "were", "what", "who", "with",
]);

function noop() {}

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function webSearchCacheKey(fnName, fnArgs) {
  if (fnName !== "web_search") return "";
  const query = typeof fnArgs?.query === "string" ? fnArgs.query : "";
  const tokens = query
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !WEB_SEARCH_INTENT_WORDS.has(token));
  return tokens.join(" ");
}

function sanitizeForOpenAI(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeForOpenAI);

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["$schema", "additionalProperties", "allOf", "anyOf", "default", "format", "oneOf"].includes(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      cleaned.type = value.filter((t) => t !== "null")[0] || "string";
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      cleaned.enum = value.map(String);
      continue;
    }
    cleaned[key] = sanitizeForOpenAI(value);
  }
  return cleaned;
}

function trimNoMidWord(text, max) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  const slice = raw.slice(0, max);
  const trimmed = slice.replace(/\s+\S*$/, "");
  return (trimmed || slice).trim();
}

function firstSentence(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = raw.match(/^.*?(?:[.!?](?:\s|$)|$)/);
  return (match?.[0] || raw).trim();
}

function compactToolDescription(text) {
  return trimNoMidWord(firstSentence(text), 160);
}

function compactParamDescriptions(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(compactParamDescriptions);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === "description" && typeof value === "string"
      ? trimNoMidWord(value, 80)
      : compactParamDescriptions(value);
  }
  return out;
}

function compactOpenAITool(tool) {
  return {
    ...tool,
    function: {
      ...tool.function,
      description: compactToolDescription(tool.function?.description || ""),
      parameters: compactParamDescriptions(tool.function?.parameters || { type: "object", properties: {} }),
    },
  };
}

function getFinishReason(choice) {
  return choice?.finish_reason || choice?.finishReason || null;
}

function fallbackForFinishReason(reason, hasToolResults) {
  if (reason === "content_filter") return "i can't help with that request";
  if (reason === "length") return hasToolResults ? "i ran the tool, but got cut off finishing the answer. try again in a sec" : "i got cut off thinking there, try again in a sec";
  return "";
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      if (!block) return "";
      if (typeof block === "string") return block;
      if (block.type === "text") return block.text || "";
      if (block.text) return block.text;
      if (block.type === "image") return "[image attached]";
      if (block.type === "tool_use") return `[tool call: ${block.name}]`;
      if (block.type === "tool_result") return `[tool result: ${block.tool_name || block.tool_use_id}] ${textFromContent(block.content)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyToolContent(content, limit = 2500) {
  let text;
  if (typeof content === "string") {
    text = content;
  } else {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  return (text || "").slice(0, limit);
}

function appendGeminiStyleToolHistory(history, msg, slots, botLabel) {
  if (!Array.isArray(history) || !slots?.length) return;

  const assistantParts = [];
  const visibleText = textFromContent(msg?.content).trim();
  if (visibleText) assistantParts.push({ text: `[${botLabel} said]\n${visibleText}`.slice(0, 1900) });
  else assistantParts.push({ text: `[${botLabel} said]` });

  for (const slot of slots) {
    if (slot.parseError) continue;
    assistantParts.push({
      functionCall: {
        name: slot.fnName || "unknown_tool",
        args: slot.fnArgs || {},
        _id: String(slot.call?.id || `${slot.fnName || "tool"}_${Date.now()}`),
      },
    });
  }

  history.push({ role: "model", parts: assistantParts });

  const responseParts = slots.map((slot) => ({
    functionResponse: {
      name: slot.fnName || "unknown_tool",
      response: { result: stringifyToolContent(slot.resultContent, 900) },
      _id: String(slot.call?.id || `${slot.fnName || "tool"}_${Date.now()}`),
    },
  }));
  history.push({ role: "user", parts: responseParts });
}

function appendAnthropicToolHistory(history, msg, slots) {
  if (!Array.isArray(history) || !slots?.length) return;

  const assistantContent = [];
  const visibleText = textFromContent(msg?.content).trim();
  if (visibleText) assistantContent.push({ type: "text", text: visibleText.slice(0, 1900) });

  for (const slot of slots) {
    assistantContent.push({
      type: "tool_use",
      id: String(slot.call?.id || `${slot.fnName || "tool"}_${Date.now()}`),
      name: slot.fnName || "unknown_tool",
      input: slot.parseError ? {} : (slot.fnArgs || {}),
    });
  }

  history.push({ role: "assistant", content: assistantContent });
  history.push({
    role: "user",
    content: slots.map((slot) => ({
      type: "tool_result",
      tool_use_id: String(slot.call?.id || `${slot.fnName || "tool"}_result`),
      tool_name: slot.fnName || "unknown_tool",
      content: stringifyToolContent(slot.resultContent),
    })),
  });
}

function messagesFromContentTurn(turn, role) {
  const out = [];
  const textParts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of turn.content) {
    if (!block) continue;
    if (typeof block === "string") { textParts.push(block); continue; }
    if (block.type === "text" && block.text) textParts.push(block.text);
    else if (block.type === "image") textParts.push("[image attached]");
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || `${block.name || "tool"}_${toolCalls.length}`),
        type: "function",
        function: {
          name: block.name || "unknown_tool",
          arguments: JSON.stringify(block.input || {}),
        },
      });
    } else if (block.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id || block.id || `${block.tool_name || "tool"}_result`),
        content: stringifyToolContent(block.content),
      });
    } else if (block.text) {
      textParts.push(block.text);
    }
  }
  if (role === "assistant") {
    if (textParts.length || toolCalls.length) {
      const msg = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  } else if (textParts.length) {
    out.push({ role: "user", content: textParts.join("\n") });
  }
  for (const tr of toolResults) out.push(tr);
  return out;
}

function messagesFromPartsTurn(turn, role) {
  const out = [];
  const textParts = [];
  const toolCalls = [];
  const toolResults = [];
  let i = 0;
  for (const part of turn.parts) {
    if (!part) continue;
    if (part.text) textParts.push(part.text);
    else if (part.functionCall) {
      const fc = part.functionCall;
      toolCalls.push({
        id: String(fc._id || `${fc.name || "tool"}_${i++}`),
        type: "function",
        function: {
          name: fc.name || "unknown_tool",
          arguments: JSON.stringify(fc.args || {}),
        },
      });
    } else if (part.functionResponse) {
      const fr = part.functionResponse;
      const resp = fr.response || {};
      toolResults.push({
        role: "tool",
        tool_call_id: String(fr._id || `${fr.name || "tool"}_${i++}`),
        content: stringifyToolContent(resp.result ?? resp, 900),
      });
    }
  }
  if (role === "assistant") {
    if (textParts.length || toolCalls.length) {
      const msg = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  } else if (textParts.length) {
    out.push({ role: "user", content: textParts.join("\n") });
  }
  for (const tr of toolResults) out.push(tr);
  return out;
}

function turnToMessages(turn, historyReadOrder) {
  const role = turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";
  if (historyReadOrder === "parts-first" && Array.isArray(turn.parts)) return messagesFromPartsTurn(turn, role);
  if (Array.isArray(turn.content)) return messagesFromContentTurn(turn, role);
  if (Array.isArray(turn.parts)) return messagesFromPartsTurn(turn, role);

  const text = textFromContent(turn.content);
  return text ? [{ role, content: text }] : [];
}

function toMessages(systemInstruction, history, userMessage, historyReadOrder = "content-first") {
  const messages = [{ role: "system", content: systemInstruction || "" }];
  for (const turn of history || []) {
    for (const m of turnToMessages(turn, historyReadOrder)) messages.push(m);
  }

  const last = messages[messages.length - 1];
  if (userMessage && (!last || last.role !== "user" || !last.content?.includes(String(userMessage).slice(0, 60)))) {
    messages.push({ role: "user", content: String(userMessage) });
  }

  return messages;
}

function buildBody({ oc, model, messages, tools }) {
  const body = {
    model,
    messages,
    stream: false,
  };
  if (Number.isFinite(oc.maxTokens) && oc.maxTokens > 0) body.max_tokens = oc.maxTokens;
  if (Number.isFinite(oc.temperature)) body.temperature = oc.temperature;
  if (Number.isFinite(oc.topP)) body.top_p = oc.topP;
  if (tools?.length) {
    body.tools = tools;
    if (oc.toolChoice !== "none") body.tool_choice = oc.toolChoice || "auto";
  }
  if (oc.extraBody && typeof oc.extraBody === "object" && !Array.isArray(oc.extraBody)) {
    for (const [key, value] of Object.entries(oc.extraBody)) {
      if (key === "messages" || key === "tools" || key === "model") continue;
      body[key] = value;
    }
  }
  return body;
}

export function classifyProviderError(err) {
  const status = err?.status;
  const message = String(err?.message || "").toLowerCase();
  if (status === 401 || status === 403) return { shouldFallback: false, label: `auth-${status}` };
  if (status === 429) return { shouldFallback: true, label: "rate-limit-429" };
  if (typeof status === "number" && status >= 500) return { shouldFallback: true, label: `server-${status}` };
  if (typeof status === "number" && status >= 400) return { shouldFallback: false, label: `client-${status}` };
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || message.includes("timeout") || message.includes("aborted")) {
    return { shouldFallback: true, label: "timeout" };
  }
  return { shouldFallback: true, label: "network" };
}

function classifyLegacyError(err) {
  if (err?.status === 401 || err?.status === 403) return "auth";
  if (err?.status === 429) return "rate-limit";
  if (typeof err?.status === "number" && err.status >= 500) return "server";
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || String(err?.message || "").toLowerCase().includes("timeout")) return "timeout";
  return "error";
}

function valueFromKeys(source, keys, fallback) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

export function createOpenAICompatProvider(deps = {}) {
  const {
    getConfig,
    log = noop,
    resolveAlias = (name) => name,
    getDeclaration = () => null,
    taskKeywordPattern = DEFAULT_TASK_KEYWORDS,
    quickReplyAutoSend = false,
    historyFlavor = "none",
    defaultExecutor = null,
    postProcessToolResult = null,
    toolCoachingBlock = null,
    botLabel = "Assistant",
    chatFailureMode = "fallback-shape",
    toolTimeoutKeys = ["toolSlow", "workerSlow", "worker"],
    toolTimeoutForName = null,
    chatTimeoutKeys = ["workerSlow", "worker"],
    historyReadOrder = historyFlavor === "gemini" ? "parts-first" : "content-first",
  } = deps;
  if (typeof getConfig !== "function") {
    throw new Error("createOpenAICompatProvider: getConfig function is required");
  }

  let apiKeyCursor = 0;
  let consecutiveFailures = 0;
  let lastFailureAt = 0;
  let onRateLimit = null;
  let onSuccess = null;
  const toolCache = new WeakMap();

  function runtime() {
    const config = getConfig() || {};
    return {
      config,
      oc: config.openaiCompat || {},
      timeouts: config.timeouts || {},
    };
  }

  function providerName(oc) {
    return oc.providerName || "OpenAICompat";
  }

  function toOpenAICompatTools(tools) {
    const { oc } = runtime();
    if (!tools || !tools.length) return undefined;
    const compactSchemas = Boolean(oc.compactSchemas);
    const cached = toolCache.get(tools);
    if (cached?.compactSchemas === compactSchemas) return cached.result;

    if (tools[0]?.type === "function" && tools[0]?.function?.name) {
      const result = compactSchemas ? tools.map(compactOpenAITool) : tools;
      toolCache.set(tools, { compactSchemas, result });
      return result;
    }

    let raw = tools;
    if (tools[0]?.functionDeclarations) {
      raw = tools.flatMap((t) => t.functionDeclarations || []);
    }

    const result = raw
      .filter((tool) => tool && tool.name)
      .map((tool) => {
        const functionDecl = {
          name: tool.name,
          description: tool.description || "",
          parameters: sanitizeForOpenAI(tool.input_schema || tool.parameters) || { type: "object", properties: {} },
        };
        if (compactSchemas) {
          functionDecl.description = compactToolDescription(functionDecl.description);
          functionDecl.parameters = compactParamDescriptions(functionDecl.parameters);
        }
        return { type: "function", function: functionDecl };
      });

    toolCache.set(tools, { compactSchemas, result });
    return result;
  }

  function apiKeys(oc) {
    const keys = Array.isArray(oc.apiKeys) ? oc.apiKeys.filter(Boolean) : [];
    if (!keys.length && oc.apiKey) keys.push(oc.apiKey);
    return [...new Set(keys)];
  }

  function headers(oc, apiKey) {
    const out = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...oc.extraHeaders,
    };
    if (apiKey) out.Authorization = `Bearer ${apiKey}`;
    if (oc.httpReferer) out["HTTP-Referer"] = oc.httpReferer;
    if (oc.appTitle) out["X-Title"] = oc.appTitle;
    return out;
  }

  async function postChatWithKey(body, timeoutMs, apiKey) {
    const { oc } = runtime();
    const baseUrl = String(oc.baseUrl || "").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(oc, apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const error = new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }

    return res.json();
  }

  async function postChat(body, timeoutMs) {
    const { oc } = runtime();
    const keys = apiKeys(oc);
    if (!keys.length) return postChatWithKey(body, timeoutMs, null);

    let lastError;
    for (let attempt = 0; attempt < keys.length; attempt += 1) {
      const keyIndex = (apiKeyCursor + attempt) % keys.length;
      try {
        const result = await postChatWithKey(body, timeoutMs, keys[keyIndex]);
        apiKeyCursor = (keyIndex + 1) % keys.length;
        return result;
      } catch (err) {
        lastError = err;
        if (![401, 403, 429].includes(err?.status) || attempt === keys.length - 1) throw err;
        log(`[${providerName(oc)}] key ${keyIndex + 1}/${keys.length} returned HTTP ${err.status}; trying next key`);
      }
    }
    throw lastError;
  }

  function withTimeout(promise, timeoutMs, label) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)}s`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
  }

  function toolTimeoutMs(toolName) {
    const { timeouts } = runtime();
    const custom = typeof toolTimeoutForName === "function"
      ? toolTimeoutForName(toolName, timeouts)
      : null;
    if (Number.isFinite(custom) && custom > 0) return custom;
    return valueFromKeys(timeouts, toolTimeoutKeys, 30_000);
  }

  function chatTimeoutMs() {
    const { timeouts } = runtime();
    return valueFromKeys(timeouts, chatTimeoutKeys, 60_000);
  }

  function slowChatTimeoutMs() {
    const { timeouts } = runtime();
    return timeouts.workerSlow ?? 60_000;
  }

  function quickReplyTimeoutMs() {
    const { timeouts } = runtime();
    return timeouts.quickReply ?? 15_000;
  }

  function recordFailure(reason) {
    const { oc } = runtime();
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
    if (consecutiveFailures === FAILURE_THRESHOLD) {
      log(`[${providerName(oc)}] circuit open after ${consecutiveFailures} failures (${reason})`);
      onRateLimit?.();
    }
  }

  function recordSuccess() {
    if (consecutiveFailures >= FAILURE_THRESHOLD) onSuccess?.();
    consecutiveFailures = 0;
  }

  function setRateLimitCallbacks(onLimit, onOk) {
    onRateLimit = onLimit;
    onSuccess = onOk;
  }

  function isRateLimited() {
    if (consecutiveFailures < FAILURE_THRESHOLD) return false;
    if (Date.now() - lastFailureAt > CIRCUIT_COOLDOWN_MS) return false;
    return true;
  }

  async function quickReply(_client, systemInstruction, userText, context) {
    const { oc } = runtime();
    try {
      const data = await postChat(buildBody({
        oc,
        model: oc.fastModel || oc.model,
        messages: [
          { role: "system", content: systemInstruction || "" },
          { role: "user", content: String(userText || "") },
        ],
      }), quickReplyTimeoutMs());

      const text = stripReasoning(data.choices?.[0]?.message?.content || "") || null;
      if (text && quickReplyAutoSend && context?.reply) await context.reply(text).catch(() => {});
      return text;
    } catch (err) {
      log(`[${providerName(oc)}] quickReply failed: ${err.message}`);
      return null;
    }
  }

  function looksLikeTask(text) {
    if (!text) return false;
    if (taskKeywordPattern?.global || taskKeywordPattern?.sticky) taskKeywordPattern.lastIndex = 0;
    return taskKeywordPattern.test(String(text));
  }

  function appendToolHistory(history, msg, slots, flavor) {
    if (flavor === "gemini") appendGeminiStyleToolHistory(history, msg, slots, botLabel);
    else if (flavor === "anthropic") appendAnthropicToolHistory(history, msg, slots);
  }

  function appendFinalHistory(history, finalText, flavor) {
    if (!Array.isArray(history) || !finalText) return;
    if (flavor === "gemini") {
      history.push({ role: "model", parts: [{ text: String(finalText).slice(0, 1900) }] });
    } else if (flavor === "anthropic") {
      history.push({ role: "assistant", content: String(finalText).slice(0, 1900) });
    }
  }

  async function executeProviderTool(executor, fnName, fnArgs, message) {
    const activeExecutor = typeof executor === "function" ? executor : defaultExecutor;
    if (typeof activeExecutor !== "function") throw new Error("executor is not a function");
    const raw = activeExecutor === defaultExecutor
      ? await activeExecutor(fnName, fnArgs, message)
      : await activeExecutor(fnName, fnArgs);
    if (typeof postProcessToolResult === "function") {
      return postProcessToolResult(raw, { message, toolName: fnName, toolArgs: fnArgs });
    }
    return raw;
  }

  async function handleChatFailure(err, toolsUsed) {
    const { oc } = runtime();
    if (chatFailureMode === "auth-message") {
      const kind = classifyLegacyError(err);
      if (kind === "auth") {
        log(`[${providerName(oc)}] auth error - check API key/base URL`);
        return { text: `${oc.providerName || "OpenAI-compatible provider"} auth failed; check the API key/config`, toolsUsed };
      }
      recordFailure(err.message);
      log(`[${providerName(oc)}] chat failed: ${err.message}`);
      return { text: "i'm having trouble thinking rn, try again in a sec", toolsUsed };
    }

    recordFailure(err.message);
    const kind = classifyProviderError(err);
    if (!kind.shouldFallback) log(`[${providerName(oc)}] ${kind.label}; not falling back`);
    else log(`[${providerName(oc)}] chat failed: ${err.message}`);
    return { text: "i'm having trouble thinking rn, try again in a sec", toolsUsed };
  }

  async function runOpenAICompatChat(options = {}) {
    const { oc } = runtime();
    const {
      systemInstruction,
      tools,
      history,
      message,
      useFastModel,
      executor,
      routerToolNames,
      onToolStatus,
      persistHistory = historyFlavor !== "none",
    } = options;
    const model = useFastModel ? (oc.fastModel || oc.model) : oc.model;
    const baseOpenaiTools = toOpenAICompatTools(tools);
    const tier1ToolNames = (baseOpenaiTools || []).map((tool) => tool.function?.name).filter(Boolean);
    const openaiTools = withRouterTool(baseOpenaiTools, routerToolNames, { format: "openai" });
    const routerOptions = {
      routerToolNames: routerToolNames || [],
      tier1ToolNames,
      resolveAlias,
      getDeclaration,
    };
    const userMessage = options.userMessage ?? message?.userMessage ?? message?.content ?? "";
    let sysInstruction = systemInstruction;
    if (oc.toolCoaching && openaiTools?.length && typeof toolCoachingBlock === "function") {
      sysInstruction = `${systemInstruction || ""}${toolCoachingBlock(openaiTools.length)}`;
    }
    const messages = toMessages(sysInstruction, history, userMessage, historyReadOrder);
    const toolsUsed = [];
    let finalText = "";
    const calledSignatures = new Set();
    const webSearchResults = new Map();
    const maxIterations = Math.max(1, oc.maxIterations || 12);
    const shouldPersistHistory = Array.isArray(history) && Boolean(persistHistory);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let data;
      try {
        data = await postChat(buildBody({ oc, model, messages, tools: openaiTools }), chatTimeoutMs());
        recordSuccess();
      } catch (err) {
        return handleChatFailure(err, toolsUsed);
      }

      const choice = data.choices?.[0];
      const msg = choice?.message;
      const finishReason = getFinishReason(choice);
      if (!msg) {
        recordFailure("empty response");
        return { text: "", toolsUsed };
      }

      if (typeof msg.content === "string") msg.content = stripReasoning(msg.content) || null;
      delete msg.reasoning_content;
      delete msg.reasoning;

      if (!msg.tool_calls?.length) {
        finalText = msg.content || "";

        const trimmed = finalText.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          let fnName = null;
          let fnArgs = {};
          let parsedOk = false;

          try {
            const parsed = JSON.parse(trimmed);
            fnName = parsed.tool || parsed.name || parsed.function || (parsed.query ? "web_search" : null);
            fnArgs = parsed.arguments || parsed.args || parsed.parameters || (parsed.query ? parsed : {});
            parsedOk = true;
          } catch {
            const qMatch = trimmed.match(/"query"\s*:\s*"([\s\S]*?)"\s*(?:}|,)/);
            if (qMatch) {
              fnName = "web_search";
              fnArgs = { query: qMatch[1].trim() };
              parsedOk = true;
            }
          }

          const rescued = parsedOk && fnName
            ? routeRescuedToolCall(fnName, fnArgs, { ...routerOptions, offeredToolNames: tier1ToolNames })
            : null;
          if (rescued) {
            msg.tool_calls = [{
              id: `call_hallucinated_${Date.now()}`,
              type: "function",
              function: {
                name: rescued.name,
                arguments: JSON.stringify(rescued.args),
              },
            }];
            msg.content = null;
            finalText = "";
            log(`[${providerName(oc)}] rescued hallucinated tool call for ${fnName}`);
          }
        }

        if (!msg.tool_calls?.length) {
          if (toolsUsed.length > 0 && oc.chatModel && oc.chatModel !== model) {
            try {
              const wrap = await postChat(buildBody({ oc, model: oc.chatModel, messages, tools: [] }), slowChatTimeoutMs());
              const wrapText = stripReasoning(wrap.choices?.[0]?.message?.content || "");
              if (wrapText) finalText = wrapText;
            } catch {}
          }
          if (!finalText) finalText = fallbackForFinishReason(finishReason, toolsUsed.length > 0);
          if (finishReason && !["stop", "tool_calls", "function_call"].includes(finishReason)) {
            log(`[${providerName(oc)}] finish_reason=${finishReason}`);
          }
          break;
        }
      }

      messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });

      let allDuplicates = true;
      const slots = msg.tool_calls.map((call) => {
        let fnName = call.function?.name;
        let fnArgs = {};
        let parseError = null;
        if (!fnName) parseError = new Error("missing tool name");
        try {
          if (!parseError) fnArgs = JSON.parse(call.function?.arguments || "{}");
        } catch (err) {
          parseError = err;
          log(`[${providerName(oc)}] bad tool args for ${fnName}: ${err.message}`);
        }

        if (parseError) {
          allDuplicates = false;
          return { call, fnName, fnArgs, duplicate: false, parseError };
        }

        const routed = routeCatalogTool(fnName, fnArgs, routerOptions);
        if (!routed.ok) {
          allDuplicates = false;
          return { call, fnName, fnArgs, duplicate: false, parseError, routeError: routed.result };
        }
        fnName = routed.toolName;
        fnArgs = routed.args;

        const searchKey = webSearchCacheKey(fnName, fnArgs);
        if (searchKey && webSearchResults.has(searchKey)) {
          allDuplicates = false;
          return { call, fnName, fnArgs, duplicate: false, cacheHit: true, cacheResult: webSearchResults.get(searchKey), parseError };
        }

        const signature = `${fnName}::${stableStringify(fnArgs)}`;
        if (calledSignatures.has(signature)) return { call, fnName, fnArgs, duplicate: true, parseError };
        calledSignatures.add(signature);
        allDuplicates = false;
        return { call, fnName, fnArgs, duplicate: false, parseError, searchKey };
      });

      const fresh = slots.filter((slot) => !slot.duplicate && !slot.cacheHit && !slot.parseError && !slot.routeError && slot.fnName);
      if (fresh.length > 1) log(`[${providerName(oc)}] running ${fresh.length} tool calls in parallel`);
      if (fresh.length && onToolStatus) {
        await onToolStatus(`running ${fresh.map((s) => s.fnName).join(", ")}`).catch(() => {});
      }

      const results = await Promise.all(fresh.map(async ({ fnName, fnArgs }) => {
        try {
          log(`[${providerName(oc)}] ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
          return await withTimeout(
            Promise.resolve(executeProviderTool(executor, fnName, fnArgs, message)),
            toolTimeoutMs(fnName),
            `tool ${fnName}`,
          );
        } catch (err) {
          log(`[${providerName(oc)}] tool ${fnName} failed: ${err.message}`);
          return `tool error: ${err.message}`;
        }
      }));

      const byId = new Map();
      fresh.forEach((slot, index) => {
        const result = results[index];
        byId.set(slot.call.id, result);
        if (slot.searchKey) webSearchResults.set(slot.searchKey, result);
        toolsUsed.push(slot.fnName);
      });

      for (const slot of slots) {
        let content;
        if (slot.parseError) {
          content = `Tool arguments were malformed JSON: ${slot.parseError.message}`;
        } else if (slot.routeError) {
          content = slot.routeError;
        } else if (slot.cacheHit) {
          content = `Already searched for "${slot.fnArgs?.query || "that"}" this turn. Use this previous result instead of searching again:\n${stringifyToolContent(slot.cacheResult)}`;
        } else if (slot.duplicate) {
          content = `Already executed this exact call earlier. Do not call ${slot.fnName} again with these arguments.`;
        } else {
          content = byId.get(slot.call.id);
        }
        slot.resultContent = content;
        messages.push({
          role: "tool",
          tool_call_id: slot.call.id,
          content: stringifyToolContent(content),
        });
      }

      if (shouldPersistHistory) appendToolHistory(history, msg, slots, historyFlavor);

      if (allDuplicates) {
        if (msg.content) {
          finalText = msg.content;
        } else if (toolsUsed.length) {
          try {
            const wrap = await postChat(buildBody({ oc, model: oc.chatModel || model, messages, tools: [] }), slowChatTimeoutMs());
            finalText = stripReasoning(wrap.choices?.[0]?.message?.content || "")
              || "i already checked that, but got stuck finishing the answer. try again in a sec";
          } catch {
            finalText = "i already checked that, but got stuck finishing the answer. try again in a sec";
          }
        }
        break;
      }
    }

    if (shouldPersistHistory) appendFinalHistory(history, finalText, historyFlavor);
    return { text: finalText, toolsUsed };
  }

  return {
    quickReply,
    toOpenAICompatTools,
    looksLikeTask,
    setRateLimitCallbacks,
    isRateLimited,
    classifyProviderError,
    runOpenAICompatChat,
    _internal: {
      sanitizeForOpenAI,
      toMessages,
      stringifyToolContent,
      classifyLegacyError,
    },
  };
}

export const _internal = {
  sanitizeForOpenAI,
  compactToolDescription,
  compactParamDescriptions,
  textFromContent,
  toMessages,
  stringifyToolContent,
  classifyLegacyError,
};
