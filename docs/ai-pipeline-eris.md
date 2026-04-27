# Eris AI Pipeline

End-to-end trace of an incoming Discord message, from gateway event to a delivered reply. File paths are relative to `packages/eris/`. Line numbers are approximate.

---

## 1. Entry point — `[STABLE]`

`index.js` boots `discord.js` with the intent set for guild messages, content, members, DMs, presences, and reactions (`index.js:16-27`). Event modules are auto-loaded from `events/`: each `*.js` file is dynamically imported, its `default` export wrapped in `try/catch` (`:71-74`) and bound to `client.on(filename)`, so `events/messageCreate.js` handles every `MESSAGE_CREATE`. A keepalive HTTP server shares the process (`:91-117`).

---

## 2. Gating — `[EVOLVING]`

`events/messageCreate.js` runs a long gauntlet, in order: self-skip + LRU dedup on `message.id` (`:257-262`); bump-service short-circuit for DISBOARD/Discadia/Disforge confirms (`:267-284`); sleep mode unless owner-with-wake-trigger (`:287-298`); bot allowlist — twin Irene (`TWIN_BOT_ID`, `:176`) and bots that mention us pass, 3-exchange/5-min loop guard (`:301-323`); exploit/spam filter via `EXPLOIT_PATTERNS` (`:40-64`) plus `trackMessage`+`addWarning` escalating to Discord timeouts at 3+ repeats (`:354-372`); twin throttle at 2 mention or 1 name-drop exchange (`:402-428`); hard directive block for "don't talk here" rules, owner-only override (`:437-454`); mention/name/reply gate requiring `@mention`, username/displayName/sub-tokens, or `_awaitingReply` within 90s (`:464-501`); mute list (`chat_muted_channels`, `:507-511`); rate-limit + per-user anti-spam escalating 15s → 60s → 5min (`:516-543`); 1500-char length cap for non-owners (`:545-548`); injection firewall — keyword pre-filter then semantic `checkInjection` (`:549-564`). Concurrent messages serialize through a per-channel `withLock` mutex (`:151-164, 575`).

---

## 3. Context building — `[EVOLVING]`

After the typing indicator starts (`:573, 580-582`), two parallel batches fetch memory + custom personality + cross-channel snippets (`:610-614`), then personality, opinions, self-canon, twin state, long-term memory, preoccupations (`:681-697`).

`systemInstruction` is assembled from base personality (`serverPersona` / DB / `config.botPersonality`, loaded at boot from `prompts/eris-personality.md` via `prompts/loader.ts`), speaker/server/channel tags, affinity tier, mood + energy labels (`:634-647`); temporal context (`:652-662`); mood modifiers (`:665-673`); keyword nudges for code, distress, gambling, bump config, event channels, game tracking, karaoke, awaited replies (`:700-729`); group-chat awareness from last 20 entries (`:743-763`); active directives (`:766-775`); channel context from last 12 messages plus a variety check listing recent openers/endings (`:850-887`); `[ADDRESSING — STRICT]` framing (`:786-788`); `[LENGTH BUDGET]` block at 150 / 250 / 400 chars by message type (`:1018-1034`).

History is per-channel (guilds) / per-user (DMs) in a 2000-entry / 1h LRU (`:170`). `compressHistory` (`ai/contextCompressor.js`) bins it three tiers — last 3 turns full, turns 4-8 moderate, older one-liners — with hard-slice fallback (`:900-904`).

**Two-tier tool selection.** `ai/toolRegistry.js` registers ~10 categories with regex keyword patterns (`toolRegistry.js:147-256`). When a category's regex matches the message, its tools land in Tier 1 (full schemas sent to the model). `_alwaysInclude` (memory, web, GIF, notes, mood — `:149-158`) is permanent; recent-usage tools for that channel are boosted, excluding game tools (`:64-71`). The remainder become a Tier 2 name+description catalog appended to the prompt — the executor still dispatches by name. `messageCreate.js:910-942` builds five cached tool profiles (`twin`, `chat`, `chatOwner`, `full`, `fullOwner`) and routes by `looksLikeTask(...) || ACTIVITY_KEYWORDS_RX.test(...)` plus owner status. The `twin` profile is metadata-driven — it's `EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"))`, so adding `tags: ["fun"]` to a tool definition in `ai/tools.js` is the only step needed to make it available in twin conversations. Gemini schemas are sanitized once and cached in a `WeakMap` (`ai/dual.js:40-57`). A 12000-char budgeter trims `core` to make room for `runtime` (`messageCreate.js:999-1014`).

