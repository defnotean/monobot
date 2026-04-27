// ─── Dual-Model AI System ───────────────────────────────────────────────────
// Fast model for quick acknowledgments, main model for tool-augmented chat.

import { GoogleGenAI } from "@google/genai";
import config from "../config.js";
import { log } from "../utils/logger.js";

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

// ─── Quick Reply (fast model, no tools) ─────────────────────────────────────

/**
 * Fast model reply for task acknowledgments (no tools, 5s timeout).
 * @param {object} client — GoogleGenAI client instance
 * @param {string} systemInstruction — full personality prompt
 * @param {string} userText — the user's message
 * @param {string} [context] — optional extra context
 * @returns {Promise<string|null>} short acknowledgment or null on failure
 */
export async function quickReply(client, systemInstruction, userText, context) {
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
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("quickReply timeout")), 5000)),
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

// Legacy compatibility — always returns false since rate limiting is now per-key in the pool
export function isRateLimited() { return false; }

/**
 * Main AI chat loop with multi-turn tool calling.
 * Converts tools/history to Gemini format, runs up to 5 iterations of
 * generate → extract tool calls → execute → feed results back.
 * @param {object} client — GoogleGenAI client from key pool
 * @param {string} systemInstruction — full personality + context prompt
 * @param {Array} tools — tool definitions (Anthropic or Gemini format)
 * @param {Array} history — conversation history (Anthropic or Gemini format)
 * @param {string} userMessage — the user's current message text
 * @param {(toolName: string, toolArgs: object) => Promise<string>} executor — tool dispatch function
 * @returns {Promise<{text: string, toolsUsed: boolean, history: Array}>}
 */
export async function runGeminiChat(client, systemInstruction, tools, history, userMessage, executor, options = {}) {
  const MAX_ITERATIONS = 5;
  const { useFastModel = false } = options;
  // Conversational replies timeout faster than worker-with-thinking reasoning loops, but
  // leave headroom for at least one slow tool (web_search, scrape_url) plus a follow-up call.
  const TIMEOUT_MS = useFastModel ? 45_000 : 90_000;

  // tools may already be in Gemini format [{functionDeclarations}] or Anthropic format [{name, input_schema}]
  const geminiTools = Array.isArray(tools) && tools[0]?.functionDeclarations ? tools : toGeminiTools(tools);

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
  const currentThinkBudget = useFastModel ? 256 : 4096;
  // maxOutputTokens MUST exceed thinkingBudget — thinking tokens count
  // toward this cap, so a 2048 cap with a 4096 thinking budget left zero
  // tokens for visible text and silently truncated mid-word. Mirrors the
  // fix landed in irene/ai/dual.js.
  const currentMaxOutputTokens = useFastModel ? 2048 : 8192;

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
              config: { systemInstruction, tools: geminiTools, thinkingConfig: { thinkingBudget: 4096 } },
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
              config: { systemInstruction, maxOutputTokens: 256 },
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
              config: { systemInstruction, maxOutputTokens: 1024 },
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
          calls.push(part.functionCall);
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
      const GAME_TOOLS = new Set([
        "coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start", "blackjack_action",
        "roulette_spin", "rps_play", "trivia_start", "word_scramble_start", "number_guess_start",
        "fish", "dig", "hunt", "work", "beg", "search_location", "pet_battle",
        "daily_reward", "weekly_reward", "monthly_reward", "shop_buy", "shop_browse",
        "rob_user", "start_duel", "accept_duel",
        "scratch_card", "open_lootbox", "adventure_start", "adventure_choice",
      ]);
      let gameToolSeen = false;
      const skippedGameTools = new Set();
      const skippedDuplicates = new Set(); // exact signature already executed
      for (const call of calls) {
        // Hard dedup — same tool with same args = skip silently
        const signature = `${call.name}::${JSON.stringify(call.args || {})}`;
        if (calledSignatures.has(signature)) {
          skippedDuplicates.add(signature);
          log(`[AI] Skipping duplicate ${call.name} call (already executed this turn)`);
          continue;
        }
        calledSignatures.add(signature);

        if (GAME_TOOLS.has(call.name)) {
          if (gameToolSeen) { skippedGameTools.add(call.name); continue; }
          gameToolSeen = true;
        }
        functionCalls.push(call);
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
      }

      // Network-bound tools need more time than in-memory tools
      const SLOW_TOOLS = new Set(["web_search", "scrape_url", "search_images", "search_meme_templates", "send_gif", "analyze_image", "check_deploy", "read_emails", "github_repos", "github_issues", "github_prs"]);

      const responseParts = await Promise.all(calls.map(async (call) => {
        // Skip duplicate (same name + args) calls — already executed
        const signature = `${call.name}::${JSON.stringify(call.args || {})}`;
        if (skippedDuplicates.has(signature)) {
          return { functionResponse: { name: call.name, response: { result: "already executed earlier this turn — don't call again, move on or finish" } } };
        }
        // Skip duplicate game tools — return a message instead of executing
        if (skippedGameTools.has(call.name)) {
          return { functionResponse: { name: call.name, response: { result: "skipped — one game at a time" } } };
        }
        let result;
        const timeoutMs = SLOW_TOOLS.has(call.name) ? 25_000 : 10_000;
        const toolPromise = executor(call.name, call.args);
        let timedOut = false;
        try {
          result = await Promise.race([
            toolPromise,
            new Promise((_, rej) => setTimeout(() => {
              timedOut = true;
              rej(new Error(`tool "${call.name}" timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs)),
          ]);
          if (typeof result !== "string") result = JSON.stringify(result);
        } catch (err) {
          result = `Error: ${err.message}`;
          log(`Tool ${call.name} failed: ${err.message}`);
        }
        // Attach observer to late completion so orphaned in-flight work is
        // logged rather than silently producing partial side-effects.
        if (timedOut) {
          toolPromise.then(
            (late) => log(`[AI] late-completion of timed-out "${call.name}" → ${String(late).slice(0, 140)}`),
            (err) => log(`[AI] late-failure of timed-out "${call.name}": ${err?.message || err}`)
          );
        }
        return {
          functionResponse: {
            name: call.name,
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
          config: { systemInstruction, tools: geminiTools, maxOutputTokens: 1024 },
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

  // Race against timeout
  return Promise.race([
    run(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("runGeminiChat timed out after 90s")), TIMEOUT_MS)
    ),
  ]);
}
