# Twin Coordination Layer

Cross-bot REST + HMAC protocol that lets Eris (chaotic twin) and Irene (good twin) talk to each other safely. Irene also exposes a Lanyard-style presence feed and a dashboard API on the same HTTP server.

## 1. Purpose [STABLE]

The two bots are deployed as separate Render services with separate Discord identities. By design:

- **Eris** is the chaos / economy / fun bot. She has *no* moderation tools at all — `ban_user`, `kick_user`, `purge_messages`, `create_channel`, etc. all live on Irene.
- **Irene** has the moderation toolset (~150 tools wired through `executor.js` at `packages/irene/ai/executor.js`) and is also the bot whose Discord presence is being mirrored to the outside world.
- When a user asks Eris to do something only Irene can do (e.g. "ban that guy"), Eris *delegates* via the `ask_irene` tool. The request is HMAC-signed and POSTed to Irene's REST API.
- HMAC exists so the public REST surface (Render gives both bots a public URL) can't be invoked by random callers — only a counterpart who knows `TWIN_API_SECRET` can sign a request that Irene will execute.

The presence cache itself is the original reason an HTTP server exists on Irene at all (Lanyard replacement at `/presence/:userId`); the twin-command and dashboard endpoints are layered on top of the same `http.createServer` (`packages/irene/presence.js:101`).

## 2. Endpoints exposed by Irene's presence.js [mostly STABLE]