---

## 4. AI call — `[EVOLVING]`

`runGeminiChat` in `ai/dual.js:185-447` is the orchestration loop. Worker model = `config.geminiModel` (Gemini 2.5 Pro), fast = `config.geminiFastModel`, `config.geminiFallbackModel` covers empty/filtered or 429 responses (`:214, 244-248, 274-279`). Caps: `MAX_ITERATIONS = 5`, `maxOutputTokens = 2048`, `thinkingBudget = 4096` worker / `256` fast (`:186, 215, 227-228`); whole loop in `Promise.race` against 90s worker / 45s fast (`:190, 442-446`). `SLOW_TOOLS` (web/scrape/image/email/github) get a 25s per-call budget, everything else 10s (`:369, 382`); late completions of timed-out tools are logged (`:400-405`).

Each iteration: generate → split parts into text/thinking/functionCall → push assistant turn → break if no calls. Otherwise execute calls in parallel, dedup signatures via `calledSignatures` (`:212, 350-358`), enforce one-game-per-turn via `GAME_TOOLS` (`:339-348`), feed `functionResponse` parts back as a user turn (`:371-415`). `part.thought` parts are mined for self-reflective sentences and stored via `addThought` (`:311-326`). Two fallback-model retry tiers handle "tools ran but no follow-up text" and "thinking-only output" (`:259-289, 422-435`). On 429 the specific `keyPool` key is marked (`:236-239`) and the fallback model is tried before surfacing a "brain overheating" message. A quick-reply path (`dual.js:69-100`) is fired-and-forgotten on the conversational client for task-like non-game, non-twin, non-sister messages (`messageCreate.js:976-982`).

---

## 5. Tool dispatch — `[STABLE]`

`ai/executor.js:192-232` is a thin router: auto-correct ~150 model name mistakes via `TOOL_ALIASES` (`:32-131`); per-user rate-limit expensive tools via `utils/toolRateLimit.js` (`:202-208`); read-only cache (15s TTL, 200-entry LRU keyed by `userId:toolName:args`, `CACHEABLE_TOOLS` at `:137-146, 211-215`); then `_executeToolInner` delegates to legacy JS executors (`economyExecutor`, `activityExecutor`, `socialExecutor`) by hardcoded set membership (`:251-275`), then walks the `SUB_EXECUTORS` array (`:236-249`) — `memory`, `media`, `web`, `notes`, `system`, `github`, `admin`, `twin`, `gambling`, `game`, `casino`, `misc` — first non-`undefined` wins. Writes invalidate the user's cache in O(k) via the LRU group index, plus the target user for `TWO_USER_TOOLS` (`:218-229`). Hallucinated tool names accumulate in `_unknownToolCounts` (`:338-345`). Calls inside one turn run in parallel via `Promise.all(calls.map(...))` (`dual.js:371`).

---

## 6. Response rendering — `[EVOLVING]`

After `runGeminiChat` returns (`messageCreate.js:1038-1046`): the 8s typing-interval is cleared (`:1052`); game-tool embeds suppress the AI's redundant text (`:1059-1069`); the reply is scrubbed of leaked `tool_code`/`functionCall(...)`/`[used X]`/`[SYSTEM:...]`/`[username said]` blocks via ~10 regex passes (`:1071-1091`); `@username` resolves to `<@id>` (`:1098-1102`); `_charBudget` trims to the last sentence boundary with 1.2× grace (`:1106-1121`); 2000-char Discord cap is the safety net (`:1123`).

