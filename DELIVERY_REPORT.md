# Delivery Report

Scope executed: WP1 through WP7 from `IMPLEMENTATION_PLAN.md` in the requested order. WP8 was not built.

Branch: `defnotean/implementation-plan-wp1-wp7`

Commits:
- WP1: `1ff0f1a Improve local tool routing`
- WP2: `80e8b1b Harden persistence cache durability`
- WP3: `708118a Harden safe fetch boundaries`
- WP4: `ffc4c2d Add static guardrails`
- WP5: `ba479e9 Compact tool schemas`
- WP6: `aec8293 Extract shared AI modules`
- WP7: `7a496a9 Decompose message and blackjack flows`

## WP1 - Tool-calling Phase 3

Implemented:
- Wired recent tool usage tracking and demotion-aware routing for both bots.
- Added shared `toolRouter`, Eris `unknownTools` telemetry parity, schema echo/help/rescue behavior, compact schema plumbing, and clean prompt footprint measurement.
- Preserved hosted/Gemini defaults; compact schemas are gated by local-provider/env behavior.

Files:
- `packages/eris/ai/dual.js`, `packages/eris/ai/executor.js`, `packages/eris/ai/providers/nvidia.js`, `packages/eris/ai/providers/openaiCompat.js`, `packages/eris/ai/toolCoaching.js`, `packages/eris/ai/toolRegistry.js`, `packages/eris/config.js`
- `packages/eris/events/messageCreate/contextBuild.js`, `packages/eris/events/messageCreate/gates.js`, `packages/eris/events/messageCreate/toolProfiles.js`
- `packages/irene/ai/dual.js`, `packages/irene/ai/executor.js`, `packages/irene/ai/providers/nvidia.js`, `packages/irene/ai/providers/openaiCompat.js`, `packages/irene/ai/toolCoaching.js`, `packages/irene/ai/toolRegistry.js`, `packages/irene/ai/unknownTools.js`, `packages/irene/config.js`, `packages/irene/events/messageCreate/contextBuild.js`
- `packages/shared/package.json`, `packages/shared/src/ai/stripReasoning.js`, `packages/shared/src/ai/toolRouter.js`, `packages/shared/src/ai/unknownTools.js`, `scripts/measure-prompt-footprint.mjs`
- Tests under `packages/eris/tests/ai`, `packages/eris/tests/config`, `packages/irene/tests/ai`, `packages/irene/tests/config`, and `packages/shared/tests`.

Gate:
- Full section 9 gate passed after WP1.

Measurements:
- `npm run measure:prompt`: Eris owner casual/admin `tier1SchemaJsonChars=17926`; Irene admin casual `10670`; Irene admin moderation `17624`.
- Compact schema spot measurement: Irene `setup_ticket` `fullBytes=6498`, `compactBytes=3055`, `savedBytes=3443`, `reductionPct=53.0`.

Deviations / skipped:
- None recorded for WP1.

## WP2 - Persistence Durability and Cache Correctness

Implemented:
- Eris debounced flush retry/reschedule on failure.
- Irene dirty flush now snapshots with `structuredClone(data)` and a cheap dirty guard instead of full JSON round-tripping.
- Eris executor cache invalidation gaps were fixed, including partner invalidation in social divorce.
- Twin punish confiscation was made atomic with a dashboard lock and unsafe balance variants inside the lock.

Files:
- `packages/eris/database/core.js`, `packages/eris/ai/executor.js`, `packages/eris/ai/socialExecutor.js`, `packages/eris/api/dashboard.js`
- `packages/irene/database/core.js`
- `packages/eris/tests/db/flushRetry.test.ts`, `packages/eris/tests/ai/executorCacheInvalidation.test.ts`, `packages/eris/tests/api/twinPunishAuth.test.ts`, `packages/irene/tests/database/dirtyFlush.test.ts`

Gate:
- Full section 9 gate passed after WP2.

