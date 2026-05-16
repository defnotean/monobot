# Tool Calling — End-to-End

How a structured tool call emitted by the model becomes a side effect (DB row, GIF embed, web fetch) and then a string the model sees on its next turn.

File paths are relative to `packages/eris/`. Line numbers track real source — they drift; the file paths and function names are the durable bit.

---

## 1. Mental model

```
model → { name, args } → executor.executeTool(name, args, message) → string → fed back as tool result
```

Three loops are nested:

- **Outer (per Discord message)**: `events/messageCreate.js` builds the system prompt, picks tools, calls the provider.
- **Middle (per AI turn)**: the provider runs `generate → split parts → dispatch tool calls → push results → generate again` up to `MAX_ITERATIONS = 5` (Gemini, `ai/dual.js:228`) or 10 (NVIDIA, `ai/providers/nvidia.js:246`). Loop exits when the model emits no tool calls.
- **Inner (per tool call)**: `executor.executeTool` runs alias correction, rate limit, cache lookup, dispatch — then either returns a cached string or runs the handler. Tool string results are stuffed back into a `functionResponse` part (Gemini) or `tool` message (NVIDIA / OpenAI-compat) and shipped on the next iteration.

The model **never** sees side effects directly. Everything is a string. If the handler stored a fact, the model sees `"remembered: ..."`. If it failed, the model sees `"Error: ..."` and is expected to recover (apologize, retry differently, give up gracefully).

---

## 2. Tool definition

All schemas live in `ai/tools.js` — pure data, no handlers. Two exports:

- `EVERYONE_TOOLS` (anyone can call) — `ai/tools.js:29` onward.
- `OWNER_TOOLS` (owner-only; gated inside each handler with `isOwner`) — appended later (`ai/tools.js:1774`).

Each entry is Anthropic-format:

```js
{
  name: "remember_fact",
  tags: ["fun"],                          // optional; "fun" opts into twin profile
  description: "Store a fact about ...",  // ≥25 chars (enforced by toolContracts.test.ts:82)
  input_schema: {
    type: "object",
    properties: { fact: { type: "string", description: "..." } },
    required: ["fact"],
  },
}
```

The provider abstraction (`ai/dual.js:79` `toGeminiTools`, `ai/providers/nvidia.js:31` `toNvidiaTools`, `ai/providers/openaiCompat.js:62`) translates Anthropic shape into whatever the active backend wants. Each provider strips fields the upstream rejects (Gemini hates `$schema`/`additionalProperties`/array `type`; OpenAI-compat additionally strips `allOf`/`anyOf`/`oneOf`). Conversion is cached in a `WeakMap` keyed by the tool array (`ai/dual.js:77`, `nvidia.js:29`, `openaiCompat.js:60`).

Contract enforcement lives in `tests/ai/toolContracts.test.ts`:

- Every tool needs a unique snake_case name (`:79-81`).
- Every required property needs a ≥12-char description (`:62-71`).
- Every tool must have a handler somewhere in `ai/` (`switch` `case`, `HANDLED` `Set`, or `toolName === ...` literal — `:36-47, 84`).
- Every name referenced by `TOOL_ALIASES`, `CACHEABLE_TOOLS`, or `CACHE_INVALIDATING_TOOLS` must map to a real tool (`:88-100`).
- Lookalike families (`update_personality` vs `ask_irene`, `execute_terminal` vs `execute_local`, `set_event_channels` vs `set_chat_channels`, `configure_feature` vs `configure_game`) get explicit description boundary assertions (`:102-122`).

---

## 3. Tool tiers (always-included vs context-included)

The full tool list is ~170 entries. Sending every schema on every turn would burn tokens and confuse the model. `ai/toolRegistry.js` runs a two-tier selection:

- **Tier 1** — full schemas in the API `tools` parameter. Hand-curated `_alwaysInclude` (`toolRegistry.js:157-166`: memory, GIF, meme, web search, notes, reminders, mood, channel config) plus any category whose keyword regex matches the current message (`:36-79`).
- **Tier 2** — name+one-line-description list appended to the system prompt as `OTHER AVAILABLE TOOLS` (`:104-106`). The model can still call them — the executor dispatches by name regardless of tier.

Categories (`toolRegistry.js:174-269`):

- `economy`, `games`, `advanced`, `grinding`, `code`, `news`, `fun`, `channel_restrictions`, `owner`, `always_include`, plus `other` for the leftovers.
- Each is `{ names: string[], keywords: RegExp }`.

