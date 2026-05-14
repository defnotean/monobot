# Irene AI Pipeline — Discord message → reply

End-to-end trace through Irene. Paths absolute from repo root; line numbers approximate.

## How to read this

The pipeline runs in **7 stages** — a message flows through them top to bottom:

1. **Entry point** — the Discord event arrives and gets routed to `messageCreate.js`.
2. **Gating** — a gauntlet of cheap skip-checks decides *whether to reply at all*. Auto-mod also runs here, and most messages stop at this stage before spending a single AI token.
3. **Context building** — assemble the system prompt: personality, permissions, memory, server rules, history, and which tools to offer.
4. **AI call** — hand it to the model and run the generate → tool-call loop.
5. **Tool dispatch** — route each tool the model asked for to the code that runs it.
6. **Response rendering** — clean up the model's text and deliver it like a human typing.
7. **State persistence** — write back what changed (mood, memory, affinity, …).

Roughly: stages 1–2 *gatekeep*, 3–5 are the *AI turn*, 6–7 *clean up and deliver*.

Each heading is tagged **`[STABLE]`** (settled; changes rarely — safe to build on) or **`[EVOLVING]`** (actively churning — trust the code over the line numbers here). Treat the whole doc as a map, not a spec: skim it once for the shape, then jump back to the stage you're actually touching. Line numbers drift; the stage names and file paths are the durable part.

## 1. Entry point  [STABLE]

`packages/irene/index.js` (~line 20) builds the discord.js `Client`. `main()` (~line 249) boots in order: `startPresenceAPI(client)` → `initDatabase` → `loadCommands` → `loadEvents` → `registerCommands` → `client.login` → `setupLavalink`.

`startPresenceAPI` runs *first* so Render's port-detection timeout doesn't kill the dyno. Server in `packages/irene/presence.js` (~line 100) hosts `/presence`, `/tts/:id`, dashboard `/api/*`, and the HMAC-signed `/api/twin/command` Eris uses (~line 472).

`loadEvents()` (~line 130) glob-imports `events/*.js` and wires `execute` to `client.on(name, …)`. `messageCreate.js → execute(message)` (~line 331) is the AI-pipeline entry.

## 2. Gating  [STABLE]

`messageCreate.js` runs an ordered series of bail-outs before spending AI tokens:

- **Dedup + self-loop guard** (line 333).
- **Auto-mod** (line 348): `enforceMessage()` from `ai/rulesEnforcer.js` runs the cheap regex pre-filter → on a hit, the LLM judge. If it actions the message, handler returns so Irene doesn't AI-reply on top of moderating.
- **Sleep/nap mode** (line 360); **bot detection** (line 389) — twin allowed, other bots only if they @mention with a 3-exchange/5-min cap; **anti-exploit pattern wall** (line 417) for paradox/recursion/twin-loop prompts; **repeat escalation** (line 468) → 5/15/60 min auto-timeout.
- **Age gate** (line 567): drop messages >30 s old (shard-resume replays).
- **Per-user AI cooldown** (line 577) escalates on abuse; **length guard** (line 605) silently drops >1500 chars from non-owner.
- **Anti-injection firewall** (line 613): keyword pre-filter, then async fire-and-forget into `ai/firewall.js → checkInjection()` (~line 491) — L1 normalization (homoglyph/leetspeak/unicode), L1.5 decoding (base64/rot13/reversed), L2 multi-language regex, L3 semantic similarity (Voyage + pgvector). Owner exempt; fail-open.
- **Mention/name match** (line 749): in guilds, only respond when @mentioned, name (username, server-persona, 4+ char chunk) appears, or twin speaks. If only Eris is named, stay silent.
- **Per-user serialization queue** (line 791): in-flight → queue (max `config.maxQueuedMessages`) with 📝 reaction.

