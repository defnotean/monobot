# Contributing

Welcome. This guide covers how to make a change to the bots monorepo without breaking the deployed bots or stepping on the maintainer's toes.

If you haven't run the bots locally yet, start with **[GETTING_STARTED.md](./GETTING_STARTED.md)**.

## Repository layout

```
MonoBot/
├── packages/
│   ├── eris/             # Chaotic-twin Discord bot — economy, gambling, AI personality
│   │   ├── COMMANDS.md   # Slash command inventory (54 commands across 8 categories)
│   ├── irene/            # Good-twin Discord bot — moderation, music, auto-mod, tickets
│   │   └── COMMANDS.md   # Slash command inventory (67 commands across 8 categories)
│   └── shared/           # Shared utilities — twin signing (HMAC), LRU cache, role categorizer
├── docs/                 # Architecture and onboarding docs
│   ├── ai-pipeline-eris.md   # Message-to-reply trace for Eris
│   ├── ai-pipeline-irene.md  # Message-to-reply trace for Irene
│   ├── presence-api.md       # Twin REST + HMAC signing surface
│   └── dev-guild-workflow.md # How to set up a dev Discord guild + safe testing
├── scripts/
│   └── verify-version-sync.js   # CI guard for shared third-party dep ranges
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
4. **Check the twin boundary** — if your change touches code that exists in both bots (`personality.js`, `longmemory.js`, `firewall.js`, bump reminder modules, or shared utilities), confirm whether the other bot needs the same change

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
- `docs: update Render deployment notes`
- `chore: unify + pin shared dep ranges across workspaces (phase D)`

**Body (optional):** explain *why*, not what. Reference the issue or incident that prompted it.

**Important:** do NOT add AI-tool attribution to commits, PR descriptions, or `Co-Authored-By` fields. All work is attributed to the contributor.

## Pull requests

- **Title** in the same format as a commit message
- **Body** under 200 words covering: what changed, why, and a one-line test plan
- **Smoke-test plan** if your change affects production behavior — include slash commands, mentions, embeds, and twin API behavior when relevant

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
| `npm run test:eris` | Eris workspace tests |
| `npm run test:irene` | Irene workspace tests |
| `npm test --workspaces --if-present` | all workspace tests |
| `npm run dev:eris` / `npm run dev:irene` | run the bot with file-watch (faster inner loop than `start:*`) |
| `npm run lint:version-sync` | guards that non-local dependencies used by multiple workspaces have identical version ranges |

**Critical paths worth focused tests** — good places to add coverage when you touch them:
- Irene AI router / sub-executors (`packages/irene/ai/executor.js` is now a compact router with direct `executeTool` coverage)
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
- **Twin coordination has asymmetric read/write auth.** `ask_eris` signs POST mutations and uses Bearer auth for read-only GETs; keep Eris and Irene endpoint docs/tests in sync when changing that surface.

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

Render deploys use the root [render.yaml](./render.yaml). Keep env vars managed in Render and smoke-test in a dev guild after deployment.

## Getting help

| Question | Where to look |
|---|---|
| How does the AI pipeline work? | [docs/ai-pipeline-eris.md](docs/ai-pipeline-eris.md) / [docs/ai-pipeline-irene.md](docs/ai-pipeline-irene.md) |
| What does the twin REST surface look like? | [docs/presence-api.md](docs/presence-api.md) |
| Why does X exist in both bots? | Check the matching files in `packages/eris` and `packages/irene`, then decide whether the difference is intentional before editing both |
| What slash commands does each bot have? | [packages/eris/COMMANDS.md](packages/eris/COMMANDS.md) / [packages/irene/COMMANDS.md](packages/irene/COMMANDS.md) |
| How do I set up a dev guild? | [docs/dev-guild-workflow.md](docs/dev-guild-workflow.md) |
| How do I deploy? | Root [render.yaml](render.yaml), plus [docs/self-hosting.md](docs/self-hosting.md) for non-Render installs |
| Where do I add a tool / command / event? | This file → "Your first contribution" |
