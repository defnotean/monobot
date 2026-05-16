# Eris ↔ Irene Drift Inventory

Both bots evolved from the same scaffolding. Some divergence is intentional (each twin has its own personality, schema, and tools); some is accidental copy-paste slated for extraction.

This is the new-dev summary. The full reconciliation plan is in [packages/eris/EXTRACTION_PLAN.md](../packages/eris/EXTRACTION_PLAN.md) — read that before doing extraction work.

## What the status tags mean

Every row in the table below is tagged with one of:

- **IDENTICAL** — byte-for-byte equal (ignoring line endings). Ready to lift into `@defnotean/shared` as-is.
- **ACCIDENTAL DRIFT** — *meant* to be the same, but one bot got an update the other didn't. Needs a quick reconcile pass, then it can be shared. The Notes column says which bot's version is **canonical** (the one to keep).
- **INTENTIONALLY DIFFERENT** — diverged on purpose: different schema, personality, or domain. Stays per-bot; don't try to merge it.
- **EXTRACTED** — already moved to `@defnotean/shared`; the per-bot copies are gone. Edit it in `packages/shared/`.

Quick rule: if you're about to edit a file tagged anything other than `INTENTIONALLY DIFFERENT`, read [When your change touches drifted code](#when-your-change-touches-drifted-code) first so you don't deepen the drift.

## At a glance