`sendHumanReply` (`utils/humanDelay.js:106-140`) picks a typing delay (~3.3 chars/sec ± 30%, clamped 350-4500ms — `:16-35`), optionally splits into 2-3 segments at "wait" / "actually" / "oh also" breakpoints (`:42-87`), `reply()`s segment 1 and `channel.send`s the rest with 400-1400ms pauses. If the reply contains `?`, `_awaitingReply` opens a 90s follow-up window without re-mention (`messageCreate.js:1140-1144`). A 1% afterthought sends a 6-word fast-model follow-up after 3-7s, word-overlap dedup'd (`:1159-1182`).

---

## 7. State persistence — `[EVOLVING]`

Mostly fire-and-forget Supabase writes via `database.js`. Pre-AI: `db.saveInteraction(user)` (`messageCreate.js:594`). Per tool call: `db.logToolUsage` (`:1039`). In-loop: `addThought` writes inner reasoning to `ai/longmemory.js` (`dual.js:313, 323`). Post-reply: `db.saveInteraction(bot)` (`messageCreate.js:1148`); `trackHumanInteraction` + `detectMoment` (`ai/humanity.js`, `:1134-1135`); affinity via `db.updateRelationship`, mood via `db.shiftMood` (`:1199-1207`); personality drift via `trackPersonality` (`ai/personality.js`, `:1212`); episode extraction via `analyzeExchange` (`ai/longmemory.js`, `:1220`); passive coins via `db.earnMessageCoins` (`:1224`); inside-joke tracking via `db.updateUserPreferences` (`:1227-1249`). `personality.js` and `longmemory.js` buffers flush on SIGTERM/SIGINT (`index.js:121-131`). Opinions, self-canon, preoccupations, audit, mood are updated by their respective `ai/*.js` modules during context building.

---

## Common entry points for changes

| I want to... | Edit these files |
| --- | --- |
| add a new AI tool | `ai/tools.js` (schema) + `ai/executor.js` or `ai/executors/<domain>.js` (handler) + register category in `ai/toolRegistry.js` + tests |
| change response cadence | `utils/humanDelay.js` |
| change AI model / token caps / iteration budget | `ai/dual.js` (and `config.js` for model IDs) |
| change gating (mentions, cooldowns, mute list) | `events/messageCreate.js` |
| change context shaping | `events/messageCreate.js` (assembly) + `ai/contextCompressor.js` (history) |
| change personality text | `prompts/eris-personality.md` (loaded via `prompts/loader.ts`) |
| add a new persistence column | `database.js` + `migrations/` |

---

## Where to look when X breaks

- Reply truncated mid-sentence → `_charBudget` trimmer at `messageCreate.js:1106-1121`, `[LENGTH BUDGET]` at `:1033`, `maxOutputTokens` at `ai/dual.js:227`.
- Wrong tool called → keyword regex in `ai/toolRegistry.js:147-256` plus `TOOL_ALIASES` in `ai/executor.js:32-131`.
- Bot ignores a message → walk the gating ladder in `messageCreate.js`: dedup (~261), sleep (~287), bot allowlist (~301), directive block (~437), mention gate (~464-501), mute list (~507), rate limit (~516), spam cooldown (~542), length guard (~545), injection firewall (~551).
- Tool times out → `SLOW_TOOLS` and per-call `Promise.race` at `ai/dual.js:369, 382`; per-user limits in `utils/toolRateLimit.js`.
- Bot loops with its twin → `MAX_TWIN_EXCHANGES` and Jaccard guard at `messageCreate.js:178, 393-398`; bot-to-bot counter at `:314-322`.
- 429 / "brain overheating" → per-key pool marking at `ai/dual.js:236-239`; pool in `ai/keyPool.js`.
- Empty / no response → empty-part recovery at `ai/dual.js:259-289`, thinking-only retry at `:422-435` — both retry against `config.geminiFallbackModel`.
- Cached stale balance / inventory → `_toolCache` TTL and `CACHE_INVALIDATING_TOOLS` at `ai/executor.js:137-155`; `TWO_USER_TOOLS` at `:188-190`.
