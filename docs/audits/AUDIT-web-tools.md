# Web Tools Security Audit — SSRF, Content-Length Bombs, Prompt Injection

Scope: every code path where the bots fetch user- or LLM-supplied URLs, run
upstream web searches, and pipe the result back to the model as tool output.

## Tools surveyed

Eris (`packages/eris/ai/executors/webExecutor.js`) handles `web_search`,
`scrape_url`, and `check_presence` (`webExecutor.js:22-24`). `check_presence`
is a Discord-only guild presence lookup with no outbound HTTP, so it is noted
but excluded from the SSRF analysis.

Irene's web tools live in `packages/irene/ai/executors/advancedExecutor.js`
(the `packages/irene/ai/executors/webExecutor.js` named in the task brief does
not exist). It handles `web_search` and `web_read`
(`advancedExecutor.js:264, 525, 596`).

Both bots delegate the universal search fallback chain to
`packages/shared/src/ai/webSearchEngine.js` (note: nested under `ai/`, not
directly in `src/`). `performWebSearch` cascades through Brave Answers, Brave
Search, SearxNG, Tavily, Serper, Google CSE, and a DuckDuckGo Lite scrape
(`webSearchEngine.js:91-251`).

The SSRF defense layer is `packages/shared/src/safeFetch.js`.

## Defense-in-depth chain

1. URL parse + protocol allowlist (http/https only) — `safeFetch.js:77-79`.
2. Hostname denylist for `localhost`, `*.localhost`, `*.internal`, `*.local`
   before any DNS — `safeFetch.js:85-86`.
3. Literal-IP guard against private/loopback/link-local/CGNAT/IPv4-mapped-v6
   forms — `safeFetch.js:22-65, 91-93`.
4. DNS resolution with re-validation of the resolved address (DNS rebinding
   defense) — `safeFetch.js:102-117`.
5. Manual 3xx redirect handling with per-hop re-validation, max 3 hops —
   `safeFetch.js:144-164`.
6. Streaming body cap (5 MB default) with reader cancel on overflow —
   `safeFetch.js:168-189`.
7. 10 s AbortSignal timeout — `safeFetch.js:138-139, 17`.
8. `wrapUntrusted` envelope tags fetched text as DATA, not instructions, in
   the tool-result returned to the LLM — `safeFetch.js:202-207`.
9. `wrapUntrustedWithFirewall` additionally runs `checkInjection` on the body
   and replaces it with a redacted placeholder on hit —
   `safeFetch.js:219-234`.

## Per-tool findings

### Eris `web_search` — `webExecutor.js:53-94`
- Input: `{ query | search | q: string }`; no length cap.
- URL path: query is sent to Gemini grounding (`googleSearch` tool) when
  available, otherwise to `performWebSearch`. No direct outbound URL from
  user input — SSRF surface here is the upstream backends only.
- Content cap / timeout: 25 s race on Gemini grounding
  (`webExecutor.js:71`); 10 s passed to `performWebSearch`
  (`webExecutor.js:89`). Backend body cap is bounded only by the upstream
  client's behavior (raw `fetch` inside `webSearchEngine.js` — see Risk 1).
- Output: wrapped by `wrapWebOutput` → `wrapUntrustedWithFirewall`
  (`webExecutor.js:15-20, 79, 90`).

### Eris `scrape_url` — `webExecutor.js:96-115`
- Input: `{ url | link: string }`; no scheme or length pre-check beyond what
  `safeFetch` enforces.
- URL path: `safeFetch` with the full SSRF stack
  (`webExecutor.js:101-104`).
- Content cap: 5 MB raw body via `safeFetch`; then cheerio strips
  script/style/nav/footer/header/aside/iframe; final string truncated to
  2000 chars (`webExecutor.js:107-111`). Timeout 10 s.
- Output: wrapped by `wrapWebOutput`.

### Irene `web_search` — `advancedExecutor.js:525-594`
- Input: `{ query: string }`; per-user rate limit via
  `checkWebRateLimit(webRateLimitPerMin)` (`advancedExecutor.js:526-527`).
- URL path: Tier 1 hits Google CSE through `safeFetch`
  (`advancedExecutor.js:540`) — query is URL-encoded
  (`advancedExecutor.js:531, 539`). Tier 2 is Gemini grounding. Tier 3
  delegates to `performWebSearch` (same caveats as Eris).
- Content cap / timeout: 10 s on CSE, 25 s race on Gemini, 10 s on
  `performWebSearch`.
- Output: wrapped by `wrapWebOutput` (`advancedExecutor.js:15-20`).

