// ─── packages/eris/ai/dual.js ───────────────────────────────────────────
// Gemini orchestration loop (runGeminiChat): up to MAX_ITERATIONS turns of
// generate → split parts → execute tool calls in parallel → feed results back.
// Handles 429 fallback, empty/thinking-only retries, dedup, per-tool timeouts.
// See docs/ai-pipeline-eris.md §4 for the full trace.
// ─── Dual-Model AI System ───────────────────────────────────────────────────
// Fast model for quick acknowledgments, main model for tool-augmented chat.

import { GoogleGenAI } from "@google/genai";
import config from "../config.js";
import { log } from "../utils/logger.js";
import { getEconomyMutatingTools } from "./toolRegistry.js";
// Shared work-pool singleton — read-only, used by isRateLimited() to report real
// provider exhaustion. geminiPool.js is a module-scope singleton with no
// dependency back on the ai/ layer, so importing it here introduces no cycle.
import { _geminiPools as _geminiPoolsRef } from "../events/messageCreate/geminiPool.js";

// ─── Internal helpers (exported for unit tests) ─────────────────────────────

// Order-stable signature for the duplicate-call guard. The model can emit the
// same args object with keys in different order across iterations, and the
// raw JSON.stringify is key-order sensitive — defeating dedup. Sort top-level
// keys so {a:1,b:2} and {b:2,a:1} produce the same signature.
export function stableSig(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `${name}::${JSON.stringify(args)}`;
  }
  const keys = Object.keys(args).sort();
  const sorted = {};
  for (const k of keys) sorted[k] = args[k];
  return `${name}::${JSON.stringify(sorted)}`;
}

// UTF-16 surrogate-safe slice. JSON.stringify on a string with an unpaired
// high-surrogate (0xD800-0xDBFF without a following low-surrogate) escapes
// oddly or produces invalid UTF-8 when sent over the wire as a Gemini
// functionResponse. Trim back if our cut landed mid-emoji.
export function safeSlice(str, max) {
  if (typeof str !== "string" || str.length <= max) return str;
  let end = max - 1; // room for ellipsis suffix
  // If the last code unit is a high surrogate without a low surrogate after,
  // it's unpaired — drop it.
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, end) + "…(truncated)";
}

// ─── Schema Sanitization ────────────────────────────────────────────────────

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["$schema", "additionalProperties", "default", "format"].includes(key)) continue;

    if (key === "type" && Array.isArray(value)) {
      // Gemini doesn't support type arrays — pick the first non-null type
      const real = value.filter((t) => t !== "null");
      cleaned.type = real[0] || "string";
      continue;
    }

    cleaned[key] = sanitizeSchema(value);
  }
  return cleaned;
}

// ─── Convert Anthropic-format tools to Gemini format ────────────────────────

/**
 * Convert Anthropic-format tool definitions to Gemini function declarations.
 * @param {Array<{name: string, description: string, input_schema: object}>} tools
 * @returns {Array<{functionDeclarations: Array}>|undefined}
 */
// Cache sanitized tool schemas — the schema array is static (EVERYONE_TOOLS
// and OWNER_TOOLS never change at runtime), so we sanitize once on first call
// per distinct tool set rather than re-walking 46+ schemas on every message.
const _toolSchemaCache = new WeakMap();

export function toGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;

  const cached = _toolSchemaCache.get(tools);
  if (cached) return cached;

  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: sanitizeSchema(tool.input_schema),
  }));

  const result = [{ functionDeclarations }];
  _toolSchemaCache.set(tools, result);
  return result;
}

function routerToolDeclaration() {
  return {
    name: "use_tool",
    description: "Call a catalog-only tool by exact name. Use only for tools listed in OTHER AVAILABLE TOOLS.",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact catalog tool name to call." },
        arguments: { type: "object", description: "Arguments for that tool." },
      },
      required: ["tool_name"],
    },
  };
}

function withRouterTool(geminiTools, routerToolNames = []) {
  if (!Array.isArray(routerToolNames) || routerToolNames.length === 0) return geminiTools;
  const router = routerToolDeclaration();
  if (!geminiTools?.length) return [{ functionDeclarations: [router] }];
  return geminiTools.map((group, idx) => ({
    ...group,
    functionDeclarations: idx === 0
      ? [...(group.functionDeclarations || []), router]
      : group.functionDeclarations,
  }));
}

