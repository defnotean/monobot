# Monitoring & observability

What you can see today, where to look for it, and what's missing if you want a real production posture. Both bots ship a single homegrown logger and a couple of HTTP endpoints — that's the entire observability surface. No metrics, no traces, no error aggregator.

## 1. What logs look like today

One `log()` function per package — `packages/eris/utils/logger.js` and `packages/irene/utils/logger.js`. Every emit goes two places:

- **Console** — pretty, color-coded by category and severity. ANSI sequences only; respects `NO_COLOR=1`.
- **File** — `packages/<bot>/bot.log`, plain text, no ANSI. Rotates once at 5 MB to `bot.log.old`. **No timestamp-rotation, no compression, no multi-file ring.** That's the entire on-disk retention story.

Format on disk:

```
[2026-05-16 14:32:01] [Gemini] Key rate-limited for 24s — falling back to gemini-2.5-flash
```

Pretty console format:

```
14:32:01  [Gemini]      Key rate-limited for 24s — falling back to gemini-2.5-flash
```

There are **no log levels in the API**. Every call is `log(message)`. "Level" is detected heuristically from the message body via regex against `error|failed|fatal|crash|rejected|exception` (red), `warning|warn|slow|retry|degraded|fallback` (yellow), and `online|ready|success|connected|started` (green). Category comes from a `[Bracket]` prefix at the start of the message and drives the color column. Categories aren't structured fields — they're a string convention enforced by code review.

Logs are **not JSON**. Nothing is structured. No correlation IDs, no request IDs, no user-ID fields you can `jq` on. If you want field-based queries you'll need a shipper that parses `[Category] ...` line-by-line.

## 2. Key log lines to watch for

Search patterns that flag real production trouble:

| Symptom | Grep |
|---|---|
| All Gemini keys throttled | `\[(Gemini\|AI)\] Key rate-limited` |
| 429 on the dashboard/twin API | `rate limited` (Eris/Irene presence + dashboard JSON 429 body) |
| Gemini empty/malformed response | `\[Gemini\] Empty or malformed response` |
| Gemini hit the iteration cap | `\[Gemini\] Hit \d+ iteration limit` |
| Twin HMAC verification failed | `\[Twin\] Rejected:` (timestamp skew, bad signature, replay) |
| Twin replay cache pressure | `\[twinSign\] replay cache pressure` |
| Twin command execution error | `\[Twin\] Command error for` |
| Supabase write/read failure | `\[DB\]` (almost always means a Supabase call failed) |
| Supabase unreachable at boot | `\[DB\] Init attempt \d/3 failed` |
| Discord session killed | `\[CRITICAL\] Client session invalidated` (Irene exits 1) |
| Shard disconnected | `\[SHARD \d+\] Disconnected` |
| Lavalink node down | `\[Lavalink\] Node ".*" closed` / `disconnected` |
| Unhandled promise rejection | `\[UNHANDLED REJECTION\]` (Irene) / `Unhandled rejection:` (Eris) |
| Uncaught sync exception | `\[UNCAUGHT EXCEPTION\]` / `Uncaught exception:` |
| Render about to SIGKILL | `\[SHUTDOWN\] Flush error:` ≥ 8s after `Received SIGTERM` |
| Auto-deploy failure | `\[AUTODEPLOY\] Skipped:` |
| Firewall seed failure | `\[FIREWALL\] seed failed` |

OOM specifically isn't logged by the bot — Node's V8 prints `JavaScript heap out of memory` to stderr immediately before the process dies. Watch the wrapper (PM2 / systemd / Render dashboard) for that string.

Heap pressure short of OOM is observable on demand via `/api/health` (`memory: <heapUsedMB>`) and `/about` slash command. There's no periodic heap log.

## 3. Health-check endpoints

There is **no `/healthz`**. The endpoints that exist:

| Endpoint | Bot | Auth | Returns |
|---|---|---|---|
| `GET /` | Eris | none | text "Eris is awake." |
| `GET /health` | Irene | none | `{ok, user, bot}` — bot tag once gateway is up |
| `GET /api/health` | both | none | `{status, uptime, memory, db_connected, bot, guilds}` |
| `GET /presence` (and `/presence/<ownerId>`) | Irene | none, IP rate-limited 1/sec | live Discord presence cache |
| `GET /api/twin/status` | Eris | none | `{status, uptime, from: "eris"}` |

Sample curl for a self-host liveness probe:

```bash
curl -fsS http://localhost:3000/api/health    # Eris
curl -fsS http://localhost:3001/api/health    # Irene  (default PORT)
```

Note that `/health` and `/api/health` only confirm the **HTTP server** is alive — they don't verify the Discord gateway is connected. The `bot` field in the JSON falls back to `"connecting..."` if `client.user` is unset, so a probe that requires `bot != "connecting..."` is a closer approximation to "gateway up."

Irene's `index.js` also runs a 10-minute self-ping to `${RENDER_EXTERNAL_URL}/health` to keep Render's free tier from spinning down. Lines logged as `[KeepAlive] Pinged self`.

## 4. Self-host log routing

The bot only writes `bot.log` and stdout. Routing is your process supervisor's job.

**PM2 (default for the `docs/self-hosting.md` flow):**