Measurements:
- Synthetic 50-guild Irene-shaped payload size: `363269` bytes.
- Initial old stringify/parse average `1.205ms`, p95 `1.759ms`; initial structuredClone/stringify-check average `1.562ms`, p95 `2.109ms`.
- Final cheap-guard comparison: old stringify/parse average `1.114ms`, p95 `1.454ms`; new structuredClone/cheap-guard average `1.261ms`, p95 `2.054ms`.
- Deviation rationale: JSON parse/full JSON round-trip was removed as requested; the synthetic microbench was slightly slower but avoids lossy JSON serialization and reduces dirty-flush churn.

Deviations / skipped:
- None beyond the measured performance tradeoff above.

## WP3 - safeFetch and Untrusted-wrap Hardening

Implemented:
- Added LRU cap for pinned dispatchers.
- Tightened default port policy to empty/80/443, with `SAFE_FETCH_EXTRA_PORTS` for explicit additions.
- Completed reserved IPv4/IPv6 checks, including NAT64/6to4 coverage.
- Redirect handling now strips credential headers cross-origin and rewrites unsafe 301/302/303 redirects to GET with body dropped.
- Upgraded dual-tool untrusted result wrapping to spotlight-strength in both bots.
- Added Eris `adminAuxRoutes` `HOME_DIR` fallback using `os.homedir()`.
- Updated `SECURITY.md` SSRF posture notes.

Files:
- `packages/shared/src/safeFetch.js`, `packages/shared/tests/safeFetch.test.ts`, `packages/shared/tests/safeFetchDispatcher.test.ts`
- `packages/eris/ai/dual.js`, `packages/eris/api/adminAuxRoutes.js`, `packages/eris/events/messageCreate/contextBuild.js`, related Eris tests
- `packages/irene/ai/dual.js`, `packages/irene/events/messageCreate/contextBuild.js`, related Irene tests
- `SECURITY.md`

Gate:
- Full section 9 gate passed after WP3.

Measurements / scans:
- Local URL scan recorded documented local ports: Ollama `127.0.0.1:11434`, LM Studio/Ollama `localhost:1234/11434`, Eris/Irene dev `3000/3001`, Supabase `54321`, local tunnel `3001`.
- Code review found local Ollama embedding uses raw local `fetch`; localVision uses `safeFetch` for Discord attachment URLs and posts to configured Ollama through `fetchImpl`. Those service URLs remain outside safeFetch port policy.

Deviations / skipped:
- `spotlight()` defangs fake close tags with a zero-width space; tests assert this behavior.
- Commit includes same-file staged context in `SECURITY.md` and context-build tests that existed before this WP because those files overlapped the required WP3 edits.

## WP4 - CI/build Hardening and ESLint Baseline

Implemented:
- Hardened GitHub workflow permissions and pinned checkout/setup-node actions to full SHAs.
- Set Render `NODE_VERSION` to `22.12.0` for both services.
- Added root ESLint flat config and lint script.
- Fixed the known Eris DB silent-swallow logging cluster and gambling empty catches covered by the lint scope.
- Added a regression test for marriage logging.

Files:
- `.github/workflows/test.yml`, `render.yaml`, `eslint.config.js`, `package.json`, `package-lock.json`
- `packages/eris/ai/gambling.js`, `packages/eris/database/activities.js`, `crafting.js`, `economy.js`, `inventory.js`, `social.js`, `userContent.js`
- `packages/eris/tests/db/marriageLogging.test.ts`
- `packages/irene/tests/ai/executors/audioExecutor.test.ts`

Gate:
- `npm run lint`: passed.
- `npm run lint:version-sync`: passed.
- `npm test --workspaces --if-present`: Eris `170 files / 1600 tests`, Irene `196 files / 1797 tests`, shared `30 files / 436 tests`.
- `npm run build --workspaces --if-present`: passed.

Measurements:
- Initial global `no-empty` scan found 177 pre-existing empty-block violations; the final guardrail was scoped to the WP4 target files.

