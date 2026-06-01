# Contributing — Code Style & Conventions

This is the **per-file** style guide. The higher-level workflow (branching, PRs, where-to-add-a-thing) lives in **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — read that first. This doc only covers the conventions you need when actually typing code into a `.js` or `.ts` file.

If you're editing an existing file and it disagrees with this doc, the file wins. Don't reformat. See [§10](#10-pr-review-checklist) for the surgical-change rule.

---

## 1. Language choices

The monorepo is mixed JS + TS, by design:

| Where | Language | Why |
|---|---|---|
| `packages/eris/**/*.js` | **JavaScript** (ESM) | Source of truth for Eris. No build step in dev (`node index.js`). |
| `packages/irene/**/*.js` | **JavaScript** (ESM) | Same — Irene runs straight from `.js`. |
| `packages/shared/src/**/*.js` | **JavaScript** (ESM) | Exported to both bots. JS so consumers don't need a build. |
| `packages/*/tests/**/*.ts` | **TypeScript** | All vitest specs are `.ts`. Catches mock-shape bugs at write time. |
| `packages/*/prompts/loader.ts` | TypeScript | Prompt loaders for both bot packages. |
| `packages/eris/utils/unicode.ts` | TypeScript | Type-heavy code-point table. |

**Rule of thumb:** new application code is `.js`. New tests are `.ts`. Don't convert a `.js` file to `.ts` as a side-effect of another change.

Workspace build configs run TypeScript in `--noEmit` mode as a type lint, not a transpile. Runtime code still ships as raw `.js` via Node. Shared code uses `checkJs: true`, and bot packages type-check their configured JS/TS surfaces; keep JSDoc accurate when editing shared helpers.

No ESLint, no Prettier. **Match the file you're editing.**

---

## 2. Module style — ESM only

The root `package.json` and every package set `"type": "module"`. Every file uses `import` / `export`.

```js
// ✅ Canonical — packages/eris/ai/executor.js:11-13
import * as db from "../database.js";
import config from "../config.js";
import { log } from "../utils/logger.js";

// ✅ Named export — packages/shared/src/rateLimit.js:85
export function createRateLimiter({ limit, windowMs, maxKeys = 1000 } = {}) { … }
```

- **Always include the `.js` extension** on relative imports (`NodeNext` requires it; that's why `tsconfig.json` sets `"module": "NodeNext"`).
- **Cross-package imports** use the `@defnotean/shared` subpath exports declared in [packages/shared/package.json](../packages/shared/package.json) — e.g. `import { LRUCache } from "@defnotean/shared/LRUCache"`.
- **CJS is forbidden** in new code. The only `.cjs` files in the tree (`local_agent.cjs`, `migrate.cjs`) exist because they're invoked outside the bot process (Electron, migration CLI) and were converted intentionally.
- **Dynamic `import()` is fine** for breaking circular module loads or deferring expensive submodules — see [packages/irene/database.js:120-123](../packages/irene/database.js) (perEntity loaded lazily) and [packages/eris/ai/stockMarket.js:53-104](../packages/eris/ai/stockMarket.js) (cached `_loadPromise`).

---

## 3. Error handling — tool executors never throw

The AI executor pipeline ([packages/eris/ai/executor.js](../packages/eris/ai/executor.js), [packages/irene/ai/executor.js](../packages/irene/ai/executor.js)) treats every `case` as a **string-returning** function. A thrown exception inside a tool handler crashes the whole turn for the user and shows up as a generic failure to the model — losing the chance to feed a useful error back.

**The rule:**

- **Tool executors return a string.** Success message, or a human-readable failure prefixed with `"Error:"`, `"Couldn't"`, `"Failed"`, `"Sorry,"`, `"You don't"`, or `"Not enough"`. The cache layer pattern-matches these prefixes and refuses to cache them ([executor.js:177](../packages/eris/ai/executor.js)).
- **Validation failures return an object** `{ error: "...message..." }` from a helper, and the caller surfaces `parsed.error` as the tool result. Canonical example: `parseBet` in [packages/eris/ai/executors/gamblingExecutor.js:35-53](../packages/eris/ai/executors/gamblingExecutor.js).
- **Genuine bugs (programmer error)** may throw — uncaught throws inside `executeTool` propagate to the AI dispatcher, which logs and returns an apology string to the user. Don't rely on this; it's a safety net, not a pattern.
- **Database helpers** throw on **structural failure** (`economy_unavailable: database offline`) but **return shaped objects on business failure** (`{ success: false, reason: "duplicate directive" }`). See [packages/irene/database.js:462-471](../packages/irene/database.js).
- **`safeFetch` / external HTTP** never throws — it returns `{ ok, status, body }` or `{ ok: false, error }`. See [packages/shared/src/safeFetch.js](../packages/shared/src/safeFetch.js).

When you catch an error in a tool handler, **log the underlying error and return a friendly string** — don't expose stack traces to Discord.

---

## 4. Logging conventions

There's one logger per bot: [packages/eris/utils/logger.js](../packages/eris/utils/logger.js) and [packages/irene/utils/logger.js](../packages/irene/utils/logger.js). Both expose `log(message)` for the standard channel and color the console output based on a leading category tag.

**Always tag your logs with a bracketed scope:**

```js
log(`[EXECUTOR] Auto-corrected tool: ${toolName} → ${TOOL_ALIASES[toolName]}`);
log(`[AUTH] ${message.author.id} denied configure_bump_reminder in ${guildId}`);
log(`[Stocks] Load failed: ${err.message}`);
console.warn("[DB] ⚠️  IRENE WITHOUT PERSISTENCE — …");
```

Existing scopes the logger color-codes for free: `[ERROR]`, `[WARN]`, `[BOT]`, `[READY]`, `[INIT]`, `[STARTUP]`, `[AI]`, `[GEMINI]`, `[NVIDIA]`, `[EXEC]` / `[EXECUTOR]`, `[DB]`, `[SUPABASE]`, `[GATEKEEP]`, `[SECURITY]`, `[MODLOG]`, `[AUTOSETUP]`, `[AUDIT]`, `[MOD]`, `[ECONOMY]`, `[SHOP]`, `[GAMBLE]`, `[ACTIVITY]`, `[PET]`, `[ROB]`, `[MUSIC]`, `[LAVALINK]`, `[VC]`, `[YOUTUBE]`, `[GITHUB]`, `[TWITCH]`, `[BUMP]`, `[REMINDER]`, `[PATCHBOT]`. Feature-specific scopes (`[REGISTRY]`, `[WHITELIST]`, `[Stocks]`, `[Lottery]`, etc.) are fine — invent them where they help.

**Don't spam the log.** Counter-style logging is the pattern for repeating events — see [executor.js:351-355](../packages/eris/ai/executor.js):

```js
if (count === 1 || count % 10 === 0) {
  log(`[EXECUTOR] Unknown tool: ${toolName} (hit #${count}, user ${userId}, args: ${argPreview})`);
}
```

**Levels:**
- `log(...)` — the default; use for everything informational.
- `console.warn(...)` — recoverable degradation (Supabase unavailable, falling back to in-memory).
- `console.error(...)` — failures the operator needs to see (save retry exhausted, init failed).
- Avoid `console.log` in new code — go through the logger so colors and file output stay consistent.

---

## 5. Naming conventions

- **`camelCase`** for variables, parameters, functions, exports.
- **`PascalCase`** for classes and constructors (`LRUCache`).
- **`UPPER_SNAKE`** for top-level constants and `Set`s of tool names: `MAX_BET`, `CACHEABLE_TOOLS`, `TOOL_ALIASES`, `DEFAULT_MAX_KEYS`.
- **Leading underscore** marks "module-private" state and helpers — `_toolCache`, `_unknownToolCounts`, `_saveTimer`, `_flushSave`, `_executeToolInner`. Exporting `_size` from `createRateLimiter` signals "test helper, don't depend on this in app code."
- **`*Unsafe` suffix** on functions that skip a lock they normally hold (`_updateBalanceUnsafe`, `tryDeductBalanceUnsafe`). Calling one outside the appropriate `withUserLock` block is a bug.
- **No Hungarian prefixes.** No `IFoo`, `T`-prefix on types, etc.
- **File names** are `camelCase.js` for modules (`safeFetch.js`, `rateLimit.js`, `gamblingExecutor.js`), `lowercase.js` for the canonical singletons of a bot (`database.js`, `config.js`, `index.js`), and `UPPER_SNAKE.md` for top-level project docs.
- **Strings are double-quoted.** Template literals where interpolation or multi-line is involved.

---

## 6. Async patterns — no floating promises

The Discord client emits events into a Node event loop that nobody monitors for unhandled rejections by default. **Every promise must be awaited or explicitly fire-and-forget with `.catch()`.**

- **`async` functions await everything they call** that returns a promise. Don't `return somePromise` from an `async` function expecting the caller to await; just `await` and return the value.
- **Top-level fire-and-forget** (scheduling, background flush, side-effect dispatch) **must** attach a `.catch(err => log(...))`. The codebase already does this — search for `.catch((` in `events/messageCreate.js` to see the pattern.
- **`Promise.all` for independent work** — the dual-write fanout in [packages/irene/database.js:333](../packages/irene/database.js) is the canonical example.
- **Never `void`-prefix a promise** to silence a lint warning (we have no lint). If you don't care about the result, attach `.catch()`. If you do care, `await` it.
- **The 3-second interaction ack budget.** Slash command handlers either `interaction.deferReply()` immediately, or reply within 3s. If your handler awaits anything slow before replying, defer first. See the existing slash commands in `packages/irene/commands/` for the pattern.
- **`async` IIFEs** are used inside lazy-init blocks ([stockMarket.js:56-101](../packages/eris/ai/stockMarket.js)) and to detach work from a sync caller — both are fine.

---

## 7. Locking pattern

Three patterns guard read-modify-write sequences. Use the right one for the scope of the contention.

### `withUserLock(userId, fn)` — per-user mutations
Defined in [packages/eris/database.js:733](../packages/eris/database.js) as a public alias for `withEconLock`. Serializes everything that touches a single user's row in the cache: balance changes, bank moves, daily/weekly/monthly claims, crafting, loot boxes, marriage, divorce, pet train, loan repay.

```js
// Canonical use site — anything in packages/eris/ai/executors/socialExecutor.js
await db.withUserLock(message.author.id, async () => {
  const econ = await db.getBalance(message.author.id);
  if (econ.balance < cost) return; // safe — we hold the lock
  await db.updateBalanceUnsafe(message.author.id, -cost, "shop_buy", item);
});
```

`*Unsafe` helpers (`updateBalanceUnsafe`, `tryDeductBalanceUnsafe`) **must only** be called from inside an active `withUserLock` / `withEconLock` block — they skip the lock acquisition. Calling `updateBalance` (the locked version) from inside an open lock is a **non-reentrant deadlock**.

Irene has its own `withUserLock` in [packages/irene/database.js](../packages/irene/database.js) with the same shape for the moderation/warning path.

### `withGameLock(gameKey, fn)` — per-game mutations
Defined in [packages/eris/ai/executors/gamblingExecutor.js:22](../packages/eris/ai/executors/gamblingExecutor.js):

```js
const _gameLocks = new Map();
async function withGameLock(key, fn) {
  const prev = _gameLocks.get(key) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _gameLocks.set(key, current);
  try { return await current; } finally {
    if (_gameLocks.get(key) === current) _gameLocks.delete(key);
  }
}
```

Use when two concurrent calls could each `deck.pop()` from the same game state and silently corrupt it (blackjack actions, multi-player game ticks). The key is the game/session ID, not the user.

### Shared-promise lazy init
The idiomatic way to load expensive state once and have concurrent callers share the in-flight promise:

```js
// packages/eris/ai/stockMarket.js:53-104
let _state = null;
let _loadPromise = null;
async function _load() {
  if (_state) return _state;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => { /* fetch, validate, assign _state */ })();
  try { return await _loadPromise; } finally { _loadPromise = null; }
}
```

Used by `stockMarket.js`, `lottery.js`, and the perEntity lazy import in `irene/database.js`. Don't re-implement it as `if (!loaded) await load();` — that double-fetches under contention.

### Module-level mutex chains
For domain-wide serialization (one user can never queue against another — everything goes through one chain): see `_marriagePipeline` in [packages/eris/ai/socialExecutor.js:35-38](../packages/eris/ai/socialExecutor.js) and `_opChain` in [lottery.js:33-36](../packages/eris/ai/lottery.js). Same shape as `withGameLock` but no key.

---

## 8. Per-process state caveat

A lot of the locking, caching, and rate-limiting in this codebase is **single-process only** — it works for the current Render deployment (one Eris worker, one Irene worker) and will silently break if you fan out to multiple replicas.

Things that live in a single Node heap:
- `withUserLock` / `withGameLock` / `withEconLock` (Maps in the process)
- The LRU tool-result cache in [executor.js:141](../packages/eris/ai/executor.js)
- The in-memory `data` blob in `database.js` (both bots)
- The rate limiter in [packages/shared/src/rateLimit.js](../packages/shared/src/rateLimit.js) — see the explicit warning in its docstring at [rateLimit.js:33-38](../packages/shared/src/rateLimit.js)
- The cooldown maps in `utils/cooldown.js`
- The unknown-tool counter, the bump-correlation cache, etc.

**If you're adding any of these patterns, document the scope in the file header.** Future-you may horizontally scale and need to know what to migrate. The accepted boundaries:
- **Process-local correctness** — fine for in-memory rate limit / cooldown if a per-replica multiplier is acceptable.
- **Cross-process correctness** — must live in Postgres (via Supabase) with `version` checks (see the perEntity pattern in [packages/irene/database/perEntity.js](../packages/irene/database/perEntity.js)) or via an RPC like `eris_add_balance` (see [packages/eris/migrations/002_atomic_balance_rpc.sql](../packages/eris/migrations/002_atomic_balance_rpc.sql)).

A `SCALING.md` doc is planned and referenced by `rateLimit.js`; until it lands, this section is the canonical guidance.

---

## 9. Commit message conventions

Conventional commits, scoped by package. Already enforced loosely by `git log` shape; CONTRIBUTING.md §"Branching and commits" has the full reference:

```
<type>(<scope>): <description>
```

- `type` ∈ `feat | fix | docs | chore | refactor`
- `scope` ∈ `eris | irene | shared` (omit for repo-root changes)
- `description` is **lowercase**, **imperative mood**, **no trailing period**.

Examples lifted from `git log`:
- `feat(eris): /roulette — European single-zero wheel`
- `fix(irene): truncation + topic-drift in AI replies`
- `fix(ai): cap Brave web search latency`
- `docs: update Render deployment notes`
- `chore: unify + pin shared dep ranges across workspaces (phase D)`

**Body (optional, ≥1 blank line after subject):** explain *why*, reference the incident or PR number. Wrap at ~72 chars.

**Repo policy** (from `CONTRIBUTING.md`): commits, PR descriptions, and `Co-Authored-By` fields **do not** carry AI-tool attribution. All work is credited to the contributor account.

---

## 10. PR review checklist

A reviewer will look at every PR for these. Self-check before requesting review:

- [ ] **Surgical change.** You edited only what your task required. No drive-by reformatting, renaming, or adjacent refactors. Unrelated cleanups go in their own PR.
- [ ] **Style matches the file.** JS modules, ESM, double-quoted strings, `//` comments. If the file already disagrees with this doc, you copied the file's style, not the doc's.
- [ ] **No `Co-Authored-By` or other AI-tool attribution** in commits, the PR body, or commit trailers. Repo policy (see `CONTRIBUTING.md` §"Branching and commits").
- [ ] **CI gates pass.** `npm run lint:version-sync`, `npm audit --audit-level=moderate`, `npm test --workspaces --if-present`, and `npm run build --workspaces --if-present` green. New tool / new bug fix has a new test ([CONTRIBUTING.md §Testing](../CONTRIBUTING.md#testing)).
- [ ] **Twin boundary checked.** If your change touches a duplicated or shared-sensitive file (`personality.js`, `longmemory.js`, `firewall.js`, `twinSign.js`, `bumpReminder*`), you confirmed the change is intentional and noted whether the twin needs a matching update.
- [ ] **Logs are tagged.** New `log(...)` / `console.*` calls have a `[SCOPE]` prefix and don't spam in hot paths.
- [ ] **Error handling matches the layer.** Tool executors return strings, not throws. Validators return `{ error }` objects. Persistence helpers may throw on structural failure (no DB).
- [ ] **Lock invariants preserved.** Any new `*Unsafe` call is inside an active `withUserLock` / `withGameLock` block. Any new read-modify-write on user state is inside one.
- [ ] **`version-sync` clean.** Any non-local dependency used by multiple workspaces still has one identical version range — `npm run lint:version-sync` is the guard.
- [ ] **No secrets, no hardcoded owner / guild / Discord IDs, no deploy URLs.** Everything env-loaded via `config.js`. See `SECURITY.md` and the open-source-release note in the repo.
- [ ] **PR body** under 200 words: what, why, one-line smoke-test plan. Title in commit-message format.

If your change touches the AI pipeline or twin coordination, the reviewer bar is higher — expect more iterations and link the relevant `docs/ai-pipeline-*.md` section in the PR body.