function routeCatalogTool(call, routerToolNames = []) {
  if (call.name !== "use_tool") return { ok: true, callName: call.name, toolName: call.name, args: call.args || {}, responseName: call.name };
  const allowed = new Set(routerToolNames || []);
  const raw = call.args || {};
  const toolName = String(raw.tool_name || raw.name || raw.tool || "").trim();
  if (!toolName) {
    return { ok: false, responseName: "use_tool", result: "Error: use_tool requires tool_name" };
  }
  if (!allowed.has(toolName)) {
    return { ok: false, responseName: "use_tool", result: `Error: "${toolName}" is not available in this turn's catalog` };
  }
  const args = raw.arguments ?? raw.args ?? raw.input ?? raw.parameters ?? {};
  return { ok: true, callName: "use_tool", toolName, args: args && typeof args === "object" ? args : {}, responseName: "use_tool" };
}

// ─── Quick Reply (fast model, no tools) ─────────────────────────────────────

/**
 * Fast model reply for task acknowledgments (no tools, 5s timeout).
 * @param {object} client - GoogleGenAI client instance
 * @param {string} systemInstruction - full personality prompt
 * @param {string} userText - the user's message
 * @param {string | import("discord.js").Message} [context] - optional extra context; a Message is interpolated via its toString() (= message content)
 * @returns {Promise<string|null>} short acknowledgment or null on failure
 */
