# Contributing

Welcome. This guide covers how to make a change to the bots monorepo without breaking the deployed bots or stepping on the maintainer's toes.

If you haven't run the bots locally yet, start with **[GETTING_STARTED.md](./GETTING_STARTED.md)**.

## Repository layout

```
MonoBot/
├── packages/
│   ├── eris/             # Chaotic-twin Discord bot — economy, gambling, AI personality
│   │   ├── COMMANDS.md   # Slash command inventory (54 commands across 8 categories)
│   │   └── EXTRACTION_PLAN.md  # Eris↔Irene reconciliation plan (mirrored in irene/)
│   ├── irene/            # Good-twin Discord bot — moderation, music, auto-mod, tickets
│   │   └── COMMANDS.md   # Slash command inventory (67 commands across 8 categories)
│   └── shared/           # Shared utilities — twin signing (HMAC), LRU cache, role categorizer
├── docs/                 # Architecture and onboarding docs
│   ├── ai-pipeline-eris.md   # Message-to-reply trace for Eris
│   ├── ai-pipeline-irene.md  # Message-to-reply trace for Irene
│   ├── presence-api.md       # Twin REST + HMAC signing surface
│   ├── drift-inventory.md    # Eris ↔ Irene divergence at a glance
│   └── dev-guild-workflow.md # How to set up a dev Discord guild + safe testing
├── scripts/
│   └── verify-version-sync.js   # CI guard — both bots must pin identical shared deps
├── DEPLOY_MIGRATION.md          # Render service runbook + 2026-04-24 post-mortem
├── GETTING_STARTED.md
├── CONTRIBUTING.md  (this file)
└── README.md
```

Inside each `packages/<bot>/`:

| Path | Purpose |
|---|---|
| `index.js` | Entry point — Discord client setup, event wiring |
| `config.js` | Env loading, AI provider config, personality loader |
| `database.js` | Supabase persistence (debounced writes, in-memory cache) |
| `events/` | Discord event handlers (`messageCreate.js` is the heaviest — it owns gating + system-prompt assembly) |
| `commands/` | Slash commands, grouped by category |
| `ai/` | AI orchestration: tool schemas, executor, Gemini call, context compression |
| `ai/executors/` | Sub-executors that handle specific tool domains |
| `prompts/` | Personality and instruction text loaded at startup |
| `tests/` | Vitest specs |

## Before you start

1. **Run the bots locally** — [GETTING_STARTED.md](./GETTING_STARTED.md)
2. **Set up a dev guild** — [docs/dev-guild-workflow.md](./docs/dev-guild-workflow.md). There is no staging environment; never test against a real server
3. **Read the relevant pipeline doc** — [docs/ai-pipeline-eris.md](./docs/ai-pipeline-eris.md) or [docs/ai-pipeline-irene.md](./docs/ai-pipeline-irene.md) covers how a message becomes a reply, with file:line references for every stage
4. **Check known drift** — [docs/drift-inventory.md](./docs/drift-inventory.md) is the 1-page summary; full reconciliation plan in [packages/eris/EXTRACTION_PLAN.md](./packages/eris/EXTRACTION_PLAN.md). If your change touches a file marked `INTENTIONALLY DIFFERENT` or `ACCIDENTAL DRIFT` (`personality.js`, `longmemory.js`, `firewall.js`, `twinSign.js`, `bumpReminder*`), talk to the maintainer first

## Branching and commits

**Branch naming:** `<type>/<short-description>` — e.g. `feat/audit-by-mod`, `fix/irene-truncation`, `docs/contributing-guide`.

**Commit format** matches the existing `git log` style:

```
<type>(<scope>): <description>
```

- `type`: `feat` | `fix` | `docs` | `chore` | `refactor`
- `scope`: `eris` | `irene` | `shared` | (omit for root-level changes)

