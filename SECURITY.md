# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in MonoBot, please report it
privately rather than opening a public GitHub issue.

**Contact:** use GitHub private vulnerability reporting for this repository if
it is available. If it is not, contact the repository owner privately and avoid
posting exploit details in a public issue.

Include in your report:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (proof-of-concept code, payloads, or a minimal repro repo
  are all welcome).
- The affected commit hash or branch.
- Whether the issue is already public anywhere.

You will get an acknowledgement within 72 hours. We do not currently offer a
bug bounty.

Please do not test for vulnerabilities against bots or infrastructure you do
not own. Spin up your own instance for testing — `docs/self-hosting.md` covers
how.

## Supported Versions

Only the `main` branch is currently supported with security fixes. There are
no tagged releases yet.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | Yes                |
| Other   | No                 |

If you self-host, treat your fork's deployed commit as your "version" and pull
from `main` to receive fixes.

## Threat Model

MonoBot is a Discord bot. The defenses below are calibrated against the
following attackers, in roughly decreasing order of likelihood:

### 1. Untrusted Discord user (default attacker)

The most common case: someone in a guild the bot is in, sending crafted
messages, slash-command inputs, or content via tool outputs (URLs, attachments,
fetched pages). The bot must not be steerable into:

- Performing destructive actions on the host machine.
- Leaking secrets, owner-only data, or other users' private state.
- Following links to internal/cloud-metadata endpoints.
- Treating attacker-supplied content as instructions from the operator.

### 2. Compromised bot token

If a bot token leaks (committed to git, exfiltrated from a host), the attacker
has full Discord-side capability of that bot user. MonoBot cannot defend
against this in code — recovery is operational: rotate the token in the
Discord developer portal, redeploy, audit guild audit logs, and review the
`eris_pc_audit` table for unexpected owner-tool invocations.

### 3. Compromised twin secret

Eris and Irene authenticate cross-process calls with an HMAC-SHA256 shared
secret (`TWIN_API_SECRET`). An attacker with this secret can forge requests
between the two bots within the ±60s skew window. Defenses are local: replay
cache, constant-time comparison, body-bound signature. There is no
out-of-band revocation — rotation requires updating both `.env` files and
restarting both processes.

### 4. Self-hoster misconfiguration

The riskiest single class of issue. Common footguns:

- Exposing the bot's HTTP surface to the public internet without a tunnel
  that enforces TLS.
- Sharing a single Supabase service key across untrusted environments.
- Running the bot as root, or in a working directory the bot's PC-agent tools
  can rewrite.
- Granting `BOT_OWNER_ID` to an ID that is no longer under your control.

These are documented in `docs/self-hosting.md` but no amount of code can save
an operator who pipes the token to a public paste.

## Defense Layers in Place

### Prompt-injection firewall (`packages/shared/src/ai/firewall.js`)

Layered pipeline applied to user input before it ever reaches the LLM:

- L1 normalization (NFKC, homoglyphs, leetspeak, invisible characters,
  delimiter stripping).
- L1.5 decoders (base64, ROT13, hex, percent, unicode-escape, reversed).
- L2 Aho-Corasick literal pre-filter then a regex worker (~80 patterns) with
  a 100ms race timeout to bound ReDoS exposure.
- L2.5 sliding-window check (last 5 messages per user / 30s) to catch
  payloads split across multiple sends.
- L3 external classifier (local Prompt Guard 2 ONNX preferred; Voyage
  embedding + pgvector similarity as fallback).

External content fetched by tools is additionally wrapped in an explicit
"untrusted" envelope so the model is told to treat the body as data.

### SSRF-safe fetch (`packages/shared/src/safeFetch.js`)

Every URL that originates from a user or model is routed through `safeFetch`,
which:

- Rejects non-`http(s)` protocols and bracketed-IP tricks.
- DNS-resolves the host and checks the resolved IP against private,
  loopback, link-local, CGNAT, and cloud-metadata ranges (IPv4 and IPv6,
  including IPv4-mapped IPv6 forms).
- Follows up to 3 redirects manually, re-validating each hop (defeats
  DNS-rebinding via redirect).
- Caps body size (5 MB default) and request time (10s default).

### HMAC twin signing (`packages/shared/src/twinSign.js`)

Twin-protocol REST endpoints require `X-Twin-Timestamp` and `X-Twin-Signature`
headers. Signature is `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`,
compared in constant time. Timestamps outside ±60s are rejected; recently-seen
signatures are cached to reject replays. The replay cache fails loud (refuses
new requests) under pressure rather than evicting in-window entries.

### Rate limits (`packages/shared/src/rateLimit.js`)

In-memory sliding-window limiter used on twin endpoints and a handful of
per-user tool surfaces. Keys are typically `${identity}:${ip}`. Each limiter
can also set a process-wide `globalLimit`, so high-cardinality churn cannot
turn forged keys into unlimited accepted throughput. State is still per
process; multi-replica deployments should use a shared limiter.

### Owner gating (`BOT_OWNER_ID` env)

Sensitive tools (`shell`, deploy controls, eval-shaped helpers, audit
exports) check the invoking Discord user ID against `BOT_OWNER_ID` and refuse
otherwise. This is a single-tenant trust model — there is no admin/sub-owner
distinction.

### Dashboard / aux-route auth (`packages/eris/api/dashboard.js`, `packages/eris/api/adminAuxRoutes.js`)

The Eris dashboard API, the `/api/irene/*` cross-bot proxy, and `/api/logs`
authorize non-health requests with an explicit `Authorization: Bearer
DASHBOARD_API_KEY` header. `TWIN_API_SECRET` is reserved for `/api/twin/*`
endpoints: read-only state uses a bearer check and state-changing twin calls
use body-bound HMAC signatures.

