# Shared Core Extraction Plan

> **Status: planning doc, not actively tracked.** This was drafted as a roadmap for the shared-package extraction. For current status of extraction work, see [docs/drift-inventory.md](../../docs/drift-inventory.md). Treat the items below as candidate work, not committed scope.

*Status: drafted 2026-04-23, not yet executed.*
*Owner: TBD.*
*Prerequisite met:* Step 2 tests from the council round (roleCategorizer, poker, stockMarket, lottery) are in place.
*Prerequisite pending:* none — this is unblocked.

---

## Why

Eris and Irene share ~10 core modules that drift independently today:

| Module | State as of 2026-04-23 |
|---|---|
| `utils/roleCategorizer.js` | byte-identical ✓ |
| `utils/LRUCache.js` | **now** byte-identical (Irene was behind the group-key feature until this commit) |
| `utils/twinSign.js` | **differs** |
| `ai/firewall.js` | **differs** (Eris uses `config.ownerId`, Irene now aliases `ownerId`) |
| `ai/personality.js` | **differs** |
| `ai/longmemory.js` | **differs** (schema drift) |
| `ai/semantic.js` | unchecked — likely differs |
| `ai/humanity.js` | unchecked — likely differs |
| `ai/memory.js` | unchecked — likely differs |
| `ai/bumpReminder.js` + `bumpCelebrations.js` + `bumpCorrelation.js` + `bumpApplause.js` | ~150KB across 4 files — drift risk |

Every bug fix in one must be hand-ported to the other. The firewall owner-bypass field-name divergence (council round C1) is the canonical example — same concept, different field names, silent failure if misconfigured.

## Shape

Two viable structures:

**Option A: npm workspaces monorepo.**
One repo containing `packages/shared/`, `packages/eris/`, `packages/irene/`. Both bots `import from "@defnotean/shared/firewall"`. Deploy is two Render services pointing at the same repo with different `startCommand`s.
- **Pro:** one place to change shared code; atomic cross-bot commits; no publish workflow.
- **Con:** requires merging two existing repos into one (history preservation is doable with `git subtree add`, but non-trivial). Render service config changes.

**Option B: third "core" repo as a git dependency.**
A new `defnotean/bot-core` repo. Both Eris and Irene depend on it via `"@defnotean/bot-core": "github:defnotean/bot-core#main"` or `#v1.2.3` tag. Deploy is unchanged for both bots.
- **Pro:** minimal deploy disruption, independent versioning.
- **Con:** publish workflow (tag → update both bots' package.json → deploy); two-step for any shared change.

**Recommended:** Option A (workspaces). Tight coupling between the bots makes atomic cross-bot changes valuable; the merge is a one-time cost.

## Phased migration (safest path)

### Phase 0: Reconcile drifts (prerequisite)

Before moving anything, pick the canonical version of each divergent file:

- [ ] **`twinSign.js`** — diff and unify. Almost certainly Eris's version is authoritative since twin-punish goes Irene → Eris.
- [ ] **`firewall.js`** — Eris's version is authoritative (uses canonical `config.ownerId`). Port Eris's version to Irene, keeping Irene's `config.userId` alias.
- [ ] **`personality.js`** — each bot has diverged trait keys (Eris has stock/game/pet axes; Irene omits these). Need a union schema + conditional loading per bot.
- [ ] **`longmemory.js`** — schema drift probably cosmetic (table names are `{botName}_*`). Parameterize the table prefix.
- [ ] **`bumpReminder.js`** + family — likely shareable with minimal changes; bump logic is bot-agnostic.

### Phase 1: Set up workspace structure

- [ ] Create a new GitHub repo: `defnotean/bots-monorepo` (or merge into one of the existing repos).
- [ ] `git subtree add --prefix=packages/eris  defnotean/Eris  main` — preserves Eris's history.
- [ ] `git subtree add --prefix=packages/irene defnotean/Irene main` — preserves Irene's history.
- [ ] Root `package.json` with `"workspaces": ["packages/*"]`.
- [ ] Create `packages/shared/` with its own `package.json`.
- [ ] Smoke test: `npm install` from repo root resolves workspace links.

### Phase 2: Move one file at a time

For each shared module, in order of smallest-blast-radius first:

1. [ ] `utils/LRUCache.js` — pure, zero dependencies, already byte-identical.
2. [ ] `utils/roleCategorizer.js` — pure, has tests (step 2).
3. [ ] `utils/twinSign.js` — pure crypto, needs reconciled version.
4. [ ] `ai/firewall.js` — imports `config` + `logger`; needs dependency injection (factory that takes `ownerId`, `log`).
5. [ ] `ai/semantic.js` / `ai/humanity.js` / `ai/memory.js` — medium complexity.
6. [ ] `ai/personality.js` — largest; needs the union schema from phase 0.
7. [ ] `ai/longmemory.js` — largest; needs `botName` param.
8. [ ] `ai/bumpReminder*.js` (4 files) — likely bulk-movable.

After each file moves:
- Update imports in both `packages/eris/*` and `packages/irene/*` to use `@defnotean/shared/<name>`.
- Run both bots' test suites.
- Smoke test by running each bot locally against a test guild.

### Phase 3: Deploy

- [ ] Update Render service for Eris: set root directory to `packages/eris`.
- [ ] Update Render service for Irene: set root directory to `packages/irene`.
- [ ] Verify build command picks up workspace hoisting (`npm ci` at repo root installs shared deps).
- [ ] Canary deploy Eris first (smaller user base); watch logs 24h.
- [ ] Canary deploy Irene.

### Phase 4: Retire old repos

- [ ] Archive `defnotean/Eris` + `defnotean/Irene` with a README pointing at the monorepo.
- [ ] Update CLAUDE.md and FEATURES.md references.

## Risk register

| Risk | Mitigation |
|---|---|
| Git history gets mangled during subtree merge | Use `git subtree add` (preserves SHAs) not `git merge --allow-unrelated-histories` |
| Render picks up wrong workspace root | Test with `render.yaml` in a branch first; deploy from branch before flipping main |
| Shared personality schema breaks one bot's existing data | Migration script to UNION-fill missing fields on first load after deploy |
| Dependency version skew between bots | Root `package.json` pins shared deps; workspace-level `package.json`s pin bot-specific ones |
| One bot's tests start depending on shared internals | Enforce: shared package only exposes via `index.js` public API, not deep imports |

## Out of scope for the first pass

- TypeScript migration of shared code (nice-to-have, adds days).
- Republishing as a public `@defnotean/bot-core` on npm (only needed if external users want it).
- Unifying the two bots' personality *content* (traits, opinions, memories). They're intentionally different characters; only infrastructure gets shared.

---

## Checklist summary

Before starting:
- [x] Tests for shared modules in place (roleCategorizer ✓, others pending).
- [x] LRUCache is byte-identical between bots.
- [ ] Reconcile firewall.js, twinSign.js, personality.js, longmemory.js drifts.

Execution order: reconcile → set up workspace → move file-by-file → deploy.

Estimated effort: **2–3 focused days** assuming no surprises in phase 0 reconciliation.
