# Deploy Migration: from two Render repos → one monorepo

This guide moves the two Render services (`eris-bot` and `irene-bot`) from their individual repos onto the new `defnotean/bots-monorepo`, **one bot at a time**, with a fast rollback path.

The migration is non-destructive: the old repos stay on GitHub and the old service settings can be restored in under a minute.

---

## TL;DR — what's actually changing

| | Before | After |
|---|---|---|
| Source repo | `defnotean/eris` + `defnotean/irene` (2 separate repos) | `defnotean/bots-monorepo` (1 repo, 2 packages) |
| `utils/roleCategorizer.js` | Duplicated in both bots (drift risk) | Single source in `packages/shared/src/` |
| `utils/twinSign.js` | Duplicated (already drifted once) | Single source in `packages/shared/src/` |
| `utils/LRUCache.js` | Duplicated | Single source in `packages/shared/src/` |
| Install command | `npm install` (from repo root = bot root) | `npm install` (from monorepo root — npm workspaces hoists `@defnotean/shared`) |
| Start command | `npm start` | `npm run start:eris` or `npm run start:irene` |

Environment variables, bot tokens, Supabase keys, service plans, and ports **do not change**.

---

## Pre-flight

Before touching Render, confirm locally:

```bash
cd bots-monorepo
npm install
npm test --workspace=@defnotean/eris   # 337/338 (known pre-existing flake in bumpApplause.test.ts)
npm test --workspace=@defnotean/irene  # 100/100
```

If either package fails to even resolve `@defnotean/shared/*` imports, STOP — workspace linkage is broken, do not migrate.

---

## Canary: migrate Irene first

Irene is less public-facing than Eris in current usage, so roll Irene first. If it breaks, Eris is untouched and you still have a known-good service to compare against.

### Step 1 — Render dashboard: Irene service

1. Open the `irene-bot` service on Render.
2. **Settings → Repository → "Change Repository"** → select `defnotean/bots-monorepo` on the `main` branch.
3. **Settings → Build & Deploy**:
   - **Root Directory**: leave **blank** (must be empty — do NOT set to `packages/irene`). npm workspaces requires install from the repo root to establish symlinks; setting a sub-root breaks that.
   - **Build Command**: `npm install`
   - **Start Command**: `npm run start:irene`
4. Leave all env vars alone — they carry over with the service, the repo change does not touch them.
5. **Manual Deploy → Deploy latest commit**.

### Step 2 — Watch the first deploy

On the Logs tab, expect:
- `npm install` installs all workspaces (3 packages: `@defnotean/shared`, `@defnotean/eris`, `@defnotean/irene`). Irene-only deps like `@discordjs/voice` install under the root `node_modules`.
- Build completes → service enters `Live`.
- First log line from Irene's `index.js` should be the usual startup banner.

**Sanity smoke test** (run against your dev Discord guild):
- `/ping` or equivalent: Irene responds.
- `/setup` (the setupExecutor path): uses `@defnotean/shared/roleCategorizer` — confirm role categorization still works against a guild with existing roles.
- Twin API: trigger anything that signs an outbound HMAC via `@defnotean/shared/twinSign` (e.g., a `twinPunish` call) and verify Eris accepts it.

If all three pass, leave Irene on the monorepo for **at least 24 hours** before touching Eris. This catches slow-burn bugs that only surface under real guild load (long-lived cache entries, role change listeners, etc.).

### Rollback (Irene)

If anything misbehaves:

1. Render dashboard → Irene service → **Settings → Repository → "Change Repository"** → select `defnotean/irene` on `main`.
2. **Build & Deploy** settings: restore `Build Command = npm install`, `Start Command = node index.js`.
3. **Manual Deploy → Deploy latest commit**.

You are back on the old repo in ~2 minutes. The monorepo retains the full history — nothing is lost.

---

## After Irene is stable: migrate Eris

Same procedure, Eris service:

1. `eris-bot` service → Repository → `defnotean/bots-monorepo` / `main`.
2. Build & Deploy:
   - **Root Directory**: blank.
   - **Build Command**: `npm install`
   - **Start Command**: `npm run start:eris`
3. Deploy.

Smoke tests for Eris:
- `/ping` and any admin command (exercises `@defnotean/shared/roleCategorizer`).
- `/coins` or economy (independent of shared package — sanity that nothing else regressed).
- Receive a twin-signed request from Irene (exercises `@defnotean/shared/twinSign` verify path).

### Rollback (Eris)

Same flip as Irene:

1. Repository → `defnotean/eris` / `main`.
2. Build Command `npm install`, Start Command `npm start`.
3. Manual Deploy.

---

## Stale files to ignore (and eventually clean up)

The following still exist in the monorepo because they were imported by `git subtree` and it's safer to leave them alone during migration than to edit things:

- `packages/eris/render.yaml` — a Render Blueprint that still references `name: eris-bot`, `startCommand: npm start`. **Render does NOT auto-read this** when the service was configured manually through the dashboard. It's dead weight, harmless, but misleading.
- `packages/irene/render.yaml` — same story (`name: irene-bot`, `startCommand: node index.js`).
- `packages/*/EXTRACTION_PLAN.md` — planning docs from the migration itself. Safe to leave, or delete in a cleanup PR later.

**Do not delete these during the migration itself.** Clean them up in a separate PR after both services are confirmed stable on the monorepo for at least a week. That way if you ever need to bisect a regression, the subtree history is intact and byte-for-byte matches the old repo state.

---

## After both bots have been green for ~2 weeks

Optional cleanup (not required for operation):

1. Archive the old repos on GitHub:
   - `defnotean/eris` → Settings → Archive this repository.
   - `defnotean/irene` → Settings → Archive this repository.
   Archiving is reversible. It stops new pushes, makes the repos read-only, and signals to future-you that the monorepo is canonical.
2. Delete the stale `render.yaml` files inside `packages/eris/` and `packages/irene/` — or replace them with a single root `render.yaml` Blueprint defining both services, if you want "click-to-redeploy-on-a-new-Render-account" portability. That's a separate refactor, not a migration step.

---

## What this migration does NOT change

Just so there are no surprises:

- **Bot behavior**: zero code changes to runtime logic. The only code change is import paths (`../utils/X.js` → `@defnotean/shared/X`), which resolve to the same module — the file contents of those three modules are byte-identical to what Eris and Irene were running before (Phase 0 reconciliation made the canonical version the one both bots now import).
- **Database / Supabase**: untouched. No migrations ran.
- **Discord permissions or OAuth scopes**: untouched.
- **Rate limits, cooldowns, cached state**: all in-memory state resets on deploy (as it always has on any Render deploy). No special behavior.

---

## If you hit a problem not covered here

The single most likely class of failure is **module resolution** — `Cannot find module '@defnotean/shared/...'`. If that happens on Render:

1. Confirm the service's **Root Directory** is blank (not `packages/eris` / `packages/irene`). A non-blank Root Directory is the #1 cause — it skips workspace hoisting.
2. Confirm Build Command is `npm install` (not `npm ci` — `npm ci` requires a `package-lock.json` strictly consistent with the committed one, and can refuse to link workspaces if the lockfile is off).
3. Check Render build logs for `added N packages, and audited M packages` — if `N` is very small (< 50), only the sub-package's deps got installed and the workspace root install didn't run. Rollback and investigate.

Rollback first, debug second. Don't try to hot-fix a broken deploy on the main branch.
