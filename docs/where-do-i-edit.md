# Where do I edit?

Decision tree for "I want to do X — what file do I open?"

Pair this with [cheatsheet.md](./cheatsheet.md) (which gives you the actual code patterns) and [debugging-playbook.md](./debugging-playbook.md) (which goes the other way: symptom → file).

## AI behavior

### Add a new AI tool
1. **Schema** → `packages/<bot>/ai/tools.js` (the file's TOC comment groups schemas by category; pick the right one).
2. **Handler** → `packages/<bot>/ai/executors/<domain>.js` — add to the `HANDLED` Set + a `case` in the switch. If no existing executor fits, create a new file and add it to `SUB_EXECUTORS` in `ai/executor.js`.
3. **(Optional) Category regex** → `packages/<bot>/ai/toolRegistry.js` if you want it in Tier 1 selection.
4. **Test** → `packages/<bot>/tests/ai/<toolName>.test.ts`.

Reference tools (annotated `// ─── REFERENCE TOOL ───`):
- Eris: `get_mood` — schema [ai/tools.js:425](../packages/eris/ai/tools.js), handler [ai/executors/miscExecutor.js:62](../packages/eris/ai/executors/miscExecutor.js), test [tests/ai/getMoodTool.test.ts](../packages/eris/tests/ai/getMoodTool.test.ts)
- Irene: `list_emojis` — schema [ai/tools.js:1901](../packages/irene/ai/tools.js), handler [ai/executor.js:1509](../packages/irene/ai/executor.js), test [tests/ai/executors/listEmojis.test.ts](../packages/irene/tests/ai/executors/listEmojis.test.ts)

### Make a tool's name aliasable (model misspells it)
`packages/<bot>/ai/executor.js` — `TOOL_ALIASES` map. Add `"play": "play_music"`. ~150 entries currently.

### Make a tool's result cacheable
`packages/<bot>/ai/executor.js` — add the tool name to `CACHEABLE_TOOLS`. 15s TTL, 200-entry LRU. Only for read-only tools.

### Make a write tool invalidate a user's read cache
`packages/<bot>/ai/executor.js` — add to `CACHE_INVALIDATING_TOOLS`. If the write affects another user, also add to `TWO_USER_TOOLS`.

### Change which tools the AI sees in a given message
- **Eris**: `packages/eris/events/messageCreate.js` — the `chooseToolProfile()` block. Five cached profiles: `twin`, `chat`, `chatOwner`, `full`, `fullOwner`. Edit which tools each profile filters in.
- **Irene**: currently sends ALL tools every message; if you want tier-based selection, re-enable `selectByMessage()` in `packages/irene/ai/toolRegistry.js`.

### Mark a tool as available in twin (sister-bot) conversations
Add `tags: ["fun"]` to its schema in `packages/eris/ai/tools.js`. The `twin` profile is `EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"))`. No code changes needed.

### Change the AI model / token caps / iteration budget
`packages/<bot>/ai/dual.js` — constants near the top of `runGeminiChat`. Then update model IDs in `packages/<bot>/config.js` (`geminiModel` / `geminiFastModel` / `geminiFallbackModel`).

### Change response cadence (typing speed, segment splits)
`packages/<bot>/utils/humanDelay.js`. Identical between bots — change once and you'll need to change both (or extract to `@defnotean/shared`).

### Change personality text
- **Eris** → `packages/eris/prompts/eris-personality.md` + `eris-relationships.md` + `eris-rules.md`.
- **Irene** → `packages/irene/prompts/irene-personality.md`.

Reloads on bot restart — no code changes. Templated with `{{OWNER_ID}}`.

### Change context shaping (what goes into the system prompt)
`packages/<bot>/events/messageCreate.js` — the system-prompt assembly section (Eris ~lines 634-1034, Irene ~939-1216). Personality, mood, temporal, keyword nudges, channel context, length budget all assembled here.

### Change history compression
`packages/<bot>/ai/contextCompressor.js`. Bins are: last 3 turns full / 4-8 moderate / older one-liner. Hard-slice fallback if all that still exceeds budget. **INTENTIONALLY DIFFERENT between bots** (Eris is Gemini-format, Irene is Anthropic-format).

## Gating

### Add or change a gate (whether the bot replies)
`packages/<bot>/events/messageCreate.js`. Gates run top-to-bottom; cheap checks first. The order matters — putting a slow check before a fast one wastes work.

Common gate edits:
- **Mention behavior** → mention/name/reply gate (Eris ~464-501, Irene ~749).
- **Rate limit** → per-user AI cooldown block.
- **Length cap** → currently 1500 chars for non-owners.
- **Mute list** → `chat_muted_channels` block.
- **Sleep mode** → search for "sleep" in `messageCreate.js`.

### Add or change auto-mod (Irene only)
Three files, three concerns:
- **Detector** (regex pre-filter + LLM judge prompt) → `packages/irene/ai/rulesDetector.js`.
- **Enforcer** (skip checks, orchestration) → `packages/irene/ai/rulesEnforcer.js`.
- **Escalation ladder** (severity × prior offenses → action) → `packages/irene/ai/rulesEscalation.js`.

### Disable auto-mod for a guild / user
`packages/irene/database.js` — `setAutoModEnabled(guildId, false)` or `addExemption(guildId, userId, ruleNumber, ttl)`.

## Slash commands

### Add a new slash command
1. Create `packages/<bot>/commands/<category>/<name>.js`. Copy the pattern from a sibling file.
2. Run `npm run deploy --workspace=@defnotean/<bot>` to register globally (~1h propagation) or use a guild-scoped deploy for instant updates ([dev-guild-workflow.md §5](./dev-guild-workflow.md)).
3. Test by typing `/<your-command>` in your dev guild.

### Change permissions for a slash command
The command file's `data: new SlashCommandBuilder().setDefaultMemberPermissions(...)`. Discord enforces this at the gate.

### Add an autocomplete handler
The command file's `async autocomplete(interaction) { ... }`. Returns up to 25 choices. Routed by `events/interactionCreate.js`.

### Make a command owner-only
Use `isOwner(interaction.user.id)` from `utils/permissions.js` (Eris) or `isAdminOrOwner(interaction.member)` (Irene). Reply with a sass denial via `denyMessage(...)` if denied.

## Events

### Add a new Discord event handler
Drop a file in `packages/<bot>/events/` named after the event (`messageDelete.js`, `voiceStateUpdate.js`, etc.). Auto-loaded by `loadEvents()`. Export `default async function (...args, client) { ... }`. The loader wraps in try/catch.

### Add a one-time / `client.once` event
Either name it `ready.js` (the loader treats `ready` as `once`) or set `export const once = true` if your loader respects it. Eris's loader currently hardcodes `ready` → `once`.

### Modify how an event handler is loaded
`packages/<bot>/index.js` — the `loadEvents()` function. Both bots have similar code; tweak there if you need event-specific wrapping.

## Persistence

### Add a Supabase column
1. Add a migration SQL file to `packages/<bot>/migrations/` (numbered).
2. Apply manually via Supabase SQL editor (no auto-migrator).
3. Add the read/write methods in `packages/<bot>/database.js` (cache bucket + `markDirty` + flush logic).
4. Update the cache shape definition at the top of `database.js`.

### Add a guild setting
`packages/<bot>/database.js` — `getGuildSettings(guildId)` / `setGuildSetting(guildId, key, value)`. Lives in the in-memory `cache.guild_settings`; flushes to Supabase via the standard pattern.

### Add an in-memory cooldown
`packages/<bot>/utils/cooldown.js` for the generic helper, or a local `Map` for one-off cooldowns. Cooldowns reset on bot restart by design — don't persist them unless you have a reason.

### Make a tool's effect atomic (read-modify-write)
Wrap in `database.js` `withUserLock(userId, async () => {...})`. Serializes per-user; doesn't block different users.

## Twin coordination

### Change what Eris can ask Irene to do
`packages/irene/presence.js` — `TWIN_ALIASES` map (around line 536). Add `"foo" → "foo_full_tool_name"`. Both bots also need the requester-permission check to pass.

### Change what Irene's `ask_eris` can do (currently unsigned!)
`packages/irene/ai/executors/advancedExecutor.js:430-492`. Sub-actions: `remind | note | fact | mood | status`. URL is hardcoded to `https://irene-bot.onrender.com/api/twin/...` (a known inconsistency).

### Add a new HMAC-signed twin endpoint
1. Receiver: add a route in `packages/irene/presence.js` (or `packages/eris/api/dashboard.js`). Use `verifyTwinRequest` from `@defnotean/shared/twinSign`. Re-check requester is trusted.
2. Caller: build payload, `signTwinRequest(body, secret)`, POST.
3. See [presence-api.md](./presence-api.md) for the full pattern.

### Change the twin URL in production
- **Eris reads** → `IRENE_API_URL` env (default `https://irene-bot.onrender.com`).
- **Irene reads** → `ERIS_API_URL` env (default `https://eris-bot.onrender.com`).

## HTTP server (Irene only)

### Add a dashboard endpoint
`packages/irene/presence.js` — add a `case` in the route handler. Use `Bearer` auth for read-only, HMAC for state-changing. CORS allowlist is at the top of the file.

### Change presence cache TTL
`packages/irene/presence.js` — search for the rate-limit + cache constants near the top.

### Add a public endpoint (no auth)
Same place. Be careful with rate limiting — there's a global IP rate-limit middleware.

## Music (Irene only)

### Change the Lavalink node config
`packages/irene/config.js` — `lavalink.{host, port, password, secure}`. From env vars `LAVALINK_*`.

### Change queue persistence interval
`packages/irene/music/player.js` — search for the 60s auto-save interval.

### Change track playback behavior (loop, shuffle, filter)
`packages/irene/music/player.js`. The slash commands in `commands/music/*` are thin wrappers around the player module.

### Change karaoke lyric source
`packages/irene/ai/karaoke.js` — currently uses LRCLIB. Tied into `onTrackStart` / `onTrackEnd` events from the music player.

## Voice listener (Irene only)

### Add or change the wake word
Per-server: `setWakeWord(guildId, word)` in `packages/irene/voice/listener.js`. Global default: `setWakeWordAll(word)`.

### Change silence/min/max-utterance thresholds
`packages/irene/voice/listener.js` — constants near the top.

## Configuration

### Add a new env var
1. `packages/<bot>/config.js` — add `env("MY_VAR", "default")` to the relevant config namespace.
2. Document in `packages/<bot>/.env.example` (mark required/conditional/optional).
3. Update [docs/glossary.md](./glossary.md) if it introduces a new concept.

### Change a default
`packages/<bot>/config.js`. Defaults are second arg to `env(...)`.

### Move a setting from hardcoded to env-overridable
`packages/<bot>/config.js`. Find the hardcoded value, replace with `env("MY_VAR", currentValue)`.

## Logging / debugging

### Change log format / colors
`packages/<bot>/utils/logger.js`. **DIFFERENT between bots** — Irene also exports `sendModLog()`.

### Add an audit log entry
Irene only — `database.js` `logAudit(guildId, action, userId, details)`. Surfaces in the dashboard `/api/*` endpoints.

### Increase log verbosity
There's no log level system right now — every `log()` call writes. If you need verbosity tiers, you'd add them to `utils/logger.js`.

## Slash command auto-deploy

### Force a re-registration
Delete the row in `bot_data` keyed `eris_commands_hash:{clientId}` (Eris) or the equivalent for Irene. Or run `npm run deploy --workspace=@defnotean/<bot>` directly.

### Change the auto-deploy hash logic
`packages/eris/utils/autoDeploy.js`. SHA256 over sorted command JSON. Change the hash function or the storage key.

## Tests

### Add a test
`packages/<bot>/tests/<area>/<name>.test.ts`. Vitest. No Discord/Supabase contact — use the mocks in `tests/mocks/`.

### Run only one test file
`npm test -- <file pattern>` from the package directory, or `npx vitest run <pattern>`.

### Watch mode
`npm run test:watch --workspace=@defnotean/<bot>`.

## When you're stuck

If you can't figure out where to edit:
1. Search for a string from the existing UX — log message, embed title, slash command name. `git grep` will find it.
2. Read the canonical pipeline doc for the bot you're touching: [ai-pipeline-eris.md](./ai-pipeline-eris.md) / [ai-pipeline-irene.md](./ai-pipeline-irene.md).
3. Check [debugging-playbook.md](./debugging-playbook.md) — it goes symptom → file.
4. Look at recent `git log` for similar changes — `git log --all --grep "your topic"`.

## When you SHOULDN'T edit something

These files are marked drift-sensitive in [drift-inventory.md](./drift-inventory.md). Don't edit without coordinating with the maintainer:
- `ai/personality.js` (intentional schema divergence)
- `ai/longmemory.js` (cross-bot migration coordination needed)
- `ai/firewall.js` (canonical lives in Eris; mind `ownerId`/`userId`)
- Any `bump*.js` file (port to the other bot in the same PR)
- `utils/twinSign.js` (extracted to `@defnotean/shared`, don't deepen the drift)

And from [CONTRIBUTING.md](../CONTRIBUTING.md): no broad refactors, no renames, no reformats — surgical changes only.
