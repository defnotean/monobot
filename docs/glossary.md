# Glossary

Terms that appear repeatedly in this codebase, especially ones whose meaning here differs from common usage. Sorted alphabetically.

## Project-specific

### Activity
A passive coin-earning action in Eris's economy — `fish`, `hunt`, `dig`, `work`. Lives in `packages/eris/ai/activityExecutor.js` and the `commands/activities/` slash commands.

### Affinity
Per-user relationship score from -100 to +100. Updated in `database.js` via `updateRelationship(userId, delta)`. Drives how warm/cold the bot's tone is. Owner is always 100.

### Auto-mod
Irene-only. The 3-file LLM-judged moderation pipeline: `ai/rulesDetector.js` (judge) → `ai/rulesEnforcer.js` (orchestration) → `ai/rulesEscalation.js` (punishment ladder). Runs as gate #3 in `messageCreate.js`. Bypassed for owner/ManageGuild/exempt/cooldown.

### Bumpathon
A multi-day server-bump competition Eris runs. Tracks who bumped most. See `ai/bumpAnalytics.js` and `commands/utility/bumpathon.js`.

### Bump reminder
Both bots monitor for DISBOARD/Discadia/Disforge bump confirmations and ping a configured role 2h later. See `ai/bumpReminder.js`.

### Canonical
When a file exists in both bots and one version is the "right" one to share. E.g. `ai/firewall.js` Eris is canonical, Irene needs to port. See [drift-inventory.md](./drift-inventory.md).

### Catchphrase
A verbal tic the bot has learned to use repeatedly with a specific user. Tracked in `ai/personality.js`. Drift mechanic.

### Cross-bot punish
Opt-in feature where Irene banning a user triggers Eris confiscating that user's economy balance. HMAC-signed signal via `utils/twinPunish.js` → Eris's `/api/twin/punish`.