Recent-usage boost: tools called in the same channel in the last 10 turns get pulled into Tier 1 (`toolRegistry.js:72-79`) — but game/activity tools are excluded (`GAME_TOOL_NAMES` at `:57-71`), because boosting `slots_spin` after one spin makes the model auto-fire it on every follow-up.

The **twin profile** is a metadata filter — `selectByMessage({ isTwin: true })` returns only tools with `tags: ["fun"]` (`toolRegistry.js:40-44`). Adding a tool to twin conversations is one tag away.

---

## 4. Tool aliasing — and the silent-fallthrough risk

`TOOL_ALIASES` in `ai/executor.js:37-135` is a hand-curated map of ~150 entries from "names the model emits" to "real tool names":

```js
const TOOL_ALIASES = {
  remember: "remember_fact", save_fact: "remember_fact",
  flip: "coinflip_bet", heads_or_tails: "coinflip_bet",
  terminal: "execute_terminal", shell: "execute_terminal", cmd: "execute_terminal",
  // ...
};
```

Applied first thing in `executeTool` (`:205-208`). If a model emits `flip`, it gets rewritten to `coinflip_bet` before any other layer runs.

**The audit-flagged risk**: matching is exact-case JS-property-lookup. `docs/audits/AUDIT-pc-agent.md:27-31` calls out that if the model emits `"Terminal"` (capital T), it never hits the `terminal: "execute_terminal"` alias and silently flows into the unknown-tool fallback at `executor.js:349-356` — counted as a hallucination, message returns `"unknown tool: Terminal"`. It's safe-by-accident for PC tools (the dangerous handlers aren't reached) but it's the same shape as a real bug: a near-miss model output becomes a no-op with a counter increment, no exception, no retry. The first-occurrence + every-10th log line at `:353` is the only visibility.

If you add a new alias and the model still misses, check exact case and underscores — there's no fuzzy match.

---

## 5. Sub-executor pattern

`ai/executor.js` is a router, not a handler. Anything beyond a tiny inline case (the `configure_bump_reminder` block at `:289-337` is the largest still inline) lives in a sub-executor.

Two sub-executor styles coexist:

**Legacy domain executors** — single file per domain, dispatched by hard-coded name set:

- `economyExecutor.js` — shop, inventory, loans, bounties, challenges, achievements (gated by the `ECONOMY_TOOLS` set at `executor.js:264-267`).
- `activityExecutor.js` — fish/hunt/dig/work/beg/search + weekly/monthly rewards (`:278-281`).
- `socialExecutor.js` — bank, give_coins, scratch/lootbox, adventure, prestige, multiplier, marry/divorce, craft/trade, pet battle/train, use_item (`:283-286`).

**New `executors/*.js` modules** — registered in the `SUB_EXECUTORS` array at `executor.js:247-260` and walked in order, first non-`undefined` result wins:

```
memory → media → web → notes → system → github → admin → twin → gambling → game → casino → misc
```

Each module exports `execute(toolName, input, message, context)` with a top-of-file `HANDLED = new Set([...])`. Returns `undefined` if it doesn't recognize the tool, lets the loop continue. Example contract (`executors/webExecutor.js:22-24, 48-50`):

```js
const HANDLED = new Set(["web_search", "scrape_url", "check_presence"]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;
  switch (toolName) { ... }
}
```

The order in `SUB_EXECUTORS` matters when two modules claim the same name — first wins. The contracts test (`tests/ai/toolContracts.test.ts:36-47`) scans every `ai/` file for `HANDLED` sets and `case` labels, so a tool with a schema but no handler fails CI.

The split is by *cognitive surface*, not size: `casinoExecutor.js` is 177 lines but lives alone because its tests (`tests/ai/poker.test.ts`, `stockMarket.test.ts`, `lottery.test.ts`) are layered the same way (`casinoExecutor.js:1-10`).

---

## 6. Per-tool rate limiting

`utils/toolRateLimit.js` is a per-user sliding window. The `TOOL_LIMITS` table at `:5-12` covers only the expensive externally-billed tools:

```js
web_search:    { max: 10, windowMs: 60_000 },
scrape_url:    { max: 5,  windowMs: 60_000 },
analyze_image: { max: 5,  windowMs: 60_000 },
search_images: { max: 10, windowMs: 60_000 },
create_meme:   { max: 5,  windowMs: 60_000 },
send_gif:      { max: 10, windowMs: 60_000 },
```

Storage is in-process: `userId:toolName → [timestamps]` (`:15`). Periodic cleanup every 5 min drops empty windows (`:18-27`). Tools not in the table return `{ allowed: true }` immediately — economy, memory, notes, and games are *not* rate-limited here. Those rely on the DB-side cooldowns inside their handlers.

