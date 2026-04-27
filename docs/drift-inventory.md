# Eris ↔ Irene Drift Inventory

Both bots evolved from the same scaffolding. Some divergence is intentional (each twin has its own personality, schema, and tools); some is accidental copy-paste slated for extraction.

This is the new-dev summary. The full reconciliation plan is in [packages/eris/EXTRACTION_PLAN.md](../packages/eris/EXTRACTION_PLAN.md) — read that before doing extraction work.

## At a glance

| File / module | Eris | Irene | Same? | Notes |
|---|---|---|---|---|
| `ai/personality.js` | yes | yes | INTENTIONALLY DIFFERENT | Eris has stock/game/pet trait axes; Irene omits them. Need union schema before sharing. |
| `ai/longmemory.js` | yes | yes | INTENTIONALLY DIFFERENT | Schema diverged — table prefix is `{botName}_*`. Convergence planned in extraction Phase 0. |
| `ai/firewall.js` | yes | yes | ACCIDENTAL DRIFT | Eris uses `config.ownerId`; Irene aliases via `config.userId`. Eris's version is canonical. |
| `ai/semantic.js` | yes | yes | UNCONFIRMED DRIFT | Likely diverged — diff before editing either. |
| `ai/humanity.js` | yes | yes | UNCONFIRMED DRIFT | Likely diverged — diff before editing either. |
| `ai/memory.js` | yes | yes | UNCONFIRMED DRIFT | Likely diverged — diff before editing either. |
| `ai/bump{Reminder,Celebrations,Correlation,Applause,Analytics,UserPrefs}.js` | yes | yes | ACCIDENTAL DRIFT | ~150KB family; bot-agnostic, prime sharing candidate. |
| `ai/dual.js` | yes | yes | ACCIDENTAL DRIFT | LLM call wrapper; differences mostly cosmetic. |
| `ai/contextCompressor.js` | yes | yes | ACCIDENTAL DRIFT | Diff before editing. |
| `ai/{keyPool,regexWorker,temporal,tools,toolRegistry,sentiment,responsestyle,preoccupations,memoryQuirks,selfCanon,karaoke,opinions}.js` | yes | yes | UNCONFIRMED DRIFT | Same filename in both; diff before editing. |
| `ai/executor.js` + `ai/executors/*` | yes | yes | INTENTIONALLY DIFFERENT | Dispatch fans out into bot-specific executors (Eris: economy/gambling/games; Irene: moderation/voice/leveling). |
| `ai/providers/{gemini,nvidia,index}.js` | yes | yes | UNCONFIRMED DRIFT | Same three files in both. |
| `utils/twinSign.js` | yes | yes | ACCIDENTAL DRIFT | Already extracted to `packages/shared/src/twinSign.js`; per-bot copies still exist and may be stale. |
| `utils/LRUCache.js` | yes | yes | EXTRACTED | Identical, also lives in `packages/shared/src/LRUCache.js`. |
| `utils/roleCategorizer.js` | yes | yes | EXTRACTED | Byte-identical, also in shared. |
| `utils/{logger,cooldown,permissions,twinState,humanDelay,toolRateLimit}.js` | yes | yes | UNCONFIRMED DRIFT | Same filename in both `utils/` dirs. |

## Eris-only modules (don't expect to find these in Irene)

- Economy/gambling/games: `ai/{economy,economyExecutor,stocks,stockMarket,gambling,poker,lottery,gameVisuals,gameWatcher}.js`, `ai/{games,gambling}/`
- Pets/activities/social: `ai/{minions,activityExecutor,socialExecutor,randomEvents,opinions}.js`
- Executors: `ai/executors/{admin,casino,gambling,game,github,media,misc,notes,system,twin,web}Executor.js`
- Top-level: `agent-ui/`, `api/`, `lastfm/`, `migrations/`, `run.bat`
- Utils: `autoDeploy`, `discord`, `mememaker`, `pcAgent`, `unicode.ts`
- Commands: `commands/{activities,economy,gambling,games,lastfm,pets,social}/`

## Irene-only modules (don't expect to find these in Eris)

- Rules engine: `ai/rules{Detector,Enforcer,Escalation}.js`
- Other AI: `ai/{dreams,weeklyDigest,newtools}.js`
- Twin REST surface: `presence.js` (see [docs/presence-api.md](./presence-api.md))
- Voice/music: `music/`, `voice/`, `ai/executors/{audio,voice}Executor.js`
- Moderation/admin executors: `ai/executors/{moderation,channel,role,message,server,setup,toggle,leveling,advanced,personalize}Executor.js`
- Server-management utils (~28 files): `antinuke`, `auditFormat`, `birthday`, `commandsHelp`, `embeds`, `giveawayEligibility`, `invites`, `leveling`, `msglog`, `raid`, `safety`, `scheduler`, `scrims`, `snipe`, `stats`, `tempvc`, `twinPunish`, `twitch`, `vcpanel`, `youtube`, etc.
- Commands: `commands/{ai,context,fun,moderation,music,setup,voice}/`

## What's already shared

Lives in `packages/shared/src/` (workspace package `@defnotean/shared`):
- `twinSign.js` — HMAC signing for twin REST calls
- `LRUCache.js` — bounded LRU for both bots
- `roleCategorizer.js` — Discord role classification

Per-bot copies still exist in each `utils/` dir and may be stale — prefer the shared package when adding new imports.

## When your change touches drifted code

Per [CONTRIBUTING.md](../CONTRIBUTING.md) "Before you start", talk to the maintainer first. Specifically:
- `ai/personality.js` → mirror to the other bot or document the asymmetry
- `ai/firewall.js` → usually goes in both (mind the `ownerId`/`userId` divergence)
- `ai/longmemory.js` → schema changes need cross-bot migration coordination
- `utils/twinSign.js` → fix it in `packages/shared/src/twinSign.js`; don't deepen the drift
- Any `bump*.js` → port to the other bot in the same PR; logic is bot-agnostic

## Status of the extraction plan

EXTRACTION_PLAN.md was **drafted 2026-04-23, not yet executed**. Phase progress:
- **Phase 0 (reconcile drifts):** not started — `firewall`, `personality`, `longmemory`, `twinSign` still differ between bots.
- **Phase 1 (workspace structure):** done — already a monorepo with `packages/{eris,irene,shared}`.
- **Phase 2 (move files):** partial — `LRUCache`, `roleCategorizer`, `twinSign` live in shared but per-bot duplicates remain; the other ~7 modules untouched.
- **Phase 3 (deploy):** done — Render runs from this monorepo (see [DEPLOY_MIGRATION.md](../DEPLOY_MIGRATION.md)).
- **Phase 4 (retire old repos):** blocked on Phase 0/2.

Workspace plumbing landed early; de-duplication of core AI modules is still to do.