Deviations / skipped:
- `no-empty` was scoped rather than enforced globally to avoid turning WP4 into a repo-wide cleanup.
- Irene audio executor test mock was adjusted for Vitest 4 constructible `GoogleGenAI`; assertions were not weakened.

## WP5 - Schema Diet and Naming Convergence

Implemented:
- Renamed Irene canonical tools to converged names while preserving old names as aliases: `set_reminder`, `cancel_reminder`, `forget_fact`, `forget_all`, `scrape_url`, `list_trusted`.
- Removed dead self-aliases: Eris `track_game`/`untrack_game`; Irene `snipe`/`editsnipe`/`set_birthday`.
- Added dual-shape adapters for compact schemas, including `purge_messages` before confirm-defer so pending-confirm payload compatibility remains intact.
- Tightened Eris prompt byte ceiling from `26000` to `18000`.
- Updated live harness name checking.

Files:
- `ARCHITECTURE.md`, `scripts/testAllToolsLive.js`
- `packages/eris/ai/executor.js`, `packages/eris/ai/executors/twinExecutor.js`, `packages/eris/ai/tools/owner/whitelistPersona.js`, Eris schema/alias tests
- `packages/irene/ai/dual.js`, `executor.js`, executor modules for advanced/channel/customCommand/memory/message/moderation/role/setup/toggle, `newtools.js`, `toolAliases.js`, `toolCoaching.js`, `toolRegistry.js`, admin/everyone tool declarations, context build, and related tests

Gate:
- Full section 9 gate passed after WP5.
- `npm run measure:prompt`: passed.
- Live harness name check ran locally: 326 expected tool names, missing `[]`.

Measurements:
- Post-WP5 prompt footprint: Eris owner casual/admin `16278`; Irene admin casual `10664`; Irene admin moderation `16264`.

Deviations / skipped:
- Live tool execution harness was not run against real providers because no real `OPENROUTER_API_KEY`/live bot token was available; local name validation was run instead.
- Commit includes same-file pre-existing staged hunks in `ARCHITECTURE.md`, `packages/irene/ai/executors/channelExecutor.js`, `moderationExecutor.js`, and `roleExecutor.js` because they overlapped required WP5 edits.

## WP6 - Shared Dedup Migration

Implemented:
- Extracted shared factories/modules for `bumpReminder`, `bumpCelebrations`, `bumpAnalytics`, `bumpCorrelation`, `opinions`, `aiBudget`, `preoccupations`, `humanity`, `longmemory`, and `openaiCompat`.
- Added extensionless `@defnotean/shared` exports for the extracted modules.
- Replaced Eris/Irene copies with bot-local shims; measured shim sizes are 10-46 lines, all under the 60-line target.
- Added shared and bot-specific tests for exports, behavior, long memory, humanity, preoccupations, and OpenAI compatibility.
- Ported the Eris-style NVIDIA circuit breaker into Irene, the allowed small WP6.3 item.

Files:
- Shared source: `packages/shared/src/ai/bumpReminder.js`, `bumpCelebrations.js`, `bumpAnalytics.js`, `bumpCorrelation.js`, `opinions.js`, `preoccupations.js`, `humanity.js`, `longmemory.js`, `openaiCompat.js`, `packages/shared/src/utils/aiBudget.js`, `packages/shared/package.json`
- Bot shims: matching Eris/Irene files under `packages/*/ai`, `packages/*/utils/aiBudget.js`, and provider shims
- Tests: `packages/shared/tests/ai/dedupExports.test.ts`, `preoccupations.test.ts`, `humanity.test.ts`, `humanityExports.test.ts`, `longmemory.test.ts`, `openaiCompat.test.ts`; Eris/Irene `humanityExports.test.ts`, `longmemory.test.ts`; updated Irene `nvidiaFallback.test.ts`

