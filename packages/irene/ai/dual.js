// ─── Gemini AI Engine ────────────────────────────────────────────────────────
// Gemini is the primary AI for all conversations and tool execution.
// Supports full chat (text replies) and multi-turn tool calling loops.

import { executeTool } from "./executor.js";
import { ADMIN_TOOLS } from "./tools.js";
import { registry } from "./toolRegistry.js";
import { log } from "../utils/logger.js";
import config from "../config.js";

const GEMINI_MODEL = config.geminiModel;               // worker AI — most capable, deep reasoning + tools
const GEMINI_FALLBACK_MODEL = config.geminiFallbackModel; // fallback on rate limit — still thinking-capable
const GEMINI_FAST_MODEL = config.geminiFastModel;    // conversation AI — fast replies, smart enough for chat

// Denial messages for admin-tool attempts by non-admins. Kept module-scoped
// so adding/removing entries doesn't require updating a hardcoded length
// anywhere. Old code hardcoded `Math.random() * 8` — if someone edited the
// array, the multiplier wouldn't match and the picker could return undefined.
const SASSY_DENIALS = [
  "lol cute attempt",
  "that's adorable",
  "you wish bestie",
  "nah not happening",
  "maybe ask someone with actual power",
  "that's above your clearance level",
  "nice try though",
  "i admire the confidence but no",
];
function pickDenial() {
  return SASSY_DENIALS[Math.floor(Math.random() * SASSY_DENIALS.length)];
}

// Per-key rate limit callbacks — set by messageCreate to mark specific keys in the pool
let _onRateLimit = null;
let _onSuccess = null;
export function setRateLimitCallbacks(onRateLimit, onSuccess) { _onRateLimit = onRateLimit; _onSuccess = onSuccess; }

// ─── Fast Conversation AI — instant acknowledgment, no tools ─────────────────
// Returns a quick natural response. Used to acknowledge task requests immediately
// while the worker AI handles the actual tool execution in the background.