`rulesEnforcer.js → enforceMessage()` (~line 127) is its own pipeline: skip DMs/bots/owner/ManageGuild/exempt-users/60s-cooldown → `analyzeMessage()` LLM judge → `decideAction()` escalation. Auto-mod fires upstream and short-circuits everything. DM opt-out checked at the post-reply DM-mirror step (~line 1824).

## 3. Context building  [EVOLVING]

System prompt assembled in layers (~line 939+). Recent commit `feat(irene): rules + commands awareness in AI context` added the `[SERVER RULES]` and `[YOUR SLASH COMMANDS]` blocks.

1. **Personality** (line 899): server persona override → Supabase custom → `config.botPersonality`. Cached per-guild 5 min.
2. **Permission context** (line 885): ADMIN/MODERATOR/STAFF/MEMBER from Discord API perms + anti-impersonation block.
3. **Core instructional block** (lines 939–1082): tools-by-emoji guide, anti-hallucination rules, parallel-search rule, "don't double down" rule.
4. **Memory injection** (line 1085): `buildMemoryContext` from `ai/memory.js`.
5. **`[DIRECTIVES]`** (line 1091): admin-set behavioral rules, server-wide + per-channel filtered.
6. **`[YOUR SLASH COMMANDS]`** (line 1108): `buildCommandsContext(client.commands)` from `utils/commandsHelp.js` — `/name — description` so Irene suggests real commands instead of hallucinating.
7. **`[SERVER RULES]`** (line 1121): auto-mod engine's stored rules + whether enforcement is enabled.
8. **`[MANDATORY_SEARCH]`** (line 1150): heuristic — factual question / homework / challenge → forces `web_search` before any text output.
9. **Length budget** (line 1156): per-turn char cap, also enforced post-hoc (vent: 400, research: 250, casual: 150).
10. **Mood, relationship, temporal, personality drift, long-term recall** (lines 1162–1216): all cached, 1 s timeout so a slow DB doesn't stall the handler.
11. **`[CHANNEL CONTEXT]`** (line 1487): last ~10 channel messages summarized — passive awareness, NOT pushed as history (would make the bot try to reply to everyone).
12. **Variety check** (line 1518): tracks Irene's recent openers/endings, tells the model to break the pattern.
13. **History + compression** (lines 1380, 1536): `conversations` LRU per-channel for guilds, per-user for DMs. `compressHistory()` from `ai/contextCompressor.js` runs progressive 3-tier compression (recent full → mid-truncated → ultra-compressed) within an 8 KB budget.

Final prompt hard-capped at `PROMPT_BUDGET = 12000` chars (line 1601), trimming the static core to make room for runtime context.

## 4. AI call (`ai/dual.js`)  [EVOLVING]

`runGeminiChat()` (~line 257):

- **Key pool** (`ai/keyPool.js`, instantiated in `messageCreate.js` line 45): 12 Gemini keys split "conv" (Flash) + "work" (Pro+thinking), per-key 429 tracking.
- **Model routing** (line 281): `looksLikeTask(content)` (in `messageCreate.js` line 1542) — strong-action verbs/imperatives → worker, chitchat → fast. Both paths get the full tool surface; Flash isn't upgraded mid-request (used to cause 60 s timeouts on twin banter).
- **Token budgets** (lines 282–287): Fast `thinkingBudget=256, maxOutputTokens=2048, timeout=35s`. Worker `thinkingBudget=4096, maxOutputTokens=8192, timeout=60s`. **Recent fix (~line 287)**: `maxOutputTokens` MUST exceed `thinkingBudget` because thinking tokens count toward the cap — previous mismatch silently truncated visible text mid-word.
- **Iteration loop** (line 289): up to 15 turns. Per-turn signature dedup (`calledSignatures` line 274) stops the model spamming the same call.
- **Tool execution** (line 484): all calls in a turn run in parallel via `Promise.all`. Per-tool timeouts from `config.timeouts.tool{Fast,Slow,VerySlow}` based on `VERY_SLOW_TOOLS`/`SLOW_TOOLS` allowlists (line 478). Late-completing timed-out tools attach an observer.
- **Empty-response handling** (line 343): retry on `GEMINI_FALLBACK_MODEL` — first with tools, then text-only.
- **Thinking → monologue capture** (line 399): `thought: true` parts scraped for "I think/feel/wonder…" and added via `addThought()` to `ai/longmemory.js`.

