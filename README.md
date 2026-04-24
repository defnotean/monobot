# defnotean-bots-monorepo

Monorepo housing the twin-bot system:

| Package | What it is | Deploy target |
|---|---|---|
| [`packages/eris`](./packages/eris) | Eris — the chaotic twin (economy, gambling, AI personality, 170+ tools) | Render service: `eris-bot` |
| [`packages/irene`](./packages/irene) | Irene — the good twin (server moderation, tickets, music, 200+ tools) | Render service: `irene-bot` |
| [`packages/shared`](./packages/shared) | Shared core utilities: role categorizer, HMAC twin-signing, LRU cache | Imported by both bots via `@defnotean/shared/<module>` |

## Development

```bash
npm install                    # installs all workspace deps at root, hoists where possible
npm run test                   # runs tests in every workspace that has them
npm run start:eris             # starts Eris locally (needs .env in packages/eris/)
npm run start:irene            # starts Irene locally (needs .env in packages/irene/)
npm run lint:shared-sync       # verifies shared package stays in sync (see scripts/verify-shared-sync.js)
```

## History

This monorepo was created by `git subtree add`-ing the two pre-existing repos:
- [`defnotean/Eris`](https://github.com/defnotean/Eris) → `packages/eris/`
- [`defnotean/Irene`](https://github.com/defnotean/Irene) → `packages/irene/`

Original repos remain as-is for backward compatibility during the Render deploy migration. Once both services point at this monorepo, the originals can be archived.

## Migration notes

See [`DEPLOY_MIGRATION.md`](./DEPLOY_MIGRATION.md) for the step-by-step Render service update.

See [`EXTRACTION_PLAN.md`](./EXTRACTION_PLAN.md) for the extraction rationale and the remaining files that still have drift between the two packages (personality.js, longmemory.js, semantic.js, humanity.js — kept per-package on purpose because they hold bot-specific state/schema).
