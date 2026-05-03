// Generic OpenAI-compatible chat-completions provider.
//
// Works with providers that expose POST /chat/completions using the OpenAI
// message/tool schema: OpenRouter, Groq, Cerebras, Mistral, DeepInfra,
// Together, GitHub Models, Cloudflare Workers AI gateways, LM Studio, Ollama,
// and similar local/self-hosted servers.

import config from "../../config.js";
import { log } from "../../utils/logger.js";

const OC = config.openaiCompat || {};
let _apiKeyCursor = 0;

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
  if (tools[0]?.functionDeclarations) {
    raw = tools.flatMap((t) => t.functionDeclarations || []);
  }

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

function apiKeys() {
  const keys = Array.isArray(OC.apiKeys) ? OC.apiKeys.filter(Boolean) : [];
  if (!keys.length && OC.apiKey) keys.push(OC.apiKey);
  return [...new Set(keys)];
}

function headers(apiKey) {
  const out = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...OC.extraHeaders,
  };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  if (OC.httpReferer) out["HTTP-Referer"] = OC.httpReferer;
  if (OC.appTitle) out["X-Title"] = OC.appTitle;
  return out;
}

async function postChatWithKey(body, timeoutMs, apiKey) {
  const baseUrl = String(OC.baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
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
  const keys = apiKeys();
  if (!keys.length) return postChatWithKey(body, timeoutMs, null);

  let lastError;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const keyIndex = (_apiKeyCursor + attempt) % keys.length;
    try {
      const result = await postChatWithKey(body, timeoutMs, keys[keyIndex]);
      _apiKeyCursor = (keyIndex + 1) % keys.length;
      return result;
    } catch (err) {
      lastError = err;
      if (![401, 403, 429].includes(err?.status) || attempt === keys.length - 1) throw err;
      log(`[${OC.providerName || "OpenAICompat"}] key ${keyIndex + 1}/${keys.length} returned HTTP ${err.status}; trying next key`);
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

function appendGeminiStyleToolHistory(history, msg, slots) {
  if (!Array.isArray(history) || !slots?.length) return;

  // Push STRUCTURED Gemini parts so the next turn's history converter
  // (toMessages below) can reconstruct proper OpenAI tool_calls instead of
  // stringifying as `[tool call: name]` prose. Stringifying taught the model
  // to imitate that text format in fresh content while leaving the actual
  // structured tool_calls field empty — the visible reply looked like a
  // tool call but no action ever ran.
  const assistantParts = [];
  const visibleText = textFromContent(msg?.content).trim();
  if (visibleText) assistantParts.push({ text: `[Eris said]\n${visibleText}`.slice(0, 1900) });
  else assistantParts.push({ text: "[Eris said]" });

  for (const slot of slots) {
    if (slot.parseError) continue; // can't reconstruct a malformed call
    assistantParts.push({
      functionCall: {
        name: slot.fnName || "unknown_tool",
        args: slot.fnArgs || {},
        // Preserve the original tool_call id so the matching functionResponse
        // can reference it. Stored on the part so toMessages can reuse it.
        _id: String(slot.call?.id || `${slot.fnName || "tool"}_${Date.now()}`),
      },
    });
  }

  history.push({ role: "model", parts: assistantParts });

  // The matching functionResponse parts — one per slot. toMessages converts
  // these into role:"tool" messages with the same tool_call_id so the OpenAI
  // server-side validator can pair them with the assistant.tool_calls above.
  const responseParts = slots.map((slot) => ({
    functionResponse: {
      name: slot.fnName || "unknown_tool",
      response: { result: stringifyToolContent(slot.resultContent, 900) },
      _id: String(slot.call?.id || `${slot.fnName || "tool"}_${Date.now()}`),
    },
  }));
  history.push({ role: "user", parts: responseParts });
}

// Convert a single past turn into one or more OpenAI-shape messages.
// Critical: when an assistant turn has Gemini `functionCall` parts (or
// Anthropic `tool_use` blocks if a future caller sends them), reconstruct
// proper `assistant.tool_calls` + `role:"tool"` pairs instead of stringifying
// as `[tool call: name]` prose. Stringification taught the model to emit
// text-shaped tool calls in fresh content — the actual `tool_calls` field
// stayed empty, so the action never ran.
function turnToMessages(turn) {
  const out = [];
  const role = turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";

  // Gemini-shape: { role, parts: [{ text } | { functionCall, _id } | { functionResponse, _id }] }
  if (Array.isArray(turn.parts)) {
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

  // Anthropic-shape blocks (in case a future history entry uses this form).
  if (Array.isArray(turn.content)) {
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

  // String content fallback.
  const text = textFromContent(turn.content);
  if (text) out.push({ role, content: text });
  return out;
}

function toMessages(systemInstruction, history, userMessage) {
  const messages = [{ role: "system", content: systemInstruction || "" }];
  for (const turn of history || []) {
    for (const m of turnToMessages(turn)) messages.push(m);
  }

  const last = messages[messages.length - 1];
  if (userMessage && (!last || last.role !== "user" || !last.content?.includes(String(userMessage).slice(0, 60)))) {
    messages.push({ role: "user", content: String(userMessage) });
  }

  return messages;
}

function buildBody({ model, messages, tools }) {
  const body = {
    model,
    messages,
    stream: false,
  };
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
    if (text && context?.reply) await context.reply(text).catch(() => {});
    return text;
  } catch (err) {
    log(`[${OC.providerName || "OpenAICompat"}] quickReply failed: ${err.message}`);
    return null;
  }
}

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder|karaoke|lyrics)\b/i;

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

function classifyError(err) {
  if (err?.status === 401 || err?.status === 403) return "auth";
  if (err?.status === 429) return "rate-limit";
  if (typeof err?.status === "number" && err.status >= 500) return "server";
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || String(err?.message || "").toLowerCase().includes("timeout")) return "timeout";
  return "error";
}

export async function runOpenAICompatChat(_client, systemInstruction, tools, history, userMessage, executor, options = {}) {
  const model = options.useFastModel ? (OC.fastModel || OC.model) : OC.model;
  const openaiTools = toOpenAICompatTools(tools);
  const messages = toMessages(systemInstruction, history, userMessage);
  const toolsUsed = [];
  let finalText = "";
  const calledSignatures = new Set();
  const maxIterations = Math.max(1, OC.maxIterations || 10);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let data;
    try {
      data = await postChat(buildBody({ model, messages, tools: openaiTools }), config.timeouts?.worker ?? 60_000);
      recordSuccess();
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "auth") {
        log(`[${OC.providerName || "OpenAICompat"}] auth error - check API key/base URL`);
        return { text: `${OC.providerName || "OpenAI-compatible provider"} auth failed; check the API key/config`, toolsUsed };
      }
      recordFailure(err.message);
      log(`[${OC.providerName || "OpenAICompat"}] chat failed: ${err.message}`);
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
      slot.resultContent = content;
      messages.push({
        role: "tool",
        tool_call_id: slot.call.id,
        content: stringifyToolContent(content),
      });
    }

    appendGeminiStyleToolHistory(history, msg, slots);

    if (allDuplicates) {
      finalText = msg.content || (toolsUsed.length ? "i already checked that, but got stuck finishing the answer. try again in a sec" : "");
      break;
    }
  }

  // Persist the final assistant text into the caller's history so the next
  // turn doesn't see [tool_result] → [user] with no answer between them. Used
  // to be missing — the model would re-call the same tool on the next message
  // because it had no record of how the previous turn finally answered.
  if (Array.isArray(history) && finalText) {
    history.push({ role: "model", parts: [{ text: String(finalText).slice(0, 1900) }] });
  }

  return { text: finalText, toolsUsed };
}

export { runOpenAICompatChat as runGeminiChat };
export { toOpenAICompatTools as toGeminiTools };