Examples from history:
- `feat(eris): /roulette — European single-zero wheel`
- `fix(irene): truncation + topic-drift in AI replies`
- `docs: add DEPLOY_MIGRATION.md for Render service cutover`
- `chore: unify + pin shared dep ranges across workspaces (phase D)`

**Body (optional):** explain *why*, not what. Reference the issue or incident that prompted it.

**Important:** do NOT add Claude/AI attribution to commits, PR descriptions, or `Co-Authored-By` fields. All work is attributed to the contributor.

## Pull requests

- **Title** in the same format as a commit message
- **Body** under 200 words covering: what changed, why, and a one-line test plan
- **Smoke-test plan** if your change affects production behavior — see [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) for the existing manual checklist (slash commands, mentions, embeds, twin API)

There's no staging environment. Reviews are stricter for changes that touch the AI pipeline or twin coordination than for additive features.

## Your first contribution

Most first PRs fall into one of these buckets. Each is a 1-2 file change.

### Add a new AI tool

**Start by reading the reference tools** — these are the canonical examples to copy:

| Bot | Reference tool | Schema | Handler | Test |
|---|---|---|---|---|
| Eris | `get_mood` | [packages/eris/ai/tools.js:425](packages/eris/ai/tools.js) | [packages/eris/ai/executors/miscExecutor.js:62](packages/eris/ai/executors/miscExecutor.js) | [packages/eris/tests/ai/getMoodTool.test.ts](packages/eris/tests/ai/getMoodTool.test.ts) |
| Irene | `list_emojis` | [packages/irene/ai/tools.js:1901](packages/irene/ai/tools.js) | [packages/irene/ai/executor.js:1509](packages/irene/ai/executor.js) | [packages/irene/tests/ai/executors/listEmojis.test.ts](packages/irene/tests/ai/executors/listEmojis.test.ts) |

Each is annotated `// ─── REFERENCE TOOL ───` with cross-references between the three files. Read all three, then:

1. Add your tool's schema to `packages/<bot>/ai/tools.js` — the file's TOC comment groups schemas by category; pick the right one
2. Add the handler:
   - **Eris:** new `case` in `packages/eris/ai/executor.js` or one of `packages/eris/ai/executors/*.js` (sub-executors return `undefined` for tools outside their `HANDLED` set so the router can fall through)
   - **Irene:** new `case` in the appropriate `packages/irene/ai/executors/*.js` (the main `ai/executor.js` is the router)
3. Write a vitest spec in `packages/<bot>/tests/` — mirror the shape of the reference test
4. Run `npm run test:<bot>`

Full message-to-reply trace with file:line references: [docs/ai-pipeline-eris.md](docs/ai-pipeline-eris.md) / [docs/ai-pipeline-irene.md](docs/ai-pipeline-irene.md).

### Add a new slash command (Irene)

1. Add `packages/irene/commands/<category>/<name>.js` — copy the pattern from a sibling file
2. Run `npm run deploy --workspace=@defnotean/irene` (registers with Discord)
3. Test by typing `/<your-command>` in your dev guild

### Modify the bot personality

- **Eris:** edit `packages/eris/prompts/eris-personality.md`, `eris-relationships.md`, or `eris-rules.md`
- **Irene:** edit `packages/irene/prompts/irene-personality.md`

No code changes — prompt files reload on bot restart.

## Testing

Both bots use **vitest**. From the repo root:

| Command | What it runs |
|---|---|
| `npm run test:eris` | Eris suite (~423 tests across 32 files) |
| `npm run test:irene` | Irene suite (~218 tests across 19 files) |
| `npm test` | both |
| `npm run dev:eris` / `npm run dev:irene` | run the bot with file-watch (faster inner loop than `start:*`) |
| `npm run lint:version-sync` | guards that both bots pin identical shared dep versions (a real bug we hit on 2026-04-24, see `DEPLOY_MIGRATION.md`) |

