# Audit: Env Var Handling

Scope: `packages/eris/config.js`, `packages/irene/config.js`, both `.env.example`
files, and every `process.env.*` / `env(...)` callsite under `packages/`. Goal:
confirm each variable is documented, mark insecure defaults, find leakage in
logs, and verify which keys actually fail the boot.

## Env var inventory

### Eris (`packages/eris/config.js`)

| Var | Required | Default | Source line |
|---|---|---|---|
| `DISCORD_TOKEN` | yes (FATAL) | — | `config.js:199` |
| `CLIENT_ID` | yes (FATAL) | — | `config.js:200` |
| `BOT_OWNER_ID` | recommended | — | `config.js:201` |
| `PORT` | no | `3000` | `config.js:202` |
| `BOT_NAME` | no | `eris` | `config.js:206` |
| `PC_AGENT_DISABLED` | no | `0` | `config.js:210` |
| `TWIN_API_SECRET` / `IRENE_API_URL` / `TWIN_BOT_ID` | no | — | `config.js:212-214` |
| `AI_PROVIDER` | no | `gemini` | `config.js:180` |
| `GEMINI_API_KEY[_2..4]` | conditional FATAL | — | `config.js:267-272` |
| `NVIDIA_API_KEY` / `NVIDIA_*` tunables | conditional FATAL | various | `config.js:233-246` |
| `OPENAI_COMPAT_*` + provider aliases | conditional FATAL | provider-derived | `config.js:248-264` |
| `VOYAGE_API_KEY` | no | — | `config.js:225` |
| `SUPABASE_URL` / `SUPABASE_KEY` | warn-only | — | `config.js:282-287` |
| `REQUIRE_PERSISTENCE` | no | `0` | `config.js:284` |
| `LASTFM_API_KEY` | warn-only | — | `config.js:289` |
| `KLIPY_API_KEY` / `GITHUB_TOKEN` / `RENDER_API_KEY` | no | — | `config.js:290-292` |
| `DREAM_CHANNEL_ID` / `BRIEFING_CHANNEL_ID` | no | — | `config.js:293-294` |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | no (all-or-nothing) | — | `config.js:297-301` |
| `BRAVE_*`, `SEARXNG_*`, `TAVILY_*`, `SERPER_*`, `GOOGLE_SEARCH_*`, `WEB_SEARCH_*_TIMEOUT_MS` | no | various | `config.js:304-315` |
| `TIMEOUT_QUICK_REPLY` / `_WORKER` / `_FETCH` | no | 15000 / 60000 / 5000 | `config.js:363-365` |
| `NO_COLOR` | no | unset | `utils/logger.js:14` |
| `DASHBOARD_API_KEY` / `DASHBOARD_URL` | no | — | `api/dashboard.js:27,77` |
| `EXTERNAL_URL` / `RENDER_EXTERNAL_URL` | no | — | `api/dashboard.js:27` |
| `WEB_SEARCH_GEMINI_GROUNDING` | no | unset | `ai/executors/webExecutor.js:42` |

### Irene (`packages/irene/config.js`)

Same shape as Eris with these deltas:

| Var | Required | Default | Source line |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` (vs `DISCORD_TOKEN`) | yes (FATAL) | — | `config.js:189` |
| `DISCORD_CLIENT_ID` / `DISCORD_USER_ID` | yes / recommended | — | `config.js:190-191` |
| `ERIS_API_URL` / `ERIS_BOT_ID` | no | — | `config.js:201-202` |
| `LAVALINK_HOST` / `_PORT` / `_PASSWORD` / `_SECURE` | no | `localhost` / `2333` / **`youshallnotpass`** / `false` | `config.js:204-207` |
| `GEMINI_API_KEY[_2..12]` | conditional FATAL | — | `config.js:248-261` |
| `SUPABASE_ANON_KEY` | no (fallback for `_KEY`) | — | `config.js:268` |
| `DUAL_WRITE_PERSISTENCE` | no | `false` | `config.js:297` |
| `TWITCH_CLIENT_ID` / `_SECRET` | no | — | `config.js:289-290` |
| `TIMEOUT_WORKER_FAST` / `_SLOW` / `TOOL_FAST` / `_SLOW` / `_VERY_SLOW` | no | 35000 / 60000 / 15000 / 30000 / 60000 | `config.js:354-360` |
| `WEB_SEARCH_GEMINI_GROUNDING` | no | unset | `ai/executors/advancedExecutor.js:84` |

The Discord-side var rename (`DISCORD_TOKEN` vs `DISCORD_BOT_TOKEN`,
`CLIENT_ID` vs `DISCORD_CLIENT_ID`, `BOT_OWNER_ID` vs `DISCORD_USER_ID`)
between the two bots is a deliberate split — both names are documented in
their respective `.env.example` and noted in `docs/start-here.md`.

## Documentation completeness

Walking every `env(...)`/`process.env.*` site versus the two `.env.example`
files, the following are **used but not documented**:

| Var | Used at | Status |
|---|---|---|
| `WEB_SEARCH_GEMINI_GROUNDING` | `packages/eris/ai/executors/webExecutor.js:42`, `packages/irene/ai/executors/advancedExecutor.js:84` | Missing in **both** `.env.example` |
| `TWIN_BOT_ID` | `packages/eris/config.js:214,326` | Missing in `packages/eris/.env.example` (Irene's `ERIS_BOT_ID` counterpart IS documented at `irene/.env.example:237`) |

Everything else has a stanza with a `Required: …` annotation and a
"Where to get it" pointer. Quality of those stanzas is high — the recent
open-source-prep commit (`b59e54c`) put work into making each key
self-explanatory.

## Insecure defaults

| Var | Default | Severity | Note |
|---|---|---|---|
| `LAVALINK_PASSWORD` | `"youshallnotpass"` (`packages/irene/config.js:206`) | Medium | This is the published Lavalink stock password. It's only safe if the Lavalink node is on `localhost` and the bind address is `127.0.0.1`; a node exposed on `0.0.0.0` with this default is open to anyone. The `.env.example:175-176` flags it as "Default: youshallnotpass" but doesn't warn about exposure. |
| `LAVALINK_SECURE` | `"false"` | Low | Acceptable for localhost; would be a leak for a tunneled node. Documented. |
| `REQUIRE_PERSISTENCE` | `"0"` | Low | Documented. Production deploys are told to flip it to `1`. |
| `DUAL_WRITE_PERSISTENCE` | `"false"` | none | Default-off is correct for the migration phase it gates. |
| `PC_AGENT_DISABLED` | `"0"` (Eris) | Medium for unattended hosts | The PC-agent surface is owner-only via Discord ID, so the default is consistent with how Eris is shipped, but a fresh self-hoster who forgets to set `BOT_OWNER_ID` gets the previous owner ID baked into the personality prompts (`prompts/eris-relationships.md`). See AUDIT-pc-agent.md. |
| `OPENAI_COMPAT_BASE_URL` | OpenRouter URL in the `.env.example` (`packages/{eris,irene}/.env.example:77`/`93`) | none | This is a docs default, not a code default. Code falls back to a per-provider URL based on `AI_PROVIDER`. |

No hardcoded API keys, tokens, or owner IDs survive in `config.js`,
verified by Grep against the secret-shaped substrings used historically.
The NVIDIA-key inline fallback that lived in the file was removed pre-
release (`config.js:228-231` comment).

## Logging leaks

`packages/{eris,irene}/utils/logger.js` is a thin wrapper around
`console.log` plus a 5-MB rolling file at `bot.log`. **It has no
redaction layer.** Anything passed to `log()` lands in both stdout and
the on-disk log verbatim.

Inspection of every `log(...)` callsite under `packages/`:
- No callsite interpolates `config.token`, `config.geminiKeys`,
  `config.nvidia.apiKey`, `config.twinApiSecret`, `config.supabaseKey`,
  `config.voyageApiKey`, `config.lastfmApiKey`, `config.klipyApiKey`,
  `config.renderApiKey`, `config.githubToken`, or any `*ClientSecret`.
- No callsite serializes the `config` object with `JSON.stringify` /
  `util.inspect`. Verified by Grep.
- Twitch error logger logs `${res.status}` only, not the body
  (`packages/irene/utils/twitch.js:33,43`).
- Error logs use `err.message` rather than `err.stack` in the cases
  inspected, so axios-style "request config" objects that embed
  `Authorization` headers are not at risk via the standard path.

There is no token-shape regex on the way to `appendFile` either. That is
fine **today** because no current callsite leaks, but it's brittle: any
future contributor who writes `log(JSON.stringify(req.headers))` or
`log(\`fetch failed for \${url}\`)` (where `url` carries `?api_key=`)
sends secrets straight to disk. A defense-in-depth redaction pass in
`utils/logger.js` (Discord token shape `[A-Za-z0-9._-]{24,}\.[A-Za-z0-9._-]{6,}\.[A-Za-z0-9._-]{27,}`,
Gemini `AIza…`, `Bearer\s+\S+`) would close the gap with ~20 lines.

## Boot-time validation

Both bots fail-fast on the same set of critical conditions, verified at
`packages/eris/config.js:374-402` and `packages/irene/config.js:368-393`:

| Check | Action |
|---|---|
| `config.token` missing | `console.error("[FATAL] …")` → `process.exit(1)` |
| `config.clientId` missing | FATAL exit |
| `AI_PROVIDER=gemini` but `geminiKeys.length === 0` | FATAL exit |
| `AI_PROVIDER=nvidia\|kimi` but `nvidia.apiKey` missing | FATAL exit |
| OpenAI-compatible `AI_PROVIDER` but `openaiCompat.apiKeys.length === 0` and not in the lmstudio/ollama allowlist | FATAL exit |
| `AI_PROVIDER` not in `{gemini, google, nvidia, kimi, <openai-compat aliases>}` | FATAL exit |

Warn-only (non-fatal):
- `supabaseEnabled === false` → `[WARN]` ("running without persistence")
- Eris: `lastfmApiKey` missing → `[WARN]` (`/fm` will fail)

This matches what the `.env.example` "MINIMUM VIABLE LOCAL DEV" stanzas
promise. `TWIN_API_SECRET` deliberately doesn't fail boot — the twin link
is optional, and missing it just 401s twin calls (verified at
`packages/eris/api/dashboard.js:283-331`).

Edge case: `REQUIRE_PERSISTENCE=1` is read into `config.requirePersistence`
but **no callsite checks it to abort startup** when Supabase is also
missing. The flag exists in both `.env.example` files as "production
deploys should use 1", but flipping it doesn't actually change behavior
today — it's wired but not enforced. Either remove the flag or add the
`if (config.requirePersistence && !config.supabaseEnabled) process.exit(1)`
check next to the other FATAL blocks.

## Top 5 issues

1. **`REQUIRE_PERSISTENCE=1` is documented but not enforced.** Both
   `.env.example` files tell production deployers to set it; the
   validation block silently ignores it. Either wire it into the
   fail-fast loop or drop it from the docs.
2. **`WEB_SEARCH_GEMINI_GROUNDING` is undocumented.** Used in both
   bots' web executors but absent from both `.env.example` files —
   self-hosters have no way to discover the toggle. Add a stanza near
   the other `WEB_SEARCH_*` keys.
3. **`TWIN_BOT_ID` missing from Eris `.env.example`.** Used in
   `eris/config.js:214` and substituted into personality prompts; the
   Irene counterpart (`ERIS_BOT_ID`) IS documented. Asymmetric.
4. **`LAVALINK_PASSWORD` defaults to the published stock value.** Safe
   when Lavalink binds to localhost; a footgun the moment it doesn't.
   Either harden the `.env.example` warning ("change this if the
   Lavalink port is reachable off-host") or fail boot when the password
   equals `"youshallnotpass"` **and** `LAVALINK_HOST !== "localhost"`.
5. **Logger has no secret-shaped redaction.** No current callsite leaks
   (audited), but the on-disk log will faithfully record anything a
   future `log(...)` adds. Adding a 5-pattern strip in
   `utils/logger.js` (Discord token, `AIza…`, `Bearer …`, `sk-…`,
   `xoxb-…`) is cheap insurance.