### Irene `web_read` — `advancedExecutor.js:596-628`
- Input: `{ url: string }`; per-user rate limit.
- URL path: `safeFetch` with full SSRF stack
  (`advancedExecutor.js:602-605`).
- Content cap: 5 MB raw body via `safeFetch`; stripped with naked regex
  (`<script>`, `<style>`, then `<[^>]+>` for all tags), entity-decoded, then
  truncated to 3000 chars (`advancedExecutor.js:609-623`). Timeout 10 s.
- Output: wrapped by `wrapWebOutput`.

### `performWebSearch` backends — `webSearchEngine.js:91-251`
All seven backends use raw `fetch` (no `safeFetch`) against hard-coded
provider URLs — acceptable because the host is not user-controlled. Each path
sets an AbortSignal timeout via `timeoutFor`/`withTimeout`
(`webSearchEngine.js:16-26`). None of them caps response body size, and none
streams — `await res.json()` / `res.text()` will buffer whatever the upstream
returns (see Risk 1).

The DuckDuckGo Lite fallback (`webSearchEngine.js:215-247`) parses returned
HTML with cheerio. There is no `wrapUntrusted` here; wrapping happens one
layer up in the executor.

## Top 5 risks (severity-ranked)

1. **High — `performWebSearch` has no response-size cap.** Every backend in
   `webSearchEngine.js` does `await res.json()` / `await res.text()` with no
   byte limit (`webSearchEngine.js:111, 130, 145, 165, 188, 205, 230`). A
   compromised or impersonated upstream (especially the SearxNG instance, which
   the operator controls but is HTTP-fetched without `safeFetch`, lines
   139-143) could serve a multi-GB JSON body and OOM the process.
2. **High — SearxNG URL is templated but not SSRF-checked.** Line 141 does
   `config.searxngQueryUrl.replace("<query>", encodeURIComponent(query))`
   and feeds it to raw `fetch` (line 143). If `searxngQueryUrl` is ever
   sourced from anything but trusted env (e.g. a per-guild config), it is a
   direct SSRF — bypasses `safeFetch` entirely.
3. **Medium — Irene `web_read` HTML stripping uses naked regex.** Lines
   609-620 strip tags with `/<[^>]+>/g`. Malformed HTML (e.g. attribute values
   containing `>`) can leak raw script bodies into the model's context,
   defeating the script-removal intent. Eris's path uses cheerio
   (`webExecutor.js:105-110`) and is safer — Irene should align.
4. **Medium — Prompt-injection firewall is best-effort, not blocking.** When
   `firewallCheck` throws, `wrapUntrustedWithFirewall` swallows the error and
   returns the unredacted body (`safeFetch.js:223-231`). A malicious page
   that crashes the firewall (e.g. via a regex blow-up in the pattern set)
   bypasses redaction. The `wrapUntrusted` envelope remains, but envelope
   alone is a soft defense.
5. **Low — Gemini grounding sources are not validated.** Source URLs are
   appended to the tool result verbatim (`webExecutor.js:76-78`,
   `advancedExecutor.js:576-578`). A model-hallucinated or attacker-controlled
   `web.uri` could embed a `javascript:` link in the LLM's reply context that
   Discord renders harmlessly but a downstream consumer (a webhook, a future
   feature) might not.

## Remediation suggestions

- Add a `MAX_BODY_BYTES` guard in `webSearchEngine.js`. Cheapest fix: read
  `res.body` via a streaming reader mirroring `safeFetch.js:176-189`, with a
  ~256 KB cap (search APIs return tiny payloads).
- Route the SearxNG and DuckDuckGo Lite calls through `safeFetch` — both are
  HTTP fetches that ultimately resolve to operator- or third-party-controlled
  hosts. The Brave/Tavily/Serper/Google calls hit hard-coded vendor TLDs and
  can stay on raw `fetch`.
- Switch Irene's `web_read` to cheerio (it is already a runtime dependency
  per the Eris path) and reuse the same `script,style,nav,footer,header,
  aside,iframe` strip set.
- In `wrapUntrustedWithFirewall`, treat a firewall throw as fail-closed —
  return the redacted placeholder when `firewallCheck` errors. Today it
  fails open.
- Validate Gemini grounding URLs through `validateUrl` before appending
  them to the tool output; drop any that fail.
- Cap the `query` input length in all four entry points
  (`webExecutor.js:54`, `advancedExecutor.js:528`) to a sensible bound
  (e.g. 512 chars) to reduce upstream-cost amplification.