export async function quickReply(geminiClient, systemInstruction, userText, context) {
  // Gemini quick reply
  let timeoutId;
  try {
    const promise = geminiClient.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [{ parts: [{ text: userText }] }],
      config: {
        systemInstruction: systemInstruction + `\n\nIMPORTANT: You are the CONVERSATION side of a dual-AI system. A separate worker AI is handling the actual task (tool calls, server actions, etc) in the background. Your ONLY job right now is to give a SHORT, natural acknowledgment that you're working on it. Keep it under 30 words. Be casual and specific to what they asked — not generic. Examples:
- "setting up those color roles now"
- "pulling up the latest valorant patch"
- "lemme find that for you"
- "on it, creating that channel"
Do NOT say "I'll use X tool" or describe your process. Just acknowledge naturally like a person would.
CRITICAL: Check the PERMISSION level in the system prompt above. If this user is a MEMBER asking for admin/mod actions (ban, kick, create channel, manage roles, purge, lock, etc), do NOT acknowledge — instead mock them for not having perms ("lol you wish" or "cute that you think you can do that"). Only say "on it" if they actually have the perms for what they asked.
If this is just a casual conversation (greeting, question, chitchat) and NOT a task/command, respond normally as a full conversational reply instead.`,
        maxOutputTokens: 150,
        thinkingConfig: { thinkingBudget: 128 },
      },
    });
    const timeout = new Promise((_, rej) => { timeoutId = setTimeout(() => rej(new Error("timeout")), 5000); });
    const response = await Promise.race([promise, timeout]);

    const text = response.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text).join("").trim();
    return text || null;
  } catch (err) {
    if (err?.message !== "timeout") log(`[QuickReply] Failed: ${err?.message}`);
    return null; // fail silently — worker will still respond
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Detect if a message likely needs tools ──────────────────────────────────
// Simple heuristic: if the message looks like a command/request, the worker
// AI will handle it. If it's just chitchat, the main Gemini call handles everything.

// Word-boundary matched action verbs — no false positives from substrings
// ("procreate" won't match "create", "change my mind" will match "change" intentionally
// since change/add/set could still be a task, but we down-weight those).
const STRONG_TASK = /\b(ban|kick|warn|timeout|untimeout|unban|unmute|mute|purge|lockdown|unlock|whitelist|giveaway|raffle|starboard|leveling|tempvc|ticket|schedule[_-]?task|cancel[_-]?scheduled|reaction\s*role|button\s*role|color\s*role|welcome\s*embed|autorole|modlog)\b/i;

const ACTION_VERB = /\b(create|make|build|delete|remove|rename|move|setup|set\s+up|configure|customize|assign|enable|disable|change|add|play|skip|stop|pause|resume|queue|shuffle|loop|join|leave|pin|unpin|announce|promote|demote|grant|revoke)\b/i;

const OBJECT_WORD = /\b(role|roles|channel|channels|category|embed|emoji|button|dropdown|reaction|poll|reminder|persona|avatar|nickname|twitch|youtube|github|stream|feed|tts|voice|vc)\b/i;

const IMPERATIVE_MARKER = /^(please\s|pls\s|can you\s|could you\s|would you\s|i need you to\s|irene[,\s]+(please\s+)?|hey\s+irene[,\s]+)/i;

// Reflection / chitchat giveaways — if the message is primarily commentary
// ("i was thinking about...", "what do you think about...") we route to the
// fast conversational model even if a stray verb matches.
const CHITCHAT_MARKER = /^(i\s+(was|am|think|feel|just|wonder|bet|guess|mean|can't|don't|hate|love)|what\s+(do|are|is)|why\s+(do|does|are|is)|how\s+(do|does|are|is|about)|do\s+you|did\s+you|are\s+you|lol|lmao|omg|bruh|wait|yo\b)/i;

export function looksLikeTask(text) {
  if (!text || text.length < 3) return false;
  const trimmed = text.trim();

  // Strong command keywords anywhere → definitely a task (mod actions etc)
  if (STRONG_TASK.test(trimmed)) return true;

  // Explicit imperative at the start → task
  if (IMPERATIVE_MARKER.test(trimmed)) return true;

  // Verb + object close together → task (e.g. "create a role", "setup channels")
  if (ACTION_VERB.test(trimmed) && OBJECT_WORD.test(trimmed)) return true;

  // Chitchat opener without a strong marker → NOT a task, even with a stray verb
  if (CHITCHAT_MARKER.test(trimmed)) return false;

  // Short messages (<80 chars) with just an action verb → probably a task
  // ("play something chill" or "skip this")
  if (trimmed.length < 80 && ACTION_VERB.test(trimmed)) return true;

  return false;
}

// Sanitize a JSON schema to be Gemini-compatible (recursive)
// - enum values → strings
// - strip $schema, additionalProperties, default, format
// - type arrays → first type string
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema;

  const out = {};
  for (const [key, val] of Object.entries(schema)) {
    // Strip unsupported fields
    if (["$schema", "additionalProperties", "default", "format"].includes(key)) continue;
    // Fix type arrays → single string
    if (key === "type" && Array.isArray(val)) { out.type = val.find((t) => t !== "null") ?? "string"; continue; }
    // Fix enum → all strings
    if (key === "enum" && Array.isArray(val)) { out.enum = val.map(String); continue; }
    // Recurse into objects
    if (typeof val === "object" && !Array.isArray(val)) { out[key] = sanitizeSchema(val); continue; }
    // Recurse into arrays (e.g. items in allOf/oneOf)
    if (Array.isArray(val)) { out[key] = val.map((v) => typeof v === "object" ? sanitizeSchema(v) : v); continue; }
    out[key] = val;
  }
  return out;
}

