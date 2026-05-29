# Monobot Security Audit

Date: 2026-05-29
Audited commit: `a5fecf8a299e18167002b20df59102eafa4fb165`
Branch: `main`

## Scope

This audit reviewed the full cloned Monobot repository, excluding generated dependencies and media artifacts. The codebase is a twin Discord bot system:

- `packages/eris`: economy, chat, admin dashboard, local PC-agent, twin API.
- `packages/irene`: moderation, server configuration, music/presence, dashboard, twin API.
- `packages/shared`: HMAC signing, safe fetch, rate limits, logging, shared security helpers.

The main question was whether a regular Discord user can gain admin-level capabilities or otherwise abuse security boundaries.

## Verification Performed

- Fetched the latest GitHub `main` commit.
- Inventoried the full repository.
- Reviewed command/tool definitions, runtime executors, event routing, HTTP APIs, dashboard auth, twin-bot auth, scheduler behavior, persistence, SSRF protections, logging/redaction, and environment-gated dangerous features.
- Ran `npm audit --omit=dev --json`: 0 vulnerabilities.
- Ran `npm audit --json`: 0 vulnerabilities.
- Searched for common leaked token/key patterns. Only fake test fixtures were found.
- Attempted workspace tests with `npm test --workspaces --if-present`; this did not run because `vitest` was not installed in the current workspace.

## Executive Summary

The codebase has several solid security primitives, especially shared HMAC request signing, replay protection, SSRF-safe fetch wrappers, log redaction tests, and strong owner gates around Eris local system-control tools.

However, there is one critical privilege escalation path: Irene exposes a regular-user scheduling tool that can store arbitrary tool executions, and the scheduler later calls the central tool executor directly. Its fire-time admin denylist is incomplete, so a regular user can schedule missing admin tools such as `trust_user`. Once the task fires, that user can be added to the trusted users list, and trusted users are treated as admins by Irene's context-building logic.

There are also important dashboard and bot-configuration bypasses, especially an Eris proxy route that can turn remote requests into localhost requests against Irene, bypassing Irene dashboard authentication.

## Finding 1: Critical - Regular User Can Schedule Irene Admin Tool To Become Trusted

### Impact

A regular Discord user can become a trusted/admin-equivalent Irene user if the model or tool-dispatch path accepts their request to schedule an arbitrary tool call. Once trusted, later messages are evaluated as admin and expose Irene admin tools.

### Evidence

`schedule_task` is exposed to regular users in `EVERYONE_TOOLS` and explicitly advertises arbitrary tool scheduling:

- `packages/irene/ai/tools/everyoneTools.js:439`

Its handler accepts an arbitrary `tool_name` and `tool_input` and stores the task without a permission check:

- `packages/irene/ai/executors/advancedExecutor.js:407`
- `packages/irene/ai/executors/advancedExecutor.js:432`

The scheduler only blocks a short hard-coded admin list:

- `packages/irene/utils/scheduler.js:26`
- `packages/irene/utils/scheduler.js:128`

That list omits many admin tools, including `trust_user`, `untrust_user`, `toggle_auto_responders`, `toggle_voice_tracking`, `toggle_invite_filter`, `set_welcome_channel`, `set_access_role`, `setup_verification`, sticky-message tools, and leveling configuration tools.

At execution time, the scheduler directly calls the central executor:

- `packages/irene/utils/scheduler.js:141`

The central `executeTool` function does not enforce a global admin boundary:

- `packages/irene/ai/executor.js:530`

`trust_user` is an admin tool that grants full admin-level access:

- `packages/irene/ai/tools/adminTools.js:644`

Its runtime handler has no permission check and persists the trusted user:

- `packages/irene/ai/executors/toggleExecutor.js:67`
- `packages/irene/database.js:1367`

Trusted users are then treated as admins:

- `packages/irene/events/messageCreate/commandPrefix.js:34`
- `packages/irene/events/messageCreate/contextBuild.js:217`

### Exploit Path

In a controlled test guild, a regular user could ask Irene to schedule a call to `trust_user` for their own account after a short delay. The intended Tier-2 design says tools can be invoked by name even when their schemas are not sent directly to the model:

- `packages/irene/events/messageCreate/contextBuild.js:205`
- `docs/TOOLCALLING.md:64`

