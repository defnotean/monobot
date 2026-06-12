# Monobot Implementation Plan — Engineering Hand-off

**Audience:** an AI coding agent (or human) with NO prior context on this repo. Everything you need is in this file plus the repo itself. Read sections 0–2 fully before writing any code. Every file path, symbol name, and line number below was verified against the current tree on 2026-06-11; line numbers will drift as you work — the symbol names and file paths are the durable anchors.

**Origin:** this plan is the remaining roadmap from a full security/quality audit (see `IMPROVEMENTS.md`) after the first batch (P0–P2 security fixes + local-model Phases 1–2) was already implemented. Do not redo that batch — section 0.2 lists what already exists so you can build on it.

---

## 0. Read this first

### 0.1 What this repo is

Node ≥22 ESM monorepo (npm workspaces), no transpile step — JS ships raw, type-checked via `tsc --noEmit` with `checkJs + strict`:

- `packages/eris` — Discord chat/economy/gambling bot (~75k LOC). Has an Electron side-app in `packages/eris/agent-ui/`.
- `packages/irene` — Discord moderation/music/server-config bot (~95k LOC). Hosts the HTTP presence/dashboard/twin API.
- `packages/shared` — cross-bot utilities consumed via subpath exports (`@defnotean/shared/<name>`), source consumed raw (no build).

Both bots run an LLM pipeline: gating → context build → provider call (Gemini / NVIDIA / OpenAI-compat incl. Ollama & LM Studio) → tool dispatch (`ai/executor.js` → sub-executors) → render → persist. The two bots coordinate over an HMAC-signed twin protocol. Persistence is Supabase behind in-memory caches with debounced flushes.

### 0.2 What was ALREADY done (do not redo, do not regress)