`executor.js:213-219` runs the check; on a hit the user gets `"chill — you're using ${toolName} too fast. try again in ${secs}s"` and the model sees that string as the tool result. Counts the failed call against neither cache nor the per-key API limit.

---

## 7. Error contract

Tool handlers **never throw to the model**. They return a string. Error shape conventions:

- Plain English for the user-facing case: `"no search query provided"`, `"couldn't find that memory"`, `"not enough coins"`.
- `"Error: <message>"` for an exception the wrapper caught — `ai/dual.js:467-470` and `nvidia.js:362-364` both turn thrown errors into `"Error: <msg>"` / `"tool error: <msg>"` strings.
- `"unknown tool: <name>"` for hallucinations (`executor.js:356`).

The cache layer deliberately refuses to cache error strings — `setCachedResult` skips anything matching `^(Error:|Couldn't|Failed|Sorry,|You don't|Not enough)/i` (`executor.js:176-177`). Without this, a transient web_search failure would freeze for the 15s TTL.

Timeouts surface the same way: `ai/dual.js:455-470` races each tool against 10s (default) / 25s (`SLOW_TOOLS` at `:442`). On timeout the model gets `"Error: tool \"X\" timed out after 25s"` and a late-completion observer logs the eventual result for forensics (`:472-478`).

The model is *expected* to read the error and either retry with different args, fall back to chat, or apologize. Empirically: Gemini reads errors well, Kimi/Qwen sometimes re-emit the same call (handled by `calledSignatures` dedup — `dual.js:254, 421-431`, `nvidia.js:243, 345-353`).

---

## 8. Adding a new tool — recipe

1. **Schema** — append to `EVERYONE_TOOLS` or `OWNER_TOOLS` in `ai/tools.js`. Use snake_case. Description ≥25 chars. Every required property gets a ≥12-char description. If it belongs in twin convos, add `tags: ["fun"]`.
2. **Handler** — pick a sub-executor in `ai/executors/` whose domain fits (or add a new one and append it to `SUB_EXECUTORS` in `executor.js:247-260`). Add the name to `HANDLED`, add a `case` branch, return a string.
3. **Tier 1 routing** — open `ai/toolRegistry.js:155-269`, drop the name into the relevant category's `.filter(t => [...].includes(t.name))` list. If no category fits, either expand a category's regex or add the name to `_alwaysInclude` at `:157-166`.
4. **Aliases (optional)** — if you expect the model to mis-name it, add entries to `TOOL_ALIASES` in `ai/executor.js:37-135`. Watch case.
5. **Cache policy** — if it's read-only and idempotent for ~15s, add to `CACHEABLE_TOOLS` at `executor.js:142-150`. If it mutates user state, add to `CACHE_INVALIDATING_TOOLS` at `:152-166`. If it mutates *another* user's state too, add to `TWO_USER_TOOLS` at `:199-201`.
6. **Rate limit (optional)** — if it costs external $ per call, add a row to `TOOL_LIMITS` in `utils/toolRateLimit.js:5-12`.
7. **Game-tool dedup (optional)** — if it's a game/activity that should be one-per-turn, add to both `GAME_TOOLS` in `dual.js:403-418` and `GAME_TOOL_NAMES` in `toolRegistry.js:57-71`. The dual.js comment at `:401-402` calls out that these three lists must stay aligned.
8. **Tests** — `pnpm vitest run ai/toolContracts` will fail if the handler is missing, the description is too short, or an alias points nowhere.

---

## 9. Cross-provider quirks