`quickReply()` (line 42) uses Flash with `thinkingBudget: 128` and 5 s timeout to fire a short ack while the worker grinds.

## 5. Tool dispatch (`ai/executor.js` + sub-executors)

`executeTool(toolName, input, message)` (~line 332):

1. **Alias correction** (`TOOL_ALIASES`, line 211) — hand-curated map for Gemini's name drift (`play → play_music`, `ban → ban_user`).
2. **Per-user/per-tool rate limit** (`utils/toolRateLimit.js`).
3. **Read-cache check** (`CACHEABLE_TOOLS`, line 291): 15 s TTL keyed `guildId:toolName:argsJSON`. Write tools in `CACHE_INVALIDATING_TOOLS` (line 299) clear it.
4. **`_executeToolInner()`** (line 365): builds shared `ctx` (`findMember`, `findChannel`, `findRole`, `checkHierarchy`, `checkRoleAssignment`, lines 84–205) and walks `SUB_EXECUTORS` (line 30). Each sub-executor declares a `HANDLED` Set, returns `undefined` for tools it doesn't own, result string for ones it does.
5. **Inline fallback** (line 391): tools not yet extracted (temp VC, whitelist) still in a giant `switch` in `executor.js`.

Sub-executors in `packages/irene/ai/executors/`: `channelExecutor`, `roleExecutor`, `moderationExecutor` (~658 lines, with `checkHierarchy`), `voiceExecutor`, `audioExecutor`, `levelingExecutor`, `personalizeExecutor`, `memoryExecutor`, `toggleExecutor`, `messageExecutor`, `serverExecutor`, `advancedExecutor`, `setupExecutor` (~1274 lines, composite flows: welcome, verify, reaction roles, starboard, ticket).

The sub-executor pattern is **[STABLE]**. The 1663-line `executor.js` itself is **[EVOLVING]** — the inline `switch` and alias table will keep shrinking as more domains move out.

The same `executeTool` path is reused by the twin command relay in `presence.js` (line 567) — Eris HMAC-signs a request, Irene resolves the requester's real `member` (so `checkHierarchy` evaluates against the user, not the bot — comment at line 519), and dispatches.

`ai/toolRegistry.js → selectByMessage()` (line 36) implements two-tier selection. `messageCreate.js` (line 861) currently bypasses it and sends ALL tools every message — registry is wired and tracking usage for when Tier 2 is re-enabled.

## 6. Response rendering  [STABLE]

After `runGeminiChat` returns (line 1667):

- **Reply scrub** (line 1685): strip leaked tool syntax (`tool_name(args)`, `<tool_code>`, `[Irene said]`, `[result: …]`).
- **Mention resolution** (line 1710); **length-budget enforcement** (line 1723) trims to last sentence boundary at/under `message._charBudget`; **chunk split** (line 1747) `splitMessage(text, 2000)` for rare >2000-char Discord cap.
- **Human delivery** (line 1755): `sendHumanReply()` from `utils/humanDelay.js` (line 106). Typing delay median 3.3 chars/sec ±30%, capped 350–4500 ms; shows typing indicator; optionally splits into 1–3 segments at natural breakpoints (`splitHumanReply` line 55) using markers like "wait", "actually", "ngl". First segment uses `message.reply()`, follow-ups use plain `channel.send()` to avoid double-pinging.
- **Typing indicator** kept alive during the AI call by an 8 s `setInterval` (line 1580); status-message cleanup (line 1674); DM mirror (line 1824) if tools used + guild DM-results enabled + user not opted out; afterthought (line 1797) 4% chance with strict word-overlap dedup.

