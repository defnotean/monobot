// ─── NVIDIA AI Provider — Kimi K2.5 (1TB) via integrate.api.nvidia.com ──────
// OpenAI-compatible chat completions endpoint with tool calling support.
//
// Implements the same interface as ai/providers/gemini.js so the rest of the
// bot doesn't care which AI is running. Switch via AI_PROVIDER=nvidia in .env.

import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { executeTool, postDeferralIfNeeded } from "../executor.js";
import { routeCatalogTool, withRouterTool } from "@defnotean/shared/toolRouter";
import { TOOL_ALIASES } from "../toolAliases.js";
import { registry } from "../toolRegistry.js";

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

export function toGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;
  const cached = _toolCache.get(tools);
  if (cached) return cached;

  // Tools may arrive in three shapes:
  //   1. Anthropic-style: [{name, description, input_schema}, ...]
  //   2. Gemini-style:    [{functionDeclarations: [{name, description, parameters}, ...]}]
  //   3. OpenAI-style:    [{type: "function", function: {name, description, parameters}}, ...]
  //                       Already-formatted, return as-is.
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
      signal: AbortSignal.timeout(15_000),
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

// ─── Looks-like-task heuristic ─────────────────────────────────────────────

const TASK_KEYWORDS = /\b(set|create|make|delete|remove|update|change|configure|enable|disable|start|stop|skip|play|pause|fetch|get|show|list|search|find|add|give|send|kick|ban|mute|warn|timeout|track|watch|bet|gamble|flip|roll|spin|blackjack|hit|stand|fish|hunt|dig|work|beg|daily|weekly|monthly|rob|steal|duel|trivia|fortune|confess|curse|balance|coin|leaderboard|bump|reminder|karaoke|lyrics|music|queue|volume|filter)\b/i;

export function looksLikeTask(text) {
  if (!text) return false;
  return TASK_KEYWORDS.test(text);
}

// ─── Rate limit hooks ──────────────────────────────────────────────────────

export function setRateLimitCallbacks() { /* TODO if needed */ }
export function isRateLimited() { return false; }

// ─── Main chat call with tool calling loop ──────────────────────────────────
// Irene's runGeminiChat takes an options OBJECT, not positional args, because
// her dual.js interface differs from Eris's. This adapter handles both.