Provider selection in `ai/providers/index.js:22-77` reads `config.aiProvider`. The active provider is loaded once at boot; `runGeminiChat` (the name stuck even though it's now provider-generic) is re-exported from `:112`.

**Gemini** (`providers/gemini.js`, delegates to `ai/dual.js`):

- Tool shape: `[{ functionDeclarations: [...] }]`. Conversion at `dual.js:79-94`.
- Schema sanitizer strips `$schema`, `additionalProperties`, `default`, `format`; collapses array `type: ["string","null"]` to `"string"` (`:46-65`).
- History conversion: Anthropic message blocks → `functionCall` / `functionResponse` parts (`:154-198`).
- `MAX_ITERATIONS = 5`, per-call timeout 10s/25s, whole-loop timeout 90s worker / 45s fast.
- Quirks: thinking-only response (all `parts` have `thought: true`, no visible text, no calls) is handled by a fallback-model retry at `:495-509`. `maxOutputTokens` must exceed `thinkingBudget` or visible text is silently truncated (called out in comments at `:259-262`).

**NVIDIA / Kimi** (`providers/nvidia.js`):

- Tool shape: OpenAI `[{ type: "function", function: { name, description, parameters } }]`. Conversion at `:31-65`.
- Schema sanitizer is lighter (only `$schema` and array `type`); see `:14-27`.
- Loop budget is 10 iterations (`:246`) vs Gemini's 5 — Kimi/Qwen often need more turns to converge.
- Inflated system prompt: `:178-217` appends a "TOOL USE — CRITICAL" block with explicit user-phrase→tool-name mappings, because Qwen otherwise narrates what it *would* do instead of calling the tool.
- Circuit breaker at `:127-156` — 3 consecutive failures opens; half-open after 30s. `isRateLimited()` is queried by `providers/index.js:92-95` to route around a dead primary.
- Auto-fallback to Gemini on 5xx/timeout/network (not on 401/403/4xx user errors) — `_classifyError` + `_fallbackToGemini` at `:409-463`.

**OpenAI-compat** (`providers/openaiCompat.js`):

- Same wire format as NVIDIA (OpenAI chat completions); covers OpenRouter, Groq, Cerebras, Mistral, DeepInfra, Together, GitHub Models, Cloudflare Workers AI, LM Studio, Ollama (`:1-6`, `providers/index.js:50-71`).
- Stricter sanitizer — also strips `allOf`, `anyOf`, `oneOf`, coerces `enum` values to strings (`:46-58`).
- API-key rotation cursor (`_apiKeyCursor` at `:12`) lets you pool multiple keys per provider.

**All three** translate tool results back to a provider-shaped message:

- Gemini: `{ functionResponse: { name, response: { result: <string> } } }` (`dual.js:480-484`).
- NVIDIA / OpenAI-compat: `{ role: "tool", tool_call_id, content: <string> }` (`nvidia.js:382-389`).

The executor doesn't care — it returns strings.

---

## 10. Debugging tool dispatch

Logs come from `utils/logger.js` — `log(...)` writes to console and (in production) ships to wherever your log sink is. Greppable tags:

- `[EXECUTOR] Auto-corrected tool: X → Y` — alias hit (`executor.js:206`). If the model is making this mistake repeatedly, consider adding it to the system prompt instead of fixing it after the fact.
- `[EXECUTOR] Cache hit: X` — read-only cache served the result (`executor.js:224`).
- `[EXECUTOR] Unknown tool: X (hit #N, user, args: ...)` — no sub-executor claimed it (`executor.js:354`). First occurrence + every 10th; the `_unknownToolCounts` Map at `:362` accumulates them.
- `[REGISTRY] N tools registered across M categories` — boot-time summary (`toolRegistry.js:287`).
- `[AI] Skipping duplicate X call (already executed this turn)` — same name+args fired twice in one turn (`dual.js:428`).
- `[AI] late-completion of timed-out "X" → ...` — a tool that timed out eventually finished. Side effects landed; the model never saw the result (`dual.js:475`).
- `[Gemini] dropped malformed functionCall (no name)` — model emitted a call with no name; dropped silently (`dual.js:366`).
- `[NVIDIA] running N tool calls in parallel: ...` — multi-call turn (`nvidia.js:356`).
- `[NVIDIA] Bad tool args for X: <err>` — model emitted invalid JSON in `arguments` (`nvidia.js:339`).
- `[NVIDIA] CIRCUIT OPEN — N consecutive failures` — provider circuit tripped (`nvidia.js:131`).
- `[NVIDIA→Gemini] fallback after <label>` — cross-provider failover (`nvidia.js:448`).
- `[web_search] Gemini grounding failed: ... — falling back to DDG HTML` — Tier 1 search failed, fell back to universal engine (`webExecutor.js:82`).

To trace a single tool call end-to-end:

1. Grep for the **tool name** — every dispatch and most sub-executors log it.
2. Grep for the **user ID** — `executor.js:354` includes it; many handlers add it to their log lines too.
3. Check `_unknownToolCounts` — if the count is climbing for a name that looks legit, you forgot to register it.
4. If results look stale, look at the **cache** — `getCachedResult` returns before the handler runs; the `Cache hit` log fires before any handler-level log would.
5. If the model loops, look at **dedup signatures** — `stableSig` in `dual.js:19-27` sorts arg keys before hashing; a model emitting `{a:1,b:2}` then `{b:2,a:1}` is dedup'd, but `{a:1,b:"2"}` (string vs number) is not.

For changes to the dispatch order itself: `executor.js:247-260`. For changes to the alias map: `:37-135`. For changes to cache policy: `:142-166`.
