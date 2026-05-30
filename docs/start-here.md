# Start here

You just opened the repo. This page gets you oriented in 10 minutes.

If you want to get a bot **running** locally instead, jump to [GETTING_STARTED.md](../GETTING_STARTED.md). Come back here after.

## What this is

A monorepo with two Discord bots and one shared utility package:

- **Eris** (`packages/eris`) — chaotic-twin AI personality, economy, gambling, ~170 tools.
- **Irene** (`packages/irene`) — good-twin server moderation, music, tickets, presence API, ~200 tools.
- **Shared** (`packages/shared`) — 4 drop-in modules both bots import: HMAC signing, LRU cache, role categorizer, SSRF-safe fetch.

The two bots are deployed as separate Render services. They talk to each other over HTTPS via an HMAC-signed REST surface (the "twin protocol"). Each bot has zero of the other's tools — Eris delegates moderation to Irene; Irene's economy actions delegate to Eris.

## Read this in this order

| Step | Read | Why |
|---|---|---|
| 1 | This page | Orientation |
| 2 | [GETTING_STARTED.md](../GETTING_STARTED.md) | Get a bot running locally |
| 3 | [glossary.md](./glossary.md) | Vocabulary — twin / tier / profile / sub-executor / gauntlet / etc. |
| 4 | [ai-pipeline-eris.md](./ai-pipeline-eris.md) **or** [ai-pipeline-irene.md](./ai-pipeline-irene.md) | The single most important file in the codebase: what happens when a Discord message arrives |
| 5 | [where-do-i-edit.md](./where-do-i-edit.md) | Decision tree: "I want to do X, where do I open?" |
| 6 | [cheatsheet.md](./cheatsheet.md) | Copy-paste recipes for the 10 most common tasks |
| 7 | [CONTRIBUTING.md](../CONTRIBUTING.md) | Workflow, conventions, your first PR |

If you're only here to fix a specific bug or add one feature, you can skip steps 4-5 and use [debugging-playbook.md](./debugging-playbook.md) (symptom → file location) or [where-do-i-edit.md](./where-do-i-edit.md) (goal → file location) directly.

## The 30-second mental model

```
                                    Discord
                                       │
                                       │ MESSAGE_CREATE event
                                       ▼
                       ┌─────────────────────────────────┐
                       │  events/messageCreate.js        │
                       │   ─ gating gauntlet (~10 gates) │
                       │   ─ build context + system prompt│
                       │   ─ call AI (ai/dual.js)        │
                       │   ─ dispatch tool calls         │
                       │   ─ render reply                │
                       │   ─ persist state               │
                       └─────────────────────────────────┘
                                       │
                                       │ tool calls fan out
                                       ▼
                       ┌─────────────────────────────────┐
                       │  ai/executor.js → SUB_EXECUTORS │
                       │   memory / web / moderation /   │
                       │   gambling / music / etc.       │
                       └─────────────────────────────────┘
                                       │
                                       │ writes
                                       ▼
                       ┌─────────────────────────────────┐
                       │  database.js  (cache + flush)   │
                       │   in-memory reads, debounced    │
                       │   2s flush to Supabase          │
                       └─────────────────────────────────┘
```

That's it. Everything else is supporting cast.

## The four files that hold most of the behavior

If you only read four files in the whole codebase, read these:

| Bot | File | Approx. size | What it owns |
|---|---|---|---|
| Eris | [packages/eris/events/messageCreate.js](../packages/eris/events/messageCreate.js) | ~1,328 lines | The whole AI pipeline |
| Eris | [packages/eris/ai/executor.js](../packages/eris/ai/executor.js) + [ai/executors/*](../packages/eris/ai/executors/) | ~1,500 lines | All tool dispatch |
| Irene | [packages/irene/events/messageCreate.js](../packages/irene/events/messageCreate.js) | ~1,830 lines | Same role; auto-mod runs first |
| Irene | [packages/irene/ai/executor.js](../packages/irene/ai/executor.js) + [ai/executors/*](../packages/irene/ai/executors/) | ~1,663 lines | All tool dispatch |

Big files — but they're sequential top-to-bottom. Skim by section comments.

## What's NOT in the codebase that you might expect

- **No CI** other than `scripts/verify-version-sync.js`. You'd add GitHub Actions if you want lint/test/build gates.
- **No staging environment.** Render auto-deploys from `main`. Use a [dev guild](./dev-guild-workflow.md) to safely test moderation/AI changes.
- **No multi-shard sharding.** One Node process per service. Sized for small-to-mid creator communities, not 10k-guild bots.
- **No structured log shipping.** `console.log` + a 5MB-rotating `bot.log` per package.
- **No type system.** ESM JS throughout. There's a `tsconfig.json` for editor JSDoc support but no compile step.

## Pick a track

Which describes you?

### "I want to add a new AI tool"
1. Read [ai-pipeline-eris.md](./ai-pipeline-eris.md) §5 ("Tool dispatch") and [cheatsheet.md](./cheatsheet.md) §1 ("Add a tool").
2. The reference tools are flagged `// ─── REFERENCE TOOL ───`:
   - Eris: `get_mood` ([ai/tools.js:425](../packages/eris/ai/tools.js), [ai/executors/miscExecutor.js:62](../packages/eris/ai/executors/miscExecutor.js), [tests/ai/getMoodTool.test.ts](../packages/eris/tests/ai/getMoodTool.test.ts))
   - Irene: `list_emojis` ([ai/tools.js:1901](../packages/irene/ai/tools.js), [ai/executor.js:1509](../packages/irene/ai/executor.js), [tests/ai/executors/listEmojis.test.ts](../packages/irene/tests/ai/executors/listEmojis.test.ts))
3. Follow the pattern.

### "I want to add a new slash command"
[cheatsheet.md](./cheatsheet.md) §2. Copy a sibling file, run `npm run deploy --workspace=@defnotean/<bot>`.

### "I want to change how the bot picks replies / its personality"
[ai-pipeline-eris.md](./ai-pipeline-eris.md) §3 ("Context building") + [packages/eris/prompts/eris-personality.md](../packages/eris/prompts/eris-personality.md) (or `irene-personality.md`). Personality reloads on bot restart — no code change needed.

### "I want to add a new event handler"
Drop a file in [packages/eris/events/](../packages/eris/events/) (or `irene/events/`) — auto-loaded by `loadEvents()` based on filename. Filename = event name (`messageDelete.js` binds to `MESSAGE_DELETE`).

### "Something is broken and I don't know why"
[debugging-playbook.md](./debugging-playbook.md) lists symptoms → file locations.

### "I want to write tests"
[testing-guide.md](./testing-guide.md). Vitest, no Discord/Supabase contact.

### "I want a faster inner loop"
[local-dev-loop.md](./local-dev-loop.md). `tsx --watch`, `vitest --watch`, prompt hot-reload.

## Some things to know before you change anything

- **Surgical changes only.** Don't refactor adjacent code, don't rename things, don't reformat. From [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Don't fix drift in an unrelated PR.** Some files exist in both bots and have intentionally diverged (`personality.js`, `longmemory.js`, `firewall.js`, `bumpReminder*.js`). Check both bot implementations before touching any of them.
- **Tests don't connect to Discord or Supabase.** Safe to run anywhere.
- **There is no staging.** Production tests happen in your dev guild — see [dev-guild-workflow.md](./dev-guild-workflow.md).
- **Pin dep versions exact across workspaces.** A 2026-04-24 incident took prod down because `discord.js@^14.14.1` and `^14.26.2` resolved to the same hoisted version with subtly broken APIs. `npm run lint:version-sync` enforces this.

## What to do after you finish reading

1. Run `npm install` from the repo root.
2. Run `npm test` to see ~641 tests pass (~423 Eris, ~218 Irene).
3. Pick one of the [tracks above](#pick-a-track).
4. Open the `.md` file it points to.

If you get stuck, the [debugging-playbook.md](./debugging-playbook.md) handles symptoms; [glossary.md](./glossary.md) handles "what does THIS word mean in this codebase?"