When the scheduler fires, the incomplete denylist does not block `trust_user`; `executeTool` dispatches it; the user is persisted as trusted; future messages from the same user load admin capability.

### Recommended Fix

- Make `schedule_task` admin-only, or restrict it to a positive allowlist of safe, read-only, or self-owned tools.
- At fire time, derive admin-ness from `ADMIN_TOOLS`, not a hand-maintained subset.
- Add handler-side permission checks to every admin mutator, especially `trust_user` and `untrust_user`.
- Add regression tests proving non-admin users cannot schedule `trust_user`, setup/config tools, sticky-message tools, leveling config, or toggle tools.

## Finding 2: Critical - Eris Proxy Can Bypass Irene Dashboard Authentication

### Impact

If Eris's HTTP server is reachable by remote users, an unauthenticated caller can access Irene dashboard APIs through Eris's `/api/irene/*` proxy. Irene sees the request as coming from localhost and skips auth.

### Evidence

Eris proxies `/api/irene/*` before its dashboard auth wrapper:

- `packages/eris/index.js:101`
- `packages/eris/index.js:144`

Irene bypasses dashboard auth for localhost requests:

- `packages/irene/presence.js:285`

Irene dashboard endpoints expose sensitive read/write operations, including conversation/memory data and personality updates:

- `packages/irene/presence.js:339`
- `packages/irene/presence.js:446`
- `packages/irene/presence.js:480`

### Exploit Path

A remote caller requests Eris at `/api/irene/stats`, `/api/irene/conversations`, or other Irene dashboard routes. Eris forwards the request to `127.0.0.1:3001`; Irene treats it as local and bypasses token auth.

### Recommended Fix

- Authenticate `/api/irene/*` at Eris before proxying.
- Remove or narrow Irene's localhost auth bypass.
- Prefer an explicit internal proxy header signed with a private shared secret, validated by Irene.
- Add tests proving unauthenticated remote access to proxied Irene dashboard endpoints returns `401`.

## Finding 3: High - Eris Regular Users Can Toggle Server-Level Twin Chat

### Impact

Any user who can invoke Eris tools can enable or disable twin chat for a guild. This is server-level configuration tampering and can disrupt bot behavior.

### Evidence

`toggle_twin_chat` is listed in Eris `EVERYONE_TOOLS`:

- `packages/eris/ai/tools.js:1181`

It is included in Tier-1 tools for every conversation:

- `packages/eris/ai/toolRegistry.js:201`

The handler has no runtime permission gate:

- `packages/eris/ai/executors/adminExecutor.js:154`

### Recommended Fix

Require `canCustomize(...)`, `ManageGuild`, or equivalent admin/trusted checks inside the handler, matching the pattern used by `configure_feature`, `set_event_channels`, and `set_chat_channels`.

## Finding 4: High - Eris Cross-Bot Punishment Toggle Is Everyone-Classified

### Impact

If reachable through the AI dispatch path, a regular user can enable or disable cross-bot punishment behavior for a guild. With the toggle enabled, Irene moderation actions can trigger Eris economy confiscation.

### Evidence

`toggle_cross_bot_punish` is in `EVERYONE_TOOLS`, despite being described as admin-only:

- `packages/eris/ai/tools.js:784`

The handler lacks a permission check:

- `packages/eris/ai/executors/adminExecutor.js:160`

The punishment endpoint itself is HMAC-gated and checks the guild opt-in setting:

- `packages/eris/api/dashboard.js:383`
- `packages/eris/api/dashboard.js:410`
- `packages/eris/api/dashboard.js:435`

### Recommended Fix

Move `toggle_cross_bot_punish` out of `EVERYONE_TOOLS` and add runtime `canCustomize(...)` or `ManageGuild` enforcement.

## Finding 5: High - Regular Users Can Persist Admin-Framed Directives

### Impact

Regular users can save persistent directives that are later injected into model context as admin-set instructions. This can steer bot behavior, strengthen prompt-injection attempts, and create persistent policy confusion.

### Evidence

Eris exposes `save_directive` and `remove_directive` to everyone:

- `packages/eris/ai/tools.js:81`
- `packages/eris/ai/executors/adminExecutor.js:197`

Eris injects those directives as admin overrides:

- `packages/eris/events/messageCreate/contextBuild.js:225`

Irene also exposes directive mutation to everyone:

- `packages/irene/ai/tools/everyoneTools.js:547`
- `packages/irene/ai/executor.js:860`

