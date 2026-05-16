# defnotean-bots-monorepo

[![Tests](https://github.com/defnotean/monobot/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/defnotean/monobot/actions/workflows/test.yml)

Monorepo housing the twin-bot system: two Discord bots (Eris + Irene) and a shared utilities package.

| Package | What it is | Deploy target |
|---|---|---|
| [`packages/eris`](./packages/eris) | Eris — the chaotic twin (economy, gambling, AI personality, ~170 tools) | Render service: `eris-bot` |
| [`packages/irene`](./packages/irene) | Irene — the good twin (server moderation, tickets, music, ~200 tools) | Render service: `irene-bot` |
| [`packages/shared`](./packages/shared) | Shared core utilities: HMAC twin signing, LRU cache, role categorizer, SSRF-safe fetch | Imported by both bots via `@defnotean/shared/<module>` |

*Service names (`eris-bot`, `irene-bot`) are examples — self-hosters and forks pick their own.*

**Each bot runs independently** — deploy just Eris, just Irene, or both. When both run, they coordinate over an HMAC-signed REST surface (the "twin protocol"). Single-bot setups skip that entirely.

## New here?

**[docs/start-here.md](./docs/start-here.md)** is the front door — a 10-minute orientation with the mental model, the handful of files that hold most of the behavior, and a "pick your track" guide that points you at the right doc next. Start there and let it route you.

In a hurry to just get a bot running? **[GETTING_STARTED.md](./GETTING_STARTED.md)** takes you from `git clone` to a live bot in about 15 minutes.

## Reference docs

### Orientation (start here)
| File | Use it when |
|---|---|
| [docs/start-here.md](./docs/start-here.md) | 10-minute new-contributor orientation |
| [docs/glossary.md](./docs/glossary.md) | A term in the code doesn't make sense |
| [docs/where-do-i-edit.md](./docs/where-do-i-edit.md) | "I want to change X — what file?" decision tree |
| [docs/cheatsheet.md](./docs/cheatsheet.md) | Copy-paste recipes for the 15 most common tasks |

### How it works
| File | Use it when |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level system map — twin model, AI pipeline, persistence, deployment shapes |
| [docs/ai-pipeline-eris.md](./docs/ai-pipeline-eris.md) | How a Discord message becomes an Eris reply (line-by-line trace) |
| [docs/ai-pipeline-irene.md](./docs/ai-pipeline-irene.md) | Same for Irene |
| [docs/TOOLCALLING.md](./docs/TOOLCALLING.md) | Deep-dive on the AI tool system — registry, dispatch, contracts, aliasing |
| [docs/TWIN-PROTOCOL.md](./docs/TWIN-PROTOCOL.md) | HMAC twin coordination — signing, replay, rate limits, every endpoint |
| [docs/presence-api.md](./docs/presence-api.md) | The dashboard REST surface |
| [docs/PERSISTENCE.md](./docs/PERSISTENCE.md) | Data layer — schema, migrations, debounced flush, atomic ops, in-memory mode |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | Exhaustive env-var reference (87 vars across both bots) |

### Working in the codebase
| File | Use it when |
|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Workflow, conventions, your first PR |
| [docs/CONTRIBUTING-CODE.md](./docs/CONTRIBUTING-CODE.md) | Code style + naming + async patterns + commit conventions |
| [docs/local-dev-loop.md](./docs/local-dev-loop.md) | Fastest inner-loop workflow (watch mode, twin local testing, migrations) |
| [docs/dev-guild-workflow.md](./docs/dev-guild-workflow.md) | Setting up a safe dev Discord guild for testing |
| [docs/testing-guide.md](./docs/testing-guide.md) | Vitest patterns, mocking Discord/Supabase, fake-timer & seeded-RNG recipes |
| [docs/debugging-playbook.md](./docs/debugging-playbook.md) | "X is broken — where do I look?" symptom→file lookups |
| [docs/drift-inventory.md](./docs/drift-inventory.md) | Eris ↔ Irene divergence at a glance — read before touching shared modules |

### Running it (deployment)
| File | Use it when |
|---|---|
| [docs/self-hosting.md](./docs/self-hosting.md) | Running on your own hardware (laptop / home server / VPS) instead of Render |
| [docs/llm-provider-guide.md](./docs/llm-provider-guide.md) | Provider setup (Gemini / NVIDIA / OpenRouter / Ollama / LM Studio) |
| [DEPLOY_MIGRATION.md](./DEPLOY_MIGRATION.md) | Render deployment runbook + known deploy gotchas |
| [docs/SCALING.md](./docs/SCALING.md) | What scales horizontally and what doesn't; multi-replica caveats |
| [docs/MONITORING.md](./docs/MONITORING.md) | What's observable today, what's missing, alert recipes |

### Security
| File | Use it when |
|---|---|
| [SECURITY.md](./SECURITY.md) | Reporting vulnerabilities + supported-versions / disclosure policy |
| [docs/audits/README.md](./docs/audits/README.md) | Index of subsystem audits (twin, web, GitHub, PC-agent, gambling, moderation, env, logging) |

### Release notes
| File | Use it when |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | What changed in each version (Keep-a-Changelog format) |

## Security

Found a vulnerability? Please **do not** open a public issue. See [SECURITY.md](./SECURITY.md) for the private disclosure channel, supported versions, and the response timeline. Deeper subsystem audits live under [docs/audits/](./docs/audits/README.md).

## Development

```bash
npm install                    # installs all workspace deps at root, hoists where possible
npm run test                   # runs ~1100 tests across both bots + shared
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

Prefer to run on your own hardware? See [docs/self-hosting.md](./docs/self-hosting.md) — covers Linux/Windows/macOS, process managers, networking, and Lavalink setup.

See [docs/drift-inventory.md](./docs/drift-inventory.md) for files that have drifted between the two bots — some intentionally (per-bot personality, schema), some accidentally (slated for extraction into `@defnotean/shared`).
