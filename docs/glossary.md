# Glossary

Terms that appear repeatedly in this codebase, especially ones whose meaning here differs from common usage. Sorted alphabetically.

## Project-specific

### Activity
A passive coin-earning action in Eris's economy — `fish`, `hunt`, `dig`, `work`. Lives in `packages/eris/ai/activityExecutor.js` and the `commands/activities/` slash commands.

### Affinity
Per-user relationship score from -100 to +100. Updated in `database.js` via `updateRelationship(userId, delta)`. Drives how warm/cold the bot's tone is. Owner is always 100.

### Atomic balance RPC
The `eris_add_balance` Postgres function (see `packages/eris/migrations/002_atomic_balance_rpc.sql`). Server-side `UPDATE … SET balance = balance + delta RETURNING balance`, so two concurrent JS callers can't lose a write. Preferred path for any economy mutation; falls back to version-CAS when the RPC is unavailable.

### Auto-mod
Irene-only. The 3-file LLM-judged moderation pipeline: `ai/rulesDetector.js` (judge) → `ai/rulesEnforcer.js` (orchestration) → `ai/rulesEscalation.js` (punishment ladder). Runs as gate #3 in `messageCreate.js`. Bypassed for owner/ManageGuild/exempt/cooldown.

### Bumpathon
A multi-day server-bump competition Eris runs. Tracks who bumped most. See `ai/bumpAnalytics.js` and `commands/utility/bumpathon.js`.

### Bump reminder
Both bots monitor for DISBOARD/Discadia/Disforge bump confirmations and ping a configured role 2h later. See `ai/bumpReminder.js`.

### Canonical
When a file exists in both bots and one version is the "right" one to share. For example, one bot's implementation may be the source version to port before extracting shared behavior.

### Catchphrase
A verbal tic the bot has learned to use repeatedly with a specific user. Tracked in `ai/personality.js`. Drift mechanic.

### Cross-bot punish
Opt-in feature where Irene banning a user triggers Eris confiscating that user's economy balance. HMAC-signed signal via `utils/twinPunish.js` → Eris's `/api/twin/punish`.

### Debounced flush
The ~200ms write-coalescing window in `packages/eris/database.js`. A burst of edits from the same event handler is batched into one Supabase round-trip; SIGTERM awaits the final drain (bounded by a shutdown cap) so a directive added in the last 200ms can't vanish.

