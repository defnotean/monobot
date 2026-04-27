// ─── NVIDIA AI Provider — Kimi K2.5 (1TB) via integrate.api.nvidia.com ──────
// OpenAI-compatible chat completions endpoint with tool calling support.
//
// Implements the same interface as ai/providers/gemini.js so the rest of the
// bot doesn't care which AI is running. Switch via AI_PROVIDER=nvidia in .env.

import config from "../../config.js";
import { log } from "../../utils/logger.js";

const NV = config.nvidia;

// ─── Tool schema conversion (Anthropic → OpenAI format) ─────────────────────

function sanitizeForOpenAI(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeForOpenAI);
  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if (key === "type" && Array.isArray(value)) {
      cleaned.type = value.filter(t => t !== "null")[0] || "string";
      continue;
    }
    cleaned[key] = sanitizeForOpenAI(value);
  }
  return cleaned;
}

const _toolCache = new WeakMap();

export function toNvidiaTools(tools) {
  if (!tools || !tools.length) return undefined;
  const cached = _toolCache.get(tools);
  if (cached) return cached;

  // Tools may arrive in three shapes:
  //   1. Anthropic-style: [{name, description, input_schema}, ...]
  //   2. Gemini-style:    [{functionDeclarations: [{name, description, parameters}, ...]}]
  //   3. OpenAI-style:    [{type: "function", function: {name, description, parameters}}, ...]
  //                       (already-formatted — return as-is, this happens when
  //                        messageCreate caches via toGeminiTools then runGeminiChat
  //                        re-processes the same array)
  if (tools[0]?.type === "function" && tools[0]?.function?.name) {
    _toolCache.set(tools, tools);
    return tools;
  }

  let raw = tools;
  if (tools[0]?.functionDeclarations) {
    raw = tools.flatMap(t => t.functionDeclarations || []);
  }

  const result = raw
    .filter(t => t && t.name)
    .map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: sanitizeForOpenAI(t.input_schema || t.parameters) || { type: "object", properties: {} },
      },
    }));
  _toolCache.set(tools, result);
  return result;
}

// ─── Quick reply (no tools, fast acknowledgment) ────────────────────────────

export async function quickReply(_client, systemInstruction, userText, context) {
  try {
    const messages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: userText },
    ];
    const res = await fetch(`${NV.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NV.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: NV.fastModel,
        messages,
        max_tokens: 256,
        temperature: NV.temperature,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeouts?.quickReply ?? 15_000),
    });
    if (!res.ok) {
      log(`[NVIDIA] quickReply HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text && context?.reply) {
      await context.reply(text).catch(() => {});
    }
  } catch (e) { log(`[NVIDIA] quickReply: ${e.message}`); }
}

// ─── Looks-like-task heuristic (same logic, no AI dependency) ──────────────

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder|karaoke|lyrics)\b/i;

export function looksLikeTask(text) {
  if (!text) return false;
  return TASK_KEYWORDS.test(text);
}

// ─── Rate limit hooks (no-op for now — NVIDIA's free tier is generous) ─────

// ─── Circuit breaker ────────────────────────────────────────────────────────
// Track consecutive failures so we can flip a "provider unhealthy" signal that
// upstream (dual.js / messageCreate.js) can read to fall back or degrade
// gracefully instead of silently returning generic error strings every time.

let _consecutiveFailures = 0;
let _lastFailureAt = 0;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

let _onRateLimit = null;
let _onSuccess = null;

function recordFailure(reason) {
  _consecutiveFailures++;
  _lastFailureAt = Date.now();
  if (_consecutiveFailures === FAILURE_THRESHOLD) {
    log(`[NVIDIA] CIRCUIT OPEN — ${_consecutiveFailures} consecutive failures (last: ${reason})`);
    _onRateLimit?.();
  } else if (_consecutiveFailures > FAILURE_THRESHOLD && _consecutiveFailures % 5 === 0) {
    log(`[NVIDIA] still failing — ${_consecutiveFailures} consecutive failures (last: ${reason})`);
  }
}

