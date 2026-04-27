# defnotean-bots-monorepo

Monorepo housing the twin-bot system: two Discord bots (Eris + Irene) and a shared utilities package.

| Package | What it is | Deploy target |
|---|---|---|
| [`packages/eris`](./packages/eris) | Eris — the chaotic twin (economy, gambling, AI personality, ~170 tools) | Render service: `eris-bot` |
| [`packages/irene`](./packages/irene) | Irene — the good twin (server moderation, tickets, music, ~200 tools) | Render service: `irene-bot` |
| [`packages/shared`](./packages/shared) | Shared core utilities: HMAC twin signing, LRU cache, role categorizer, SSRF-safe fetch | Imported by both bots via `@defnotean/shared/<module>` |

## New here? Read in this order

1. **[docs/start-here.md](./docs/start-here.md)** — 10-minute orientation tour. The 30-second mental model, the four files that hold most of the behavior, and which doc to read next based on what you're trying to do.
2. **[GETTING_STARTED.md](./GETTING_STARTED.md)** — clone → install → running bot in ~15 minutes.
3. **[docs/glossary.md](./docs/glossary.md)** — vocabulary used throughout the codebase (twin, tier, profile, sub-executor, gauntlet, drift, etc.).
4. **[CONTRIBUTING.md](./CONTRIBUTING.md)** — workflow, commit conventions, what NOT to touch.

## Reference docs

| File | Use it when |
|---|---|
| [docs/start-here.md](./docs/start-here.md) | First time opening the repo |
| [docs/glossary.md](./docs/glossary.md) | A term in the code doesn't make sense |
| [docs/where-do-i-edit.md](./docs/where-do-i-edit.md) | "I want to change X — what file?" decision tree |
| [docs/cheatsheet.md](./docs/cheatsheet.md) | Copy-paste recipes for the 10 most common tasks |
| [docs/debugging-playbook.md](./docs/debugging-playbook.md) | "X is broken — where do I look?" symptom→file lookups |
| [docs/testing-guide.md](./docs/testing-guide.md) | Vitest patterns, mocking Discord/Supabase |
| [docs/local-dev-loop.md](./docs/local-dev-loop.md) | Fastest inner-loop workflow (watch mode, twin local testing, etc.) |
| [docs/ai-pipeline-eris.md](./docs/ai-pipeline-eris.md) | How a Discord message becomes an Eris reply (line-by-line trace) |
| [docs/ai-pipeline-irene.md](./docs/ai-pipeline-irene.md) | Same for Irene |
| [docs/presence-api.md](./docs/presence-api.md) | The HMAC twin coordination layer + the dashboard REST surface |
| [docs/drift-inventory.md](./docs/drift-inventory.md) | Eris ↔ Irene divergence at a glance — read before touching shared modules |
| [docs/dev-guild-workflow.md](./docs/dev-guild-workflow.md) | Setting up a safe dev Discord guild for testing |
| [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) | Render service runbook + 2026-04-24 post-mortem |

## Development

```bash
npm install                    # installs all workspace deps at root, hoists where possible
npm run test                   # runs ~641 tests across both bots
npm run start:eris             # starts Eris locally (needs .env in packages/eris/)
npm run start:irene            # starts Irene locally (needs .env in packages/irene/)
npm run dev:eris               # tsx --watch index.ts for fast inner loop
npm run dev:irene
npm run lint:version-sync      # CI guard — both bots must pin identical shared deps
```

For the watch-mode + dev-guild workflow, see [docs/local-dev-loop.md](./docs/local-dev-loop.md).

## History

This monorepo was created by `git subtree add`-ing the two pre-existing repos:
- [`defnotean/Eris`](https://github.com/defnotean/Eris) → `packages/eris/`
- [`defnotean/Irene`](https://github.com/defnotean/Irene) → `packages/irene/`

Original repos remain as-is for backward compatibility during the Render deploy migration. Once both services point at this monorepo, the originals can be archived.

## Migration notes

See [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) for the step-by-step Render service update and the 2026-04-24 post-mortem (workspace dep hoisting silently broke production — required reading before touching dep ranges).

See [docs/drift-inventory.md](./docs/drift-inventory.md) for files that have drifted between the two bots — some intentionally (per-bot personality, schema), some accidentally (slated for extraction into `@defnotean/shared`).