Gate:
- Full section 9 gate passed after WP6:
  - `npm run lint:version-sync`: passed.
  - `npm test --workspaces --if-present`: Eris `174 files / 1612 tests`, Irene `200 files / 1815 tests`, shared `36 files / 453 tests`.
  - `npm run build --workspaces --if-present`: passed.
- Supplemental `npm run measure:prompt` and `npx eslint .`: passed.

Measurements:
- Post-WP6 prompt footprint: Eris owner casual/admin `16278`; Irene admin casual `10664`; Irene admin moderation `16264`.
- Dedup measurement, pair-scoped across extracted modules: tier-1-only `common=98`, `max=110`; final extracted-pair pass `common=182`, `max=239`.

Deviations / skipped:
- Several shared factories use justified `// @ts-nocheck` because they bind untyped bot-local dependencies, following the existing shared factory precedent.
- Some extracted modules expose test hooks through public exports or factory instances rather than top-level `_internal`.
- Because the user explicitly requested parallel agents, WP7 sidecar work started before WP6 commit/gate. The WP6 gate was still run and passed with the concurrent WP7 work present in the worktree.

## WP7 - Orchestrator Decomposition

Implemented:
- Decomposed Irene `events/messageCreate.js` into a sequencer plus modules for context build, passive features, ack/status lifecycle, and AI turn body.
- Added an Irene orchestration-order smoke test.
- Extracted Eris blackjack action resolution into a pure `blackjackEngine.js`.
- Updated both the button path and AI gambling executor path to call the engine while preserving their original locking and balance APIs.
- Added direct blackjack engine unit tests for hit, stand, double, bust, push, and dealer-draw behavior.

Files:
- `packages/irene/events/messageCreate.js`, `packages/irene/events/messageCreate/contextBuild.js`, `ackStatus.js`, `aiTurn.js`, `passiveFeatures.js`
- `packages/irene/tests/events/messageCreate/orchestrationOrder.test.ts`
- `packages/eris/ai/blackjackEngine.js`, `packages/eris/ai/executors/gamblingExecutor.js`, `packages/eris/events/interactionCreate.js`, `packages/eris/tests/ai/blackjackEngine.test.ts`

Gate:
- Full section 9 gate passed after WP7:
  - `npm run lint:version-sync`: passed.
  - `npm test --workspaces --if-present`: Eris `174 files / 1612 tests`, Irene `200 files / 1815 tests`, shared `36 files / 453 tests`.
  - `npm run build --workspaces --if-present`: passed.
- Supplemental `npm run measure:prompt`: passed with the same WP6/WP7 footprint numbers.
- Supplemental `npx eslint .`: passed.

Measurements:
- Irene `execute()` spans lines 87-262, 176 physical lines, meeting the `<=200` target. Full `messageCreate.js` is 262-263 physical lines depending on split-line counting.
- `rg "dealerHand\\) < 17" packages/eris` returns exactly one hit: `packages/eris/ai/blackjackEngine.js`.
- `blackjackEngine.js` is 124 split lines.
- Trap check: Eris button path still uses `db.withUserLock` with `tryDeductBalanceUnsafe`/`updateBalanceUnsafe`; AI executor path still uses its safe balance variants.

Deviations / skipped:
- `packages/eris/events/interactionCreate/games/` and a broader customId-prefix dispatch map were not created. The blackjack payout/math dedup acceptance was satisfied, but the broader game-module split was deferred.
- The blackjack engine is pure and does not inject balance operations. Callers preserve their original lock and balance behavior, which keeps the unsafe/safe distinction explicit, but differs from the plan wording about injected balance ops.
- `packages/irene/events/messageCreate.js` had pre-existing same-file staged context before WP7; the WP7 commit used explicit path commits and records the overlap here.

## Final Notes

- No files under `packages/*/prompts/` were edited by the WP commits.
- Security tests and assertions were not weakened to make tests pass.
- WP8 was deliberately skipped because its contingency trigger was not in scope.
- The worktree still contains pre-existing staged audit/background changes outside WP1-WP7. They were not reverted or included in the WP commits.
