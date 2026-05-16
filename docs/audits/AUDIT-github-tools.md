# Audit: GitHub Executor Tools

Scope: GitHub-related tools exposed by Eris's AI executor pipeline. Irene has no
GitHub executor (confirmed by `Glob **/executors/*.js` — only Eris has one).

## Tools surveyed

Defined in `packages/eris/ai/executors/githubExecutor.js:11-15` and registered as
tool schemas in `packages/eris/ai/tools.js:1454-1539`. Five real GitHub tools
exist (no `gh_file_read` / `gh_file_write` / `gh_create_pr` — the brief listed
hypothetical names; only the below are wired up):

| Tool | File:line | API call | Mutating |
|---|---|---|---|
| `github_repos` | `githubExecutor.js:145-161` | `repos.listForAuthenticatedUser` | no |
| `github_issues` | `githubExecutor.js:163-178` | `issues.listForRepo` | no |
| `github_prs` | `githubExecutor.js:180-195` | `pulls.list` | no |
| `github_create_issue` | `githubExecutor.js:197-214` | `issues.create` | **yes** |
| `github_repo_stats` | `githubExecutor.js:216-235` | `repos.get` | no |

Plus two deploy-adjacent tools delegated to the same executor:
`check_deploy` (`githubExecutor.js:237-258`, Render REST) and `watch_deploy`
(`githubExecutor.js:260-268`, DB write to deploy-watch table). The Gmail tools
in the same file (`read_emails`, `search_emails`, `draft_email`,
`summarize_inbox`, lines 58-143) are out of scope here.

## Auth model

- Single shared Octokit singleton, constructed lazily from
  `config.githubToken` (`githubExecutor.js:33-40`), which sources
  `GITHUB_TOKEN` env (`config.js:51, 291`). One PAT for everything; no
  per-user, per-tool, or per-repo scoping.
- Owner-gate is `isOwner(message.author.id)` returning early with
  `denyMessage()` if false (`permissions.js:5-7, 46-55`). Owner is the single
  Discord ID in `BOT_OWNER_ID` (`config.js:201`).
- Every tool case checks owner at function entry (`githubExecutor.js:146,
  164, 181, 198, 217, 238, 261`) — gating is uniform.
- **No repo allowlist exists** in the executor (Grep:
  `allowlist|repo_allowlist` → 0 matches in `githubExecutor.js`). The PAT's
  GitHub-side scope/repo selection is the only boundary on what the owner
  can hit.
- **No per-tool rate limiting** in the executor (Grep:
  `rateLimit|throttle` → 0 matches). Only Octokit's built-in client and
  GitHub's server-side limits apply. `watch_deploy` writes to the DB on
  every call with no debounce.
- The Electron `agent-ui` (`agent-ui/main.js:81-92`,
  `agent-ui/index.html:76-88, 220-225`) is a separate desktop surface where
  the local user pastes their own PAT — out of scope of the Discord-facing
  executor but worth noting because both paths share the same `githubToken`
  config key.

## Per-tool findings

### `github_repos` (`githubExecutor.js:145-161`)
- Owner-gated. Lists the PAT user's repos, optional client-side substring
  filter. `input.limit` is forwarded to `per_page` with no clamp — owner
  could request `per_page: 1000000` which Octokit caps to 100, so blast
  radius is low but the code makes no guarantee.

### `github_issues` (`githubExecutor.js:163-178`)
- Owner-gated. `resolveRepo` (lines 44-51) accepts `owner/repo` string OR
  separate `owner` + `repo`. No format validation — any string with a `/`
  passes through to Octokit, which rejects malformed names. `input.state`
  is forwarded raw to `issues.listForRepo` — GitHub rejects unknown values
  so injection surface is null, but a typo gives a server error to the
  user rather than a clean message.

### `github_prs` (`githubExecutor.js:180-195`)
- Same shape as `github_issues`. Same notes; no extra concerns.