function recordSuccess() {
  if (_consecutiveFailures >= FAILURE_THRESHOLD) {
    log(`[NVIDIA] CIRCUIT CLOSED — recovered after ${_consecutiveFailures} failures`);
    _onSuccess?.();
  }
  _consecutiveFailures = 0;
}

export function setRateLimitCallbacks(onLimit, onSuccess) {
  _onRateLimit = onLimit;
  _onSuccess = onSuccess;
}

export function isRateLimited() {
  if (_consecutiveFailures < FAILURE_THRESHOLD) return false;
  // Half-open: let a request through after the cooldown to test recovery
  if (Date.now() - _lastFailureAt > CIRCUIT_COOLDOWN_MS) return false;
  return true;
}

export function _providerHealth() {
  return { consecutiveFailures: _consecutiveFailures, lastFailureAt: _lastFailureAt, open: isRateLimited() };
}

// ─── Main chat call with tool calling loop ──────────────────────────────────

/**
 * Run a chat with tool calling. Same signature as runGeminiChat for drop-in.
 * @param {*} _client — unused (kept for interface compat)
 * @param {string} systemInstruction
 * @param {Array} tools — Anthropic-format tool definitions
 * @param {Array} history — [{role, parts: [{text}]}] Gemini-style history
 * @param {string} userMessage
 * @param {Function} executor — async (toolName, toolArgs) => result
 * @param {object} options — { useFastModel?: boolean }
 */