```bash
pm2 logs eris            # tail
pm2 logs irene -f
pm2 install pm2-logrotate    # rotate ~/.pm2/logs/*.log nightly
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

**systemd / journalctl (Linux):**

```bash
sudo journalctl -u monobot-eris  -f
sudo journalctl -u monobot-eris  --since "1 hour ago" | grep '\[Twin\]'
```

Rotation is journal-side (`/etc/systemd/journald.conf`: `SystemMaxUse=`). The bot's own `bot.log` keeps rotating at 5 MB regardless.

**NSSM (Windows service):** in `services.msc` → MonoBot service → Properties → Log on tab, redirect stdout/stderr to a file. NSSM has no built-in rotation — point it at the same dir and run a scheduled task that `Compress-Archive`s old files.

**Docker / containers:** no Dockerfile ships in-repo yet. If you build your own, write to stdout (the logger already does) and let `docker logs` / your aggregator do the rest. Disable the file sink by symlinking `packages/<bot>/bot.log` → `/dev/null` to avoid double writes.

In every case, `packages/<bot>/bot.log` is a *second copy* of the log. If your supervisor already captures stdout, the file is redundant — leave it as a fallback for when you need to grep without supervisor access.

## 5. What's NOT instrumented today

Be clear-eyed about this before promising any SLO:

- **No metrics export.** No Prometheus scrape endpoint, no statsd push, no OpenTelemetry. Not in `package.json`, not anywhere in `packages/`.
- **No tracing.** No spans across the message → AI → tool → reply pipeline. If a turn took 12 seconds you have to read the log timestamps and guess.
- **No error aggregator.** No Sentry, no Bugsnag, no Rollbar. Crashes go to `bot.log` and the supervisor's stderr.
- **No structured logging.** Lines are `[Cat] free-form text`. You can't reliably query "all failures for user X" — you'd have to grep for the user ID *if* it happens to be in the message body.
- **No log levels.** `log()` is the only emit fn. Severity is regex-guessed from message text.
- **No request/correlation IDs.** A single Discord message → AI pipeline turn emits ~5-15 unrelated log lines you can't link.
- **No periodic heap snapshot.** Heap is sampled only when something calls `/api/health` or `/about`.
- **No alerting hooks built in.** Nothing fires a webhook on `[FATAL]` or `[UNHANDLED REJECTION]`. You build that with your supervisor.
- **No log shipping.** The bot writes to local disk. Loki / Datadog / CloudWatch require an external agent.
- **The "categories" are a convention.** A misspelled `[Gemmini]` is silently uncolored and your grep misses it.

## 6. Minimal viable monitoring for production self-host

If you self-host and want something better than "ssh in and tail", three escalating tiers:

**Tier 1 — supervisor only (10 minutes):**

- PM2 with `pm2-logrotate` (`max_size 10M`, `retain 14`).
- A cron that `curl -fsS localhost:PORT/api/health || pm2 restart <bot>` every minute. Restart is recovery; alert separately.

**Tier 2 — ship logs off-box (an hour):**

- Install **Vector** or **promtail** on the host. Point at PM2's log dir (`~/.pm2/logs/`) and `packages/<bot>/bot.log`.
- Pipe to **Grafana Loki** (self-host or free Grafana Cloud tier).
- Parse `[Category]` as a `category` label and the leading `\d{2}:\d{2}:\d{2}` as time. Now you have searchable, filterable, retained logs without changing any bot code.

**Tier 3 — add a real metrics layer (a day):**

- Wrap `log()` in `packages/<bot>/utils/logger.js` to also count emissions per category into a `prom-client` `Counter`.
- Expose `/metrics` on the existing HTTP server (mount alongside `/api/health`).
- Scrape from Prometheus, dashboard in Grafana. Suggested first metrics: `log_emissions_total{category}`, `gemini_429_total`, `twin_auth_failures_total`, `process_resident_memory_bytes` (default from `prom-client`).

Anything beyond that — distributed tracing, real APM, error grouping with stack-trace fingerprinting — is a larger code change and probably overkill for two-bot self-host.

## 7. Alert recipes

The bot doesn't alert. Your supervisor / log pipeline does. Two patterns that take 10 minutes apiece:

**Discord webhook on `[FATAL]` / `[UNHANDLED REJECTION]` / `[CRITICAL]` (no extra infra):**

```bash
# PM2 ecosystem.config.js — add a process that tails and posts
pm2 start "tail -F ~/.pm2/logs/eris-out.log ~/.pm2/logs/irene-out.log | \
  awk '/\\[FATAL\\]|\\[UNHANDLED REJECTION\\]|\\[CRITICAL\\]|\\[UNCAUGHT EXCEPTION\\]/ \
       { system(\"curl -fsS -X POST -H Content-Type:application/json \
         -d \\\"{\\\\\\\"content\\\\\\\":\\\\\\\"\" $0 \"\\\\\\\"}\\\" $WEBHOOK\") }'" \
  --name alert-tail
```

(Yes, that's awk + curl as a babysitter. Cheap and works.)

**Loki + Alertmanager (Tier 2 setup):**

```yaml
# alertmanager rule
- alert: BotFatal
  expr: count_over_time({job="monobot"} |~ "\\[FATAL\\]|\\[UNHANDLED REJECTION\\]" [5m]) > 0
  for: 0m
  labels: { severity: critical }
  annotations:
    summary: "MonoBot fatal/unhandled — check logs"

- alert: GeminiAllKeysThrottled
  expr: count_over_time({job="monobot"} |~ "brain overheating" [10m]) > 3
  for: 5m
  labels: { severity: warning }

- alert: SupabaseFlushFailing
  expr: count_over_time({job="monobot"} |~ "\\[DB\\] Flush .* failed" [10m]) > 5
  for: 10m
  labels: { severity: warning }
```

**Health-probe alert (any uptime monitor — UptimeRobot, BetterStack, Healthchecks.io):**

- HTTP GET `/api/health` every 60s, alert if non-200 for ≥3 checks.
- Optionally also assert `body.bot != "connecting..."` to catch a stuck Discord gateway (HTTP server up, but bot disconnected).