Single Node `http` server, started from `startPresenceAPI(client)` (`packages/irene/presence.js:100`), which is invoked first thing in `main()` before Discord login (`packages/irene/index.js:251`) so Render sees an open port immediately.

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/presence/:userId`, `/presence` | GET | none, IP rate-limited 1/s (around line 110) | Cached Discord presence (status, activities, Spotify) — Lanyard replacement |
| `/health` | GET | none | `{ ok, user, bot }` — public self-ping / liveness target (around line 142) |
| `/tts/:id` | GET | none, exempt from rate limit (Lavalink HEAD+GET) | Serves cached TTS audio buffer (around line 145) |
| `/api/health` | GET | none | `{ ok: true }` — Render healthcheck target (around line 212). Use authenticated `/api/stats` for uptime, memory, and guild count. |
| `/api/stats`, `/api/mood`, `/api/relationships`, `/api/conversations`, `/api/conversations/:id`, `/api/memories`, `/api/personality`, `/api/monologue`, `/api/humanity`, `/api/episodes`, `/api/reminders` | GET (some PUT/DELETE) | `Bearer DASHBOARD_API_KEY`; localhost bypass only when `DASHBOARD_ALLOW_LOCALHOST_BYPASS=1` | Dashboard read/write surface for the Base44 twin dashboard |
| `/api/twin/state` | GET | `Bearer TWIN_API_SECRET` (around line 441) | Side-effect-free snapshot: `{ bot, mood_score, energy, preoccupation, at }` |
| `/api/twin/command` | POST | **HMAC** via `verifyTwinRequest` (around line 489) | Eris → Irene moderation relay |

Twin-command request body shape (`packages/irene/presence.js:495`):

```json
{
  "requester_id": "123456789012345678",
  "guild_id": "...",
  "channel_id": "...",
  "command": "ban",
  "args": { "target_id": "...", "reason": "spam" }
}
```

After verifying HMAC, Irene also re-checks that `requester_id` is owner or in `getTrustedUsers(guild_id)` (around line 498), maps Eris's short command names through `TWIN_ALIASES` (around line 536, e.g. `ban` → `ban_user`), and runs the resolved tool through `executeTool` from `ai/executor.js` (around line 567). Crucially, the synthesized message context uses the *requester's* guild member, not the bot's, so downstream hierarchy/permission checks evaluate against the human (around line 520, with explicit comment).

Body is capped at 10 KB and the connection is destroyed if exceeded (around line 477).

Eris exposes the inverse direction on her own dashboard server: HMAC-signed POST endpoints at `/api/twin/punish`, `/api/twin/remind`, `/api/twin/note`, and `/api/twin/fact`; Bearer-gated read endpoints at `/api/twin/mood`, `/api/twin/status`, and `/api/twin/state`. Irene's `ask_eris` tool calls those routes through `callEris()` (see §4).

## 3. Auth Model [STABLE]

Two separate auth schemes on the same secret:

**HMAC (state-changing endpoints, `/api/twin/command`, `/api/twin/punish`)**

Implemented in `packages/shared/src/twinSign.js`. Both sign and verify functions live in the same module; both bots import it as `@defnotean/shared/twinSign`.

Headers attached to every signed request:

```
X-Twin-Timestamp: <unix_ms>
X-Twin-Signature: <hex(HMAC_SHA256(secret, `${ts}.${rawBody}`))>
Content-Type:     application/json
```

Verification (`twinSign.js:61`):

1. Look up lowercased headers (Node's `req.headers` is already lowercased).
2. Reject if signature isn't a 64-char hex string (around line 69).
3. Reject if `|now - ts| > TWIN_MAX_SKEW_MS` (60 s each way, line 13).
4. Recompute `HMAC_SHA256(secret, ts + '.' + body)` and compare via `crypto.timingSafeEqual`.
5. Replay cache (in-memory `Map`, max 2048 entries, pruned opportunistically — line 35–51) rejects an already-seen signature inside the skew window.

**Bearer (read-only twin endpoints, `/api/twin/state`, `/api/twin/mood`, `/api/twin/status`)**

`Authorization: Bearer <TWIN_API_SECRET>`. No timestamp, no replay protection — fine because these endpoints have no side effects (`packages/irene/presence.js:441`, comment explicitly notes this). Non-health dashboard `/api/*` routes use `Authorization: Bearer <DASHBOARD_API_KEY>` instead.

**Worked example** — Eris signing `{"foo":"bar"}` with secret `s3cret`:

```
ts   = "1714060800000"
body = '{"foo":"bar"}'
sig  = HMAC_SHA256("s3cret", "1714060800000.{\"foo\":\"bar\"}")  // hex digest

POST /api/twin/command HTTP/1.1
Content-Type:     application/json
X-Twin-Timestamp: 1714060800000
X-Twin-Signature: 9a3f...  (64 hex chars)

{"foo":"bar"}
```

The signer/verifier must agree byte-for-byte on the body, so callers serialize JSON once and reuse it (see `packages/irene/utils/twinPunish.js:31`).

## 4. Caller Patterns [STABLE]

**Eris → Irene (`ask_irene`)** — `packages/eris/ai/executors/twinExecutor.js`

1. LLM emits an `ask_irene` tool call with `{ command, ...args }`.
2. Eris does her *own* role-based check first (admin/mod/staff command lists, around line 30–37). Sassy denial returned to user without ever hitting Irene if perms missing.
3. Builds JSON payload `{ requester_id, guild_id, channel_id, command, args }` (around line 99).
4. `signTwinRequest(payload, TWIN_API_SECRET)` → headers (line 106).
5. `fetch(IRENE_API + "/api/twin/command", { method: "POST", headers, body: payload })` (line 108).
6. Returns either `told irene to {command} and she did it: {result}` or `irene refused: {error}` to the model.

**Eris → Irene (read-only state)** — `packages/eris/utils/twinState.js`

Cached 5 min, called from `buildTwinStateContext` whenever the user's text mentions "irene" (around line 62). Bearer auth, 4 s timeout, fails silently to empty string. This is what lets Eris reference Irene's *actual* current mood instead of hallucinating one.

**Irene → Eris (`firePunishSignal`)** — `packages/irene/utils/twinPunish.js`

Fire-and-forget, called from the moderation executor whenever Irene bans/kicks. Validates snowflakes, signs, POSTs to `/api/twin/punish` with a 5 s `AbortSignal.timeout`. Eris checks the guild's `cross_bot_punish` opt-in and confiscates the user's economy balance if true (`packages/eris/api/dashboard.js:347`).

**Irene → Eris (`ask_eris` LLM tool)** — `packages/irene/ai/executors/advancedExecutor.js` (`callEris` helper + `ask_eris` block)

Sub-actions `remind | note | fact | mood | status`. Routed through the shared `callEris(path, opts)` helper, which reads the base URL from `config.twinApiUrl` (env: `ERIS_API_URL`) and signs every `POST` body via `signTwinRequest` against `TWIN_API_SECRET` — same protocol as `twinPunish`. `GET` sub-actions (`/mood`, `/status`) use `Authorization: Bearer <TWIN_API_SECRET>`. A 5 s `AbortSignal.timeout` bounds each call.

## 5. Failure Modes

- **Network timeout** [STABLE] — `ask_irene` uses a 5 s `AbortSignal.timeout`; `twinState` uses 4 s and caches the error; `twinPunish` and `ask_eris` use 5 s.
- **Signature mismatch** [STABLE] — Irene returns `403 { success: false, error: "twin auth failed: <reason>" }` (presence.js:492). Eris surfaces this verbatim to the LLM as `irene refused: ...`.
- **Replay** [STABLE] — same signature seen twice → `403 "replay detected"` (twinSign.js:93).
- **Clock skew** [STABLE] — > 60 s in either direction → `403 "timestamp outside acceptable skew"`.
- **Rate limit** [STABLE] — public `/presence` is 1 req/sec/IP (presence.js:114); dashboard `/api/*` is 180/min/IP. `/api/twin/state` is additionally capped at 10/min/IP via the shared `createRateLimiter` (mirrored on both bots) so a leaked or replayed bearer can't scrape mood at arbitrary resolution; rejects with `Retry-After: 60`. All return `429 { error: "..." }`. Twin-command isn't separately rate-limited beyond the dashboard bucket.
- **Other bot down** [STABLE] — `ask_irene` catches and returns `couldn't reach irene — {message}` to the user. `twinState` caches the error and returns empty context (silent degradation). `twinPunish` logs and returns; the ban itself still succeeds. `ask_eris` returns `couldn't reach eris right now — she might be sleeping`.
- **Payload too large** [STABLE] — > 10 KB body to `/api/twin/command` returns `413` and destroys the request socket (presence.js:478).

## 6. Config Required

**Both bots** — `TWIN_API_SECRET` (must match exactly). Long random string. Loaded via `env()` helper (`packages/eris/config.js:74`, `packages/irene/config.js:73`).

**Irene side**:
- `PORT` — defaults to `3001` (irene/config.js:65). Server bound in `presence.js:585`.
- `DISCORD_USER_ID` — owner ID, used for the presence userId path and as the default trusted requester.
- `DASHBOARD_API_KEY` (dashboard auth for remote non-health `/api/*` calls).
- `DASHBOARD_ALLOW_LOCALHOST_BYPASS=1` (local development only; keep unset in hosted/proxied deployments).

**Eris side**:
- `IRENE_API_URL` — no code default. Set it to Irene's HTTP API URL when running twin coordination; this is what `ask_irene` and `twinState` POST/GET against.

**Cross-references**:
- `TWIN_BOT_ID` on Eris and `ERIS_BOT_ID` on Irene are env-loaded sibling bot IDs used for prompt substitution and twin-message detection.

---

## 5-minute mental model

- **Two Render services, one shared secret.** Eris does fun/economy, Irene does moderation + presence. They talk over plain HTTP, authed by `TWIN_API_SECRET`.
- **Irene's `presence.js` is the entire HTTP server** — public `/presence`, `/health`, `/tts/`, the Base44 dashboard `/api/*`, and the twin endpoints `/api/twin/state` (Bearer) and `/api/twin/command` (HMAC).
- **State-changing twin requests are HMAC-SHA256 signed** over `${timestamp}.${rawBody}`, with a 60 s skew window and an in-memory replay cache. Logic lives in `packages/shared/src/twinSign.js`, used by both bots. Read-only twin endpoints use simple `Bearer TWIN_API_SECRET` because they have no side effects; dashboard routes use `DASHBOARD_API_KEY`.
- **Eris → Irene**: `ask_irene` LLM tool builds payload, signs, POSTs `/api/twin/command`. Irene re-verifies HMAC, then re-verifies the requester is owner/trusted, maps short command name to real tool, and calls `executeTool` with a fake message context whose `member` is the *requesting human* (so hierarchy checks aren't bypassed by the bot's own permissions). **Irene → Eris**: `firePunishSignal` after a ban/kick triggers Eris to confiscate the user's economy balance if the guild opted in.
- **If the twin is down**, callers degrade silently: `ask_irene` returns a "couldn't reach irene" string to the model, `twinState` returns empty context, `firePunishSignal` logs and lets the moderation action stand alone. Nothing blocks on the twin being reachable.

---

## Notes

- All paths above are **searched and verified**. Nothing was missing.
- The previously-flagged hardcoded Eris URL in `ask_eris` was fixed: `callEris()` now reads `config.twinApiUrl`, signs every POST with `TWIN_API_SECRET`, sends `Bearer TWIN_API_SECRET` on read-only GETs, and bounds calls with `AbortSignal.timeout`.