| File / module | Eris | Irene | Same? | Notes |
|---|---|---|---|---|
| `ai/personality.js` | yes | yes | INTENTIONALLY DIFFERENT | Eris has stock/game/pet trait axes; Irene omits them. Need union schema before sharing. |
| `ai/longmemory.js` | yes | yes | INTENTIONALLY DIFFERENT | Schema diverged — table prefix is `{botName}_*`. Convergence planned in extraction Phase 0. |
| `ai/firewall.js` | yes | yes | ACCIDENTAL DRIFT | Eris uses `config.ownerId`; Irene aliases via `config.userId`. Eris's version is canonical. |
| `ai/keyPool.js` | no | no | EXTRACTED | Lives in `packages/shared/src/ai/keyPool.js`. Per-bot copies removed; logger is injected via `{ log }` opt on `createSplitPools` / `new KeyPool` instead of imported. |
| `ai/regexWorker.js` | yes | yes | IDENTICAL | Byte-equal modulo CRLF. Drop-in shared candidate. |
| `ai/temporal.js` | no | no | EXTRACTED | Lives in `packages/shared/src/ai/temporal.js`. Per-bot copies have been removed. |
| `ai/memoryQuirks.js` | no | no | EXTRACTED | Lives in `packages/shared/src/ai/memoryQuirks.js`. Per-bot copies have been removed. |
| `ai/selfCanon.js` | yes | yes | IDENTICAL | Byte-equal modulo CRLF. Logger import is now unblocked, but the module still depends on bot-local `ai/personality.js` via `await import("./personality.js")` for `_getData` / `_markOpinionsDirty`. Needs a DI/registration pass (or sharing of `personality.js` first) before it can move. |
| `ai/responsestyle.js` | no | no | EXTRACTED | Lives in `packages/shared/src/ai/responsestyle.js`. Per-bot copies have been removed. |
| `ai/humanity.js` | yes | yes | ACCIDENTAL DRIFT | Eris is canonical (UTC-day streak, time-based grudge decay, dedup-before-push, defensive `_lastDay` persistence). Irene needs port. |
| `ai/semantic.js` | yes | yes | ACCIDENTAL DRIFT | Eris has FIFO cache cap, length-aware hash, split store/search rate trackers, smart "human-like forgetting" cleanup. Irene's only structural difference is the `eris_*`/`irene_*` table prefix — parametrize for shared. |
| `ai/preoccupations.js` | yes | yes | ACCIDENTAL DRIFT | Logic identical; only differences are `eris_*`/`irene_*` table prefix and minor fallback-topic flavor wording. |
| `ai/opinions.js` | yes | yes | ACCIDENTAL DRIFT | Eris adds defensive `Number.isFinite(Date.parse(...))` checks for malformed timestamps; otherwise identical. Earlier doc claim of "Eris-only" was wrong — file exists in both. |
| `ai/memory.js` | yes | yes | INTENTIONALLY DIFFERENT | Different storage and API. Eris: Supabase-backed facts table with sensitivity levels (normal/sensitive/secret), tied to economy/prefs. Irene: in-memory `Map<guildId, Map<userId, []>>` with 90-day cleanup, no sensitivity tiers. Belongs per-bot. |
| `ai/sentiment.js` | yes | yes | INTENTIONALLY DIFFERENT | Same 4-pass shape (bigram → word → emoji → sarcasm) but the lexicons are bot-flavored: Eris focuses on negation handling ("not bad", "ngl good"); Irene encodes Discord-speak ("no cap", "big w", "cope harder"). Sarcasm patterns + emoji sets also differ. |
| `ai/contextCompressor.js` | yes | yes | INTENTIONALLY DIFFERENT | Different LLM message formats. Eris compresses Gemini-style entries (`parts: [{ text }]`); Irene compresses Anthropic-style entries (`content: string \| [blocks]`) with `tool_use`/`tool_result` block handling and orphan sanitization. |
| `ai/dual.js` | yes | yes | INTENTIONALLY DIFFERENT | Eris is a thin generic dual-model wrapper (sanitizeSchema, toGeminiTools, quickReply, looksLikeTask). Irene is a full bot orchestrator with admin-tool denials, hardcoded "irene"/mod-action keywords, music-bot keywords (tts/voice/vc), and an inline tool-call loop. |
| `ai/karaoke.js` | yes | yes | INTENTIONALLY DIFFERENT | Irene has the real implementation (Lavalink integration, dual message/nickname display modes, queue polling, title cleanup). Eris's copy is vestigial — comment even says "Irene-only feature" and it imports lastfm. Should be removed from Eris. |
| `ai/bump{Reminder,Celebrations,Correlation,Applause,Analytics,UserPrefs}.js` | yes | yes | ACCIDENTAL DRIFT | ~150KB family; bot-agnostic, prime sharing candidate. |
| `ai/executor.js` + `ai/executors/*` | yes | yes | INTENTIONALLY DIFFERENT | Dispatch fans out into bot-specific executors (Eris: economy/gambling/games; Irene: moderation/voice/leveling). |
| `ai/providers/index.js` | yes | yes | ACCIDENTAL DRIFT | Eris is canonical — adds NVIDIA→Gemini fallback router with circuit-open detection. Irene is single-provider. Port Eris's wrapper. |
| `ai/providers/gemini.js` | yes | yes | INTENTIONALLY DIFFERENT | Re-exports the bot's local `dual.js`. Since `dual.js` itself is bot-specific (see above), the adapter is too — Irene stubs missing exports (`toGeminiTools` passthrough, `isRateLimited` returns false) that Eris's `dual.js` does export. |
| `ai/providers/nvidia.js` | yes | yes | INTENTIONALLY DIFFERENT | Both call NVIDIA OpenAI-format endpoint, but the system-prompt tool examples are bot-specific (Eris embeds `fish/hunt/dig/gamble/flip/slots/blackjack/balance` keywords; Irene embeds `skip/stop/pause/lyrics/karaoke/purge`). Eris also has a circuit breaker; Irene has a positional/object call-style adapter. |
| `utils/twinSign.js` | no | no | EXTRACTED | Lives in `packages/shared/src/twinSign.js`. Per-bot copies have been removed. |
| `utils/LRUCache.js` | no | no | EXTRACTED | Lives in `packages/shared/src/LRUCache.js`. Per-bot copies have been removed. |
| `utils/roleCategorizer.js` | no | no | EXTRACTED | Lives in `packages/shared/src/roleCategorizer.js`. Per-bot copies have been removed. |
| `utils/twinState.js` | yes | yes | IDENTICAL | Byte-equal modulo CRLF. Logger import is now unblocked, but the module still imports bot-local `config.js` for `twinApiSecret` / `twinApiUrl`. Needs a config-injection pass before extraction. |
| `utils/humanDelay.js` | no | no | EXTRACTED | Lives in `packages/shared/src/utils/humanDelay.js`. Per-bot copies have been removed. |
| `utils/toolRateLimit.js` | yes | yes | ACCIDENTAL DRIFT | Earlier audit's "logic byte-equal" claim is stale. Irene's `TOOL_LIMITS` now includes `generate_image` and `say_tts` entries (image-gen + TTS are Irene-only features); Eris does not. Reconcile by parametrizing the limit map per bot, then extract. |
| `utils/cooldown.js` | yes | yes | ACCIDENTAL DRIFT | Same core, but Irene adds `resetCooldown()` (refund on failure) and a deferred `startCooldownCleanup()` (vs Eris's import-time `setInterval`). Irene's API is the better target. |
| `utils/logger.js` | yes (shim) | yes (shim) | EXTRACTED (split) | Core factory `createLogger({ botPrefix, logFile, redact })` lives in `packages/shared/src/logger.js`. Per-bot `utils/logger.js` is now a thin shim that calls the factory and re-exports `log` + `redact`; Irene's shim also defines the bot-local `sendModLog()` since that depends on Irene's `database.js` + `embeds.js`. |
| `utils/permissions.js` | yes | yes | INTENTIONALLY DIFFERENT | Different domains. Eris exports owner/trusted-user gating (`isOwner`/`isTrusted`/`canCustomize`/`denyMessage`) for the creator-only command surface. Irene exports Discord moderation gating (`isAdminOrOwner`/`requirePermission`/`canModerate`) with role-hierarchy checks. Belongs per-bot. |

## Eris-only modules (don't expect to find these in Irene)

- Economy/gambling/games: `ai/{economy,economyExecutor,stocks,stockMarket,gambling,poker,lottery,gameVisuals,gameWatcher}.js`, `ai/{games,gambling}/`
- Pets/activities/social: `ai/{minions,activityExecutor,socialExecutor,randomEvents}.js`
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
- `logger.js` — `createLogger({ botPrefix, logFile, redact })` factory; bot-local `utils/logger.js` is a thin shim around it
- `ai/temporal.js` — temporal awareness prompt fragment
- `ai/memoryQuirks.js` — rare memory-imperfection hints
- `ai/responsestyle.js` — dynamic response-style picker
- `ai/keyPool.js` — smart API-key pool with per-key rate-limit tracking; logger is injected via `{ log }` opt
- `utils/humanDelay.js` — human-timed message delivery

Per-bot copies have been removed — both bots now import from `@defnotean/shared` for these modules.

## When your change touches drifted code

Per [CONTRIBUTING.md](../CONTRIBUTING.md) "Before you start", talk to the maintainer first. Specifically:
- `ai/personality.js` → mirror to the other bot or document the asymmetry
- `ai/firewall.js` → usually goes in both (mind the `ownerId`/`userId` divergence)
- `ai/longmemory.js` → schema changes need cross-bot migration coordination
- `utils/twinSign.js` → fix it in `packages/shared/src/twinSign.js`; don't deepen the drift
- Any `bump*.js` → port to the other bot in the same PR; logic is bot-agnostic

## Status of the extraction plan

EXTRACTION_PLAN.md was **drafted 2026-04-23, not yet executed**. Phase progress:
- **Phase 0 (reconcile drifts):** not started — `firewall`, `personality`, `longmemory` still differ between bots. (`twinSign` already reconciled — see Phase 2.)
- **Phase 1 (workspace structure):** done — already a monorepo with `packages/{eris,irene,shared}`.
- **Phase 2 (move files):** partial — `LRUCache`, `roleCategorizer`, `twinSign`, plus `ai/{temporal,memoryQuirks,responsestyle,keyPool}`, `logger` (factory + per-bot shim), and `utils/humanDelay` already extracted. Files still pending:
  - `ai/selfCanon.js` — still imports bot-local `ai/personality.js` (`_getData` / `_markOpinionsDirty`).
  - `ai/bumpApplause.js`, `ai/bumpUserPrefs.js` — still import bot-local `database.js` (and bumpApplause also `bumpReminder.js` + `bumpAnalytics.js`).
  - `utils/twinState.js` — still imports bot-local `config.js`.
  - `utils/toolRateLimit.js` — now ACCIDENTAL DRIFT (Irene-only `generate_image` + `say_tts` entries); reconcile first.
  - ACCIDENTAL DRIFT files (`humanity`, `semantic`, `preoccupations`, `opinions`, `cooldown`, `providers/index`) still need a brief reconcile pass before extraction.
- **Phase 3 (deploy):** done — Render runs from this monorepo (see [DEPLOY_MIGRATION.md](../DEPLOY_MIGRATION.md)).
- **Phase 4 (retire old repos):** blocked on Phase 0/2.

Workspace plumbing landed early; de-duplication of core AI modules is still to do.