export async function runGeminiChat(arg1, ...rest) {
  // Detect call style
  let geminiClient, systemInstruction, history, tools, msgCtx, isAdmin, useFastModel, executor, onToolStatus, routerToolNames;
  if (typeof arg1 === "object" && arg1 && (arg1.systemInstruction || arg1.history)) {
    // Irene-style object call
    ({ geminiClient, systemInstruction, history, tools, message: msgCtx, isAdmin, useFastModel, onToolStatus, routerToolNames } = arg1);
    executor = arg1.executor;
  } else {
    // Eris-style positional call: (client, sysInstr, tools, history, userMsg, executor, opts)
    geminiClient = arg1;
    systemInstruction = rest[0];
    tools = rest[1];
    history = rest[2];
    const userMessage = rest[3];
    executor = rest[4];
    const opts = rest[5] || {};
    useFastModel = opts.useFastModel;
    routerToolNames = opts.routerToolNames;
    msgCtx = { userMessage };
  }

  // Default executor — uses the bot's own executeTool if caller didn't provide one
  // (Irene's runGeminiChat doesn't take an executor; it uses the global executor).
  // aiInitiated:true so moderationExecutor's destructive-action confirm gate
  // engages — these calls originate from the LLM tool loop.
  if (!executor) {
    executor = (toolName, toolArgs) => executeTool(toolName, toolArgs, msgCtx, { aiInitiated: true });
  }

  const model = useFastModel ? NV.fastModel : NV.model;
  const baseNvidiaTools = toGeminiTools(tools);
  const tier1ToolNames = (baseNvidiaTools || []).map((tool) => tool.function?.name).filter(Boolean);
  const nvidiaTools = withRouterTool(baseNvidiaTools, routerToolNames, { format: "openai" });
  const routerOptions = {
    routerToolNames: routerToolNames || [],
    tier1ToolNames,
    resolveAlias: (name) => Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name,
    getDeclaration: (name) => registry.getDeclaration(name),
  };

  // Append tool-use directive with explicit examples for Qwen.
  let sysPrompt = systemInstruction;
  if (nvidiaTools && nvidiaTools.length) {
    sysPrompt += `\n\n[TOOL USE — CRITICAL]
You have ${nvidiaTools.length} tools available. Your job is to CALL THE RIGHT TOOL, not describe what you would do.

ALWAYS call a tool when the user asks for ANY of these:
- "send a gif" / "gif of X" / "dab" / "shrug" / "shocked" / any short reaction word → call send_gif with that word as the query
- "make a meme" / "create meme" → call create_meme
- "look up X" / "search for X" / "google X" → call web_search
- "play X" / "queue X" / "put on X in vc" → call play_music. BUT if they're just sharing/showing off music ("heres my spotify", "check out my music", dropping an artist link with no play verb) → do NOT call play_music, just react like a person
- "skip" / "stop" / "pause" / "resume" / "volume" → matching music tool
- "lyrics" / "karaoke" → call start_lyrics_mode or karaoke commands
- "remember X" → call remember_fact
- "remind me X" → call set_reminder
- "kick" / "ban" / "mute" / "warn" / "purge" → matching mod tool
- "set X channel" / "configure X" / "setup X" → matching config tool
- ANY other clear request to perform an action → find the closest tool and call it

Only respond with plain text for: casual chitchat, opinions, jokes, answering questions from memory.

Output format: tool calls go in tool_calls field, NOT in text content.]`;
    if (NV.toolStrictness !== "strict") {
      sysPrompt += `\n\n[BALANCED TOOL JUDGMENT]
Kimi is allowed to use judgment. Call tools for clear actions, live lookups, saved state, Discord side effects, moderation, music controls, and games. For casual chat, jokes, opinions, reassurance, or vague vibes, answer naturally without forcing a tool. If a requested action is ambiguous, ask one short clarifying question instead of guessing.`;
    }
  }

  // Convert Gemini-style history to OpenAI messages format
  const messages = [{ role: "system", content: sysPrompt }];
  for (const turn of (history || [])) {
    const text = turn.parts?.[0]?.text || turn.content || "";
    if (!text) continue;
    if (turn.role === "model" || turn.role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else {
      messages.push({ role: "user", content: text });
    }
  }

  const toolsUsed = [];
  let finalText = "";
  // Track tool call signatures to break out of infinite retry loops.
  const calledSignatures = new Set();

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
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const httpErr = /** @type {Error & { status?: number }} */ (new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`));
        httpErr.status = res.status;
        throw httpErr;
      }
      data = await res.json();
    } catch (e) {
      log(`[NVIDIA] chat call failed: ${e.message}`);
      const cls = _classifyError(e);
      if (cls.shouldFallback) {
        const fb = await _fallbackToGemini({
          systemInstruction, history, tools, msgCtx, isAdmin, onToolStatus, routerToolNames,
          errorLabel: cls.label,
        });
        if (fb) return fb;
      }
      return { text: "i'm having trouble thinking rn, try again in a sec", toolsUsed };
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      log(`[NVIDIA] No message in response`);
      return { text: "", toolsUsed };
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content || "";
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    // Two-phase: classify every call (skip duplicates / malformed) then
    // Promise.all the fresh ones. Lets the model fire N parallel web_searches
    // in one turn without paying N× latency.
    let allDuplicates = true;
    const slots = msg.tool_calls.map((call) => {
      let fnName = call.function?.name;
      let fnArgs = {};
      let parseError = null;
      // Guard malformed calls — without this, an undefined fnName flows into
      // executor(undefined, {}) and crashes or returns "unknown tool" with no
      // signal to the model. Surface the issue via tool_result so it can
      // self-correct on the next iteration.
      if (!fnName) parseError = new Error("missing tool name");
      try {
        if (!parseError) fnArgs = JSON.parse(call.function?.arguments || "{}");
      } catch (e) {
        parseError = e;
        log(`[NVIDIA] Bad tool args for ${fnName}: ${e.message}`);
      }
      if (parseError) {
        allDuplicates = false;
        return { call, fnName, fnArgs, duplicate: false, parseError };
      }
      const routed = routeCatalogTool(fnName, fnArgs, routerOptions);
      if (!routed.ok) {
        allDuplicates = false;
        return { call, fnName, fnArgs, duplicate: false, routeError: routed.result };
      }
      fnName = routed.toolName;
      fnArgs = routed.args;
      const signature = `${fnName}::${JSON.stringify(fnArgs)}`;
      if (calledSignatures.has(signature)) {
        log(`[NVIDIA] Skipping duplicate ${fnName} call (already executed)`);
        return { call, fnName, fnArgs, duplicate: true };
      }
      calledSignatures.add(signature);
      allDuplicates = false;
      return { call, fnName, fnArgs, duplicate: false };
    });

    const fresh = slots.filter((s) => !s.duplicate && !s.parseError && !s.routeError);
    if (fresh.length > 1) log(`[NVIDIA] running ${fresh.length} tool calls in parallel: ${fresh.map((s) => s.fnName).join(", ")}`);
    const execResults = await Promise.all(fresh.map(async ({ fnName, fnArgs }) => {
      log(`[NVIDIA] ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
      try {
        if (!executor) return "no executor";
        const raw = await executor(fnName, fnArgs);
        // Render bridge: a destructive AI action returns a confirm-prompt OBJECT
        // — post the Confirm/Cancel buttons as a real message and feed the model
        // the pending notice instead of JSON-stringifying the object back.
        return await postDeferralIfNeeded(raw, msgCtx?.channel);
      } catch (e) {
        log(`[NVIDIA] Tool ${fnName} failed: ${e.message}`);
        return `tool error: ${e.message}`;
      }
    }));
    const resultByCallId = new Map();
    fresh.forEach((s, i) => { resultByCallId.set(s.call.id, execResults[i]); toolsUsed.push(s.fnName); });

    // Append in the original tool_calls order so the model sees a coherent sequence.
    for (const s of slots) {
      if (s.parseError) {
        messages.push({
          role: "tool",
          tool_call_id: s.call.id,
          content: `Tool call was malformed: ${s.parseError.message}. Re-emit the tool call with a valid name and JSON arguments.`,
        });
      } else if (s.routeError) {
        messages.push({
          role: "tool",
          tool_call_id: s.call.id,
          content: s.routeError,
        });
      } else if (s.duplicate) {
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

    if (allDuplicates) {
      log(`[NVIDIA] Model stuck repeating tool calls — exiting loop`);
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

async function _fallbackToGemini({ systemInstruction, history, tools, msgCtx, isAdmin, onToolStatus, routerToolNames, errorLabel }) {
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
    return await dual.runGeminiChat({
      geminiClient,
      systemInstruction,
      history,
      tools,
      message: msgCtx,
      isAdmin,
      useFastModel: fbUseFastModel,
      onToolStatus,
      routerToolNames,
    });
  } catch (e) {
    log(`[NVIDIA→Gemini] fallback also failed: ${e.message}`);
    return null;
  }
}
