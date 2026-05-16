# Logger Secret / PII Leak Audit

Scope: every code path that emits log output from the two bots — file appender,
console transport, and ad-hoc `console.*` calls — surveyed for credential
exposure (Discord bot token, AI API keys, dashboard secrets) and user-identifier
exposure (Discord IDs, tags, usernames, message content, guild names).

## Logger inventory

There is no third-party logger (no `pino`, `winston`, `bunyan`, or `debug`).
Each bot has its own ~120-line module:

- `packages/eris/utils/logger.js` — exports `log(message)`. Buffers lines for
  500 ms, then `appendFile` to `packages/eris/bot.log` with a 5 MB roll. Console
  half adds ANSI category tinting (`logger.js:101-117`).
- `packages/irene/utils/logger.js` — same shape as Eris', plus `sendModLog()`
  for guild-facing audit-log embeds (`logger.js:136-180`).

The file transport writes the raw `message` argument verbatim — no key
allowlist, no value redaction, no field-level structure. Every call site is
responsible for redacting before formatting the string.

Across `packages/`, `log(` is invoked **1052** times. There are also a handful
of direct `console.error` / `console.warn` calls in startup paths
(`packages/eris/config.js:375-405`, `packages/irene/config.js:369-396`,
`packages/irene/database.js:182-390`) and one stack dump
(`packages/irene/ai/rulesEnforcer.js:215`).

## Sensitive-data exposure points

### Credentials — clean

The Discord bot token is never logged. `client.login(config.token)` is the only
consumer (`packages/eris/index.js:118`, `packages/irene/index.js:264`), and
discord.js does not echo it into any error event we trap (`client.on("error",
err => log(\`[ERROR] \${err.message}\`))` at `eris/index.js:328`).

AI provider keys (`NVIDIA_API_KEY`, `GEMINI_API_KEY`,
`OPENAI_COMPAT_API_KEYS`) are referenced only by **name** in fatal-config
output (`packages/eris/config.js:386-396`) and provider-status messages
(`nvidia.js:414`, `nvidia.js:440`). The key value never appears in a template
literal. The `Authorization: Bearer ${apiKey}` header is constructed once in
`openaiCompat.js:104` / `nvidia.js:78,270`; the variable is never echoed.

The dashboard / twin secret comparison in `packages/eris/api/dashboard.js:78`
short-circuits with a generic `401 { error: "unauthorized" }` and does not log
the rejected token — good.

### Upstream provider error bodies — minor risk

`postChatWithKey` constructs `new Error(\`HTTP \${res.status}: \${errText.slice(0, 300)}\`)`
(`packages/eris/ai/providers/openaiCompat.js:120-123`), then the catch site at
`openaiCompat.js:462` logs `err.message`. `nvidia.js:278-287` does the same
with a 200-char slice. The captured `errText` is the upstream response body —
NVIDIA / OpenRouter / Gemini do not echo the inbound `Authorization` header,
but they DO sometimes echo the request URL, request id, and on 4xx the
masked-key prefix. Not a clear-text leak today, but couples the audit trail to
provider behaviour we don't control.

### Discord IDs and usernames — pervasive but expected

`message.author.username`, `member.user.tag`, `guild.name`, `guild.id`, and
`channel.name` appear in `log()` arguments throughout `packages/eris/events/`
and `packages/irene/events/` (e.g. `irene/events/messageCreate.js:769`,
`irene/events/interactionCreate.js:287-294`,
`irene/events/guildMemberAdd.js:260-342`,
`irene/utils/antinuke.js:150-195`). Discord IDs and tags are quasi-public, but
the volume + file persistence makes `bot.log` a soft user-activity ledger.

### Message content — partial leak

`packages/eris/events/messageCreate.js:471-472` logs the first 150 chars of a
bot-sourced message when bump detection almost-matches. `messageCreate.js:738`
logs the length of a blocked oversize message, not the content. AI tool-call
trace logs (`openaiCompat.js:561`, `nvidia.js:358`, `irene/ai/dual.js:553`)
emit `JSON.stringify(fnArgs).slice(0, 100)` — args to tools like `web_search`
include the user's literal query.

### SQL / structured data — clean

No `INSERT` / `SELECT` / `UPDATE` / `DELETE` text is constructed by the bots
(all DB access is via the Supabase JS client). `db.saveInteraction` errors are
logged as `\`[DB] saveInteraction: \${error.message}\``
(`packages/eris/database.js:278`) — no row payload.

### Stack traces — present but bounded