- Owner-ID fallback removed; owner identity is env-only and fail-closed (`config.js` both bots).
- RLS migration exists: `packages/eris/migrations/014_enable_rls_all_tables.sql` + CI guard test `packages/eris/tests/migrations/rlsLockdown.test.ts` (a source-scan that fails if a `.from("table")` appears that the migration doesn't cover — **if you add a new Supabase table, you must extend the migration or this test fails**).
- Prompt-injection spotlighting on channel context / memory facts / directives; `wrapUntrustedToolResult` + `UNTRUSTED_RESULT_TOOLS` in both `ai/dual.js`.
- Two-tier tool selection is LIVE on both bots with `TOOLS_TIER1_MAX` cap (default 32) + `TOOLS_SHADOW_LOG` telemetry in both `ai/toolRegistry.js`.
- OpenAI-compat lane: `stripReasoning` (shared), `OPENAI_COMPAT_EXTRA_BODY` passthrough, tool-coaching modules (`ai/toolCoaching.js` per bot), outer turn deadline on Eris, ack gating on Irene, `maxIterations`/`toolCoaching`/`extraBody` knobs in `config.openaiCompat`.
- Electron agent-ui hardening, twin-relay `aiInitiated`, dedicated twin rate-limit buckets, music DJ guard (`packages/irene/utils/musicGuard.js`), voice STT firewall/throttle/consent, alert redaction, destructive-tool confirm + rate caps.
- Test baseline: **3,771 tests across 390 files, all green**; 3× `tsc --noEmit` green; `lint:version-sync` green.

### 0.3 Hard rules (violating any of these fails review)

1. **Never weaken a security test or assertion to make something pass.** If a security test fails, your change is wrong.
2. **Default hosted/Gemini behavior must stay byte-identical** unless a work package explicitly says otherwise. New behavior is env-gated or local-provider-gated.
3. **Do not edit the personality voice files** (`packages/*/prompts/*.md`). The owner cares deeply about the bots' personalities. Mechanical interpolation code may be touched only where a WP says so.
4. **Every change ships with tests.** Follow the existing patterns in `packages/*/tests/` (vitest, heavy use of mock req/res and `_internal` test exports).
5. **All three typechecks must stay green** (`npm run build --workspaces --if-present`). New JS must satisfy `checkJs + strict` — use JSDoc types where inference fails; `// @ts-nocheck` only with a justification comment (existing precedent: `packages/shared/src/ai/selfCanon.js:1`).
6. **`npm run lint:version-sync` must stay green.** It fails if any external dep shared by ≥2 workspaces has differing version ranges. `@defnotean/*` workspace deps are exempt.
7. Commit per work package (or per numbered step for the big ones), imperative one-line subject, no AI attribution / co-author trailers.
8. One workflow runs CI: `.github/workflows/test.yml` — `npm ci` → `lint:version-sync` → `npm audit --audit-level=moderate` → `npm test --workspaces` → `npm run build --workspaces`. Keep all five green.

### 0.4 Commands

```bash
npm ci                                        # install (workspace symlinks matter)
npm test --workspaces --if-present            # full suite (~390 files)
npx vitest run tests/ai/toolRegistry.test.ts  # single file, run from the owning package dir
npm run build --workspaces --if-present       # tsc --noEmit x3 (the typecheck)
npm run lint:version-sync
npm run measure:prompt                        # tool-surface footprint (see WP1.8)
```

Gotchas: `packages/shared/src/ai/firewall.js` contains a NUL byte (~35KB in) — ripgrep treats it as binary; use `grep -a` or read it directly. Tool modules import `config.js` which fail-fasts on missing `DISCORD_TOKEN` — stub env (`DISCORD_TOKEN=x CLIENT_ID=1 GEMINI_API_KEY=x`) when importing them in scripts.

---

## 1. Work-package overview and order

| # | Package | Size | Depends on |
|---|---------|------|-----------|
| WP1 | Tool-calling Phase 3 (local-lane quality) | M (2–3 d) | — |
| WP2 | Persistence durability + cache correctness | S (1 d) | — |
| WP3 | safeFetch + untrusted-wrap hardening | S (1 d) | — |
| WP4 | CI/build hardening + ESLint baseline | S (1 d) | — |
| WP5 | Schema diet + naming convergence (Phase 4) | M (2–3 d) | WP1 |
| WP6 | Shared dedup migration (tier 1 then tier 2) | L (3–5 d) | WP1 (for openaiCompat pair) |
| WP7 | Orchestrator decomposition | M (2–3 d) | best after WP6 tier 1 |
| WP8 | CONTINGENCY: `TOOL_STRATEGY=json` envelope | M | only if trigger met (see WP8) |

Recommended order: **WP1 → WP2/WP3/WP4 (parallelizable) → WP5 → WP6 → WP7**. WP8 only on its trigger condition. Run the full gate (section 9) after every WP.

---

## WP1 — Tool-calling Phase 3: make the local lane work *well*

**Goal:** a 14B local model (Qwen3-14B class via Ollama/LM Studio) reliably picks and calls tools. The selection/caps/coaching plumbing exists; this WP closes the remaining quality gaps.

### WP1.1 Wire `trackUsage` at the dispatch boundary (both bots)

**Current state (verified):** `registry.trackUsage(channelKey, toolName)` exists in both `ai/toolRegistry.js` (eris lines ~274–290, irene ~169–187; move-to-front, max 10/channel, prunes at 1000 channels). It has exactly ONE production call site in the entire repo: `packages/irene/ai/dual.js:650` (Gemini lane only). **Eris never calls it** — its recent-usage scoring band (891–900) is dead code at runtime. Neither bot's `openaiCompat.js` or `nvidia.js` lane tracks usage.

**Trap:** the channel-key shapes differ. Irene's tracking call uses `` `${guild.id}-${userId}` `` / `` `dm-${userId}` `` (dual.js:649) but Eris's *selection* passes keys shaped `dm:${userId}` / `ch:${channelId}` (from `events/messageCreate/gates.js:396` → `contextBuild.js:456`). If you wire tracking with a different shape than selection uses, the usage data lands under keys selection never reads.

**Change:**
1. Add a tiny exported helper per bot — `channelKeyFor(message)` — in each `ai/toolRegistry.js` (or a more natural home you find), returning the **same shape selection already uses on that bot**. Refactor the existing selection call sites and Irene's dual.js:650 tracking call to use it.
2. Call `registry.trackUsage(channelKeyFor(message), canonicalToolName)` at the **dispatch boundary** in both `ai/executor.js` `executeTool` — after alias resolution, after the call succeeds (don't track failures or unknown tools). This covers every provider lane at once. Remove the now-redundant direct call in irene dual.js:650 (or keep it and dedupe — executor-level is the single source of truth; pick one, don't double-track).
3. Skip tracking for economy-mutating tools on Eris (the selection already skips them when *reading* usage — `ECONOMY_MUTATING_TOOLS`, eris toolRegistry.js:38–62 — mirror that on write for consistency).

**Tests:** executor-level test per bot: dispatch a known tool with a mock message → assert `registry._recentUsage` (or via a `_internal` accessor you add) contains it under `channelKeyFor(message)`; dispatch an unknown tool → not tracked. Update `packages/irene/tests/ai/dual.test.ts` if it mocked the old call site.

### WP1.2 Demotion-aware cap floor on Eris (fixes the documented KNOWN LIMITATION)

**Current state:** `packages/eris/ai/toolRegistry.js` lines ~193–202 documents it: Eris has exactly 29 always-include cores and `selectByMessage` floors the cap at `Math.max(MAX_TIER1_TOOLS, alwaysAccessible.length)` — so `TOOLS_TIER1_MAX=16` has **no effect** on Eris. The relief valve (per-turn intent demotion of 21 of the 29 cores) currently runs **downstream** in `packages/eris/events/messageCreate/toolProfiles.js` (`compactTier1ForTurn`), after selection, so demoted cores still consume cap slots.

**Change:** compute demotions **before/within selection**. Concretely: extract the intent-demotion decision from `toolProfiles.js` (the regex table at lines ~22–49 and whatever `compactTier1ForTurn` uses) into a function that returns the demoted-core name set for a message; pass it into `selectByMessage` as `demotedCores` (new option). Inside selection: demoted cores score in a low band (e.g. 600 — below keyword matches, still above nothing) instead of 1000, and the floor becomes `Math.max(MAX_TIER1_TOOLS, alwaysAccessible.length - demoted.length)` — i.e., the floor is the *non-demotable* core count. Demoted cores that fall out of tier-1 MUST land in the tier-2 name catalog (verify they flow into the names list the caller builds — eris `contextBuild.js:527` builds `tier2ToolNames` including demoted cores already; keep that contract). Keep `toolProfiles.compactTier1ForTurn` working during the transition or remove it once selection subsumes it — no double-demotion.

**Tests:** with `TOOLS_TIER1_MAX=16` and a casual message, Eris tier-1 ≤16 with the non-demotable core present; with a gambling-intent message, gambling tools beat demoted cores; every demoted core appears in tier-2 names. Update the KNOWN LIMITATION comment (remove it).

### WP1.3 Strong/weak keyword split in the Eris scorer + fix over-broad category regexes

**Current state:** eris categories score `700 + min(hits,50)` per keyword regex hit (toolRegistry.js:154). The `games` category regex matches generic verbs (`play|start|game|deal|cards?` — find it in the `registerOpenClawTools` category table, lines ~316–449), which is why a kitchen-sink message used to pull 75 schemas.

**Change:** per category, split patterns into `strong` (unambiguous phrases: "blackjack", "slot machine", "bet \d+") and `weak` (generic verbs: "play", "start"). Strong match → ~850 band; weak match → ~700 band; tie-break by leftmost match position in the message (earlier = higher within band). Rework the `games`/`economy` regexes specifically — every generic verb goes to `weak`. Irene's scorer (flat 700, toolRegistry.js:67) gets the same mechanism but is lower priority — do Eris first, port if clean.

**Tests:** "lets play blackjack, bet 500" → blackjack/bet tools in tier-1 at strong band; "let's play it by ear, when do we start" (weak-only) → games tools do NOT displace cores; extend the existing kitchen-sink cap test.

### WP1.4 Schema-echo on `use_tool` miss + `{"help":true}` short-circuit

**Current state (verified, all 6 router copies):** the tier-2 router `use_tool` is duplicated in `eris/ai/dual.js` (131–171), `irene/ai/dual.js` (232–268), both `ai/providers/openaiCompat.js` (eris 94–126, irene 86–118), both `ai/providers/nvidia.js`. Behavior on a name not in this turn's catalog: returns the literal string `` Error: "${toolName}" is not available in this turn's catalog `` — identical in all 6. **Note:** the allowlist is tier-2-only, so calling a *tier-1* tool via `use_tool` also errors with that string.

**Change:**
1. Create ONE shared helper `packages/shared/src/ai/toolRouter.js` exporting the router declaration builder, `routeCatalogTool`, and a new `compactSignature(toolDecl)` → one-line string `name(arg:type, arg?:type) — first sentence of description` (≤200 chars). Add the subpath export `"./toolRouter"` to `packages/shared/package.json` (extensionless key — that's the convention; some legacy keys have `.js` duplicates, don't imitate that). Replace the 6 copies with imports. This is a pure consolidation — keep behavior bit-identical except the items below.
2. **Echo on miss:** when `use_tool` names a tool not in the catalog, resolve through that bot's `TOOL_ALIASES` first; if it resolves to a **registered** tool, return `` `"${name}" wasn't offered this turn. Signature: ${compactSignature(decl)} — call it directly as a tool (not via use_tool) if it has a schema this turn, otherwise retry use_tool with exactly this name.` `` If it's a tier-1 tool this turn, alternatively just execute it (it had a schema; the model finding it via use_tool is harmless) — prefer execution over echo for tier-1, echo for everything else unknown.
3. **`help` arg:** if `use_tool` args contain `help: true` (or `args.help === true`), return the compact signature WITHOUT executing. One `if` in `routeCatalogTool`.
4. The router needs the full declaration objects to build signatures, not just names — extend the call sites to pass a name→declaration lookup (both registries hold the full arrays; expose a `getDeclaration(name)` on the registry).

**Tests:** new `packages/shared/tests/toolRouter.test.ts` (signature builder corpus: required vs optional args, enum params, long descriptions truncated); per-bot dual.js/openaiCompat tests: miss → echo string contains signature; help:true → signature without execution; tier-1 name via use_tool → executes. Existing tests pin the old error string — update them deliberately.

### WP1.5 Rescue parser accepts router/tier-2 names

**Current state:** both `openaiCompat.js` have a hallucinated-call rescue (model emits JSON in content instead of a tool_call: eris lines ~541–576, irene ~537–572). It only promotes the JSON to a real call if the name matches a **tier-1 schema sent this turn** — a rescued call naming a tier-2 catalog tool is dropped.

**Change:** also accept names present in this turn's `routerToolNames` (wrap as a `use_tool` invocation so it flows through the same allowlist/echo path), and run alias resolution before matching. Keep the existing guard that the JSON must parse and have a name field.

**Tests:** extend the existing rescue tests (find them near the openaiCompat tests): content-JSON naming a tier-2 tool → executes via router; naming garbage → still dropped.

### WP1.6 Wire-time schema compactor (`OPENAI_COMPAT_COMPACT_SCHEMAS`)

**Change:** in both `openaiCompat.js`, at the existing schema-translation function (the Anthropic→OpenAI sanitizer, eris lines ~62–90 area), add an opt-in pass gated on `config.openaiCompat.compactSchemas` (add the knob to both `config.js`: env `OPENAI_COMPAT_COMPACT_SCHEMAS`, default **true when local provider, false otherwise** — same pattern as `toolCoaching`): truncate each tool description to its first sentence (or 160 chars, whichever is shorter, never mid-word); truncate each param description to 80 chars; drop param descriptions entirely for params whose name+type is self-explanatory is NOT safe to automate — just truncate. Never touch names, types, enums, or `required`. This is wire-time only — source schemas unchanged.

**Tests:** snapshot a handful of known-fat tools (irene `setup_ticket` description is exactly 1,257 chars at `adminTools.js:1538`) compacted vs not; assert hosted default = no change (byte-identical body); measure the reduction and note it in the PR description.

### WP1.7 Port Irene's `unknownTools` module to Eris (telemetry parity)

**Current state:** irene has `packages/irene/ai/unknownTools.js` (TTL 1h, cap 512 keys, exported for tests). Eris has an **unbounded module-private Map** inline in `ai/executor.js:268` with two increment sites (lines ~349 pre-dispatch, ~510 post-fallback).

**Change:** move irene's module to `packages/shared/src/ai/unknownTools.js` (factory or plain module — it has no bot deps; plain module + per-bot instance via `createUnknownToolTracker()` factory is cleanest), export from shared, consume in BOTH executors (eris keeps its two increment sites, now bounded). Keep irene's existing test file passing (update imports).

### WP1.8 `measure:prompt` on clean checkout + CI byte ceilings

**Current state:** `scripts/measure-prompt-footprint.mjs` dies on a clean checkout because importing tool modules pulls `config.js`'s fail-fast (`DISCORD_TOKEN` required).

**Change:** stub required env at the top of the script (`process.env.DISCORD_TOKEN ||= "measure"`, `CLIENT_ID ||= "0"`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `GEMINI_API_KEY ||= "x"`). Then add a small test (or CI step) that runs it and asserts worst-case tier-1 tool bytes ≤ **26,000** for Eris and ≤ **26,000** for Irene (current worst measured: eris ~24.5KB capped, irene ~24.4KB — the ceiling catches future schema bloat). Put the assertion where it runs in CI naturally (a vitest file under `packages/eris/tests/` that shells the script, or a workflow step).

**WP1 acceptance:** all of 1.1–1.8 individually tested; full gate green; `npm run measure:prompt` runs clean and shows tier-1 worst-case under ceilings; with `TOOLS_TIER1_MAX=16` Eris actually selects ≤16 (1.2 proven by test).

---

## WP2 — Persistence durability + cache correctness

Four independent, small, high-value fixes. File anchors verified current.

### WP2.1 Eris flush: reschedule on failure

`packages/eris/database/core.js`: `save(bucket)` (162–166) arms a 200ms timer only if none exists; `_flushSave` (208–252) on bucket failure does `_dirty.add(bucket)` (233) and **never reschedules** — a failed bucket waits for an unrelated future `save()`. Add a retry timer on the failure path: `setTimeout(_flushSave, 30_000)` (mirror irene's pattern at irene `database/core.js:551`), with backoff after repeated failures, and DO NOT disturb the `_consecutiveFlushFailures` / `_assertPersistenceHealthy` machinery (187–206) that gates economy writes. Test: simulate upsert failure → assert timer armed (vi.useFakeTimers) → next tick retries.

### WP2.2 Irene flush: stop round-tripping the whole cache

`packages/irene/database/core.js` 449–456: `JSON.parse(JSON.stringify(data))` of the ENTIRE cache on every 2s-debounced flush, on the main thread, under the message handler. The blob upsert (line 479, `bot_data` id "irene") is deliberately whole-blob (cold-boot system of record — comment at 432–437) — **keep the blob write whole**, but kill the round-trip cost: replace the stringify/parse sanitizer with `structuredClone(data)` IF the only purpose is de-referencing (check: the current code also uses `json.length` as a size sanity check at 450–455 — preserve an equivalent guard, e.g. clone first, stringify only the final payload once for the size check, or use a cheap recursive size estimate). Better still: serialize once — `const json = JSON.stringify(data)` is unavoidable for the upsert anyway via supabase-js? No: supabase-js serializes internally. So: `structuredClone` for the snapshot + drop the manual parse; keep ONE stringify only if the size guard demands it (then reuse that string's length — never parse it back). Measure before/after with `perf_hooks` in a quick script on a synthetic 50-guild cache and put the numbers in the PR. Do not touch the dirty-slice/`_dualWriteFanout` logic (363–413) — it already scopes per-entity writes to dirty guilds.

### WP2.3 Eris executor cache invalidation gaps

`packages/eris/ai/executor.js`: add `buy_lottery_ticket`, `start_poker`, `join_poker`, `daily_challenge_complete` to `CACHE_INVALIDATING_EXTRAS` (lines 286–300). For `divorce`: the tool schema has no params (partner resolved internally from the marriage record in `packages/eris/ai/socialExecutor.js` case "divorce", lines ~482–497), so the `TWO_USER_TOOLS` input-id sniffing (393–398) can't find the partner — invalidate the ex-partner's cache **inside the socialExecutor divorce case** after the alimony credit, by exporting `invalidateUserCache` from executor.js (it exists as `invalidateUserCache`/`deleteGroup` internals around 329–332) and calling it with the resolved partner id. Tests: each newly-listed tool clears the caller's cached `check_balance`; divorce clears the partner's `partner_status`.

### WP2.4 Twin-punish confiscation: make it atomic

`packages/eris/api/dashboard.js` `/api/twin/punish` handler (520–585): `getBalance` at 560 → `updateBalance(-confiscated)` at 565 is read-then-write with no lock (comment at 564 admits it). Replace with an atomic confiscate-to-zero: preferred — a `withUserLock`/`withEconLock` wrapper (see `packages/eris/database/economy.js:76–85`) doing read+clamp+debit inside the lock; or a dedicated RPC if one exists that can clamp (check `eris_add_balance`'s never-negative semantics in migrations 002/009 — if `updateBalance` already clamps at zero server-side, the residual risk is over/under-confiscation of concurrent earnings, which the lock fixes cleanly). Keep the response shape (`confiscated` amount) identical. NOTE on the nonce: `packages/irene/utils/twinPunish.js:36` generates a nonce that the server never reads — replay is actually handled one layer down by `verifyTwinRequest`'s in-memory signature cache (`packages/shared/src/twinSign.js`, ~60s window, documented restart gap). Leave the nonce alone in this WP; don't build a persistent nonce store unless asked.

**WP2 acceptance:** four fixes, each with a test; full gate green.

---

## WP3 — safeFetch + untrusted-wrap hardening

All in `packages/shared/src/safeFetch.js` (39 existing tests in `packages/shared/tests/safeFetch.test.ts` + `safeFetchDispatcher.test.ts` — extend, never weaken) and the two `ai/dual.js`.

### WP3.1 Dispatcher cache eviction

`PINNED_DISPATCHERS` (line 102) is an unbounded Map of undici `Agent`s keyed `${family}:${ip}`, never closed. Convert to a small LRU (cap 64): on eviction call `agent.close()` (fire-and-forget with `.catch(()=>{})` — closing is best-effort). The repo has an LRU in shared (`packages/shared/src/LRUCache.js`) — reuse it if its eviction hook allows close-on-evict; otherwise a 15-line inline LRU is fine. Test: 65 distinct IPs → first agent evicted and closed (spy on close).

### WP3.2 Port policy

`validateUrl` (161–185) never inspects `parsed.port`. Add: allow only 80, 443, and empty (scheme default); any other port → reject UNLESS listed in env `SAFE_FETCH_EXTRA_PORTS` (comma-separated, parsed once at module init). Check the repo for current non-standard-port usage before landing (SearXNG instances and local services are configured by URL env — grep `.env.example` for port-bearing URLs; localVision/Ollama does NOT go through safeFetch, verify and note). Test: `:6379` rejected; `:8080` allowed when env lists it.

### WP3.3 Reserved-range completeness

Extend `isPrivateIPv4` (108–120): add 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved incl. broadcast), 192.0.0.0/24, 198.18.0.0/15, and the TEST-NETs (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). Extend `isPrivateIPv6` (125–145): NAT64 `64:ff9b::/96` (extract and re-check the embedded IPv4!), 6to4 `2002::/16` (extract embedded v4 from bits 16–48 and re-check), Teredo `2001::/32`, documentation `2001:db8::/32`, multicast `ff00::/8`, and fix the link-local regex `/^fe[89ab]/` to also cover deprecated site-local `fec0::/10` (i.e. `fe[89abcdef]` — fec0–feff). Table-driven tests for every new range, plus an embedded-v4 case (`64:ff9b::7f00:1` → rejected as loopback).

### WP3.4 Redirect header/method policy

Redirect loop (272–296) replays the caller's `headers`, `method`, and `body` verbatim on every hop including cross-origin. Change: on a **cross-origin** hop (different host than the previous hop), strip `authorization`, `cookie`, `proxy-authorization`, and any header matching `/^x-api-key$/i` from the replayed headers; on 303 (and 301/302 for non-GET/HEAD, matching fetch spec behavior) switch method to GET and drop the body. Same-origin hops keep headers. Tests: cross-origin 302 → auth header absent on hop 2; same-origin → present; 303 POST → GET.

### WP3.5 Upgrade `wrapUntrustedToolResult` to spotlight-strength

Both `ai/dual.js` wrap untrusted tool results with `wrapUntrusted` (plain header/footer concat from safeFetch.js:343–349) — attacker text containing the literal footer line fake-closes the envelope, and invisible chars pass through. `spotlight()` (`packages/shared/src/ai/firewall.js:743–755`) already does it right: strips zero-width/control chars and defangs envelope-escape attempts. Change `wrapUntrustedToolResult` in BOTH dual.js to use `spotlight(result, toolName)` (import via the per-bot firewall wrapper, `packages/irene/ai/firewall.js:21` / eris equivalent — NOT directly from shared, match existing import style). **The dual.js tests pin the wrapUntrusted envelope shape — update those assertions deliberately** (`packages/eris/tests/ai/dual.test.ts`, `packages/irene/tests/ai/dual.test.ts`). Also fix the channel-context speaker-name gap in `packages/eris/events/messageCreate/contextBuild.js`: the per-line speaker `who` (399–402) gets no bracket/newline strip or length cap (unlike the current speaker's name at 132–136 — reuse that sanitization), and the raw `${displayName}` interpolations in the block header at ~424 and the `[${displayName} said]` label at ~439 should use the sanitized name. Check irene's contextBuild for the mirror-image and fix it the same way if present (~947–960 area).

### WP3.6 `adminAuxRoutes` HOME_DIR fallback

`packages/eris/api/adminAuxRoutes.js:7`: `` process.env.HOME || `/home/${process.env.USER || "defnotean"}` `` — replace with `os.homedir()` fallback (import `node:os`), removing the author-name literal. Verify the log-path tests (if any) still pass.

**WP3 acceptance:** all safeFetch tests (existing + new) green; the SSRF posture notes in SECURITY.md updated if they enumerate ranges.

---

## WP4 — CI/build hardening + ESLint baseline

### WP4.1 Workflow hardening

`.github/workflows/test.yml`: add a top-level `permissions: { contents: read }`; pin `actions/checkout@v6` and `actions/setup-node@v6` to full commit SHAs (look up the current SHA for those tags; keep a `# vX` comment). Add `NODE_VERSION: "22.12.0"` (or current 22 LTS) to both services' `envVars` in `render.yaml` (Render reads it for Node builds) so prod stops floating.

### WP4.2 ESLint flat config

No eslint exists anywhere (verified). Add root `eslint.config.js` (flat, ESM — root package.json is `"type":"module"`), devDep `eslint` at root only. Rules — start MINIMAL and high-signal:
- `no-empty: ["error", { allowEmptyCatch: false }]` — **note this only catches truly-empty `catch {}`** (the `packages/eris/ai/gambling.js` sites at 326–332/402–408 and the two loader IIFEs at 346/422). It does NOT flag `catch { return null; }`.
- For the return-null swallows, add `no-restricted-syntax` with a selector for `CatchClause[param=null]` … that's too broad (the repo has many *intentional* bare catches, e.g. `twinSign.js:199`, `safeFetch.js:321`). Instead: scope a stricter override to the persistence dirs only — `packages/*/database/**`: selector `CatchClause > BlockStatement > ReturnStatement` (catch whose first statement is a bare return) → error with message "log before swallowing a persistence error".
- `no-undef` off (tsc covers it), formatting rules none (don't fight the existing style).
- Wire `"lint": "eslint ."` at root, add to CI after version-sync. Expect to fix or annotate every violation it finds — the POINT is the gambling.js + database swallows: fix them properly (log with each file's existing `log` helper, rate-limited if in a hot path) rather than disabling.

### WP4.3 Fix the known silent-swallow cluster (regardless of lint mechanics)

- `packages/eris/database/activities.js` — seven `catch { return null; }` at 138, 165, 204, 272, 340, 442, 567 (createBossBattle, spawnBoss, damageBoss, createPet, createHeist, createAuction, createRoastBattle): add `log(\`[DB] <op> failed: ${e.message}\`)` before returning null (the sibling helpers at lines 27/40/55/… show the exact house style).
- `packages/eris/database/economy.js` — `createMarriage` (785) and `deleteMarriage` (802): same treatment. (Their partner-cache invalidation is already correct — don't touch it.)
- `packages/eris/ai/gambling.js` — `_saveSlotsConfig` (331), `_saveGameConfig` (407), and the two loader IIFEs (346, 422): log on failure.

**Tests:** lint passes in CI; a unit test asserting createMarriage logs on a failing supabase mock (one representative case is enough).

---

## WP5 — Schema diet + naming convergence (Phase 4)

**Goal:** shrink the fattest schemas (small-model arg accuracy + tokens) and converge cross-bot names so the alias maps stop papering over them. Everything here churns model-visible surfaces — land AFTER WP1 so echo/compaction help cover the transition.

### WP5.0 Read this before renaming ANYTHING

Verified rename touchpoint checklist (from a live trace of `reminder_cancel` → every reference):
1. The schema `name` itself.
2. **Other tools' descriptions that name it** (e.g. irene `everyoneTools.js:454` — `cancel_scheduled_task`'s description says "use reminder_cancel").
3. Executor `HANDLED` set + `case` label.
4. Registry lists: always-include arrays and category tables in `ai/toolRegistry.js` — a stale name **silently drops the tool from selection**.
5. **Alias maps — flip, never delete**: both maps are boot-validated with `throwOnDrift: true` (eris `ai/executor.js:260–262`, irene `ai/toolAliases.js:139–141`) — an alias pointing at an unregistered name means **the bot won't boot**. After renaming X→Y, the entry must become `X: "Y"`.
6. System-prompt tool inventories: irene `events/messageCreate/contextBuild.js:449` lists tool names in prose; check eris's prompt-side mentions and `ai/toolCoaching.js` (both bots) for name references.
7. Tests that pin names (registry always-include assertions, executor tests, `scripts/testAllToolsLive.js`).
8. **Irene persists tool names at rest**: `schedule_task` stores raw `toolName` strings (advancedExecutor.js:421–471) replayed through `executeTool` on restore via `resolveScheduledToolName` (`packages/irene/utils/scheduler.js:38–41`, consults TOOL_ALIASES) — stored old names keep working **only if the old name stays in the alias map**. Eris has no equivalent (verified: facts/notes/economy rows never store tool names; only the analytics histogram `eris_analytics.tool_name` forks across a rename, which is acceptable — note it in the PR).

### WP5.1 Naming convergence (verb_noun wins)

Converge these verified flip pairs by renaming the **irene** side to eris's verb_noun form (irene's surface is the one with aliases already pointing the other way), keeping old names as aliases forever:
- `reminder_set` → `set_reminder`; `reminder_cancel` → `cancel_reminder` (irene `everyoneTools.js:412/424`)
- `forget_memory` → `forget_fact`; `clear_all_memories` → `forget_all` (irene `newtools.js:93/105`)
- `web_read` → `scrape_url` (irene `everyoneTools.js:522`)
- `list_trusted_users` → `list_trusted` (irene `adminTools.js:662`)

Apply the WP5.0 checklist for each. Also delete the 5 dead self-aliases: eris `track_game`/`untrack_game` (executor.js:95–96), irene `snipe`/`editsnipe` (toolAliases.js:27), `set_birthday` (toolAliases.js:51) — they're no-ops that emit spurious "Auto-corrected" logs.

### WP5.2 Mega-schema splits (one PR per tool, dual-shape adapters mandatory)

Verified inventory (schema site → executor case site):

| Tool | Schema | Params now | Executor case |
|---|---|---|---|
| `customize_welcome` | irene `adminTools.js:574` | 28 (27 scalar + `extra_fields` array) | `setupExecutor.js:1376` |
| `set_role_permissions` | `adminTools.js:187` | 25 (role_name + 24 booleans) | `roleExecutor.js:150` |
| `set_channel_permissions` | `adminTools.js:138` | 19 | `channelExecutor.js:186` |
| `setup_ticket` | `adminTools.js:1537` | 17, desc 1,257 chars | `setupExecutor.js:634` |
| `send_message` | `adminTools.js:1056` | 15 (nested embed_fields/buttons/dropdown) | `messageExecutor.js:327` |
| `create_custom_command` / `edit_custom_command` | `adminTools.js:1152/1177` | 15 each | `customCommandExecutor.js:79/108` |
| `purge_messages` | `adminTools.js:500` | 14 | `moderationExecutor.js:971` — **also wired into the confirm-defer flow at 349/982; the pending-confirm payload shape must stay compatible** |
| `ask_irene` (eris) | `whitelistPersona.js:130` | 16 params, `command` enum of 17 | `twinExecutor.js:65`; also referenced in `eris/ai/dual.js:65`, `toolRegistry.js:326`, `toolProfiles.js:23` |

Recipe per tool: group booleans/related scalars into typed sub-objects (e.g. `set_role_permissions` → `{ role_name, allow: string[], deny: string[] }` using permission-name enums; `customize_welcome` → `{ channel, message: {...}, card: {...}, fields: [...] }`), cut the description to ≤300 chars moving the rest into param descriptions, and in the executor case add a **dual-shape adapter**: `const args = normalizeXxxArgs(input)` accepting BOTH the old flat shape and the new shape (old shape support kept for at least one release — Irene's stored scheduled tasks and the confirm-defer pending payloads may carry old-shape args). Unit-test the adapter both ways. For `ask_irene`: split the 17-value `command` multiplexer into 3–4 intent-grouped tools (`irene_moderate` {ban,kick,warn,timeout,purge,lock,unlock,slowmode}, `irene_configure` {set_*_channel, create_channel, set_topic, create_role, give_role, remove_role}, `irene_announce` {announce, nickname}) OR — cheaper and acceptable — keep one tool but move per-command params into a single `params: object` with the description documenting per-command keys. Decide by token measurement; the twin relay's server-side `TWIN_COMMAND_ALLOWLIST` in irene `presence.js` must keep accepting whatever command vocabulary you emit.

### WP5.3 Re-measure and update docs

Re-run `npm run measure:prompt`; update the table in `ARCHITECTURE.md` §5 and the byte ceilings from WP1.8 (lower them to lock in the win). Update `docs/cheatsheet.md` if it names renamed tools.

**WP5 acceptance:** boot-time alias validation green on both bots (it throws on drift — that's your safety net); registry tests green; live-harness script (`scripts/testAllToolsLive.js`) names checked; measured tool bytes reduced and ceilings tightened.

---

## WP6 — Shared dedup migration

**Goal:** collapse the ~4,100 duplicated lines across eris/irene module pairs into `packages/shared` factories, ending the drift class of bugs (the crash-redaction asymmetry was one).

### WP6.0 The established pattern (replicate exactly)

Reference implementations, verified: `packages/shared/src/ai/selfCanon.js` (`createSelfCanon({ getData, markOpinionsDirty })`) + 21-line bot shims; `packages/shared/src/utils/twinState.js` (deps are **lazy getter functions** so config changes apply without re-instantiation); `packages/shared/src/ai/bumpApplause.js` + 56-line eris shim showing **cycle-avoidance via lazy `await import()`** in the dep wrappers.

Recipe: shared module = pure factory taking injected dep functions (never config/db objects), module-level constants, `_internal` export for tests; bot shim = import factory from `@defnotean/shared/<name>`, bind bot-local deps (config getters, db fns, logger, lazy dynamic imports for cycles), **re-export the exact original named surface** so zero callers change. Add the extensionless subpath to `packages/shared/package.json` exports. A new shared module with no new external deps cannot trip version-sync.

### WP6.1 Tier 1 — near-mechanical (do in this order)

Verified current identity (common lines / larger file):

| Pair | identity | combined lines |
|---|---|---|
| `ai/bumpReminder.js` | 94.0% | 1,676 |
| `ai/bumpCelebrations.js` | 97.7% | 860 |
| `ai/bumpAnalytics.js` | 93.8% | 484 |
| `ai/bumpCorrelation.js` | 98.3% | 349 |
| `ai/opinions.js` | 96.4% | 443 |
| `utils/aiBudget.js` | 98.5% | 266 |

One PR per pair: diff the two files first (`git diff --no-index packages/eris/<f> packages/irene/<f>`), enumerate every real divergence (most are the header comment + bot-name strings + which DB helper is imported), parameterize those as factory deps/options, extract, shim both sides, run BOTH bots' relevant test files. The bump* family is interdependent (bumpReminder ↔ bumpAnalytics ↔ bumpApplause already-shared) — mind the existing lazy-import cycle pattern.

### WP6.2 Tier 2 — behavior merges (more care, still worth it)

| Pair | identity | notes |
|---|---|---|
| `ai/providers/openaiCompat.js` | 82.0% | **Do after WP1** (WP1 edits both copies). Verified divergences to reconcile: eris internal `classifyError()` returns a label vs irene exported `classifyProviderError()` returning `{shouldFallback,label}` — keep irene's richer shape; irene's `TASK_KEYWORDS` adds music terms — parameterize; eris positional `runOpenAICompatChat(_client, ...)` vs irene dual-form options-object — standardize on the options-object with a positional shim; eris quickReply can `context.reply` — parameterize. The circuit-breaker block is already byte-identical (eris 449–479 / irene 424–454). |
| `ai/longmemory.js` | 83.2% | real schema/table-name differences — factory options |
| `ai/humanity.js` | 82.4% | same approach |
| `ai/preoccupations.js` | 80.1% | same |

### WP6.3 Explicitly DEFERRED (do not attempt in this pass)

- `ai/personality.js` (74.5% — eris `ensureLoaded()` is async, irene's sync; an extraction forces a load-model decision both bots feel).
- `ai/providers/nvidia.js` (71.8% — structurally divergent: eris has the full breaker + `_providerHealth()`, irene STUBS `setRateLimitCallbacks`/`isRateLimited`; export names differ). **Smaller worthwhile step instead:** port eris's breaker block into irene's nvidia.js (replacing the stubs) without merging the files.

**WP6 acceptance:** per pair — both bots' test suites green, the shim is <60 lines, `git diff` shows callers untouched; after tier 1, repo-wide duplicated-line count measurably down (state the number in the PR).

---

## WP7 — Orchestrator decomposition

### WP7.1 Irene `events/messageCreate.js` (815 lines; `execute()` spans 175–815)

Eris is the reference: its `messageCreate.js` is 204 lines delegating to 15 submodules in `events/messageCreate/`; irene has only 7 submodules. Move these verified inline blocks (current line ranges) into new/existing submodules, preserving order and behavior exactly:
- `resolveDMContext` (130–169) + the DM guild Proxy (469–483) → `messageCreate/contextBuild.js` (it already exists).
- Sleep-wake (205–219), VC auto-TTS (221–229), TTS toggle shortcut (103–116 + 449–459), leveling/XP + role rewards + level-up announce (322–350) → NEW `messageCreate/passiveFeatures.js`.
- Ack/status machinery (timer setup 592–613, `onToolStatus` narration 652–683, cancel 687–690, cleanup 711–719) → NEW `messageCreate/ackStatus.js` with a small state object.
- Sticky/auto-responders/AFK/highlight (298–320) → `passiveFeatures.js` too.
Target: `execute()` ≤200 lines of sequenced calls. **Behavior-preserving refactor — no logic changes.** The existing irene messageCreate tests (gates, contextBuild, firewall, analytics) are the safety net; add a smoke test asserting the orchestration order if one doesn't exist.

### WP7.2 Eris `events/interactionCreate.js` (1,194 lines; `handleGameButton` spans 98–983)

Create `events/interactionCreate/games/` with one module per game, routed by a customId-prefix dispatch map (the modal path at lines 49–50 already routes by prefix split — same idea). **The real win is the blackjack engine dedup** (verified duplicated): button path (153–230) vs `ai/executors/gamblingExecutor.js` `blackjack_action` (239–292) implement the same hit/stand/double resolution, dealer-draws-to-17, payout mapping. Extract ONE engine — `ai/blackjackEngine.js`: `resolveAction(state, action) → { state', outcome, payout }` — pure, no I/O. **Critical difference to respect:** the button path runs under `db.withUserLock` and uses the `*Unsafe` balance variants (`tryDeductBalanceUnsafe`:173, `updateBalanceUnsafe`:218) BECAUSE the lock is already held, while gamblingExecutor uses its own `withGameLock` + safe variants. The engine must take balance ops as injected functions; each caller keeps its own locking + balance API. Same pattern then applies to slots/roulette/duel if time allows — blackjack first, it's the one with payout-math drift risk.

**WP7 acceptance:** zero behavior change (existing tests green unmodified except import paths); blackjack payout math exists in exactly one module (grep `dealerHand) < 17` returns one hit); new engine has direct unit tests covering hit/stand/double/bust/push/dealer-draw edge cases.

---

## WP8 — CONTINGENCY: `TOOL_STRATEGY=json` constrained-output envelope

**Trigger (do NOT build this otherwise):** after WP1 has been live ≥2 weeks on the target local model, if `_unknownToolCounts` + shadow logs + manual gauntlet still show >5% malformed/hallucinated native tool_calls.

Sketch (full design exists; ask the owner for the audit's Design-3 document if triggered): a provider-level strategy flag where the model emits one JSON action envelope per turn `{"say": string, "action": {"tool": string, "args": object} | null}`, enforced via `response_format` json_schema (Ollama `format`, with a json_object → off downgrade ladder cached per process), tool catalog rendered as compact one-line signatures (reuse WP1.4's `compactSignature`), one tool per iteration, results as plain text. Native mode stays the default; the envelope is opt-in per deployment. Prereqs already built: `extraBody` plumbing, `stripReasoning`, compact signatures.

---

## 9. Final verification gate (run after every WP)

```bash
npm run lint:version-sync
npm test --workspaces --if-present        # baseline: 3,771+ passing, 0 failures
npm run build --workspaces --if-present   # 3x tsc --noEmit, 0 errors
npm run measure:prompt                    # after WP1.8: must run clean + within ceilings
npx eslint .                              # after WP4
```

Plus per-WP acceptance criteria above. A WP is done when: gate green, new behavior tested, default hosted behavior proven unchanged (snapshot/regression tests where specified), and the PR description states what was measured (token counts, perf numbers) where the WP asked for measurement.

## 10. Do NOT touch

- `packages/*/prompts/*-personality.md` and the other prompt voice files — content is owner-curated.
- Security assertions in existing tests (auth-rejection, HMAC, RLS-guard, firewall tests) — extend, never relax.
- `packages/eris/migrations/0xx_*.sql` history — new migrations only, never edit applied ones.
- The Gemini lane's behavior (`ai/dual.js` Gemini-specific paths) except where a WP explicitly references it.
- `IMPROVEMENTS.md` (audit record) and this plan's numbering (review will reference WP numbers).
