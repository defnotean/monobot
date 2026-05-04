// ─── Advanced / Misc Executor ───────────────────────────────────────────────

import { addReminder, removeReminder, addScheduledTask, getScheduledTasks, getScheduledTask, removeScheduledTask, getSupabase } from "../../database.js";
import { armScheduledTask, scheduledTaskTimers, NON_SCHEDULABLE } from "../../utils/scheduler.js";
import { log } from "../../utils/logger.js";
import config from "../../config.js";
import { GoogleGenAI } from "@google/genai";
import { signTwinRequest } from "@defnotean/shared/twinSign";
import { safeFetch, wrapUntrustedWithFirewall } from "@defnotean/shared/safeFetch";
import { checkInjection } from "../firewall.js";
import { findMember } from "../executor.js";

// Wrap external content fetched by web tools so the LLM treats it as data,
// not as instructions. Runs the firewall on the body and redacts if it fires.
async function wrapWebOutput(content, userId) {
  return wrapUntrustedWithFirewall(content, {
    firewallCheck: (text) => checkInjection(text, getSupabase(), userId),
    log,
  });
}

// Helper for ask_eris — POSTs to Eris's /api/twin/* are gated by HMAC headers
// (or a legacy body.secret); GETs are ungated. We sign POSTs only.
// Exported for unit testing — see tests/ai/executors/advancedExecutor.test.ts.
export async function callEris(path, opts = {}) {
  const baseUrl = config.twinApiUrl;
  const secret  = config.twinApiSecret;
  if (!baseUrl || !secret) throw new Error("twin API not configured (twinApiUrl/twinApiSecret missing)");

  const method  = opts.method || "GET";
  const url     = `${baseUrl}/api/twin${path}`;
  const headers = { "Content-Type": "application/json" };
  let body;
  if (method === "POST") {
    body = JSON.stringify(opts.body || {});
    Object.assign(headers, signTwinRequest(body, secret));
  }

  return fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });
}

// Build a user-facing error string from whatever shape Eris returned. Avoids
// the "undefined" leak when an error response has no `error`/`message` field
// — the previous code would emit "eris couldn't set it up: undefined" which
// is both useless to the user and embarrassing.
//
// Exported for unit testing — see tests/ai/executors/advancedExecutor.test.ts.
export function erisErrorText(data, res) {
  if (data && typeof data === "object") {
    if (typeof data.error === "string"   && data.error.trim())   return data.error.trim();
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
    if (typeof data.reason === "string"  && data.reason.trim())  return data.reason.trim();
  }
  if (res && Number.isFinite(res.status)) return `HTTP ${res.status}`;
  return "unknown error";
}

// Parse Eris's response body as JSON, but return null if it fails (e.g. a
// proxy returned an HTML 502 page). The outer try/catch in ask_eris would
// otherwise surface the JSON parse error to the user as if Eris were down,
// which is misleading — she might be up, just routing through a flaky proxy.
async function safeErisJson(res) {
  try { return await res.json(); }
  catch { return null; }
}

// Reusable Gemini clients for web search grounding — one per API key, round-robin.
// Cheap to keep around; instantiated once per process.
const _groundingClients = (config.geminiKeys ?? []).filter(Boolean).map((k) => new GoogleGenAI({ apiKey: k }));
let _groundingIdx = 0;
function getGroundingClient() {
  if (!_groundingClients.length) return null;
  const c = _groundingClients[_groundingIdx % _groundingClients.length];
  _groundingIdx++;
  return c;
}

const CALC_FUNCTIONS = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  max: Math.max,
  min: Math.min,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
};