export async function quickReply(client, systemInstruction, userText, context) {
  // Operator-tunable timeout (TIMEOUT_QUICK_REPLY). Fallback matches the sibling
  // providers (nvidia.js / openaiCompat.js both use `?? 15_000`); config default
  // is 15s, so all three paths resolve consistently.
  const timeoutMs = config.timeouts?.quickReply ?? 15_000;
  // Cancel the in-flight generateContent when the outer timeout fires instead
  // of leaking a detached request — the SDK threads config.abortSignal into the
  // underlying fetch.
  const controller = new AbortController();
  let timer;
  try {
    const contextParts = context ? `${context}\n\nUser: ${userText}` : userText;

    const result = await Promise.race([
      client.models.generateContent({
        model: config.geminiFastModel,
        contents: [{ role: "user", parts: [{ text: contextParts }] }],
        config: {
          systemInstruction,
          // 512 tokens visible budget — quickReply produces a short ack
          // ("on it, creating that channel"), but the previous 150 cap
          // collided with the 128-token thinking budget and frequently
          // truncated the ack mid-word. Disable thinking entirely here:
          // these are deterministic acknowledgements, not reasoning.
          maxOutputTokens: 512,
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: controller.signal,
        },
      }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`quickReply timeout after ${timeoutMs / 1000}s`)); }, timeoutMs); }),
    ]);

    const parts = result.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("")
      .trim();

    return text || null;
  } catch (err) {
    log(`quickReply failed: ${err.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Heuristic: does this message look like it needs tool execution? ────────

const ACTION_KEYWORDS = /\b(create|make|delete|remove|search|find|check|analyze|organize|run|execute|open|close|set|remind|save|watch|track|browse|list|send|draft|query|launch|scrape|deploy)\b/i;

export function looksLikeTask(text) {
  return ACTION_KEYWORDS.test(text);
}

// ─── Convert Anthropic-style history to Gemini format ───────────────────────

function convertHistory(history) {
  if (!history || !history.length) return [];

  const geminiHistory = [];

  for (const msg of history) {
    const role = msg.role === "assistant" ? "model" : "user";

    // Simple string content
    if (typeof msg.content === "string") {
      geminiHistory.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    // Array content (Anthropic style)
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          parts.push({
            functionResponse: {
              name: block.tool_use_id || "unknown",
              response: { result: resultText },
            },
          });
        }
      }
      if (parts.length) geminiHistory.push({ role, parts });
      continue;
    }

    // Fallback — just stringify
    geminiHistory.push({ role, parts: [{ text: JSON.stringify(msg.content) }] });
  }

  return geminiHistory;
}

// ─── Main Tool Loop ─────────────────────────────────────────────────────────

// Per-key rate limit callback — set by the caller (messageCreate) to mark the specific key
// Falls back to no-op if not provided
let _onRateLimit = null;
let _onSuccess = null;

export function setRateLimitCallbacks(onRateLimit, onSuccess) {
  _onRateLimit = onRateLimit;
  _onSuccess = onSuccess;
}

// Work pool handle for provider-exhaustion checks. Injectable (tests / explicit
// wiring) via setWorkPool; otherwise isRateLimited() falls back to reading the
// shared work pool singleton lazily on first call.
let _workPool = null;
let _workPoolResolved = false;

export function setWorkPool(pool) {
  _workPool = pool;
  _workPoolResolved = true;
}

// isRateLimited reflects real provider exhaustion: true when every key in the
// work pool is currently rate-limited (rateLimitedUntil in the future), so the
// provider-exhaustion gate in messageCreate can short-circuit instead of
// hammering a dry pool. Returns false when there is no work pool (e.g. a
// non-Gemini provider, or no keys configured). Must stay synchronous — index.js
// calls it without awaiting, and an async (Promise) return would always read as
// truthy there.
export function isRateLimited() {
  // Lazily resolve the shared work pool the first time we're asked, so the gate
  // is live without requiring an explicit setWorkPool() wiring call. Guarded so
  // a non-Gemini provider (where the pool object is empty) degrades to false.
  if (!_workPoolResolved) {
    _workPoolResolved = true;
    try {
      _workPool = _resolveWorkPoolSync();
    } catch {
      _workPool = null;
    }
  }
  if (!_workPool || typeof _workPool.allLimited !== "function") return false;
  return _workPool.allLimited();
}

// Synchronously read the already-instantiated work pool singleton. The pool is
// created at module-eval in geminiPool.js (a module-scope singleton), so this
// just reads the existing instance — it does not build a new one.
function _resolveWorkPoolSync() {
  return _geminiPoolsRef?.work || null;
}

/**
 * Main AI chat loop with multi-turn tool calling.
 * Converts tools/history to Gemini format, runs up to 5 iterations of
 * generate → extract tool calls → execute → feed results back.
 * @param {object} client - GoogleGenAI client from key pool
 * @param {string} systemInstruction - full personality + context prompt
 * @param {Array} tools - tool definitions (Anthropic or Gemini format)
 * @param {Array} history - conversation history (Anthropic or Gemini format)
 * @param {string} userMessage - the user's current message text
 * @param {(toolName: string, toolArgs: object, abortSignal?: AbortSignal) => Promise<string>} executor - tool dispatch function (abortSignal is optional; executors that honor it can abort in-flight work)
 * @returns {Promise<{text: string, toolsUsed: boolean, history: Array}>}
 */
export async function runGeminiChat(client, systemInstruction, tools, history, userMessage, executor, options = {}) {
  const MAX_ITERATIONS = 5;
  const { useFastModel = false } = options;
  // Conversational replies timeout faster than worker-with-thinking reasoning loops, but
  // leave headroom for at least one slow tool (web_search, scrape_url) plus a follow-up call.
  // Operator-tunable via distinct keys so the split is actually preserved:
  // the fast path reads TIMEOUT_WORKER_FAST (config.timeouts.workerFast, 45s)
  // and the worker path reads TIMEOUT_WORKER_SLOW (config.timeouts.workerSlow,
  // 90s). The prior single `worker` key collapsed both to one value.
  const TIMEOUT_MS = useFastModel
    ? (config.timeouts?.workerFast ?? 45_000)
    : (config.timeouts?.workerSlow ?? 90_000);

  // tools may already be in Gemini format [{functionDeclarations}] or Anthropic format [{name, input_schema}]
  const baseGeminiTools = Array.isArray(tools) && tools[0]?.functionDeclarations ? tools : toGeminiTools(tools);
  const geminiTools = withRouterTool(baseGeminiTools, options.routerToolNames);

  // history may already be in Gemini format [{role, parts}] — pass through if so
  const isGeminiFormat = history.length > 0 && history[0]?.parts;
  const convertedHistory = isGeminiFormat ? history : convertHistory(history);

  // Filter out any entries with empty/invalid parts
  const cleanHistory = convertedHistory.filter(h => h.parts && h.parts.length > 0 && h.parts.some(p => p.text || p.functionCall || p.functionResponse));

  // The user message was already pushed into history before calling runGeminiChat —
  // so cleanHistory ends with it. Do NOT add it again or Gemini rejects consecutive user turns.
  const contents = [...cleanHistory];

  let allText = "";
  let toolsUsed = [];
  let functionCalls = [];

  // Loop guard: track tool call signatures to prevent the model from calling
  // the same tool with the same args repeatedly (e.g. send_gif 9 times).
  const calledSignatures = new Set();

  const currentModel = useFastModel ? config.geminiFastModel : config.geminiModel;
  // Latency tuning: chat lane skips thinking entirely (0); task lane keeps a
  // small budget (256) for multi-step tool planning. Was 256/4096 — slow.
  const currentThinkBudget = useFastModel ? 0 : 256;
  // maxOutputTokens MUST exceed thinkingBudget — thinking tokens count
  // toward this cap, so a 2048 cap with a 4096 thinking budget left zero
  // tokens for visible text and silently truncated mid-word. Mirrors the
  // fix landed in irene/ai/dual.js.
  const currentMaxOutputTokens = useFastModel ? 2048 : 8192;

  // Outer-timeout cancellation. The previous Promise.race only abandoned the
  // run() promise — the underlying generateContent + tool executor kept running
  // detached. Thread this signal into every generateContent call (the SDK wires
  // config.abortSignal into the underlying fetch) and into the tool executor so
  // the outer timeout actually aborts in-flight work instead of leaking it.
  const controller = new AbortController();
  const { signal: abortSignal } = controller;

  const run = async () => {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let response;
      try {
        response = await client.models.generateContent({
          model: currentModel,
          contents,
          config: {
            systemInstruction,
            tools: geminiTools,
            maxOutputTokens: currentMaxOutputTokens,
            thinkingConfig: { thinkingBudget: currentThinkBudget },
            abortSignal,
          },
        });
        // Surface MAX_TOKENS truncation so future regressions are visible
        // instead of silent. If this fires, raise currentMaxOutputTokens.
        if (response?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          log(`[Eris] finishReason=MAX_TOKENS (iter ${i}) — visible reply may be truncated`);
        }
      } catch (apiErr) {
        const errMsg = apiErr?.message || String(apiErr);
        // Detect 429 rate limit
        if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
          const retryMatch = errMsg.match(/retryDelay.*?(\d+)s/);
          const retrySecs = retryMatch ? parseInt(retryMatch[1]) : 60; // 60s default (per-key, not global)
          // Mark THIS specific key as rate-limited in the pool
          if (_onRateLimit) _onRateLimit(client, retrySecs * 1000);
          log(`[AI] Key rate-limited for ${retrySecs}s — pool will use next available key`);

          // Try fallback to 2.5 Flash on rate limit
          try {
            response = await client.models.generateContent({
              model: config.geminiFallbackModel,
              contents,
              // maxOutputTokens MUST exceed thinkingBudget — otherwise thinking
              // eats the entire budget and visible text is silently truncated.
              // Match the primary call's headroom (thinkingBudget + 2048+).
              config: { systemInstruction, tools: geminiTools, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 4096 }, abortSignal },
            });
            log(`[AI] Fallback to ${config.geminiFallbackModel} succeeded`);
          } catch {
            const minsLeft = Math.ceil(retrySecs / 60);
            return { text: `my brain is overheating, gonna take a ${minsLeft} minute nap 💤`, toolsUsed: [], functionCalls: [] };
          }
        } else {
          throw apiErr; // Re-throw non-429 errors
        }
      }

      // Handle empty/filtered response — retry once with fallback model before giving up
      if (!response.candidates?.[0]?.content?.parts?.length) {
        if (toolsUsed.length > 0) {
          // Tools already ran this turn — quick follow-up without tools
          try {
            response = await client.models.generateContent({
              model: config.geminiFallbackModel,
              contents,
              config: { systemInstruction, maxOutputTokens: 256, abortSignal },
            });
          } catch (e) { /* non-critical */ }
          if (!response?.candidates?.[0]?.content?.parts?.length) {
            return { text: "done", toolsUsed, functionCalls };
          }
        } else {
          // No tools yet — retry with fallback model
          log("[Eris] Empty response — retrying with fallback model");
          try {
            response = await client.models.generateContent({
              model: config.geminiFallbackModel,
              contents,
              config: { systemInstruction, maxOutputTokens: 1024, abortSignal },
            });
          } catch (retryErr) {
            log(`[Eris] Retry failed: ${retryErr.message}`);
            return { text: "my brain glitched, try again in a sec", toolsUsed, functionCalls };
          }
          if (!response?.candidates?.[0]?.content?.parts?.length) {
            return { text: "hmm something's off, try that again?", toolsUsed, functionCalls };
          }
        }
      }

      const parts = response.candidates[0].content.parts;

      // Separate text, thinking, and function calls
      const textParts = [];
      const thinkingParts = [];
      const calls = [];

      for (const part of parts) {
        if (part.thought && part.text) {
          // These are her ACTUAL internal thoughts — the model's real reasoning
          thinkingParts.push(part.text);
        } else if (part.text) {
          textParts.push(part.text);
        }
        if (part.functionCall) {
          // Defensive — drop malformed functionCalls (no name string). Without
          // this, signature becomes "undefined::..." and executor(undefined) throws.
          if (typeof part.functionCall.name === "string" && part.functionCall.name.length > 0) {
            calls.push(part.functionCall);
          } else {
            log("[Gemini] dropped malformed functionCall (no name)");
          }
        }
      }

      // Capture genuine inner thoughts from the model's reasoning process
      if (thinkingParts.length > 0) {
        try {
          const { addThought } = await import("./longmemory.js");
          const thinking = thinkingParts.join(" ");
          // Extract the most interesting snippet from her actual reasoning
          // Look for self-reflective or emotional parts (not mechanical reasoning)
          const interesting = thinking.match(
            /(?:I (?:think|feel|wonder|notice|should|want|like|don't|can't|need|hope|wish|remember|forgot|realize)[^.!?]*[.!?])/i
          )?.[0] || thinking.match(
            /(?:(?:this|that|they|the user|hmm|honestly|actually|wait|oh)[^.!?]{10,60}[.!?])/i
          )?.[0];
          if (interesting && interesting.length > 15 && interesting.length < 200) {
            addThought(interesting.trim());
          }
        } catch (e) { /* non-critical */ }
      }

      const responseText = textParts.join("");
      if (responseText) allText += (allText ? "\n" : "") + responseText;

      // Push assistant response into contents for multi-turn
      contents.push({ role: "model", parts });

      // No function calls — we're done
      if (!calls.length) break;

      // Deduplicate — if the model calls multiple game/economy tools in one turn,
      // only execute the first one. Prevents "eris slots" from also firing blackjack etc.
      // Canonical list lives in toolRegistry.js (ECONOMY_MUTATING_TOOLS); see the
      // comment there for why three features share the same source.
      const GAME_TOOLS = new Set(getEconomyMutatingTools());
      let gameToolSeen = false;
      const skippedGameTools = new Set();
      const skippedDuplicates = new Set(); // exact signature already executed
      for (const call of calls) {
        const routed = routeCatalogTool(call, options.routerToolNames);
        if (!routed.ok) {
          functionCalls.push(call);
          continue;
        }
        // Hard dedup — same tool with same args = skip silently. stableSig
        // sorts arg keys so {a:1,b:2} and {b:2,a:1} hash identically.
        const signature = stableSig(routed.toolName, routed.args || {});
        if (calledSignatures.has(signature)) {
          skippedDuplicates.add(signature);
          log(`[AI] Skipping duplicate ${routed.toolName} call (already executed this turn)`);
          continue;
        }
        calledSignatures.add(signature);

        if (GAME_TOOLS.has(routed.toolName)) {
          if (gameToolSeen) { skippedGameTools.add(signature); continue; }
          gameToolSeen = true;
        }
        functionCalls.push({ name: routed.toolName, args: routed.args });
        if (!toolsUsed.includes(routed.toolName)) toolsUsed.push(routed.toolName);
      }

      // Network-bound tools need more time than in-memory tools
      const SLOW_TOOLS = new Set(["web_search", "scrape_url", "search_images", "show_image", "generate_image", "edit_image", "search_meme_templates", "send_gif", "analyze_image", "check_deploy", "read_emails", "github_repos", "github_issues", "github_prs"]);

      const responseParts = await Promise.all(calls.map(async (call) => {
        const routed = routeCatalogTool(call, options.routerToolNames);
        if (!routed.ok) {
          return { functionResponse: { name: routed.responseName, response: { result: routed.result } } };
        }
        // Skip duplicate (same name + args) calls — already executed
        const signature = stableSig(routed.toolName, routed.args || {});
        if (skippedDuplicates.has(signature)) {
          return { functionResponse: { name: routed.responseName, response: { result: "already executed earlier this turn — don't call again, move on or finish" } } };
        }
        // Skip duplicate game tools — return a message instead of executing
        if (skippedGameTools.has(signature)) {
          return { functionResponse: { name: routed.responseName, response: { result: "skipped — one game at a time" } } };
        }
        let result;
        const timeoutMs = SLOW_TOOLS.has(routed.toolName) ? (config.timeouts?.slowTool ?? 30_000) : 10_000;
        // Pass the outer-timeout signal to the executor so tools that honor it
        // can abort their own in-flight work (e.g. fetch). Existing executors
        // ignore the extra arg, so this is backward-compatible.
        const toolPromise = executor(routed.toolName, routed.args, abortSignal);
        let timedOut = false;
        let onAbort;
        try {
          result = await Promise.race([
            toolPromise,
            new Promise((_, rej) => setTimeout(() => {
              timedOut = true;
              rej(new Error(`tool "${routed.toolName}" timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs)),
            // Unwind promptly when the OUTER timeout aborts — otherwise this
            // Promise.all would keep awaiting a tool the caller already gave up on.
            new Promise((_, rej) => {
              if (abortSignal.aborted) return rej(new Error(`tool "${routed.toolName}" aborted (run timed out)`));
              onAbort = () => { timedOut = true; rej(new Error(`tool "${routed.toolName}" aborted (run timed out)`)); };
              abortSignal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
          if (typeof result !== "string") result = JSON.stringify(result);
        } catch (err) {
          result = `Error: ${err.message}`;
          log(`Tool ${routed.toolName} failed: ${err.message}`);
        } finally {
          if (onAbort) abortSignal.removeEventListener("abort", onAbort);
        }
        // Attach observer to late completion so orphaned in-flight work is
        // logged rather than silently producing partial side-effects.
        if (timedOut) {
          toolPromise.then(
            (late) => log(`[AI] late-completion of timed-out "${routed.toolName}" → ${String(late).slice(0, 140)}`),
            (err) => log(`[AI] late-failure of timed-out "${routed.toolName}": ${err?.message || err}`)
          );
        }
        return {
          functionResponse: {
            name: routed.responseName,
            response: { result },
          },
        };
      }));

      // Feed tool results back as user turn
      contents.push({ role: "user", parts: responseParts });
    }

    // Gemini 2.5 Flash can return thinking-only responses (all parts have thought:true)
    // where parts.length > 0 but no visible text and no function calls were produced.
    // The !parts.length guard above doesn't catch this — allText stays "" → silent failure.
    // Retry once with the fast model (no thinking) to get a visible response.
    if (!allText && toolsUsed.length === 0) {
      log("[Eris] Thinking-only response (no visible text) — retrying with fallback model");
      try {
        const fallback = await client.models.generateContent({
          model: config.geminiFallbackModel,
          contents,
          config: { systemInstruction, tools: geminiTools, maxOutputTokens: 1024, abortSignal },
        });
        const fbParts = fallback.candidates?.[0]?.content?.parts || [];
        allText = fbParts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      } catch (fbErr) {
        log(`[Eris] Thinking-only fallback failed: ${fbErr.message}`);
      }
      if (!allText) allText = "hmm something went quiet, try again?";
    }

    return { text: allText, toolsUsed, functionCalls };
  };

  // Race against timeout. When the timer wins, abort the controller so the
  // in-flight generateContent + tool executor are cancelled rather than left
  // running detached, then reject with the actual timeout that was used.
  let timeoutTimer;
  return Promise.race([
    run().finally(() => { if (timeoutTimer) clearTimeout(timeoutTimer); }),
    new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        controller.abort();
        reject(new Error(`runGeminiChat timed out after ${Math.round(TIMEOUT_MS / 1000)}s`));
      }, TIMEOUT_MS);
    }),
  ]);
}