**Critical paths with thin coverage** — good places to add tests when you touch them:
- `ai/executor.js` (Irene's is 1663 lines, currently no direct tests)
- `ai/toolRegistry.js`
- `events/messageCreate.js`

Tests don't connect to Discord or Supabase — safe to run anywhere.

## Known quirks

These exist in the codebase today. Don't fix them as part of your first PR; they need their own scoped change.

- **`AI_PROVIDER` is switchable** between Gemini, NVIDIA, and OpenAI-compatible providers such as OpenRouter. When you add provider-specific behavior, keep Eris and Irene in parity and update `docs/llm-provider-guide.md`.
- **Some env vars bypass `config.js`'s `env()` helper** — `SUPABASE_URL`/`KEY` are read via `process.env` directly in `database.js` and `events/messageCreate.js`. The `.env.example` files document them anyway.
- **Length budgeting is multi-layered.** A truncated reply could be caused by the system-prompt `[LENGTH BUDGET]` directive, `ai/dual.js`'s `maxOutputTokens`, or a post-hoc sentence trimmer in `messageCreate.js`. See `docs/ai-pipeline-*.md` for line numbers.
- **Eris's tool selection bypasses `toolRegistry.selectByMessage`** at runtime — the actual selection happens in `messageCreate.js` via cached tool profiles (`twin`/`chat`/`chatOwner`/`full`/`fullOwner`). If you want to change tool selection behavior, edit `messageCreate.js`, not the registry.
- **Voice receive/Opus behavior depends on hosted audio support.** The vulnerable native `@discordjs/opus` optional dependency was removed; avoid reintroducing native audio packages without an audit pass.
- **Twin coordination has unsigned `ask_eris` calls** that may hit non-existent endpoints in Eris's API. Tracked separately.

## Twin coordination (Eris ↔ Irene)

Both bots talk to each other via HMAC-signed REST calls. Eris delegates server moderation to Irene (who has the moderation tools); Irene exposes presence info and accepts twin commands.

If your change touches `presence.js`, `twinSign.js`, `ask_irene`, `ask_eris`, or anything HMAC-related: read **[docs/presence-api.md](./docs/presence-api.md)** first. The auth scheme has timestamp-based replay protection and the response codes carry meaning.

## Code style

- **Surgical changes.** Edit only what your task requires. Don't refactor adjacent code, don't rename things, don't reformat.
- **No comments unless the *why* is non-obvious.** Don't restate what the code does.
- **No backwards-compat shims** unless explicitly requested. Just change the code.
- **Test what you change.** A new tool gets a test. A bug fix gets a regression test.
- **Match the existing style** in the file you're editing — JS, ESM modules, `//` comments, double-quoted strings.

## Deployment

Both bots auto-deploy from `main` via Render. There is **no staging environment**. Smoke-test in your dev guild before merging.

For deploy procedure, env-var management on Render, and rollback steps: **[DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md)**.

## Getting help

| Question | Where to look |
|---|---|
| How does the AI pipeline work? | [docs/ai-pipeline-eris.md](docs/ai-pipeline-eris.md) / [docs/ai-pipeline-irene.md](docs/ai-pipeline-irene.md) |
| What does the twin REST surface look like? | [docs/presence-api.md](docs/presence-api.md) |
| Why does X exist in both bots? | [docs/drift-inventory.md](docs/drift-inventory.md) (1-page summary) — full plan in [packages/eris/EXTRACTION_PLAN.md](packages/eris/EXTRACTION_PLAN.md) |
| What slash commands does each bot have? | [packages/eris/COMMANDS.md](packages/eris/COMMANDS.md) / [packages/irene/COMMANDS.md](packages/irene/COMMANDS.md) |
| How do I set up a dev guild? | [docs/dev-guild-workflow.md](docs/dev-guild-workflow.md) |
| What features have shipped recently? | `packages/<bot>/FEATURES.md` |
| How do I deploy? | [DEPLOY_MIGRATION.md](DEPLOY_MIGRATION.md) |
| Where do I add a tool / command / event? | This file → "Your first contribution" |