`packages/eris/events/messageCreate.js:1546` logs the first 5 stack lines on
AI-pipeline failure. `packages/irene/index.js:362-367` traps
`unhandledRejection` and `uncaughtException` and logs `err.stack`. A stack from
an HTTP-client failure can occasionally contain a URL with query-string
auth — worth a redactor in the logger transport.

## Redaction recommendations

1. **Add a single redactor at the logger boundary.** A regex pass over
   `message` in both `logger.js` files that strips `Bearer [\w-]{20,}`,
   `key=[\w-]{20,}`, `api[_-]?key=[\w-]{20,}`, and `sk-[\w-]{20,}` before
   `appendFile` and before `console.log`. Cheap insurance against future
   callers that forget.
2. **Cap upstream error bodies and strip URLs.** In `postChatWithKey` /
   NVIDIA's main fetch, replace `errText.slice(0, 300)` with a function that
   also runs the same secret-shape regex. Optionally truncate to 120 chars —
   nothing useful past that for triage.
3. **Hash Discord IDs for non-moderation logs.** Keep raw IDs in mod-log
   embeds (operator needs them) but route user-activity logs through
   `crypto.createHash("sha256").update(id).digest("hex").slice(0,8)`. Same
   user → same hash within a deploy, no cross-deploy correlation.
4. **Drop or gate `JSON.stringify(fnArgs)`.** The 100-char slice in
   `openaiCompat.js:561` / `nvidia.js:358` echoes user prompts. Either log
   the tool name + arg-key list only, or gate behind `DEBUG_AI=1`.
5. **Centralize on a level.** Today everything is `info` and lands in the
   same file. Add a `log.debug()` that no-ops in production and move the
   noisy fnArgs / per-key rotation traces under it.

## Per-call risk table

| Call site                                           | Secret? | PII?            | Auth header? | Risk |
|-----------------------------------------------------|---------|-----------------|--------------|------|
| `openaiCompat.js:462` `chat failed: ${err.message}` | indirect (provider body) | no | no | medium |
| `nvidia.js:287` `chat call failed: ${e.message}`    | indirect (200-char body) | no | no | medium |
| `nvidia.js:302` `No message in response: JSON…200`  | no      | no              | no           | low |
| `nvidia.js:358` `${fnName}(${JSON.stringify(fnArgs).slice(0,100)})` | no | user query  | no | medium |
| `openaiCompat.js:561` same                          | no      | user query      | no           | medium |
| `irene/ai/dual.js:553` `${name}(${JSON.stringify(args)})` | no | user query (unsliced) | no | high |
| `eris/events/messageCreate.js:472` bump snippet 150ch | no | message content | no         | low |
| `eris/events/messageCreate.js:769` `from ${author.username}` | no | username   | no         | low |
| `irene/events/messageCreate.js:2155` `[ERROR STACK] ${stack}` | no | indirect | no    | medium |
| `irene/index.js:362` `unhandledRejection ${stack}`  | indirect | indirect      | no           | medium |
| `eris/api/dashboard.js:380` `Twin punish for ${body.user_id}` | no | Discord id  | no    | low |
| `eris/database.js:278` `saveInteraction: ${msg}`    | no      | no              | no           | low |

## Top 5 worst offenders

1. **`packages/irene/ai/dual.js:553` and `:714`** — `log(\`[Gemini] ${name}(${JSON.stringify(args)})\`)`
   logs tool arguments with no slice cap. A `web_search({query: "<user
   question verbatim>"})` lands in `bot.log` in full.
2. **`packages/eris/ai/providers/nvidia.js:278-287`** — upstream response body
   (200 chars) is embedded in the thrown `Error` and re-emitted via the catch
   logger. Provider behaviour drift could surface a request id or masked key
   here.
3. **`packages/eris/ai/providers/openaiCompat.js:120-123, 462`** — same shape
   as above with a wider 300-char slice. Of the two, this one is the bigger
   surface because the OpenAI-compat baseUrl is user-configurable
   (OpenRouter, Together, self-hosted vLLM all behave differently).
4. **`packages/irene/events/messageCreate.js:2155`** — `[ERROR STACK] ${error?.stack ?? JSON.stringify(error)}`
   has no truncation. A stack from a `fetch` failure can include the failing
   URL, sometimes with query-string auth, written verbatim to `bot.log`.
5. **`packages/irene/index.js:362-367`** — process-level handlers log full
   `err.stack` for every unhandled rejection / uncaught exception. Same URL-
   in-stack risk as above, plus the failure mode means the file fills fast
   when something is wrong.