// Convert Anthropic-style tool schema → Gemini function declaration format.
// Cached by sorted tool-name list so we avoid rebuilding 80+ schemas per message.
// Bounded to 50 unique tool combinations — different guilds / contexts pass
// different tool subsets, so without a cap this grew unbounded.
import { LRUCache } from "@defnotean/shared/LRUCache";
const _geminiToolsCache = new LRUCache(50);
function toGeminiTools(tools) {
  const cacheKey = tools.map(t => t.name).sort().join(",");
  const hit = _geminiToolsCache.get(cacheKey);
  if (hit) return hit;
  const result = [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description || "No description",
      parameters: sanitizeSchema(t.input_schema),
    })),
  }];
  _geminiToolsCache.set(cacheKey, result);
  return result;
}

// Convert our internal history (Anthropic format) → Gemini contents format
async function toGeminiHistory(history) {
  const contents = [];
  for (const msg of history) {
    if (msg.role === "user") {
      // Could be a string, an array with text+images, or tool_result array
      if (typeof msg.content === "string") {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        // Check if it's tool results
        if (msg.content[0]?.type === "tool_result") {
          const funcResponses = msg.content.map((r) => ({
            functionResponse: {
              // Gemini requires the actual function name, NOT the tool_use_id.
              // tool_use_id is stored as "gemini_N_toolname" — strip the prefix.
              // Fallback to tool_name field (set since this fix) or the id itself.
              name: r.tool_name ?? r.tool_use_id?.replace(/^gemini_\d+_/, "") ?? r.tool_use_id ?? "unknown",
              response: { result: typeof r.content === "string" ? r.content : JSON.stringify(r.content) },
            },
          }));
          contents.push({ role: "user", parts: funcResponses });
        } else {
          // Text + image blocks
          const parts = [];
          for (const block of msg.content) {
            if (block.type === "text") parts.push({ text: block.text });
            else if (block.type === "image") {
              // Use pre-cached base64 if available (cached at input time in messageCreate.js)
              if (block._cachedBase64) {
                parts.push({ inlineData: { mimeType: block._cachedMime || "image/png", data: block._cachedBase64 } });
              } else {
                // Fallback: fetch now (for old history entries without cache)
                const url = block.source?.url;
                if (url) {
                  try {
                    const parsedUrl = new URL(url);
                    const h = parsedUrl.hostname.toLowerCase();
                    if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"].includes(h) || h.endsWith(".local") || h.endsWith(".internal") || h.startsWith("10.") || h.startsWith("172.16.") || h.startsWith("192.168.")) {
                      parts.push({ text: "[image fetch blocked: internal address]" });
                      continue;
                    }

                    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
                    if (res.ok) {
                      const contentLength = parseInt(res.headers.get("content-length") || "0");
                      if (contentLength > 1_000_000) { parts.push({ text: "[image too large to process]" }); continue; }
                      const buf = Buffer.from(await res.arrayBuffer());
                      if (buf.length > 1_000_000) { parts.push({ text: "[image too large]" }); continue; }
                      parts.push({ inlineData: { mimeType: res.headers.get("content-type") || "image/png", data: buf.toString("base64") } });
                    } else {
                      parts.push({ text: "[image failed to load]" });
                    }
                  } catch {
                    parts.push({ text: "[image failed to load]" });
                  }
                }
              }
            }
          }
          if (parts.length) contents.push({ role: "user", parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        contents.push({ role: "model", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        for (const block of msg.content) {
          if (block.type === "text") parts.push({ text: block.text });
          else if (block.type === "tool_use") {
            parts.push({
              functionCall: { name: block.name, args: block.input ?? {} },
            });
          }
        }
        if (parts.length) contents.push({ role: "model", parts });
      }
    }
  }
  return contents;
}

/**
 * Main Gemini chat + tool execution.
 * Handles both conversational replies and multi-turn tool calling.
 *
 * Returns { text, toolsUsed, history } where:
 *  - text: final text reply from Gemini
 *  - toolsUsed: boolean
 *  - history: updated history array (Anthropic format) for persistence
 */
export async function runGeminiChat({
  geminiClient,
  systemInstruction,
  history,
  tools,
  message,
  isAdmin,
  onToolStatus,
  useFastModel = false,
}) {
  // ─── GEMINI PROVIDER ──────────────────────────────────────────────
  const geminiTools = toGeminiTools(tools);
  const contents = await toGeminiHistory(history);
  let toolsUsed = false;
  let iterations = 0;
  // Loop guard — track tool call signatures to prevent the model from
  // calling the same tool with the same args repeatedly (e.g. 9x send_gif).
  const calledSignatures = new Set();

  // Model routing: conversational replies use the FAST model (Flash) end-to-end — no deep
  // thinking, short-ish timeout. Tasks/tool-heavy requests use the WORKER model (Pro) with a
  // full thinking budget. Flash is fully capable of multi-step tool chains for conversational
  // tooling (memory, gif, relationship adjustments, web search), so we do NOT upgrade to the
  // worker mid-request — doing so caused 60s timeouts on otherwise-trivial twin banter.
  const currentModel = useFastModel ? GEMINI_FAST_MODEL : GEMINI_MODEL;
  const currentThinkBudget = useFastModel ? 256 : 4096;
  const currentTimeoutMs = useFastModel ? 35_000 : 60_000;
  // maxOutputTokens MUST exceed thinkingBudget — thinking tokens count
  // toward this cap, so a 2048 cap with a 4096 thinking budget left zero
  // tokens for visible text and silently truncated mid-word.
  const currentMaxOutputTokens = useFastModel ? 2048 : 8192;

  while (iterations < 15) {
    iterations++;

    let response;
    try {
      // Timeout per Gemini call — fast model is snappy, worker needs more for thinking
      let timeoutId;
      const geminiPromise = geminiClient.models.generateContent({
        model: currentModel,
        contents,
        config: {
          tools: geminiTools,
          systemInstruction,
          maxOutputTokens: currentMaxOutputTokens,
          thinkingConfig: { thinkingBudget: currentThinkBudget },
        },
      });
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Gemini request timed out after ${currentTimeoutMs / 1000}s`)), currentTimeoutMs);
      });
      try {
        response = await Promise.race([geminiPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        // Mark THIS key as rate-limited in the pool (if callback set)
        const retryMatch = errMsg.match(/retryDelay.*?(\d+)s/);
        const retrySecs = retryMatch ? parseInt(retryMatch[1]) : 60;
        if (_onRateLimit) _onRateLimit(geminiClient, retrySecs * 1000);
        log(`[Gemini] Key rate-limited for ${retrySecs}s — falling back to ${GEMINI_FALLBACK_MODEL}`);
        // Try fallback to 2.5 Flash on rate limit
        try {
          response = await geminiClient.models.generateContent({
            model: GEMINI_FALLBACK_MODEL,
            contents,
            config: { tools: geminiTools, systemInstruction, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 4096 } },
          });
          log(`[Gemini] Fallback to ${GEMINI_FALLBACK_MODEL} succeeded`);
          // Fallback succeeded — drop through to the normal response-handling
          // path below so we actually USE the fallback result instead of
          // falling through to the generic error return.
        } catch {
          return { text: "brain overloaded for a sec, try again", toolsUsed, history };
        }
      } else {
        log(`[Gemini] API error: ${errMsg}`);
        return { text: "something went wrong, try again in a sec", toolsUsed, history };
      }
    }

    // Validate response structure — empty candidates means content was filtered or API changed
    if (!response.candidates?.[0]?.content?.parts) {
      // If tools were already used this turn, Gemini sometimes returns empty mid-chain.
      // Retry WITH tools first so it can continue multi-step operations (e.g. purge → recreate).
      // Only fall back to no-tools if the retry also fails.
      if (toolsUsed) {
        log(`[Gemini] Empty response after tool use — retrying with tools (iter ${iterations})`);
        try {
          response = await geminiClient.models.generateContent({
            model: GEMINI_FALLBACK_MODEL,
            contents,
            config: { systemInstruction, tools: geminiTools, maxOutputTokens: 6144, thinkingConfig: { thinkingBudget: 4096 } },
          });
        } catch {}
        // If still empty, try once more without tools for a text response
        if (!response?.candidates?.[0]?.content?.parts) {
          try {
            response = await geminiClient.models.generateContent({
              model: GEMINI_FALLBACK_MODEL,
              contents,
              config: { systemInstruction, maxOutputTokens: 256 },
            });
          } catch {}
        }
        if (!response?.candidates?.[0]?.content?.parts) {
          return { text: "done", toolsUsed, history };
        }
      } else {
        log(`[Gemini] Empty or malformed response: candidates=${JSON.stringify(response.candidates?.length ?? 'missing')}`);
        // Retry once with fast model (no thinking, no tools) as a lightweight fallback
        try {
          log('[Gemini] Retry: fallback model');
          response = await geminiClient.models.generateContent({
            model: GEMINI_FALLBACK_MODEL,
            contents,
            config: { systemInstruction, maxOutputTokens: 1024 },
          });
          if (!response.candidates?.[0]?.content?.parts) {
            return { text: "hmm something's off, try that again?", toolsUsed, history };
          }
        } catch (retryErr) {
          log('[Gemini] Retry failed: ' + retryErr.message);
          return { text: "my brain glitched, try again in a sec", toolsUsed, history };
        }
      }
    }

    const parts = response.candidates[0].content.parts;
    const funcCalls = parts.filter((p) => p.functionCall);

    // Surface MAX_TOKENS truncation — if this fires, raise maxOutputTokens
    // for the call that produced this response (thinking budget eats into it).
    if (response.candidates[0].finishReason === "MAX_TOKENS") {
      log(`[Gemini] finishReason=MAX_TOKENS (iter ${iterations}) — visible reply may be truncated mid-sentence`);
    }

    // Capture her ACTUAL internal thoughts from the model's reasoning process
    const thinkingParts = parts.filter((p) => p.thought && p.text).map((p) => p.text);
    if (thinkingParts.length > 0) {
      try {
        const { addThought } = await import("./longmemory.js");
        const thinking = thinkingParts.join(" ");
        const interesting = thinking.match(
          /(?:I (?:think|feel|wonder|notice|should|want|like|don't|can't|need|hope|wish|remember|forgot|realize)[^.!?]*[.!?])/i
        )?.[0] || thinking.match(
          /(?:(?:this|that|they|the user|hmm|honestly|actually|wait|oh)[^.!?]{10,60}[.!?])/i
        )?.[0];
        if (interesting && interesting.length > 15 && interesting.length < 200) {
          addThought(interesting.trim());
        }
      } catch {}
    }

    // Filter out thinking parts from visible response
    const textParts = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("\n")
      .trim();

    // No tool calls — this is a conversational reply, we're done
    if (funcCalls.length === 0) {
      let finalText = textParts;

      // Gemini 2.5 Flash can return thinking-only responses (all parts have thought:true)
      // where parts exist but no visible text is produced — causes a silent "done" reply.
      // Retry once with fast model (no thinking budget) to get an actual response.
      if (!finalText) {
        log("[Gemini] Thinking-only response — retrying with fallback model");
        try {
          const fallback = await geminiClient.models.generateContent({
            model: GEMINI_FALLBACK_MODEL,
            contents,
            config: { systemInstruction, tools: geminiTools, maxOutputTokens: 1024 },
          });
          const fbParts = fallback.candidates?.[0]?.content?.parts || [];
          finalText = fbParts.filter(p => p.text && !p.thought).map(p => p.text).join("\n").trim();
        } catch (fbErr) {
          log(`[Gemini] Thinking-only fallback failed: ${fbErr.message}`);
        }
        if (!finalText) finalText = "hmm something went quiet on my end, try again?";
      }

      finalText = finalText.slice(0, 1900);
      history.push({ role: "assistant", content: finalText });
      return { text: finalText, toolsUsed, history };
    }

    // Tool calls detected
    toolsUsed = true;

    // Save assistant turn with tool calls to history (Anthropic format)
    const assistantContent = [];
    for (const p of parts) {
      if (p.text && !p.thought) assistantContent.push({ type: "text", text: p.text });
      if (p.functionCall) assistantContent.push({
        type: "tool_use",
        id: `gemini_${iterations}_${p.functionCall.name}_${Math.random().toString(36).substring(2, 6)}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    }
    history.push({ role: "assistant", content: assistantContent });

    // Record model turn in Gemini conversation
    contents.push({ role: "model", parts });

    // Show status
    if (onToolStatus) {
      const actionList = funcCalls.map((p) => `→ ${p.functionCall.name}`).join("\n");
      await onToolStatus(`im on it! this is where i'm at currently:\n${actionList}`);
    }

    // Execute all tool calls in parallel.
    // Three tiers: FAST (in-memory) = 15s, SLOW (network) = 30s, VERY_SLOW
    // (multi-track resolution like Spotify playlists) = 60s.
    const VERY_SLOW_TOOLS = new Set(["play_music", "summarize_channel", "setup_reaction_roles", "setup_autorole", "setup_starboard", "set_leveling", "mass_role", "purge_messages"]);
    const SLOW_TOOLS = new Set(["web_search", "web_read", "search_images", "send_gif", "generate_image", "configure_patch_news", "test_patch_news", "configure_twitch", "configure_youtube", "configure_github", "stop_music", "skip_track", "queue_info", "set_volume", "music_filter", "create_channel", "delete_channel", "nuke_channel"]);
    const funcResponses = [];
    const toolResults = [];
    let _completedCount = 0;
    await Promise.all(
      funcCalls.map(async (part, idx) => {
        const { name, args } = part.functionCall;

        // Loop guard — skip if we've already executed this exact call this turn
        const signature = `${name}::${JSON.stringify(args || {})}`;
        const isDuplicate = calledSignatures.has(signature);
        if (isDuplicate) {
          log(`[Gemini] Skipping duplicate ${name} call (already executed)`);
          const dupeMsg = "already executed earlier this turn — don't call again, move on or finish";
          funcResponses.push({ functionResponse: { name, response: { result: dupeMsg } } });
          toolResults.push({ type: "tool_result", tool_use_id: `gemini_${iterations}_${name}_dup`, tool_name: name, content: dupeMsg });
          _completedCount++;
          return;
        }
        calledSignatures.add(signature);

        log(`[Gemini] ${name}(${JSON.stringify(args)})`);

        const isAdminTool = ADMIN_TOOLS.some((t) => t.name === name);
        const timeoutMs = VERY_SLOW_TOOLS.has(name) ? config.timeouts.toolVerySlow
                        : SLOW_TOOLS.has(name)      ? config.timeouts.toolSlow
                        :                             config.timeouts.toolFast;
        let result;

        if (isAdminTool && !isAdmin) {
          log(`[SECURITY] Blocked admin tool "${name}" for non-admin`);
          result = pickDenial();
        } else {
          // Track the underlying tool promise so that if the race times out, we
          // still attach a handler to its eventual completion. This prevents
          // silent half-finished state (e.g. a role created after the timeout)
          // from vanishing without a trace and logs unhandled rejections.
          const toolPromise = executeTool(name, args, message);
          let timedOut = false;
          try {
            result = await Promise.race([
              toolPromise,
              new Promise((_, rej) => setTimeout(() => {
                timedOut = true;
                rej(new Error(`tool "${name}" timed out after ${timeoutMs / 1000}s`));
              }, timeoutMs)),
            ]);
          } catch (err) {
            result = `Error: ${err.message}`;
            log(`[Gemini] tool error in ${name}: ${err.message}`);
          }
          // Attach observer to the orphaned promise so we know what happened
          if (timedOut) {
            toolPromise.then(
              (late) => log(`[Gemini] late-completion of timed-out "${name}" → ${String(late).slice(0, 140)}`),
              (err) => log(`[Gemini] late-failure of timed-out "${name}": ${err?.message || err}`)
            );
          }
        }

        log(`[Gemini] ${name} → ${result}`);
        // Track usage for two-tier tool selection
        const channelKey = message.guild ? `${message.guild.id}-${message.author?.id || "unknown"}` : `dm-${message.author?.id || "unknown"}`;
        registry.trackUsage(channelKey, name);

        // Update status
        _completedCount++;
        if (onToolStatus) {
          // Wrap in try/catch so a failing status-edit doesn't abort the whole
          // tool chain — status is cosmetic, a Discord hiccup shouldn't nuke
          // the user's actual work.
          try {
            await onToolStatus(`working on it (${_completedCount}/${funcCalls.length} done):\n${funcCalls.map((p, i) => {
              const icon = i < _completedCount ? "✓" : "→";
              return `${icon} ${p.functionCall.name}`;
            }).join("\n")}`);
          } catch (err) {
            log(`[Gemini] status update failed: ${err?.message || err}`);
          }
        }

        // Truncate long results to keep context window manageable
        // 1500 chars gives enough room for role lists, channel lists, etc.
        const truncResult = typeof result === "string" && result.length > 1500
          ? result.slice(0, 1487) + "…(truncated)"
          : result;

        funcResponses.push({ functionResponse: { name, response: { result: truncResult } } });
        toolResults.push({
          type: "tool_result",
          tool_use_id: `gemini_${iterations}_${name}`,
          tool_name: name,
          content: truncResult,
        });
      })
    );

    // Save tool results to history (Anthropic format)
    history.push({ role: "user", content: toolResults });

    // Feed results back into Gemini conversation
    contents.push({ role: "user", parts: funcResponses });
  }

  // Hit max iterations — let the user know instead of silently stopping
  log(`[Gemini] Hit ${iterations} iteration limit for tool loop`);
  return { text: "done — that was a complex task so i hit my action limit, let me know if anything's still missing", toolsUsed, history };
}

// Legacy export for backward compat — runs a standalone tool loop on a task string
export async function runGeminiToolLoop({
  geminiClient,
  systemInstruction,
  task,
  tools,
  message,
  isAdmin,
  onStatus,
}) {
  const geminiTools = toGeminiTools(tools);
  const contents = [{ role: "user", parts: [{ text: task }] }];
  const completedActions = [];
  let iterations = 0;

  while (iterations < 10) {
    iterations++;

    let response;
    try {
      response = await geminiClient.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { tools: geminiTools, systemInstruction, thinkingConfig: { thinkingBudget: 2048 } },
      });
    } catch (err) {
      log(`[Gemini loop] API error: ${err.message}`);
      break;
    }

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const funcCalls = parts.filter((p) => p.functionCall);

    if (funcCalls.length === 0) break;

    contents.push({ role: "model", parts });

    if (onStatus) {
      const actionList = funcCalls.map((p) => `→ ${p.functionCall.name}`).join("\n");
      await onStatus(`im on it! this is where i'm at currently:\n${actionList}`);
    }

    const funcResponses = await Promise.all(
      funcCalls.map(async (part) => {
        const { name, args } = part.functionCall;
        log(`[Gemini] ${name}(${JSON.stringify(args)})`);

        const isAdminTool = ADMIN_TOOLS.some((t) => t.name === name);
        let result;

        if (isAdminTool && !isAdmin) {
          result = pickDenial();
        } else {
          try {
            result = await Promise.race([
              executeTool(name, args, message),
              new Promise((_, rej) => setTimeout(() => rej(new Error(`tool "${name}" timed out after 15s`)), 15_000)),
            ]);
          } catch (err) {
            result = `Error: ${err.message}`;
            log(`[Gemini] tool error in ${name}: ${err.message}`);
          }
        }

        log(`[Gemini] ${name} → ${result}`);
        completedActions.push(`${name}: ${result}`);

        return { functionResponse: { name, response: { result } } };
      })
    );

    contents.push({ role: "user", parts: funcResponses });
  }

  return completedActions;
}
