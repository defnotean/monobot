# defnotean-bots-monorepo

Monorepo housing the twin-bot system: two Discord bots (Eris + Irene) and a shared utilities package.

| Package | What it is | Deploy target |
|---|---|---|
| [`packages/eris`](./packages/eris) | Eris — the chaotic twin (economy, gambling, AI personality, ~170 tools) | Render service: `eris-bot` |
| [`packages/irene`](./packages/irene) | Irene — the good twin (server moderation, tickets, music, ~200 tools) | Render service: `irene-bot` |
| [`packages/shared`](./packages/shared) | Shared core utilities: HMAC twin signing, LRU cache, role categorizer, SSRF-safe fetch | Imported by both bots via `@defnotean/shared/<module>` |

## New here?

**[docs/start-here.md](./docs/start-here.md)** is the front door — a 10-minute orientation with the mental model, the handful of files that hold most of the behavior, and a "pick your track" guide that points you at the right doc next. Start there and let it route you.

In a hurry to just get a bot running? **[GETTING_STARTED.md](./GETTING_STARTED.md)** takes you from `git clone` to a live bot in about 15 minutes.

## Reference docs

| File | Use it when |
|---|---|
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
| [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) | Render deployment runbook + known deploy gotchas |

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

This monorepo was assembled from two previously separate bot repositories — one per bot — merged into a single npm-workspaces layout with a shared package.

## Deployment

See [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) for the step-by-step Render setup and known deploy gotchas (workspace dependency hoisting can silently break things — worth reading before touching dep ranges).

See [docs/drift-inventory.md](./docs/drift-inventory.md) for files that have drifted between the two bots — some intentionally (per-bot personality, schema), some accidentally (slated for extraction into `@defnotean/shared`).