Localhost dashboard bypass is disabled by default. Operators can set
`DASHBOARD_ALLOW_LOCALHOST_BYPASS=1` for trusted single-user local development,
but it must stay off behind public tunnels, hosted deployments, reverse
proxies, or shared machines. Every dashboard surface, including the aux routes
that run before the generic API handler, is behind the same per-IP limiter
(30 req/min, shared bucket). CORS allowlists exact origins only.

The built-in Eris admin HTML is served with `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, and `Cache-Control: no-store`. The dashboard uses an
`Authorization` header rather than ambient cookies, so ordinary browser CSRF
does not carry credentials; if a future dashboard adds cookie auth, ship a CSRF
token layer at the same time.

### PC-agent destructive-command gate (`packages/eris/utils/pcAgent.js`)

On top of the owner check, the PC-agent tool surface adds:

- A kill switch (`PC_AGENT_DISABLED=1`) that disables every PC-agent tool
  even for the owner, without redeploy.
- A pattern-based destructive-command detector (`rm -rf`, `format`, `dd
  of=/dev/`, fork bombs, `Remove-Item -Recurse -Force`, `shutdown`, etc.)
  that refuses unless the caller passes `confirm: true`.
- A hard block for opaque/elevated shell forms (`-EncodedCommand`, `cmd /c`,
  `bash -c`, download-to-shell pipes, `Invoke-Expression`, `RunAs`, execution
  policy changes). These are not confirmable; the caller must send a direct,
  reviewable command instead.
- An append-only audit log to Supabase (`eris_pc_audit`) with a local
  file fallback when the DB is unreachable.

## Security Scorecard

| Category | Local score | Notes |
| --- | --- | --- |
| SSRF / outbound fetch | S | `safeFetch` validates protocol, DNS-resolved IP, redirect hops, body size, and timeout. |
| Prompt-injection detection | S | Layered firewall runs before LLM/tool dispatch, with decoders, AC prefilter, regex worker timeout, sliding window, and optional classifier. |
| Firewall enforcement placement | S | Unsafe input is blocked before context build, AI generation, or tool callbacks. |
| Owner / identity authority | S | Discord-ID keyed owner gate remains the primary shell/tool authority. |
| Destructive-command gate | S- | Destructive commands need explicit confirmation; opaque/elevated shell forms are hard-blocked. |
| Secret hygiene | S | Environment-only secrets, gitignored `.env`, redacted logs, no hardcoded credentials. |
| Twin HMAC channel | S | Body-bound HMAC, constant-time compare, timestamp skew window, replay cache pressure fail-closed. |
| DB / authz | S | Parameterized access behind owner/twin gates; Irene refuses to boot with unhydrated default state when `REQUIRE_PERSISTENCE=1`. |
| Rate limiting | S locally | Per-key plus process-wide caps; use shared state before horizontal scaling. |
| Dependency freshness | S | `npm audit` currently reports zero vulnerabilities and CI fails on moderate-or-higher advisories. |
| Deployment containment | S locally | Current documented topology is outbound-only/loopback; public exposure needs TLS and auth in front. |

## Known Gaps / Areas Needing Hardening

We try to be honest about what's not done. The following are known and on the
list, in no particular order:

1. **Audit log is append-only but not tamper-evident.** Owner with DB access
   can edit `eris_pc_audit` rows. A hash-chain or external WORM sink isn't
   wired up.
2. **Twin secret rotation is offline-only.** No graceful dual-secret
   acceptance window — operators must restart both processes.
3. **Rate limiter is in-memory.** Multi-process or multi-host deploys do not
   share state; a flooder can multiply their budget by the number of
   workers.
4. **L3 firewall classifier is optional.** Self-hosters without Voyage or the
   Prompt Guard ONNX model run on L1+L2 only.
5. **No formal threat model for the music subsystem.** Lavalink trust is
   assumed; an attacker who can reach the Lavalink port can do arbitrary
   playback / stream proxying.
6. **External dashboard CSP depends on the frontend host.** The built-in Eris
   admin panel ships CSP/frame protections, but any separately hosted dashboard
   must set its own equivalent headers.

## Secrets Handling

- All secrets — bot tokens, API keys, the twin HMAC secret, database
  credentials — are read from environment variables. There are no hardcoded
  credentials in the repo; the `.env.example` files only list variable
  names.
- `.env` files are gitignored and must never be committed.
- The `BOT_OWNER_ID` env var is the sole authorization root for owner-only
  tools — treat it with the same care as the token.

### HMAC twin secret rotation procedure

1. Generate a new high-entropy secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Update `TWIN_API_SECRET` in **both** `packages/eris/.env` and
   `packages/irene/.env`.
3. Restart both processes within the same ±60s skew window so neither
   accepts requests signed by the other's old secret.
4. Tail logs for `bad signature` or `replay-cache-pressure` warnings — both
   are expected briefly during the cutover and should clear within a minute.

If you suspect leakage of the old secret, also rotate the bot token and any
database credentials that share the host.

## Disclosure Timeline

We follow a standard 90-day coordinated-disclosure window:

- **Day 0** — Report received, acknowledged within 72 hours.
- **Day 0–14** — Triage and severity assessment. We will tell you whether
  we're treating it as a vulnerability and our rough fix ETA.
- **Day 0–90** — Fix developed, tested, and merged to `main`. For severe
  issues we may push a hotfix sooner; for low-severity we may bundle with
  other work.
- **Day 90** — If a fix is not yet shipped, you are free to publicly
  disclose. We'd prefer you check in with us before doing so in case we're
  close.
- **After fix** — We credit reporters in commit messages or release notes
  unless you'd prefer to stay anonymous.

We will not pursue legal action against good-faith researchers who comply
with this policy.