### Dirty bucket
A named cache slice marked as needing flush to Supabase. `markDirty("mood")` schedules a debounced ~2s flush. See [persistence pattern](#persistence-pattern).

### Drift (between bots)
When a file exists in both Eris and Irene and the contents have diverged. Either **intentional** (different schemas, different personalities) or **accidental** (one bot updated, the other didn't). Full inventory in [drift-inventory.md](./drift-inventory.md).

### Episode (long-term memory)
A meaningful exchange extracted from conversation history and stored in `eris_longmemory` / `irene_longmemory`. Used for future recall context. Created by `analyzeExchange` in `ai/longmemory.js`.

### Executor (the router)
`ai/executor.js`. The single entry point that takes a tool name + args and dispatches it. Walks `SUB_EXECUTORS` array; first non-`undefined` return wins.

### Firewall (injection firewall)
Multi-layer defense against prompt injection in user messages. L1 = unicode normalization, L1.5 = base64/rot13/reversed decoding, L2 = multi-language regex, L3 = Voyage embedding similarity. See `ai/firewall.js`.

### Gauntlet (the gating gauntlet)
The ordered series of skip-checks at the top of `messageCreate.js` (dedup, sleep mode, mention gate, rate limit, etc.). Cheap checks first. Each one returns early without spending AI tokens.

### Group (LRU group)
The optional third arg to `LRUCache.set(key, value, group)`. Lets `cache.deleteGroup(group)` drop every key in that group in O(k). Used to invalidate one user's cached tool results without scanning the whole cache.

### HANDLED (Set)
The first thing every sub-executor declares: `const HANDLED = new Set([...])`. The router asks each sub-executor if a tool is in its HANDLED Set — if so, it dispatches; if not, the sub-executor returns `undefined` and the router moves on.

### Humanity
The per-user trust+grudge+streak system in `ai/humanity.js`. Tracks UTC-day streaks, time-decaying grudges, and inside jokes. Different from `personality.js` (which tracks the bot's overall traits, not per-user state).

### Inside joke
A recurring phrase the bot+user have used together. Tracked per-user in `database.js` via `updateUserPreferences`. Surfaces in context.

### Karaoke
Irene-only feature. Streams song lyrics in real time during music playback. `ai/karaoke.js` ties into the music player's `onTrackStart`/`onTrackEnd` events and uses LRCLIB. (Eris has a vestigial copy that should be removed.)

### Key pool
A rotating pool of API keys (Gemini, Voyage). Implemented in `ai/keyPool.js`. Tracks per-key 429 status; when one key gets throttled, requests route to others. Eris uses 4 Gemini keys; Irene uses up to 12.

### Long-term memory
The episodic memory layer in `ai/longmemory.js`. Three sub-layers: episodes (extracted exchanges), narrative (mood reasons), monologue (inner thoughts captured from `thought:` model parts).

### Mention gate
Gate #9 in the gauntlet. Drops messages that don't @mention the bot, don't mention its name (or a 4+ char substring), don't reply to its message, and aren't within a 90s `_awaitingReply` window after the bot asked a question.

### Mood
Global bot mood: `mood_score` (-100 to +100) and `energy` (0 to 100). One value, not per-guild. `database.js` `getMood()` / `shiftMood(delta, energyDelta)`. Affects reply tone.

### Monologue
Inner thoughts captured from the model's `thought: true` reasoning parts. Persisted to `ai/longmemory.js` for future self-reference. The bot can later reference what it was thinking.

### Owner / ownerId
The single Discord user ID that owns this bot deployment. Bypasses all gates; gets 100 affinity by default; can call OWNER tools (`execute_terminal`, `update_personality`, etc.). Set via `BOT_OWNER_ID` (Eris) or `DISCORD_USER_ID` (Irene) env.

### Personality (the file vs. the data)
- The personality **prompt** is the `.md` file in `prompts/<bot>-personality.md`. Loaded by `prompts/loader.ts`.
- The personality **drift** is the per-deployment trait evolution stored in `eris_personality` / `irene_personality_learning` Supabase tables. Tracked by `ai/personality.js`.

### Persistence pattern
The "in-memory cache + debounced Supabase write" pattern used by both `database.js` files. Reads sync from cache; writes mark a bucket dirty; flusher batches every ~2s; SIGTERM awaits final flush. Atomicity via `withUserLock(userId, async () => {...})`.

### Preoccupation
Whatever's currently on the bot's mind — a recent stressor, an upcoming event. `ai/preoccupations.js`. Short-lived; fed into the system prompt.

### Profile (tool selection profile)
Eris's runtime tool-set bundles, cached: `twin`, `chat`, `chatOwner`, `full`, `fullOwner`. `messageCreate.js` picks one based on `looksLikeTask(content)` and `isOwner`. The `twin` profile is `EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"))`.

### Quick reply
A fast-model fire-and-forget acknowledgement sent while the worker model is still thinking. Eris's `dual.js` exposes a `quickReply()` function. Saves the user from staring at silence.

### Sass denial / sassy denial
A characterful in-voice rejection message. Both bots have lists of these (see `dual.js` `SASSY_DENIALS`). Used when the bot refuses for permission/auth reasons rather than crashing.

### Self-canon
The bot's lore — immutable identity facts (origin, name, who its sister is). Lives in `ai/selfCanon.js`. Different from personality (which evolves) and self-facts (which the bot adds about itself).

### Sister bot / twin bot
Each other. Eris's sister is Irene; Irene's sister is Eris. They reference each other in personality prompts and in conversation. Run as separate processes.

### Sleep mode
Bot state where the gauntlet drops every message except the owner's wake-trigger. Saves API cost during quiet hours. Bot returns to wake state on a wake message or a timer.

### Sub-executor
A file in `ai/executors/` that owns a domain (`memoryExecutor.js`, `gamblingExecutor.js`, etc.). Each declares `HANDLED` Set + an `execute()` function. The router walks all sub-executors; first non-`undefined` wins.

### Sub-token
Used in the mention gate. The bot's username broken into 4+ char chunks, e.g. "irene" → ["iren", "rene"]. So "yo iren" matches the gate.

### Tag (tool tag)
Optional metadata on tool schemas: `tags: ["fun"]` / `["twin"]`. Drives selection profiles. Currently Eris uses `["fun"]` to mark which tools are available in twin-bot conversations.

### Tier 1 / Tier 2 (tool selection)
Two-tier tool selection in `ai/toolRegistry.js`:
- **Tier 1** = full JSON schemas sent to the AI in the API call. Limited to ~15-25 to keep token cost down.
- **Tier 2** = name+description catalog appended to the system prompt as text. Model can ask for these by name; executor dispatches them anyway.

### Trust / trusted user
A user whitelisted by the owner to use admin/customization tools without being a Discord guild owner. `addTrustedUser(guildId, userId)` in `database.js`.

### Twin protocol
The HMAC-signed REST surface between Eris and Irene. Eris → Irene via `ask_irene` tool POSTing to `/api/twin/command`. Irene → Eris via `firePunishSignal` POSTing to `/api/twin/punish`. See [presence-api.md](./presence-api.md).

### Twin throttle
A gauntlet check that caps Eris↔Irene conversation at 2 mention-exchanges or 1 name-drop-exchange before a cooldown. Stops them from looping on each other forever.

### Variety check
A subsystem that tracks the bot's recent conversation openers and endings, then nudges the model to break the pattern. In `messageCreate.js` system-prompt assembly. Stops the bot from saying "honestly," at the start of every reply.

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

### Lavalink
External Java service that does the actual audio decoding/streaming for Irene's music features. Talks to Irene via the `shoukaku` Node client over WebSocket.

### Render
The deployment platform. Two services (`eris-bot`, `irene-bot`). Auto-deploys from `main`. No staging environment.

### Shoukaku
The Lavalink Node client used by Irene's music stack. `shoukaku@4.3.0`.

### Supabase
Postgres + pgvector + auth + storage as a service. Both bots use the same Supabase project (currently — separate prod/dev recommended). Tables namespaced `eris_*` / `irene_*` plus the shared `bot_data`.

### Voyage AI
Embedding provider used for semantic memory + the L3 layer of the injection firewall. `voyageai@0.2.1`.

### Vitest
The test runner. Both bots use `vitest@2.1.9`. Tests don't connect to Discord or Supabase — pure unit tests with mocks.