### `github_create_issue` (`githubExecutor.js:197-214`) — **MUTATING**
- Owner-gated. Title and body are passed verbatim to GitHub. `labels` is
  forwarded with no validation — an LLM-supplied non-array would 422 from
  GitHub, harmless. Real risk: the LLM, prompted by chat content the owner
  pasted in, can create issues in **any repo the PAT can write to**. There
  is no confirmation step and no repo allowlist. An indirect-injection
  payload pasted into a Discord message could in principle cause an issue
  to be filed on an unrelated repo.

### `github_repo_stats` (`githubExecutor.js:216-235`)
- Owner-gated, read-only, low risk.

### `check_deploy` (`githubExecutor.js:237-258`)
- Owner-gated. `serviceId` is interpolated directly into the Render URL
  (line 243) — `serviceId` is a user-supplied string with no validation.
  Render's API path is `/v1/services/{id}`; the bot does no URL-encoding,
  so an LLM-supplied `../foo` or `srv-abc/sensitive-subpath` traverses to
  arbitrary Render endpoints under the same bearer token. Severity bounded
  by what the Render PAT can do, but this is a real path-injection
  primitive.

### `watch_deploy` (`githubExecutor.js:260-268`)
- Owner-gated. Writes a row to `deploy_watch` keyed on
  (`service`, `projectId`, `channel.id`) with no dedupe and no per-owner
  rate limit; cheap to flood the table from a single chat turn.

## Top 5 risks (severity-ranked)

1. **`check_deploy` URL injection** — `serviceId` interpolated unescaped
   into `https://api.render.com/v1/services/${serviceId}`
   (`githubExecutor.js:243`). Owner-only mitigates, but an LLM-shaped
   value can traverse the Render REST surface under the bot's bearer
   token. **High**.
2. **No repo allowlist on `github_create_issue`** — mutating tool can
   target any repo the PAT scopes (`githubExecutor.js:197-214`). Combined
   with the broad-scope single PAT (`config.js:291`) and no confirmation
   prompt, an indirect-injection payload via chat content can file issues
   anywhere. **High**.
3. **One PAT, no scope partitioning** — `getOctokit()`
   (`githubExecutor.js:33-40`) uses a single token for every tool. There
   is no read-only client for the list/read tools vs a separate
   write-scoped client for `github_create_issue`. Token compromise = full
   blast radius. **Medium**.
4. **`input.limit` unbounded** — every list tool forwards `input.limit`
   straight to Octokit `per_page` (`githubExecutor.js:151, 171, 188`)
   with no clamp. Octokit caps server-side at 100, but the contract is
   implicit. **Low–Medium**.
5. **`watch_deploy` DB amplification** — no dedupe or per-owner rate
   limit (`githubExecutor.js:266`); each call inserts a row. **Low**.

## Remediation

- `check_deploy`: validate `serviceId` against `^srv-[a-zA-Z0-9]+$` (Render
  service-ID shape) before interpolation; reject otherwise. Same fix for
  any future `project_id` interpolation in `watch_deploy`.
- `github_create_issue`: introduce a `GITHUB_REPO_ALLOWLIST` env (CSV of
  `owner/repo`) checked in `resolveRepo`'s caller. Reject if the resolved
  `owner/repo` is not in the allowlist; default to "owner's own repos
  only" if unset. Echo the target repo back in the confirmation string
  the tool already returns.
- Split PATs: introduce `GITHUB_TOKEN_READ` and `GITHUB_TOKEN_WRITE` and
  pick per-tool in `getOctokit()`; fall back to `githubToken` for
  back-compat.
- Clamp `input.limit` to `Math.min(Math.max(1, input.limit ?? 10), 100)`
  in a shared helper before passing to Octokit.
- `watch_deploy`: upsert keyed on (`service`, `projectId`, `channel.id`)
  so repeated calls are idempotent; cap rows-per-owner at e.g. 50.
- Consider moving the owner-only check into a single executor-wrapper
  decorator so adding a new GitHub tool can't accidentally skip the gate
  (the current pattern repeats the check seven times).
