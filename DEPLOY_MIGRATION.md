# Deploy Migration: from two Render repos → one monorepo

This guide moves the two Render services (`eris-bot` and `irene-bot`) from their individual repos onto the new `your-org/bots-monorepo`, **one bot at a time**, with a fast rollback path.

The migration is non-destructive: the old repos stay on GitHub and the old service settings can be restored in under a minute.

---

## TL;DR — what's actually changing

| | Before | After |
|---|---|---|
| Source repo | `your-org/eris` + `your-org/irene` (2 separate repos) | `your-org/bots-monorepo` (1 repo, 2 packages) |
| `utils/roleCategorizer.js` | Duplicated in both bots (drift risk) | Single source in `packages/shared/src/` |
| `utils/twinSign.js` | Duplicated (already drifted once) | Single source in `packages/shared/src/` |
| `utils/LRUCache.js` | Duplicated | Single source in `packages/shared/src/` |
| Install command | `npm install` (from repo root = bot root) | `npm install` (from monorepo root — npm workspaces hoists `@defnotean/shared`) |
| Start command | `npm start` | `npm run start:eris` or `npm run start:irene` |

Environment variables, bot tokens, Supabase keys, service plans, and ports **do not change**.

---

## Known gotcha: npm workspace version hoisting

The biggest pitfall when moving two bots into one monorepo: a cutover can **fail silently
in production** — the process comes up, commands load, the Discord gateway connects, but
user-facing interactions stop responding. The usual root cause is npm workspace version
hoisting.

Suppose Eris specifies `discord.js@^14.26.2` and Irene specifies `^14.14.1`. A version
like `14.26.3` satisfies BOTH ranges, so npm hoists `14.26.3` to the root — and Irene,
with no local override, ends up running against a minor version she wasn't built for.
Interaction-reply APIs changed between 14.14 and 14.26, so the handlers break silently.
Worse, unit tests can still pass because they run against the same hoisted version prod
does — both "broken" in the same matching way.

Rollback in this scenario takes ~2 minutes via the Render dashboard repo flip documented
below, but the goal is to never trigger it.

**Lessons encoded into this guide:**
1. Every shared dep must have **byte-identical** version ranges across workspaces. Pin
   exact (no caret) for reproducibility. Enforced by `npm run lint:version-sync`.
2. Disable Auto-Deploy *before* changing settings on the Render dashboard. Batch the
   repo + start command changes, then Manual Deploy. Prevents the in-flight-deploy-with-
   half-updated-state failure mode.
3. Unit tests are **not sufficient** to validate a cross-version migration. Add a real-
   Discord smoke test checklist (below) as the final gate before declaring success.

---

## Pre-flight

Before touching Render, confirm locally:

```bash
cd bots-monorepo
npm run lint:version-sync    # MUST pass — fails loudly on any divergent dep range
npm install
npm test --workspace=@defnotean/eris   # 337/338 (known pre-existing flake in bumpApplause.test.ts)
npm test --workspace=@defnotean/irene  # 100/100
```

If either package fails to even resolve `@defnotean/shared/*` imports, STOP — workspace linkage is broken, do not migrate.

---

## Canary: migrate Irene first

Irene is less public-facing than Eris in current usage, so roll Irene first. If it breaks, Eris is untouched and you still have a known-good service to compare against.

### Step 1 — Render dashboard: Irene service

**Critical procedural fix:** disable Auto-Deploy FIRST. Otherwise each settings change triggers its own auto-deploy and you end up with an in-flight deploy that captured the old start command against the new repo (or vice-versa) — a classic way to get a half-updated deploy and a botched rollback.

1. Open the Irene service on Render.
2. **Settings → Deploy → Auto-Deploy**: change to **Off**. Save.
3. **Settings → Deploy → Start Command**: change to `npm run start:irene`. Save. (No deploy triggers because Auto-Deploy is off.)
4. **Settings → Build → Repository → "Change Repository"** → select `your-org/bots-monorepo` on the `main` branch. Save.
5. **Settings → Build**: verify **Root Directory** is **blank** (must be empty — do NOT set to `packages/irene`. npm workspaces requires install from the repo root to establish symlinks; setting a sub-root breaks that.)
6. **Settings → Build → Build Command**: confirm `npm install`.
7. Leave all env vars alone — they carry over with the service, the repo change does not touch them.
8. **Manual Deploy → Deploy latest commit**. *Now* the deploy runs, with both repo and start command settings correctly applied atomically.
9. **After the deploy is confirmed Live and smoke-tested:** Settings → Deploy → Auto-Deploy → **On Commit**. Save.

### Step 2 — Watch the first deploy

On the Logs tab, expect:
- `npm install` installs all workspaces (3 packages: `@defnotean/shared`, `@defnotean/eris`, `@defnotean/irene`). Irene-only deps like `@discordjs/voice` install under the root `node_modules`.
- Build completes → service enters `Live`.
- First log line from Irene's `index.js` should be the usual startup banner.

**Sanity smoke test** — run ALL of these against your dev Discord guild before claiming success. Declaring success on "process is alive" alone is dangerous — it misses the case where interaction handlers are silently broken.

1. **`/ping`** — simplest interaction path. If this fails, interaction handling is broken. (This is the test that catches the version-hoisting failure mode described above.)
2. **Any slash command that sends an embed** — validates discord.js Embed APIs still work across the version bump.
3. **`/setup` or any command that lists roles** — uses `@defnotean/shared/roleCategorizer`; confirms shared package resolves.
4. **Mention the bot in a guild channel** — exercises the message handler + AI path, different from slash commands.
5. **Twin API** — trigger anything that signs an outbound HMAC via `@defnotean/shared/twinSign` (e.g., a `twinPunish` call) and verify the receiving bot accepts it.
6. **Check `[Bot] N commands loaded` count in the log** — compare to the previous known-good deploy. If it's lower than before, some command file failed to load silently (a dropped command count, e.g. 63 → 62, means one file was silently skipped).

If any smoke test fails, **rollback immediately** (see "Rollback" below). Do not debug in prod; the other bot is still on its old repo and stable.

Leave the migrated bot on the monorepo for **at least 24 hours** before touching the other one. Slow-burn bugs (long-lived cache entries, role change listeners, scheduled task jitter) only surface under real guild load.

### Rollback (Irene)

If anything misbehaves:

1. Render dashboard → Irene service → **Settings → Repository → "Change Repository"** → select `your-org/irene` on `main`.
2. **Build & Deploy** settings: restore `Build Command = npm install`, `Start Command = node index.js`.
3. **Manual Deploy → Deploy latest commit**.

You are back on the old repo in ~2 minutes. The monorepo retains the full history — nothing is lost.

---

## After Irene is stable: migrate Eris

Same procedure, Eris service:

1. `eris-bot` service → Repository → `your-org/bots-monorepo` / `main`.
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

1. Repository → `your-org/eris` / `main`.
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
   - `your-org/eris` → Settings → Archive this repository.
   - `your-org/irene` → Settings → Archive this repository.
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