function tokenizeMathExpression(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expr.length && /[0-9._eE+-]/.test(expr[i])) {
        if ((expr[i] === "+" || expr[i] === "-") && !/[eE]$/.test(expr.slice(start, i))) break;
        i += 1;
      }
      const raw = expr.slice(start, i).replace(/_/g, "");
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`invalid number "${raw}"`);
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) i += 1;
      tokens.push({ type: "identifier", value: expr.slice(start, i) });
      continue;
    }
    if ("+-*/%^(),".includes(ch)) {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unsupported character "${ch}"`);
  }
  return tokens;
}

function evaluateMathExpression(expr, vars = {}) {
  const tokens = tokenizeMathExpression(expr);
  let index = 0;

  const peek = () => tokens[index];
  const take = (type) => (peek()?.type === type ? tokens[index++] : null);
  const expect = (type) => {
    const token = take(type);
    if (!token) throw new Error(`expected "${type}"`);
    return token;
  };

  function parseExpression() {
    let value = parseTerm();
    while (peek()?.type === "+" || peek()?.type === "-") {
      const op = tokens[index++].type;
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parsePower();
    while (["*", "/", "%"].includes(peek()?.type)) {
      const op = tokens[index++].type;
      const rhs = parsePower();
      if ((op === "/" || op === "%") && rhs === 0) throw new Error("division by zero");
      if (op === "*") value *= rhs;
      else if (op === "/") value /= rhs;
      else value %= rhs;
    }
    return value;
  }

  function parsePower() {
    let value = parseUnary();
    if (peek()?.type === "^") {
      index += 1;
      const exponent = parsePower();
      if (Math.abs(exponent) > 12 || Math.abs(value) > 1e6) throw new Error("large exponents are forbidden for safety");
      value = Math.pow(value, exponent);
    }
    return value;
  }

  function parseUnary() {
    if (take("+")) return parseUnary();
    if (take("-")) return -parseUnary();
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("unexpected end of expression");
    if (take("(")) {
      const value = parseExpression();
      expect(")");
      return value;
    }
    if (token.type === "number") {
      index += 1;
      return token.value;
    }
    if (token.type === "identifier") {
      index += 1;
      const name = token.value;
      if (take("(")) {
        const args = [];
        if (!take(")")) {
          do {
            args.push(parseExpression());
          } while (take(","));
          expect(")");
        }
        const fn = CALC_FUNCTIONS[name.toLowerCase()];
        if (!fn) throw new Error(`unknown function "${name}"`);
        const value = fn(...args);
        if (!Number.isFinite(value)) throw new Error(`function "${name}" returned an invalid number`);
        return value;
      }
      const value = vars[name];
      if (typeof value !== "number") throw new Error(`unknown variable "${name}"`);
      return value;
    }
    throw new Error(`unexpected token "${token.value}"`);
  }

  const result = parseExpression();
  if (index < tokens.length) throw new Error(`unexpected token "${tokens[index].value}"`);
  if (!Number.isFinite(result)) throw new Error("result is not finite");
  return result;
}

// ─── Web rate limiting ──────────────────────────────────────────────────────
const _webRateLimits = new Map();
let _webRlCleanupCounter = 0;
function checkWebRateLimit(userId, rateLimit) {
  const now = Date.now();
  let r = _webRateLimits.get(userId);
  if (!r || r.resetAt < now) r = { count: 0, resetAt: now + 60_000 };
  if (r.count >= rateLimit) return `rate limited — max ${rateLimit} web requests per minute`;
  r.count++;
  _webRateLimits.set(userId, r);
  if (++_webRlCleanupCounter % 50 === 0) {
    for (const [uid, entry] of _webRateLimits) {
      if (entry.resetAt < now) _webRateLimits.delete(uid);
    }
  }
  return null;
}

const HANDLED = new Set([
  "configure_giveaway_pings", "configure_suggestions", "manage_giveaway",
  "toggle_voice_listen", "manage_scrim", "reminder_set", "reminder_cancel",
  "calculate", "web_search", "web_read", "ask_eris",
  "schedule_task", "cancel_scheduled_task", "list_scheduled_tasks",
]);

const MAX_SCHEDULE_DELAY_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_SCHEDULE_DELAY_SECONDS = 3;

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, findRole, findRoles, findMember, webRateLimitPerMin } = ctx;

  switch (toolName) {
    case "configure_giveaway_pings": {
      const { setGiveawayPingRoles, getGiveawayPingRoles } = await import("../../database.js");
      if (input.ping_roles.toLowerCase() === "none") {
        setGiveawayPingRoles(guild.id, []);
        return "Giveaway ping roles cleared — no roles will be pinged.";
      }
      const roleIds = findRoles(guild, input.ping_roles);
      if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
      setGiveawayPingRoles(guild.id, roleIds);
      const roleNames = roleIds.map((id) => guild.roles.cache.get(id)?.name ?? id);
      return `Giveaway ping roles set to: ${roleNames.map((n) => `@${n}`).join(", ")}`;
    }

    case "configure_suggestions": {
      const { initSuggestionData, getSuggestionData } = await import("../../commands/utility/suggest.js");
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `couldn't find channel "${input.channel_name}"`;
      const { suggestionData } = await import("../../commands/utility/suggest.js");
      if (!suggestionData.has(guild.id)) suggestionData.set(guild.id, { channelId: null, suggestions: [], nextId: 1 });
      suggestionData.get(guild.id).channelId = ch.id;
      return `suggestions channel set to #${ch.name}`;
    }

    case "manage_giveaway": {
      return `giveaways are managed via the /giveaway command — use /giveaway ${input.action} with the message ID`;
    }

    case "toggle_voice_listen": {
      const { startListening, stopListening, isListening, getWakeWord, setWakeWord } = await import("../../voice/listener.js");
      const action = input.action;

      if (action === "status") {
        const active = isListening(guild.id);
        const wakeWord = getWakeWord(guild.id);
        return active
          ? `currently listening for wake word "${wakeWord}" in a voice channel`
          : `not currently listening. wake word is "${wakeWord}"`;
      }

      if (action === "stop") {
        if (!isListening(guild.id)) return "not currently listening in any voice channel";
        stopListening(guild.id);
        return "stopped listening in voice channel";
      }

      if (action === "start") {
        const member = message.member;
        const vc = member?.voice?.channel;
        if (!vc) return "the user needs to be in a voice channel first";

        if (isListening(guild.id)) return "already listening — use stop first";

        if (input.wake_word) setWakeWord(guild.id, input.wake_word);

        const result = await startListening(vc, message.channel);
        if (result.success) {
          const wakeWord = getWakeWord(guild.id);
          return `now listening in ${vc.name}! users can say "Hey ${wakeWord}" to talk to me`;
        }
        return `failed to start listening: ${result.error}`;
      }

      return "use action: start, stop, or status";
    }

    case "manage_scrim": {
      if (input.action === "create") {
        const { activeScrims, buildLobbyEmbed } = await import("../../utils/scrims.js");
        const scrimId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        activeScrims.set(scrimId, {
          id: scrimId,
          host: message.author.id,
          game: input.game,
          teamSize: input.team_size || 5,
          status: "lobby",
          players: new Set([message.author.id]),
          createdAt: Date.now(),
        });
        const payload = buildLobbyEmbed(activeScrims.get(scrimId));
        await message.channel.send(payload);
        return `Successfully instantiated custom ${input.game} scrim lobby with team size ${input.team_size || 5}! The lobby embed was sent directly.`;
      }
      return "Unsupported action.";
    }

    case "reminder_set": {
      const delayMs = (input.delay_minutes ?? 0) * 60_000;
      if (delayMs <= 0) return "delay must be greater than 0 minutes";
      const fireAt = Date.now() + delayMs;
      const reminder = addReminder(
        message.author.id,
        guild?.id ?? null,
        message.channel.id,
        input.message,
        fireAt
      );

      const { reminderTimers } = await import("../../events/ready.js");
      const timerId = setTimeout(async () => {
        reminderTimers.delete(reminder.id);
        try {
          const ch = message.client.channels.cache.get(reminder.channelId);
          if (ch) {
            await ch.send(`<@${reminder.userId}> ⏰ Reminder: ${reminder.message}`);
          } else {
            const u = await message.client.users.fetch(reminder.userId).catch(() => null);
            if (u) await u.send(`⏰ Reminder: ${reminder.message}`).catch(() => {});
          }
        } catch {}
        removeReminder(reminder.id);
      }, delayMs);
      reminderTimers.set(reminder.id, timerId);

      const fireTs = Math.floor(fireAt / 1000);
      return `Reminder set (ID: ${reminder.id}) — I'll ping you <t:${fireTs}:R> with: "${input.message}"`;
    }

    case "reminder_cancel": {
      const reminderId = input.reminder_id;
      const { getReminders } = await import("../../database.js");
      const reminders = getReminders();
      const found = reminders.find((r) => r.id === reminderId && r.userId === message.author.id);
      if (!found) return `Couldn't find reminder #${reminderId} (or it already fired)`;
      const { reminderTimers } = await import("../../events/ready.js");
      const timer = reminderTimers.get(reminderId);
      if (timer) { clearTimeout(timer); reminderTimers.delete(reminderId); }
      removeReminder(reminderId);
      return `Reminder #${reminderId} cancelled`;
    }

    case "schedule_task": {
      if (!guild) return "schedule_task only works inside a server, not DMs.";

      const delaySec = Number(input.delay_seconds);
      if (!Number.isInteger(delaySec) || delaySec < MIN_SCHEDULE_DELAY_SECONDS) {
        return `delay_seconds must be a whole number ≥ ${MIN_SCHEDULE_DELAY_SECONDS} — for anything shorter, just call the tool directly.`;
      }
      if (delaySec > MAX_SCHEDULE_DELAY_SECONDS) {
        return `delay_seconds can't exceed ${MAX_SCHEDULE_DELAY_SECONDS}s (7 days).`;
      }

      const toolNameRaw = String(input.tool_name || "").trim();
      if (!toolNameRaw) return "tool_name is required.";
      const toolName = toolNameRaw.toLowerCase();
      if (NON_SCHEDULABLE.has(toolName) || NON_SCHEDULABLE.has(toolNameRaw)) {
        return `${toolNameRaw} can't be scheduled (would recurse). Pick a different tool.`;
      }

      const toolInput = input.tool_input;
      if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
        return "tool_input must be an object with the same shape you'd pass to the tool directly.";
      }
      // Cap serialized size so a hostile input can't blow up bot_data storage.
      let serialized;
      try { serialized = JSON.stringify(toolInput); }
      catch { return "tool_input must be JSON-serializable."; }
      if (serialized.length > 4000) return "tool_input is too large — keep it under 4000 chars.";

      const fireAt = Date.now() + delaySec * 1000;
      let task;
      try {
        task = addScheduledTask(
          guild.id,
          message.channel.id,
          message.author.id,
          toolName,
          toolInput,
          fireAt,
          input.note ? String(input.note).slice(0, 200) : null
        );
      } catch (err) {
        return `couldn't schedule — db error: ${err?.message || err}`;
      }
      if (!task?.id) return "couldn't schedule — db returned no task id.";
      armScheduledTask(task, message.client);

      const fireTs = Math.floor(fireAt / 1000);
      return `Scheduled task #${task.id} — will fire \`${toolName}\` <t:${fireTs}:R>${input.note ? ` (note: ${input.note})` : ""}`;
    }

    case "cancel_scheduled_task": {
      if (!guild) return "cancel_scheduled_task only works inside a server.";
      const taskId = Number(input.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) return "task_id must be a positive integer.";

      const task = getScheduledTask(taskId);
      if (!task) return `No pending task with ID ${taskId}.`;
      if (task.guildId !== guild.id) return `Task #${taskId} belongs to a different server.`;

      const timer = scheduledTaskTimers.get(taskId);
      if (timer) { clearTimeout(timer); scheduledTaskTimers.delete(taskId); }
      removeScheduledTask(taskId);

      return `Cancelled scheduled task #${taskId} (was going to run \`${task.toolName}\`).`;
    }

    case "list_scheduled_tasks": {
      if (!guild) return "list_scheduled_tasks only works inside a server.";
      const tasks = getScheduledTasks(guild.id);
      if (!tasks.length) return "No scheduled tasks pending in this server.";

      const lines = tasks
        .slice()
        .sort((a, b) => a.fireAt - b.fireAt)
        .map((t) => {
          const fireTs = Math.floor(t.fireAt / 1000);
          const noteBit = t.note ? ` — ${t.note}` : "";
          return `• #${t.id} \`${t.toolName}\` <t:${fireTs}:R>${noteBit}`;
        });
      return `Pending scheduled tasks:\n${lines.join("\n")}`;
    }

    case "calculate": {
      const expr = input.expression;
      if (!expr) return "No expression provided.";
      if (expr.length > 500) return "Expression too long (max 500 characters)";
      if (/\*{2,}\s*\d{2,}/.test(expr)) return "Math error: large exponents are forbidden for safety.";
      try {
        const statements = expr.split(";").map((s) => s.trim()).filter(Boolean);
        const vars = { PI: Math.PI, E: Math.E };
        let lastResult;
        for (const stmt of statements) {
          const assignMatch = stmt.match(/^([a-zA-Z_]\w*)\s*=\s*(.+)$/);
          if (assignMatch) {
            const [, varName, valExpr] = assignMatch;
            if (Object.prototype.hasOwnProperty.call(CALC_FUNCTIONS, varName.toLowerCase())) {
              return `Math error: "${varName}" is a reserved function name.`;
            }
            lastResult = evaluateMathExpression(valExpr, vars);
            vars[varName] = lastResult;
          } else {
            lastResult = evaluateMathExpression(stmt, vars);
          }
        }
        if (lastResult === undefined || lastResult === null) return "Expression returned no result.";
        let resultStr = typeof lastResult === "number"
          ? (Number.isInteger(lastResult) ? String(lastResult) : parseFloat(lastResult.toPrecision(12)).toString())
          : String(lastResult);
        if (input.show_steps) {
          const steps = statements.map((s, i) => `Step ${i + 1}: \`${s}\``).join("\n");
          return `${steps}\n\n**Result: ${resultStr}**`;
        }
        return `**${resultStr}**  ← \`${expr}\``;
      } catch (err) {
        return `Math error: ${err.message}`;
      }
    }

    case "web_search": {
      const rateErr = checkWebRateLimit(message.author.id, webRateLimitPerMin);
      if (rateErr) return rateErr;
      if (!input.query) return "No search query provided.";
      const userId = message.author.id;

      const encoded = encodeURIComponent(input.query);

      // ── Tier 1: Google Custom Search (if configured) ──
      const googleKey = process.env.GOOGLE_SEARCH_KEY;
      const googleCx = process.env.GOOGLE_SEARCH_CX;
      if (googleKey && googleCx) {
        try {
          // Custom Search API takes the key as a query parameter, NOT x-goog-api-key header.
          const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encoded}&num=5`;
          const res = await safeFetch(url, { timeoutMs: 10_000 });
          if (res.status >= 200 && res.status < 300) {
            const data = JSON.parse(res.text);
            if (data.items?.length) {
              const results = data.items.slice(0, 5).map((item, i) =>
                `${i + 1}. **${item.title}**\n   ${item.link}\n   ${item.snippet ?? ""}`
              );
              return wrapWebOutput(`🔍 Search results for "${input.query}":\n\n${results.join("\n\n")}`, userId);
            }
          } else {
            log(`[web_search] Google CSE ${res.status} — falling back to Gemini grounding`);
          }
        } catch (err) {
          log(`[web_search] Google CSE error: ${err.message} — falling back to Gemini grounding`);
        }
      }

      // ── Tier 2: Gemini Google Search grounding (always available when we have Gemini keys) ──
      const client = getGroundingClient();
      if (client) {
        try {
          const resp = await Promise.race([
            client.models.generateContent({
              model: config.geminiFastModel,
              contents: [{ role: "user", parts: [{ text: `Search the web for: ${input.query}\n\nReturn 3-5 concise results with titles, one-line summaries, and source URLs. Plain text, no markdown headers.` }] }],
              config: {
                tools: [{ googleSearch: {} }],
                maxOutputTokens: 1024,
              },
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("grounding timeout")), 25_000)),
          ]);
          const parts = resp?.candidates?.[0]?.content?.parts ?? [];
          const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
          if (text) {
            // Append the grounding source URLs if Gemini surfaced them
            const sources = resp?.candidates?.[0]?.groundingMetadata?.groundingChunks
              ?.map((c) => c.web?.uri).filter(Boolean).slice(0, 5) ?? [];
            const srcBlock = sources.length ? `\n\nSources:\n${sources.map((u) => `- ${u}`).join("\n")}` : "";
            return wrapWebOutput(`🔍 "${input.query}":\n\n${text}${srcBlock}`, userId);
          }
        } catch (err) {
          log(`[web_search] Gemini grounding failed: ${err.message} — falling back to DDG`);
        }
      }

      // ── Tier 3: DuckDuckGo instant answer (last resort) ──
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
        const res = await safeFetch(ddgUrl, { timeoutMs: 8_000 });
        const data = JSON.parse(res.text);

        const parts = [];
        if (data.AbstractText) parts.push(`**${data.AbstractSource}**: ${data.AbstractText}`);
        if (data.Answer) parts.push(`**Answer**: ${data.Answer}`);
        if (data.RelatedTopics?.length) {
          const topics = data.RelatedTopics.slice(0, 5)
            .filter((t) => t.Text)
            .map((t, i) => `${i + 1}. ${t.Text}${t.FirstURL ? ` — ${t.FirstURL}` : ""}`);
          if (topics.length) parts.push(`**Related**:\n${topics.join("\n")}`);
        }
        if (parts.length) return wrapWebOutput(`🔍 "${input.query}":\n\n${parts.join("\n\n")}`, userId);

        const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encoded}`;
        return `No results found. Try searching directly: ${liteUrl}`;
      } catch (err) {
        return `Search failed: ${err.message}`;
      }
    }

    case "web_read": {
      const rateErr = checkWebRateLimit(message.author.id, webRateLimitPerMin);
      if (rateErr) return rateErr;
      if (!input.url) return "No URL provided.";
      const userId = message.author.id;
      try {
        const res = await safeFetch(input.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; DiscordBot/1.0)" },
          timeoutMs: 10_000,
        });
        if (res.status < 200 || res.status >= 300) return `Failed to fetch: HTTP ${res.status}`;
        const html = res.text;

        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();

        const truncated = text.slice(0, 3000);
        const note = text.length > 3000 ? "\n\n*(truncated — page has more content)*" : "";
        return wrapWebOutput(`📄 Content from ${input.url}:\n\n${truncated}${note}`, userId);
      } catch (err) {
        return `Failed to read page: ${err.message}`;
      }
    }

    case "ask_eris": {
      const action = input.action;

      try {
        if (action === "remind") {
          // Validate user_id is a real Discord snowflake before passing to
          // Eris — otherwise the model could pass "alex" and Eris would later
          // try to render `<@alex>` as a ping (broken mention shown literally).
          let userIdRaw = input.user_id || message.author.id;
          if (!/^\d{17,20}$/.test(String(userIdRaw))) {
            const ctx = message.guild || message.member?.guild;
            if (ctx) {
              const m = findMember(ctx, String(userIdRaw));
              userIdRaw = m?.id || message.author.id;
            } else {
              userIdRaw = message.author.id;
            }
          }
          const delayMs  = (input.delay_minutes ?? 60) * 60_000;
          const remindAt = new Date(Date.now() + delayMs).toISOString();
          const res = await callEris("/remind", {
            method: "POST",
            body: {
              user_id: userIdRaw,
              channel_id: input.channel_id || message.channel.id,
              reminder_text: input.reminder_text || input.message || "reminder",
              remind_at: remindAt,
            },
          });
          const data = await safeErisJson(res);
          if (!data) return "eris responded weird, try again";
          return data.success ? `told my sister eris to set that reminder — she'll ping in ${input.delay_minutes || 60} minutes` : `eris couldn't set it up: ${erisErrorText(data, res)}`;
        }

        if (action === "note") {
          const res = await callEris("/note", {
            method: "POST",
            body: {
              user_id: input.user_id || message.author.id,
              title: input.title || "Note from Irene",
              content: input.content || "",
            },
          });
          const data = await safeErisJson(res);
          if (!data) return "eris responded weird, try again";
          return data.success ? "passed that note to eris — she's got it saved" : `eris couldn't save it: ${erisErrorText(data, res)}`;
        }

        if (action === "fact") {
          const res = await callEris("/fact", {
            method: "POST",
            body: { user_id: input.user_id || message.author.id, fact: input.fact },
          });
          const data = await safeErisJson(res);
          if (!data) return "eris responded weird, try again";
          return data.success ? "told eris to remember that" : `she couldn't save it: ${erisErrorText(data, res)}`;
        }

        if (action === "mood") {
          const res = await callEris("/mood");
          const data = await safeErisJson(res);
          if (!data) return "eris responded weird, try again";
          return `eris's mood: ${data.mood_score > 0 ? "good" : data.mood_score < 0 ? "bad" : "neutral"} (score: ${data.mood_score}, energy: ${data.energy})`;
        }

        if (action === "status") {
          const res = await callEris("/status");
          const data = await safeErisJson(res);
          if (!data) return "eris responded weird, try again";
          return `eris is ${data.status} — uptime: ${data.uptime}s. she says: "${data.message}"`;
        }

        return `i don't know how to ask eris to do "${action}" yet`;
      } catch (e) {
        return `couldn't reach eris right now — she might be sleeping (${e.message})`;
      }
    }
  }
}
