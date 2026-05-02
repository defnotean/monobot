// Generic OpenAI-compatible chat-completions provider.

import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { executeTool } from "../executor.js";

const OC = config.openaiCompat || {};

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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

const _toolCache = new WeakMap();

export function toOpenAICompatTools(tools) {
  if (!tools || !tools.length) return undefined;
  const cached = _toolCache.get(tools);
  if (cached) return cached;

  if (tools[0]?.type === "function" && tools[0]?.function?.name) {
    _toolCache.set(tools, tools);
    return tools;
  }

  let raw = tools;
  if (tools[0]?.functionDeclarations) raw = tools.flatMap((t) => t.functionDeclarations || []);

  const result = raw
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: sanitizeForOpenAI(tool.input_schema || tool.parameters) || { type: "object", properties: {} },
      },
    }));
  _toolCache.set(tools, result);
  return result;
}

function headers() {
  const out = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...OC.extraHeaders,
  };
  if (OC.apiKey) out.Authorization = `Bearer ${OC.apiKey}`;
  if (OC.httpReferer) out["HTTP-Referer"] = OC.httpReferer;
  if (OC.appTitle) out["X-Title"] = OC.appTitle;
  return out;
}

async function postChat(body, timeoutMs) {
  const baseUrl = String(OC.baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(),
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

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function toolTimeoutMs() {
  return config.timeouts?.toolSlow ?? config.timeouts?.workerSlow ?? config.timeouts?.worker ?? 30_000;
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

function toMessages(systemInstruction, history, userMessage) {
  const messages = [{ role: "system", content: systemInstruction || "" }];
  for (const turn of history || []) {
    const role = turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";
    let content = "";
    if (turn.parts) {
      content = turn.parts
        .map((part) => {
          if (part.text) return part.text;
          if (part.functionCall) return `[tool call: ${part.functionCall.name}]`;
          if (part.functionResponse) return `[tool result: ${part.functionResponse.name}] ${JSON.stringify(part.functionResponse.response || {})}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    } else {
      content = textFromContent(turn.content);
    }
    if (content) messages.push({ role, content });
  }

  const last = messages[messages.length - 1];
  if (userMessage && (!last || last.role !== "user" || !last.content?.includes(String(userMessage).slice(0, 60)))) {
    messages.push({ role: "user", content: String(userMessage) });
  }
  return messages;
}

function buildBody({ model, messages, tools }) {
  const body = { model, messages, stream: false };
  if (Number.isFinite(OC.maxTokens) && OC.maxTokens > 0) body.max_tokens = OC.maxTokens;
  if (Number.isFinite(OC.temperature)) body.temperature = OC.temperature;
  if (Number.isFinite(OC.topP)) body.top_p = OC.topP;
  if (tools?.length && OC.toolChoice !== "none") {
    body.tools = tools;
    body.tool_choice = OC.toolChoice || "auto";
  }
  return body;
}

export async function quickReply(_client, systemInstruction, userText, context) {
  try {
    const data = await postChat(buildBody({
      model: OC.fastModel || OC.model,
      messages: [
        { role: "system", content: systemInstruction || "" },
        { role: "user", content: String(userText || "") },
      ],
    }), config.timeouts?.quickReply ?? 15_000);
    const text = data.choices?.[0]?.message?.content?.trim() || null;
    return text;
  } catch (err) {
    recordFailure(err.message);
    log(`[${OC.providerName || "OpenAICompat"}] quickReply failed: ${err.message}`);
    return null;
  }
}

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder|karaoke|lyrics|music|queue|volume|filter)\b/i;

export function looksLikeTask(text) {
  return !!text && TASK_KEYWORDS.test(text);
}

let _consecutiveFailures = 0;
let _lastFailureAt = 0;
let _onRateLimit = null;
let _onSuccess = null;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

function recordFailure(reason) {
  _consecutiveFailures += 1;
  _lastFailureAt = Date.now();
  if (_consecutiveFailures === FAILURE_THRESHOLD) {
    log(`[${OC.providerName || "OpenAICompat"}] circuit open after ${_consecutiveFailures} failures (${reason})`);
    _onRateLimit?.();
  }
}

function recordSuccess() {
  if (_consecutiveFailures >= FAILURE_THRESHOLD) _onSuccess?.();
  _consecutiveFailures = 0;
}

export function setRateLimitCallbacks(onLimit, onSuccess) {
  _onRateLimit = onLimit;
  _onSuccess = onSuccess;
}

export function isRateLimited() {
  if (_consecutiveFailures < FAILURE_THRESHOLD) return false;
  if (Date.now() - _lastFailureAt > CIRCUIT_COOLDOWN_MS) return false;
  return true;
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

export async function runOpenAICompatChat(arg1, ...rest) {
  let systemInstruction, history, tools, msgCtx, useFastModel, executor, onToolStatus;
  if (typeof arg1 === "object" && arg1 && (arg1.systemInstruction || arg1.history)) {
    ({ systemInstruction, history, tools, message: msgCtx, useFastModel, onToolStatus } = arg1);
    executor = arg1.executor;
  } else {
    systemInstruction = rest[0];
    tools = rest[1];
    history = rest[2];
    msgCtx = { userMessage: rest[3] };
    executor = rest[4];
    useFastModel = rest[5]?.useFastModel;
  }
  if (!executor) executor = (toolName, toolArgs) => executeTool(toolName, toolArgs, msgCtx);

  const model = useFastModel ? (OC.fastModel || OC.model) : OC.model;
  const openaiTools = toOpenAICompatTools(tools);
  const userMessage = msgCtx?.userMessage || msgCtx?.content || "";
  const messages = toMessages(systemInstruction, history, userMessage);
  const toolsUsed = [];
  let finalText = "";
  const calledSignatures = new Set();
  const maxIterations = Math.max(1, OC.maxIterations || 10);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let data;
    try {
      data = await postChat(buildBody({ model, messages, tools: openaiTools }), config.timeouts?.workerSlow ?? 60_000);
      recordSuccess();
    } catch (err) {
      recordFailure(err.message);
      const kind = classifyProviderError(err);
      if (!kind.shouldFallback) log(`[${OC.providerName || "OpenAICompat"}] ${kind.label}; not falling back`);
      else log(`[${OC.providerName || "OpenAICompat"}] chat failed: ${err.message}`);
      return { text: "i'm having trouble thinking rn, try again in a sec", toolsUsed };
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = getFinishReason(choice);
    if (!msg) {
      recordFailure("empty response");
      return { text: "", toolsUsed };
    }

    if (!msg.tool_calls?.length) {
      finalText = msg.content || "";
      if (!finalText) finalText = fallbackForFinishReason(finishReason, toolsUsed.length > 0);
      if (finishReason && !["stop", "tool_calls", "function_call"].includes(finishReason)) {
        log(`[${OC.providerName || "OpenAICompat"}] finish_reason=${finishReason}`);
      }
      break;
    }

    messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });

    let allDuplicates = true;
    const slots = msg.tool_calls.map((call) => {
      const fnName = call.function?.name;
      let fnArgs = {};
      let parseError = null;
      if (!fnName) parseError = new Error("missing tool name");
      try {
        if (!parseError) fnArgs = JSON.parse(call.function?.arguments || "{}");
      } catch (err) {
        parseError = err;
        log(`[${OC.providerName || "OpenAICompat"}] bad tool args for ${fnName}: ${err.message}`);
      }
      if (parseError) {
        allDuplicates = false;
        return { call, fnName, fnArgs, duplicate: false, parseError };
      }
      const signature = `${fnName}::${stableStringify(fnArgs)}`;
      if (calledSignatures.has(signature)) return { call, fnName, fnArgs, duplicate: true, parseError };
      calledSignatures.add(signature);
      allDuplicates = false;
      return { call, fnName, fnArgs, duplicate: false, parseError };
    });

    const fresh = slots.filter((slot) => !slot.duplicate && !slot.parseError && slot.fnName);
    if (fresh.length > 1) log(`[${OC.providerName || "OpenAICompat"}] running ${fresh.length} tool calls in parallel`);
    if (fresh.length && onToolStatus) {
      await onToolStatus(`running ${fresh.map((s) => s.fnName).join(", ")}`).catch(() => {});
    }

    const results = await Promise.all(fresh.map(async ({ fnName, fnArgs }) => {
      try {
        log(`[${OC.providerName || "OpenAICompat"}] ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
        return await withTimeout(Promise.resolve(executor(fnName, fnArgs)), toolTimeoutMs(), `tool ${fnName}`);
      } catch (err) {
        log(`[${OC.providerName || "OpenAICompat"}] tool ${fnName} failed: ${err.message}`);
        return `tool error: ${err.message}`;
      }
    }));

    const byId = new Map();
    fresh.forEach((slot, index) => {
      byId.set(slot.call.id, results[index]);
      toolsUsed.push(slot.fnName);
    });

    for (const slot of slots) {
      let content;
      if (slot.parseError) {
        content = `Tool arguments were malformed JSON: ${slot.parseError.message}`;
      } else if (slot.duplicate) {
        content = `Already executed this exact call earlier. Do not call ${slot.fnName} again with these arguments.`;
      } else {
        content = byId.get(slot.call.id);
      }
      messages.push({
        role: "tool",
        tool_call_id: slot.call.id,
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
    }

    if (allDuplicates) {
      finalText = msg.content || (toolsUsed.length ? "i already checked that, but got stuck finishing the answer. try again in a sec" : "");
      break;
    }
  }

  if (Array.isArray(history) && typeof arg1 === "object" && arg1 && finalText) {
    history.push({ role: "assistant", content: finalText.slice(0, 1900) });
  }

  return { text: finalText, toolsUsed };
}

export { runOpenAICompatChat as runGeminiChat };
export { toOpenAICompatTools as toGeminiTools };