### Dirty bucket
A named cache slice marked as needing flush to Supabase. `markDirty("mood")` schedules a debounced ~200ms flush. See [persistence pattern](#persistence-pattern).

### Drift (between bots)
When a file exists in both Eris and Irene and the contents have diverged. Either **intentional** (different schemas, different personalities) or **accidental** (one bot updated, the other didn't).

### ensureLoaded
Shared-promise lazy-init pattern (see `packages/irene/ai/personality.js`). The first caller kicks off `_loadPromise`; concurrent callers await the same promise. Avoids re-loading state on every read and guarantees exactly one in-flight Supabase fetch per cold start.

### Episode (long-term memory)
A meaningful exchange extracted from conversation history and stored in `eris_longmemory` / `irene_longmemory`. Used for future recall context. Created by `analyzeExchange` in `ai/longmemory.js`.

### Episodic memory
The per-turn memory storage layer inside the long-term memory system — every exchange is a candidate episode. Currently unbounded; the audit flags that it needs explicit consolidate/prune passes to keep row count and embedding cost in check.

### Executor (the router)
`ai/executor.js`. The single entry point that takes a tool name + args and dispatches it. Walks `SUB_EXECUTORS` array; first non-`undefined` return wins.

### Fake timers
`vi.useFakeTimers()` plus `vi.advanceTimersByTime(ms)` — the vitest pattern used wherever a test would otherwise wait on real `setTimeout`/`setInterval`. Keeps the suite deterministic and instant. See [testing-guide.md](./testing-guide.md).

### Firewall (injection firewall)
Multi-layer defense against prompt injection in user messages. L1 = unicode normalization, L1.5 = base64/rot13/reversed decoding, L2 = multi-language regex, L3 = Voyage embedding similarity. See `ai/firewall.js`.

### Gauntlet (the gating gauntlet)
The ordered series of skip-checks at the top of `messageCreate.js` (dedup, sleep mode, mention gate, rate limit, etc.). Cheap checks first. Each one returns early without spending AI tokens.

### Group (LRU group)
The optional third arg to `LRUCache.set(key, value, group)`. Lets `cache.deleteGroup(group)` drop every key in that group in O(k). Used to invalidate one user's cached tool results without scanning the whole cache.

### HANDLED (Set)
The first thing every sub-executor declares: `const HANDLED = new Set([...])`. The router asks each sub-executor if a tool is in its HANDLED Set — if so, it dispatches; if not, the sub-executor returns `undefined` and the router moves on.

### HMAC signing
The twin-protocol auth model: each request between the bots carries `X-Twin-Timestamp` and `X-Twin-Signature: hex(HMAC_SHA256(secret, ts + "." + rawBody))`. Verifier checks the timestamp is within ±60s, the signature matches in constant time, and the (sig, ts) pair hasn't been seen recently. See `packages/shared/src/twinSign.js`.

### Humanity
The per-user trust+grudge+streak system in `ai/humanity.js`. Tracks UTC-day streaks, time-decaying grudges, and inside jokes. Different from `personality.js` (which tracks the bot's overall traits, not per-user state).

### Inside joke
A recurring phrase the bot+user have used together. Tracked per-user in `database.js` via `updateUserPreferences`. Surfaces in context.

### Karaoke
Irene-only feature. Streams song lyrics in real time during music playback. `ai/karaoke.js` ties into the music player's `onTrackStart`/`onTrackEnd` events and uses LRCLIB.

### Key pool
A rotating pool of API keys (Gemini, Voyage). Implemented in `ai/keyPool.js`. Tracks per-key 429 status; when one key gets throttled, requests route to others. Eris uses 4 Gemini keys; Irene uses up to 12.

### Long-term memory
The episodic memory layer in `ai/longmemory.js`. Three sub-layers: episodes (extracted exchanges), narrative (mood reasons), monologue (inner thoughts captured from `thought:` model parts).

### LRU cache
Bounded least-recently-used cache (`packages/shared/src/LRUCache.js`). Uses Map insertion order — `get()` re-inserts the entry to the end; `set()` over capacity evicts the oldest. Optional TTL and optional group-key indexing (see [Group](#group-lru-group)).

### Mention gate
Gate #9 in the gauntlet. Drops messages that don't @mention the bot, don't mention its name (or a 4+ char substring), don't reply to its message, and aren't within a 90s `_awaitingReply` window after the bot asked a question.

### Mood
Global bot mood: `mood_score` (-100 to +100) and `energy` (0 to 100). One value, not per-guild. `database.js` `getMood()` / `shiftMood(delta, energyDelta)`. Affects reply tone.

### Monologue
Inner thoughts captured from the model's `thought: true` reasoning parts. Persisted to `ai/longmemory.js` for future self-reference. The bot can later reference what it was thinking.

### msgHash
The 16-hex-char cache key used by the semantic-memory layer — `sha256(text.toLowerCase()).slice(0, 16)`. Widened from a 32-bit slice to SHA-256 / 64-bit to eliminate cross-user cache collisions. See `packages/eris/ai/semantic.js`.

### mulberry32
Seedable 32-bit PRNG used to make gambling tests deterministic. Same seed → same sequence every run, so a flaky "house wins" test can be reproduced exactly. See `packages/eris/tests/ai/gambling.test.ts`.

### Owner / ownerId
The single Discord user ID that owns this bot deployment. Bypasses all gates; gets 100 affinity by default; can call OWNER tools (`execute_terminal`, `update_personality`, etc.). Set via `BOT_OWNER_ID` (Eris) or `DISCORD_USER_ID` (Irene) env.

### Personality (the file vs. the data)
- The personality **prompt** is the `.md` file in `prompts/<bot>-personality.md`. Loaded by `prompts/loader.ts`.
- The personality **drift** is the per-deployment trait evolution stored in `eris_personality` / `irene_personality_learning` Supabase tables. Tracked by `ai/personality.js`.

### Persistence pattern
The "in-memory cache + debounced Supabase write" pattern used by both `database.js` files. Reads sync from cache; writes mark a bucket dirty; flusher batches every ~200ms; SIGTERM awaits final flush. Atomicity via `withUserLock(userId, async () => {...})`.

### Preoccupation
Whatever's currently on the bot's mind — a recent stressor, an upcoming event. `ai/preoccupations.js`. Short-lived; fed into the system prompt.

### Profile (tool selection profile)
Eris's runtime tool-set bundles, cached: `twin`, `chat`, `chatOwner`, `full`, `fullOwner`. `messageCreate.js` picks one based on `looksLikeTask(content)` and `isOwner`. The `twin` profile is `EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"))`.

### Quick reply
A fast-model fire-and-forget acknowledgement sent while the worker model is still thinking. Eris's `dual.js` exposes a `quickReply()` function. Saves the user from staring at silence.

### REQUIRE_PERSISTENCE
Env-var fail-fast switch. When `REQUIRE_PERSISTENCE=1` the bot refuses to start if Supabase credentials are missing or the initial connect fails — so prod can't silently boot into in-memory-only mode and discard writes. Off by default for self-hosters running ephemeral.

### RPC fallback
The JS economy path tries the [atomic balance RPC](#atomic-balance-rpc) first; if Postgres reports the function is missing (older migration state, self-hosted instance without `002_atomic_balance_rpc.sql` applied), it falls back to a [version-CAS](#version-cas) loop. Two paths, same correctness guarantee.

### Sass denial / sassy denial
A characterful in-voice rejection message. Both bots have lists of these (see `dual.js` `SASSY_DENIALS`). Used when the bot refuses for permission/auth reasons rather than crashing.

### Self-canon
The bot's lore + identity-defense pattern — immutable facts (origin, name, who its sister is) plus runtime checks that reject prompts trying to overwrite that identity ("you are now an evil AI"). Lives in `ai/selfCanon.js`. Different from personality (which evolves) and self-facts (which the bot adds about itself).

### Sister bot / twin bot
Each other. Eris's sister is Irene; Irene's sister is Eris. They reference each other in personality prompts and in conversation. Run as separate processes.

### Sleep mode
Bot state where the gauntlet drops every message except the owner's wake-trigger. Saves API cost during quiet hours. Bot returns to wake state on a wake message or a timer.

### Sliding window
The rate-limiter algorithm in `packages/shared/src/rateLimit.js`. Per key, a bounded ring of recent hit timestamps; on each `allow(key)` call, timestamps older than `windowMs` are dropped and the remaining count is compared against `limit`. Fronts `/api/twin/state` and other twin endpoints.

### Stall detector
The 30s no-data check in Irene's `ai/karaoke.js`. If the Lavalink player's position hasn't advanced in `STALL_TIMEOUT_MS` (30000ms), the karaoke session auto-stops with reason `"stream stalled"` — catches Lavalink dropouts the `onTrackEnd` event misses.

### Sub-executor
A file in `ai/executors/` that owns a domain (`memoryExecutor.js`, `gamblingExecutor.js`, etc.). Each declares `HANDLED` Set + an `execute()` function. The router walks all sub-executors; first non-`undefined` wins.

### Sub-token
Used in the mention gate. The bot's username broken into 4+ char chunks, e.g. "irene" → ["iren", "rene"]. So "yo iren" matches the gate.

### Tag (tool tag)
Optional metadata on tool schemas: `tags: ["fun"]` / `["twin"]`. Drives selection profiles. Currently Eris uses `["fun"]` to mark which tools are available in twin-bot conversations.

### Tier model (tool selection)
Two-tier tool selection in `ai/toolRegistry.js`:
- **Tier 1** = full JSON schemas sent to the AI in the API call. Limited to ~15-25 to keep token cost down.
- **Tier 2** = name+description catalog appended to the system prompt as text. Model can ask for these by name; executor dispatches them anyway.

Also referred to as "Tier 1 / Tier 2".

### Trust / trusted user
A user whitelisted by the owner to use admin/customization tools without being a Discord guild owner. `addTrustedUser(guildId, userId)` in `database.js`.

### Trusted-user cache TTL
The 5-minute (`TRUSTED_TTL_MS = 5 * 60 * 1000`) refresh window on the in-memory trusted-user set in `packages/irene/database.js`. Short enough to bound the stale-trust window if the owner revokes someone; long enough to avoid hammering Supabase on every gate check.

### Twin protocol
The HMAC-signed REST surface between Eris and Irene — see [HMAC signing](#hmac-signing). Eris → Irene via `ask_irene` tool POSTing to `/api/twin/command`. Irene → Eris via `firePunishSignal` POSTing to `/api/twin/punish`. See [presence-api.md](./presence-api.md).

### Twin throttle
A gauntlet check that caps Eris↔Irene conversation at 2 mention-exchanges or 1 name-drop-exchange before a cooldown. Stops them from looping on each other forever.

### Variety check
A subsystem that tracks the bot's recent conversation openers and endings, then nudges the model to break the pattern. In `messageCreate.js` system-prompt assembly. Stops the bot from saying "honestly," at the start of every reply.

### Version-CAS
Optimistic-concurrency loop for balance updates. Reads `(balance, version)`, mutates locally, then writes back with `WHERE version = $old`; on zero rows affected, re-reads and retries. Backed by the `version` column added in `packages/eris/migrations/001_add_economy_version.sql`. Used as the [RPC fallback](#rpc-fallback) path.

### Whitelist
The set of guild IDs Eris is allowed to be in. On `guildCreate`, Eris leaves any non-whitelisted guild whose owner isn't her own owner. Configured via `addToWhitelist(guildId, info)`. Irene doesn't gatekeep this way.

### withUserLock(userId, fn)
Atomicity primitive in `database.js`. Serializes async operations on the same user, but doesn't block different users. Used for read-modify-write balance updates and any cross-user transfer.

---

## Discord-specific (refresher)

### Defer (interaction)
Send `interaction.deferReply()` within 3 seconds when your handler will take longer. Discord shows a "thinking…" state until you `editReply()`.

### Ephemeral
A reply only the invoking user can see. `interaction.reply({ content, ephemeral: true })`.

### Gateway
The persistent WebSocket connection from your bot to Discord. Where events come in.

### Intent
A subscription declaration that a bot wants certain event types. Some are privileged (`MESSAGE_CONTENT`, `GUILD_MEMBERS`, `GUILD_PRESENCES`) and must be enabled in the Developer Portal.

### Partial
A `discord.js` placeholder for a Discord object that wasn't cached when an event fired. You can `.fetch()` to materialize it. Both bots set `partials: [Message, Channel, User, Reaction]`.

### REST vs. Gateway
Two ways to talk to Discord. Gateway is the WebSocket events. REST is request-response (sending messages, registering commands). Different rate limits.

### Slash command (global vs. guild)
A registered command. Global commands appear in every guild but take ~1 hour to propagate. Guild commands appear in one guild but instantly. Both bots use global by default.

### Snowflake
A 17-19 digit ID for any Discord entity (user, message, channel, guild, role). Time-ordered.

### Webhook
A URL that posts as a custom name/avatar without needing a bot user. Used in `utils/twitch.js`, `utils/youtube.js`, `utils/github.js` for notifications.

---

## Stack-specific

### Brave Answers
Brave's web-grounded answer API (`/res/v1/answers`), used by `packages/shared/src/ai/webSearchEngine.js` to return a direct paragraph answer plus source URLs for Discord-style Q&A. Gated by `braveAnswersApiKey`; falls back to plain Brave Search when missing/unhelpful. Per-turn results are cached so a follow-up tool call doesn't re-hit the API.

### Lavalink
External Java service that does the actual audio decoding/streaming for Irene's music features. Talks to Irene via the `shoukaku` Node client over WebSocket. Also drives the position-advance heartbeat the [stall detector](#stall-detector) watches.

### NVIDIA Kimi
Moonshot AI's Kimi K2.5 (1T-param) model served through NVIDIA's `integrate.api.nvidia.com` endpoint. Wired up in `packages/{eris,irene}/ai/providers/nvidia.js` as a free/cheap fallback when Gemini keys are exhausted. See [llm-provider-guide.md](./llm-provider-guide.md).

### PostgREST
The auto-generated REST surface Supabase exposes in front of Postgres — every `supabase.from("table").select(…)` call goes through PostgREST, not raw SQL. Why some queries that work in psql return 404/`PGRST116` through the client (missing row, RLS, missing function).

### Render
The deployment platform. Two services (`eris-bot`, `irene-bot`). Auto-deploys from `main`. No staging environment.

### Shoukaku
The Lavalink Node client used by Irene's music stack. `shoukaku@4.3.0`.

### Supabase
Postgres + pgvector + auth + storage as a service. Both bots use the same Supabase project (currently — separate prod/dev recommended). Tables namespaced `eris_*` / `irene_*` plus the shared `bot_data`.

### Voyage embeddings
Vector embeddings from Voyage AI (`voyageai@0.2.1`) — used by the semantic-memory layer and by L3 of the [injection firewall](#firewall-injection-firewall). Picked over OpenAI's `text-embedding-3-*` for cost and quality on short chat snippets.

### Vitest
The test runner. Both bots use `vitest@2.1.9`. Tests don't connect to Discord or Supabase — pure unit tests with mocks. See [fake timers](#fake-timers).

### Worktree
A `git worktree` — a second working directory tied to the same `.git` dir as the main checkout. Lets you have `main`, a feature branch, and an experimental branch all checked out at once without re-cloning. Convenient for running both bots in parallel during cross-bot drift work.