export async function runNvidiaChat(_client, systemInstruction, tools, history, userMessage, executor, options = {}) {
  const model = options.useFastModel ? NV.fastModel : NV.model;
  const nvidiaTools = toNvidiaTools(tools);

  // Append tool-use directive to system prompt with explicit examples.
  // Qwen needs concrete mappings between user requests and tool names, not
  // just "use tools when appropriate".
  let sysPrompt = systemInstruction;
  if (nvidiaTools && nvidiaTools.length) {
    sysPrompt += `\n\n[TOOL USE — CRITICAL]
You have ${nvidiaTools.length} tools available. Your job is to CALL THE RIGHT TOOL, not describe what you would do.

ALWAYS call a tool when the user asks for ANY of these:
- "send a gif" / "gif of X" / "dab" / "shrug" / "shocked" / any short reaction word → call send_gif with that word as the query
- "make a meme" / "create meme" → call create_meme
- "look up X" / "search for X" / "what is X" / "google X" → call web_search
- "remember X" / "save this" / "don't forget" → call remember_fact
- "what do you remember about me" → call recall_memories
- "play X" / "queue X" / music requests → call play_music (if available). BUT if they're just sharing music ("heres my spotify", "check out my music", dropping an artist link with no play verb) → do NOT call play_music, just react like a person
- "fire an event" / "trigger event" → call test_fire_event
- "fish" / "hunt" / "dig" / "work" / "beg" → call the matching activity tool
- "balance" / "coins" / "leaderboard" → call check_balance / coin_leaderboard
- "bet X" / "gamble X" / "flip" / "slots" / "blackjack" → call the matching gambling tool
- "set X channel" / "configure X" → call configure_feature or set_event_channels
- "remind me X" → call set_reminder
- "kick" / "ban" / "mute" / "warn" → call the matching mod tool
- ANY other clear request to perform an action → find the matching tool and call it

Only respond with plain text for: casual chitchat, opinions, jokes, answering questions from your own memory.

When unsure if a tool exists for the request, BROWSE THE TOOL LIST and pick the closest match. Calling a slightly-wrong tool is better than refusing to act.

DO NOT use ask_irene for things you can do yourself. Browse YOUR tool list FIRST. ask_irene is ONLY for cross-bot coordination (asking the twin to talk to someone, share moods, etc). For anything actionable in this server, find YOUR direct tool. Examples:
- Change someone's nickname → use change_nickname (your tool), NOT ask_irene
- Send a GIF → use send_gif (your tool), NOT ask_irene
- Kick/ban/mute → use the matching mod tool (your tool), NOT ask_irene
- Set a channel → use configure_feature (your tool), NOT ask_irene

Output format reminder: tool calls go in the tool_calls field, NOT in the text content.]`;
  }

  // Convert Gemini-style history to OpenAI messages format
  const messages = [{ role: "system", content: sysPrompt }];
  for (const turn of history) {
    const text = turn.parts?.[0]?.text || turn.content || "";
    if (!text) continue;
    if (turn.role === "model" || turn.role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else {
      messages.push({ role: "user", content: text });
    }
  }

  // The userMessage is usually already in history as the latest entry.
  // Only append if not already there.
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user" || !lastMsg.content?.includes(userMessage.slice(0, 50))) {
    messages.push({ role: "user", content: userMessage });
  }

  const toolsUsed = [];
  let finalText = "";
  // Track tool call signatures to break out of infinite retry loops.
  // Some models (Llama 3.3 esp.) keep re-calling the same tool with the
  // same args even after success, treating it as not-yet-done.
  const calledSignatures = new Set();

  // Loop for tool calling — model can call multiple tools per turn
  for (let iteration = 0; iteration < 10; iteration++) {
    const body = {
      model,
      messages,
      max_tokens: NV.maxTokens,
      temperature: NV.temperature,
      top_p: NV.topP ?? 0.95,
      stream: false,
    };
    if (nvidiaTools && nvidiaTools.length) {
      body.tools = nvidiaTools;
      body.tool_choice = "auto";
      if (iteration === 0) log(`[NVIDIA] Sending ${nvidiaTools.length} tools to ${model}`);
    }
    if (NV.thinking) {
      // Qwen uses 'enable_thinking', Kimi uses 'thinking' — send both for compat
      body.chat_template_kwargs = { enable_thinking: true, thinking: true };
    }

    let data;
    try {
      const res = await fetch(`${NV.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NV.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeouts?.worker ?? 60_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const httpErr = new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        httpErr.status = res.status;
        throw httpErr;
      }
      data = await res.json();
      recordSuccess();
    } catch (e) {
      recordFailure(e.message);
      log(`[NVIDIA] chat call failed: ${e.message}`);
      const cls = _classifyError(e);
      if (cls.shouldFallback) {
        const fb = await _fallbackToGemini({
          systemInstruction, tools, history, userMessage, executor, options, errorLabel: cls.label,
        });
        if (fb) return fb;
      }
      return { text: "i'm having trouble thinking rn, try again in a sec", toolsUsed };
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      recordFailure("empty response");
      log(`[NVIDIA] No message in response: ${JSON.stringify(data).slice(0, 200)}`);
      return { text: "", toolsUsed };
    }

    // No tool calls → final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content || "";
      if (iteration === 0 && nvidiaTools?.length) {
        log(`[NVIDIA] No tool calls in response (${nvidiaTools.length} tools available, finish_reason: ${choice?.finish_reason})`);
      }
      break;
    }

    // Append assistant message with tool calls so the model has full context
    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    // Two-phase execution: classify every call (skip duplicates) then
    // Promise.all the fresh ones. Lets the model fire N parallel web_searches
    // in one turn without paying N× latency.
    let allDuplicates = true;
    const slots = msg.tool_calls.map((call) => {
      const fnName = call.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(call.function?.arguments || "{}"); }
      catch (e) { log(`[NVIDIA] Bad tool args for ${fnName}: ${e.message}`); }
      const signature = `${fnName}::${JSON.stringify(fnArgs)}`;
      if (calledSignatures.has(signature)) {
        log(`[NVIDIA] Skipping duplicate ${fnName} call (already executed this turn)`);
        return { call, fnName, fnArgs, duplicate: true };
      }
      calledSignatures.add(signature);
      allDuplicates = false;
      return { call, fnName, fnArgs, duplicate: false };
    });

    const fresh = slots.filter((s) => !s.duplicate);
    if (fresh.length > 1) log(`[NVIDIA] running ${fresh.length} tool calls in parallel: ${fresh.map((s) => s.fnName).join(", ")}`);
    const execResults = await Promise.all(fresh.map(async ({ fnName, fnArgs }) => {
      log(`[NVIDIA] ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
      try {
        return await executor(fnName, fnArgs);
      } catch (e) {
        log(`[NVIDIA] Tool ${fnName} failed: ${e.message}`);
        return `tool error: ${e.message}`;
      }
    }));
    const resultByCallId = new Map();
    fresh.forEach((s, i) => { resultByCallId.set(s.call.id, execResults[i]); toolsUsed.push(s.fnName); });

    for (const s of slots) {
      if (s.duplicate) {
        messages.push({
          role: "tool",
          tool_call_id: s.call.id,
          content: `Already executed this exact call earlier. Don't call ${s.fnName} again with these arguments. Move on or finish.`,
        });
      } else {
        const result = resultByCallId.get(s.call.id);
        messages.push({
          role: "tool",
          tool_call_id: s.call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }

    // If every tool call this iteration was a duplicate, the model is stuck.
    // Break out instead of looping forever.
    if (allDuplicates) {
      log(`[NVIDIA] Model stuck repeating same tool calls — exiting loop`);
      finalText = msg.content || "";
      break;
    }
  }

  return { text: finalText, toolsUsed };
}

// ─── Gemini Fallback ────────────────────────────────────────────────────────
// On NVIDIA outage (5xx, network, timeout, rate limit), reroute the call to
// Gemini if it's configured. Stateless per call — no circuit breaker. Auth
// failures (401/403) and user-error 4xx do NOT trigger fallback.

function _classifyError(err) {
  const status = err?.status;
  const msg = (err?.message || "").toLowerCase();

  if (status === 401 || status === 403) {
    log(`[NVIDIA] auth error (${status}) — check NVIDIA_API_KEY, not falling back`);
    return { shouldFallback: false, label: `auth-${status}` };
  }
  if (status === 429) return { shouldFallback: true, label: "rate-limit-429" };
  if (typeof status === "number" && status >= 500) return { shouldFallback: true, label: `server-${status}` };
  if (typeof status === "number" && status >= 400) {
    return { shouldFallback: false, label: `client-${status}` };
  }
  // No status → network/timeout/abort error
  if (msg.includes("timeout") || msg.includes("aborted") || err?.name === "AbortError" || err?.name === "TimeoutError") {
    return { shouldFallback: true, label: "timeout" };
  }
  return { shouldFallback: true, label: "network" };
}

let _geminiFallbackClient = null;
async function _getGeminiClient() {
  if (_geminiFallbackClient) return _geminiFallbackClient;
  if (!config.geminiKeys?.length) return null;
  const { GoogleGenAI } = await import("@google/genai");
  _geminiFallbackClient = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
  return _geminiFallbackClient;
}

async function _fallbackToGemini({ systemInstruction, tools, history, userMessage, executor, options, errorLabel }) {
  if (!config.geminiKeys?.length) {
    log(`[NVIDIA→Gemini] fallback skipped — no GEMINI_API_KEY configured`);
    return null;
  }
  const geminiClient = await _getGeminiClient();
  if (!geminiClient) return null;

  // Tools present → use the worker model (Gemini Pro). Chat-only → fast model.
  const fbUseFastModel = !(tools && tools.length);
  log(`[NVIDIA→Gemini] fallback after ${errorLabel} (model: ${fbUseFastModel ? "fast" : "worker"})`);

  try {
    const dual = await import("../dual.js");
    return await dual.runGeminiChat(
      geminiClient,
      systemInstruction,
      tools,
      history,
      userMessage,
      executor,
      { ...options, useFastModel: fbUseFastModel },
    );
  } catch (e) {
    log(`[NVIDIA→Gemini] fallback also failed: ${e.message}`);
    return null;
  }
}

// Re-exports under the Gemini names so we can drop-in replace
export { runNvidiaChat as runGeminiChat };
export { toNvidiaTools as toGeminiTools };