Irene injects directives as admin-set overrides:

- `packages/irene/events/messageCreate/contextBuild.js:498`

### Recommended Fix

- Require guild admin/trusted permissions to save or remove directives.
- Store and display `addedBy` and permission level.
- Do not label directives as admin-set unless they were written by an admin.
- Consider sanitizing or quoting directive text as data before injection.

## Finding 6: Medium - Irene Admin Executors Depend Too Much On Upstream Filtering

### Impact

Irene's provider loop filters admin tools for non-admin users, but many admin executors do not defend themselves. Any alternate caller that bypasses the provider loop can mutate admin state. The scheduler issue is a concrete example of this.

### Evidence

Provider-loop admin filtering:

- `packages/irene/ai/dual.js:561`

Direct callers exist outside that loop:

- `packages/irene/utils/scheduler.js:141`
- `packages/irene/presence.js:661`
- `packages/irene/commands/voice/vc.js:83`

Some admin executors have good local checks:

- `packages/irene/ai/executors/channelExecutor.js:18`
- `packages/irene/ai/executors/roleExecutor.js:16`

But many mutators lack equivalent checks:

- `packages/irene/ai/executors/toggleExecutor.js:19`
- `packages/irene/ai/executors/toggleExecutor.js:67`
- `packages/irene/ai/executors/setupExecutor.js:23`
- `packages/irene/ai/executors/setupExecutor.js:1230`
- `packages/irene/ai/executors/levelingExecutor.js:8`
- `packages/irene/ai/executors/advancedExecutor.js:271`
- `packages/irene/ai/executor.js:806`

### Recommended Fix

Add a shared `requireAdminMember` guard and call it at the top of every admin mutator. Treat provider-loop filtering as user experience, not authorization.

## Finding 7: Medium - Eris Legacy Twin POSTs Are Unauthenticated When Secret Is Missing

### Impact

If Eris's HTTP API is public and `TWIN_API_SECRET` is unset, unauthenticated callers can create reminders, notes, and facts for arbitrary users through legacy twin endpoints.

### Evidence

The legacy POST path only rejects body-secret auth when `TWIN_API_SECRET` is set:

- `packages/eris/api/dashboard.js:333`

Affected routes include:

- `packages/eris/api/dashboard.js:343`
- `packages/eris/api/dashboard.js:353`
- `packages/eris/api/dashboard.js:360`

### Recommended Fix

Fail closed for all state-changing twin POSTs when `TWIN_API_SECRET` is missing, or disable those routes entirely in single-bot mode.

## Finding 8: Medium - Eris Logs Endpoint Is Exposed Before Dashboard Auth

### Impact

If the Eris HTTP server is reachable externally, unauthenticated callers can read bot log tails. Redaction helps, but logs may still contain user content, guild IDs, channel IDs, operational details, and future unredacted sensitive values.

### Evidence

`/api/logs` is handled before the dashboard API auth wrapper:

- `packages/eris/index.js:150`
- `packages/eris/index.js:176`

### Recommended Fix

Route `/api/logs` through the same dashboard auth path as other dashboard API calls, or add an explicit local/Bearer check before reading logs.

## Positive Security Notes

- Shared twin HMAC signing validates timestamp, replay, body hash, and constant-time signatures.
- Shared safe fetch blocks private/local/link-local/CGNAT targets, validates DNS and redirects, and enforces timeout/size limits.
- Irene moderation tools include several strong permission and role-hierarchy checks.
- Eris PC-agent/system tools are owner-only, environment-gated, and contain command deny/confirmation logic.
- Secret scanning found no apparent real secrets in source.
- `npm audit` reported no known dependency vulnerabilities.

## Highest Priority Remediation Plan

1. Fix Irene `schedule_task` immediately by making it admin-only or safe-tool allowlisted.
2. Add runtime permission checks to Irene admin executors, especially trust/untrust and setup/toggle/leveling/sticky tools.
3. Authenticate Eris `/api/irene/*` before proxying and stop relying on Irene localhost bypass as an auth boundary.
4. Move Eris server-level toggles out of `EVERYONE_TOOLS` and enforce handler-side checks.
5. Restrict directive mutation to admins/trusted users only.
6. Lock down legacy twin POSTs and `/api/logs`.
7. Add regression tests for each boundary above.