## 7. State persistence  [STABLE]

Writes scattered through the post-reply path hit Supabase via `database.js` and the `ai/` sub-systems:

- **Conversation history** (line 1680): `saveConversation` — debounced batch write.
- **Mood + affinity** (line 1283): `updateRelationship` + `shiftMood` — sentiment-weighted, creator boost.
- **Personality drift** (line 1296): `trackPersonality` → `ai/personality.js`.
- **Long-term memory / episodes** (line 1835): `analyzeExchange` → `ai/longmemory.js` extracts episode-worthy exchanges, refreshes mood narrative, persists thoughts captured live during the model's reasoning step.
- **Humanity / per-user trust + grudges** (line 1761): `trackHumanInteraction` + `detectMoment` in `ai/humanity.js`. Full snapshot every 100 messages via `periodicUpdate`.
- **Audit** tool-side via `logAudit` in each sub-executor; **opinions/rules/per-guild settings** all write through `database.js`'s debounced flush (`flushNow` invoked on SIGTERM in `index.js` line 324); **memory facts** route through `memoryExecutor.js` → `ai/memory.js`.

Shutdown (`index.js` line 305) explicitly flushes `database.js`, `ai/personality.js`, and `ai/longmemory.js` within an 8 s race against Render's SIGKILL.

## Common entry points for changes

| I want to... | Edit these files |
| --- | --- |
| add a new AI tool | `ai/tools.js` (schema) + `ai/executors/<domain>.js` (find the right one) + `ai/toolRegistry.js` category + tests |
| change AI model / token caps | `ai/dual.js` (lines 281–287) + `config.js` |
| add a slash command | `commands/<category>/*.js` + `node deploy-commands.js` |
| add an event handler | `events/*.js` — auto-loaded by `loadEvents()` |
| change moderation auto-action | `ai/rulesEnforcer.js` + `ai/rulesEscalation.js` + `ai/rulesDetector.js` |
| modify presence API | `presence.js` |
| change how the AI "feels" the channel | `events/messageCreate.js` system-prompt assembly (lines 939–1338) |
| change tool selection / catalog | `ai/toolRegistry.js` |
| change history compression | `ai/contextCompressor.js` |

## Where to look when X breaks

- **Reply truncated mid-sentence** → `ai/dual.js` `maxOutputTokens` vs `thinkingBudget` (recently fixed near line 287). Check logs for `finishReason=MAX_TOKENS`.
- **Bot answers from wrong topic / addresses wrong user** → `events/messageCreate.js` `[CHANNEL CONTEXT]` block (line 1516) + the `ADDRESSING — STRICT` rule in the personality block (line 946). Also `personality.md` "READING THE CURRENT CONVERSATION".
- **Wrong tool called** → `ai/toolRegistry.js` keyword categories (lines 145–311) + `ai/executor.js` `TOOL_ALIASES` (line 211).
- **Bot ignores a message** → `events/messageCreate.js` gating (step 2 above) — sleep mode, dedup Set, mention/name match, anti-exploit regex, AI cooldown.
- **Twin call to Eris fails** → `presence.js` `/api/twin/command` (line 472), HMAC via `verifyTwinRequest` from `@defnotean/shared/twinSign`, `TWIN_API_SECRET` env.
- **Auto-mod doing nothing / over-acting** → `ai/rulesEnforcer.js` skip checks (line 128), `ai/rulesDetector.js` LLM judge, `ai/rulesEscalation.js` `decideAction`. Verify `isAutoModEnabled(guildId)` in DB.
- **History corruption / "she forgot what we were talking about"** → `ai/contextCompressor.js` Tier C compression (line 97) + the per-channel `withLock` (line 1432). Verify `compressHistory` budget against `config.historyCharBudget`.
- **Empty / "hmm something went quiet" replies** → `ai/dual.js` empty-response retries (line 343) + thinking-only fallback (line 429). Usually a Flash thinking-budget edge case.
