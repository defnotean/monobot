# CONFIGURATION

Exhaustive environment variable reference for the MonoBot monorepo (Eris + Irene).

Both bots load their `.env` synchronously at process start via a manual parser in
`packages/eris/config.js:29-42` and `packages/irene/config.js:36-51`. Deployed
`process.env` values win over local `.env` defaults — see the `env()` helper at
`packages/eris/config.js:47-49` and `packages/irene/config.js:54-56`. A subset of
runtime modules also read `process.env.*` directly (web search, dashboard CORS,
keep-alive ping, GIF tool, logger color toggle); those are noted in the citation
column.

For the smallest viable boot set, see the **MINIMUM VIABLE LOCAL DEV** block at
the bottom of each `.env.example`. For the deploy-side surface, see `render.yaml`
at the repo root.

---

## Master Table

| Var | Bot | Required? | Default | Purpose | Where to get it |
|---|---|---|---|---|---|
| `DISCORD_TOKEN` | Eris | **Yes** (fatal) | — | Gateway bot token. Read at `packages/eris/config.js:199`; validated `:374-377`. | discord.com/developers/applications -> Bot -> Reset Token |
| `DISCORD_BOT_TOKEN` | Irene | **Yes** (fatal) | — | Gateway bot token. Read at `packages/irene/config.js:189`; validated `:368-371`. | discord.com/developers/applications -> Bot -> Reset Token |
| `CLIENT_ID` | Eris | **Yes** (fatal) | — | Application ID for slash command registration. Read at `packages/eris/config.js:200`; validated `:378-381`. | discord.com/developers/applications -> General Information -> Application ID |
| `DISCORD_CLIENT_ID` | Irene | **Yes** (fatal) | — | Application ID for slash command registration. Read at `packages/irene/config.js:190`; validated `:372-375`. | Same as above |
| `BOT_OWNER_ID` | Eris | No (recommended) | — | Bot owner Discord user ID. Drives owner-only PC agent tools and the "boss" label. Read at `packages/eris/config.js:201, 325`. | Discord -> Developer Mode -> right-click your name -> Copy User ID |
| `DISCORD_USER_ID` | Irene | No (recommended) | — | Bot owner Discord user ID. Same role on the Irene side. Read at `packages/irene/config.js:191, 306`. | Same as above |
| `BOT_NAME` | Both | No | `eris` / `irene` | Stable identifier for personality/longmemory/audit rows in Supabase. Changing creates a fresh personality. Read at `packages/eris/config.js:206`, `packages/irene/config.js:196`. | Pick one and keep it stable |
| `PORT` | Both | No | `3000` (Eris) / `3001` (Irene) | HTTP port for the dashboard / presence / health-check API. Render and similar PaaS hosts inject their own. Read at `packages/eris/config.js:202`, `packages/irene/config.js:192`. | Set to whatever your reverse proxy expects |
| `AI_PROVIDER` | Both | No | `gemini` | Selects the provider module under `ai/providers/`. Accepts `gemini`, `nvidia`, `kimi`, or an OpenAI-compatible alias: `openai-compatible`, `openai`, `openrouter`, `groq`, `cerebras`, `mistral`, `deepinfra`, `together`, `github`, `cloudflare`, `lmstudio`, `ollama`. Read at `packages/eris/config.js:180`, `packages/irene/config.js:135`; validated `packages/eris/config.js:399-402`, `packages/irene/config.js:390-393`. | n/a — pick based on which provider key you have |
| `GEMINI_API_KEY` | Both | Conditional (fatal if `AI_PROVIDER=gemini`) | — | Primary Google AI Studio key. Read at `packages/eris/config.js:268`, `packages/irene/config.js:249`; validated `packages/eris/config.js:383-386`, `packages/irene/config.js:378-381`. | aistudio.google.com -> Get API key |
| `GEMINI_API_KEY_2` .. `GEMINI_API_KEY_4` | Eris | No | — | Extra rotation keys for rate-limit smoothing. `packages/eris/config.js:269-271`. | Same as above |
| `GEMINI_API_KEY_2` .. `GEMINI_API_KEY_12` | Irene | No | — | Up to 12 rotation keys (extras are dropped by `.filter(Boolean)`). `packages/irene/config.js:250-260`. | Same as above |
| `GEMINI_MODEL` | Both | No | `gemini-3.1-pro-preview` | Main Gemini model ID. `packages/eris/config.js:274`, `packages/irene/config.js:322`. | n/a |
| `GEMINI_FALLBACK_MODEL` | Both | No | `gemini-2.5-flash` | Fallback model when the primary fails. `packages/eris/config.js:275`, `packages/irene/config.js:323`. | n/a |
| `GEMINI_FAST_MODEL` | Both | No | `gemini-3-flash-preview` | Cheaper/faster Gemini for short replies. `packages/eris/config.js:276`, `packages/irene/config.js:324`. | n/a |
| `NVIDIA_API_KEY` | Both | Conditional (fatal if `AI_PROVIDER=nvidia` / `kimi`) | — | NVIDIA NIM API key (Kimi K2.6 default). `packages/eris/config.js:233`, `packages/irene/config.js:216`; validated `packages/eris/config.js:387-390`, `packages/irene/config.js:382-385`. | build.nvidia.com -> API Keys |
| `NVIDIA_BASE_URL` | Both | No | `https://integrate.api.nvidia.com/v1` | NVIDIA endpoint base. `packages/eris/config.js:234`, `packages/irene/config.js:217`. | n/a |
| `NVIDIA_MODEL` | Both | No | `moonshotai/kimi-k2.6` (kimi) / `meta/llama-3.3-70b-instruct` (nvidia) | NIM model ID. `packages/eris/config.js:235`, `packages/irene/config.js:218`. | n/a |
| `NVIDIA_FAST_MODEL` | Both | No | inherits `NVIDIA_MODEL` | Fast-path NIM model. `packages/eris/config.js:236`, `packages/irene/config.js:219`. | n/a |
| `NVIDIA_MAX_TOKENS` | Both | No | `16384` (kimi) / `4096` (other) | Max output tokens. `packages/eris/config.js:237`, `packages/irene/config.js:220`. | n/a |
| `NVIDIA_TEMPERATURE` | Both | No | `1.0` (kimi) / `0.4` (other) | Sampling temperature. `packages/eris/config.js:238`, `packages/irene/config.js:221`. | n/a |
| `NVIDIA_TOP_P` | Both | No | `1.0` (kimi) / `0.95` (other) | Nucleus sampling cap. `packages/eris/config.js:239`, `packages/irene/config.js:222`. | n/a |
| `NVIDIA_THINKING` | Both | No | `true` (kimi) / `false` (other) | Toggles Kimi's `chat_template_kwargs.thinking` flag. `packages/eris/config.js:242`, `packages/irene/config.js:223`. | n/a |
| `NVIDIA_TOOL_STRICTNESS` | Both | No | `balanced` (kimi) / `strict` (other) | Tool-call argument validation level. `packages/eris/config.js:245`, `packages/irene/config.js:224`. | n/a |
| `OPENAI_COMPAT_API_KEY` | Both | Conditional (fatal if `AI_PROVIDER` is an OpenAI-compat alias and `OPENAI_COMPAT_ALLOW_NO_API_KEY!=1`) | — | Single API key for the generic OpenAI-compat client. `packages/eris/config.js:250` (resolved via `envFirst`), `packages/irene/config.js:231`; validated `packages/eris/config.js:391-398`, `packages/irene/config.js:386-389`. | Provider-dependent |
| `OPENAI_COMPAT_API_KEYS` | Both | No | — | Comma/space-separated key pool for rotation. `packages/eris/config.js:251`, `packages/irene/config.js:232`. | Same |
| `OPENAI_COMPAT_BASE_URL` | Both | No | Per-alias default (e.g. `https://openrouter.ai/api/v1`) | Override the upstream `/chat/completions` URL. `packages/eris/config.js:252`, `packages/irene/config.js:233`. | n/a |
| `OPENAI_COMPAT_MODEL` | Both | No | Per-alias default (e.g. `openrouter/owl-alpha` in `.env.example`) | Model ID. `packages/eris/config.js:253`, `packages/irene/config.js:234`. | n/a |
| `OPENAI_COMPAT_FAST_MODEL` | Both | No | inherits `OPENAI_COMPAT_MODEL` | Fast-path model. `packages/eris/config.js:254`, `packages/irene/config.js:235`. | n/a |
| `OPENAI_COMPAT_MAX_TOKENS` | Both | No | `4096` (config default; `.env.example` ships `8192`) | Output cap. `packages/eris/config.js:255`, `packages/irene/config.js:236`. | n/a |
| `OPENAI_COMPAT_TEMPERATURE` | Both | No | `0.4` | Temperature. `packages/eris/config.js:256`, `packages/irene/config.js:237`. | n/a |
| `OPENAI_COMPAT_TOP_P` | Both | No | `0.95` | top_p. `packages/eris/config.js:257`, `packages/irene/config.js:238`. | n/a |
| `OPENAI_COMPAT_PROVIDER_NAME` | Both | No | Per-alias label (e.g. `OpenRouter`) | Surfaced in logs and the OpenRouter analytics header. `packages/eris/config.js:258`, `packages/irene/config.js:239`. | n/a |
| `OPENAI_COMPAT_HTTP_REFERER` | Both | No | — (Eris) / `""` (Irene) | OpenRouter analytics Referer. `packages/eris/config.js:259`, `packages/irene/config.js:240`. | Set to your bot's public URL |
| `OPENAI_COMPAT_APP_TITLE` | Both | No | `Eris` / `""` | X-Title header for OpenRouter analytics. `packages/eris/config.js:260`, `packages/irene/config.js:241`. | n/a |
| `OPENAI_COMPAT_EXTRA_HEADERS` | Both | No | `{}` | JSON object of extra headers merged into every upstream call. Invalid JSON triggers a `[WARN]` and is ignored. `packages/eris/config.js:261`, `packages/irene/config.js:242`. | n/a |
| `OPENAI_COMPAT_TOOL_CHOICE` | Both | No | `auto` | `auto` / `none` / `required`, or a JSON `{type, function}` object. `packages/eris/config.js:262`, `packages/irene/config.js:243`. | n/a |
| `OPENAI_COMPAT_ALLOW_NO_API_KEY` | Both | No | `0` | Set to `1` to skip the API-key fatal check (auto-enabled for `lmstudio` / `ollama`). `packages/eris/config.js:263`, `packages/irene/config.js:244`. | n/a |
| `OPENAI_API_KEY` | Both | Conditional alias | — | Fallback alias for `OPENAI_COMPAT_API_KEY` when `AI_PROVIDER=openai` / `openai-compatible`. `packages/eris/config.js:149`, `packages/irene/config.js:145`. | platform.openai.com -> API keys |
| `OPENROUTER_API_KEY` | Both | Conditional alias | — | Fallback alias for OpenRouter. `packages/eris/config.js:151`, `packages/irene/config.js:147`. | openrouter.ai/keys |
| `OPENROUTER_API_KEYS` | Both | No | — | Comma/space-separated OpenRouter key pool. `packages/eris/config.js:174`, `packages/irene/config.js:174`. | Same |
| `GROQ_API_KEY` | Both | Conditional alias | — | Groq fallback alias. `packages/eris/config.js:153`, `packages/irene/config.js:149`. | console.groq.com/keys |
| `CEREBRAS_API_KEY` | Both | Conditional alias | — | Cerebras fallback alias. `packages/eris/config.js:155`, `packages/irene/config.js:151`. | cloud.cerebras.ai |
| `MISTRAL_API_KEY` | Both | Conditional alias | — | Mistral fallback alias. `packages/eris/config.js:157`, `packages/irene/config.js:153`. | console.mistral.ai |
| `DEEPINFRA_API_KEY` | Both | Conditional alias | — | DeepInfra fallback alias. `packages/eris/config.js:159`, `packages/irene/config.js:155`. | deepinfra.com/dash/api_keys |
| `TOGETHER_API_KEY` | Both | Conditional alias | — | Together.ai fallback alias. `packages/eris/config.js:161`, `packages/irene/config.js:157`. | api.together.xyz/settings/api-keys |
| `GITHUB_MODELS_API_KEY` | Both | Conditional alias | — | GitHub Models inference fallback. Falls through to `GITHUB_TOKEN` if unset. `packages/eris/config.js:163`, `packages/irene/config.js:159`. | github.com/settings/tokens |
| `CLOUDFLARE_API_TOKEN` | Both | Conditional alias | — | Cloudflare Workers AI fallback alias. `packages/eris/config.js:165`, `packages/irene/config.js:161`. | dash.cloudflare.com -> Profile -> API Tokens |
| `VOYAGE_API_KEY` | Both | No (recommended) | — | Voyage AI embeddings for semantic memory recall. Without it, recall falls back to keyword search. `packages/eris/config.js:225`, `packages/irene/config.js:319`. | voyageai.com -> API Keys |
| `OLLAMA_EMBED_URL` | Both | No | — | Local Ollama base URL for semantic embeddings. When set, Voyage embeddings are bypassed. `packages/eris/config.js`, `packages/irene/config.js`. | Your Ollama host, e.g. `http://127.0.0.1:11434` |
| `OLLAMA_EMBED_MODEL` | Both | No | `nomic-embed-text` | Ollama embedding model. `packages/eris/config.js`, `packages/irene/config.js`. | `ollama pull nomic-embed-text` |
| `OLLAMA_VISION_URL` | Both | No | — | Local Ollama base URL for Discord image descriptions. Raw image bytes are sent only to this local service; external chat providers receive text evidence. `packages/eris/config.js`, `packages/irene/config.js`. | Your Ollama host, e.g. `http://127.0.0.1:11434` |
| `OLLAMA_VISION_MODEL` | Both | No | `qwen2.5vl:7b` | Local vision model used for conservative image evidence. `qwen2.5vl:3b` is faster; `7b` is more accurate. | `ollama pull qwen2.5vl:7b` |
| `LOCAL_VISION_MAX_IMAGES` | Both | No | `4` | Max image attachments described per Discord message. Extra images are noted as omitted. | n/a |
| `LOCAL_VISION_IMAGE_MAX_BYTES` | Both | No | `5242880` | Per-image fetch cap before local vision analysis. | n/a |
| `SUPABASE_URL` | Both | No (strongly recommended) | — | Supabase project URL. Without it, the bot boots with a `[WARN]` and runs fully ephemeral. `packages/eris/config.js:282`, `packages/irene/config.js:266`; warning at `packages/eris/config.js:404-406`, `packages/irene/config.js:394-397`. | supabase.com -> Project Settings -> API -> Project URL |
| `SUPABASE_KEY` | Both | No (strongly recommended) | — | Service-role or anon key. `packages/eris/config.js:283`, `packages/irene/config.js:267`. | supabase.com -> Project Settings -> API |
| `SUPABASE_ANON_KEY` | Irene | No | — | Parsed for compatibility, but it does not enable persistence when `SUPABASE_KEY` is unset. `SUPABASE_KEY` is required for Irene persistence. `packages/irene/config.js:268`. | Same as above |
| `REQUIRE_PERSISTENCE` | Both | No | `0` | `1` makes a missing/invalid Supabase config fatal at startup instead of degrading silently. `packages/eris/config.js:284`, `packages/irene/config.js:269`. | n/a |
| `DUAL_WRITE_PERSISTENCE` | Irene | No | `false` | Phase 1 of the per-entity DB refactor: when `true`, every write hits both the legacy `bot_data` blob and the new tables in `packages/irene/database/perEntity.js`. Apply migrations first. `packages/irene/config.js:297`. | n/a |
| `TWIN_API_SECRET` | Both | No (required if you run the twin pair) | — | Shared secret for `/api/twin/*` requests: HMAC on state-changing calls, bearer on read-only twin state. It does not authorize normal dashboard routes. Read at `packages/eris/config.js:212`, `packages/irene/config.js:200`. | `openssl rand -hex 32` |
| `IRENE_API_URL` | Eris | No | — | Base URL of the Irene HTTP API (where Eris sends outbound twin calls). `packages/eris/config.js:213`. | The public URL of your Irene deploy |
| `ERIS_API_URL` | Irene | No | — | Base URL of the Eris HTTP API. `packages/irene/config.js:201`. | The public URL of your Eris deploy |
| `TWIN_BOT_ID` | Eris | No | — | Irene's bot Discord ID. Used for `{{TWIN_BOT_ID}}` substitution in `prompts/eris-relationships.md` and for twin-detection in `events/messageCreate.js`. `packages/eris/config.js:214, 326`, `packages/eris/events/messageCreate.js:365`. | Discord -> right-click Irene -> Copy ID |
| `ERIS_BOT_ID` | Irene | No | — | Eris's bot Discord ID. Used for `{{TWIN_BOT_ID}}` substitution in `prompts/irene-personality.md` (note: the template name is `TWIN_BOT_ID` on both sides — only the env var name differs). `packages/irene/config.js:202, 307-308`. | Discord -> right-click Eris -> Copy ID |
| `LASTFM_API_KEY` | Eris | No | — | Powers `/fm` commands. Missing -> `[WARN]` at startup (`packages/eris/config.js:407-409`) and `/fm` fails. Read at `packages/eris/config.js:289`. | last.fm/api/account/create |
| `KLIPY_API_KEY` | Both | No | — | GIF search backing the `send_gif` tool. Read at `packages/eris/config.js:290`; Irene reads it directly at `packages/irene/ai/executor.js:1624`. | klipy.com -> API |
| `BRAVE_SEARCH_API_KEY` | Both | No | — | Brave Web Search backing the `web_search` tool. `packages/eris/config.js:306`, `packages/irene/config.js:277`. | api-dashboard.search.brave.com |
| `BRAVE_ANSWERS_API_KEY` | Both | No | inherits `BRAVE_SEARCH_API_KEY` | Brave Answers (grounded one-shot answer). `packages/eris/config.js:307`, `packages/irene/config.js:278`. | Same |
| `BRAVE_ANSWERS_MODEL` | Both | No | `brave` | Brave Answers model ID. `packages/eris/config.js:308`, `packages/irene/config.js:279`. | n/a |
| `BRAVE_ANSWERS_TIMEOUT_MS` | Both | No | `5000` | Brave Answers per-request timeout. `packages/eris/config.js:309`, `packages/irene/config.js:280`. | n/a |
| `BRAVE_SEARCH_TIMEOUT_MS` | Both | No | `3500` | Brave Search per-request timeout. `packages/eris/config.js:310`, `packages/irene/config.js:281`. | n/a |
| `WEB_SEARCH_BACKEND_TIMEOUT_MS` | Both | No | `5000` | Generic backend timeout for non-Brave web search providers. `packages/eris/config.js:311`, `packages/irene/config.js:282`. | n/a |
| `WEB_SEARCH_DDG_TIMEOUT_MS` | Both | No | `5000` | DuckDuckGo fallback timeout. `packages/eris/config.js:312`, `packages/irene/config.js:283`. | n/a |
| `WEB_SEARCH_GEMINI_GROUNDING` | Both | No | inherits from `AI_PROVIDER` (on for `gemini`/`google`) | Force-enables (`1`/`true`/`yes`/`on`) or force-disables (`0`/`false`/`no`/`off`) Gemini Search Grounding regardless of the configured provider. Read directly at `packages/eris/ai/executors/webExecutor.js:42` and `packages/irene/ai/executors/advancedExecutor.js:84`. | n/a |
| `SEARXNG_QUERY_URL` | Both | No | — | Self-hosted SearXNG endpoint for web search. `packages/eris/config.js:304`, `packages/irene/config.js:275`. | Your own SearXNG instance |
| `TAVILY_API_KEY` | Both | No | — | Tavily search backend. `packages/eris/config.js:305`, `packages/irene/config.js:276`. | tavily.com |
| `SERPER_API_KEY` | Both | No | — | Serper.dev search backend. `packages/eris/config.js:313`, `packages/irene/config.js:284`. | serper.dev |
| `GOOGLE_SEARCH_KEY` | Both | No | — | Google Programmable Search API key (Tier-1 web-search backend in Irene). `packages/eris/config.js:314`, `packages/irene/config.js:285`. Direct read in `packages/irene/ai/executors/advancedExecutor.js:534`. | console.cloud.google.com -> Custom Search API |
| `GOOGLE_SEARCH_CX` | Both | No | — | Google Programmable Search engine ID. Pairs with the key above. `packages/eris/config.js:315`, `packages/irene/config.js:286`. Direct read in `packages/irene/ai/executors/advancedExecutor.js:535`. | programmablesearchengine.google.com |
| `RENDER_API_KEY` | Eris | No | — | Backs the `check_deploy` / `watch_deploy` tools. Without it both return "not configured". `packages/eris/config.js:292`. | dashboard.render.com -> Account Settings -> API Keys |
| `GITHUB_TOKEN` | Eris | No | — | Backs `github_repos` / `github_issues` / `github_prs` tools. Also acts as the last-resort fallback for `GITHUB_MODELS_API_KEY`. `packages/eris/config.js:51, 291`. | github.com -> Settings -> Developer settings -> Personal access tokens |
| `GOOGLE_CLIENT_ID` | Eris | No (all 3 needed together) | — | Gmail OAuth client ID for the `read_emails` tool. `packages/eris/config.js:297`. | console.cloud.google.com -> Credentials |
| `GOOGLE_CLIENT_SECRET` | Eris | No (all 3 needed together) | — | Gmail OAuth client secret. `packages/eris/config.js:298`. | Same as above |
| `GOOGLE_REFRESH_TOKEN` | Eris | No (all 3 needed together) | — | Gmail OAuth refresh token. `packages/eris/config.js:299`. | OAuth Playground |
| `TWITCH_CLIENT_ID` | Irene | No | — | Twitch live-stream notifications. `packages/irene/config.js:289`. | dev.twitch.tv -> Console -> Apps |
| `TWITCH_CLIENT_SECRET` | Irene | No | — | Twitch app secret, pairs with the client ID. `packages/irene/config.js:290`. | Same as above |
| `LAVALINK_HOST` | Irene | Conditional (only for music) | `localhost` | Lavalink node hostname. `packages/irene/config.js:204`. | Self-host (lavalink.dev) or a public node |
| `LAVALINK_PORT` | Irene | No | `2333` | Lavalink node port. `packages/irene/config.js:205`. | Same |
| `LAVALINK_PASSWORD` | Irene | No | `youshallnotpass` | Shared Lavalink password (must match `application.yml`). `packages/irene/config.js:206`. | Same |
| `LAVALINK_SECURE` | Irene | No | `false` | `true` -> `wss://` + `https://` instead of `ws://` + `http://`. `packages/irene/config.js:207`. | Same |
| `DREAM_CHANNEL_ID` | Eris | No | — | Channel where Eris posts random "dream"-style background thoughts. Feature disabled if absent. `packages/eris/config.js:293`. | Discord -> right-click channel -> Copy Channel ID |
| `BRIEFING_CHANNEL_ID` | Eris | No | — | Channel where Eris posts daily briefings. Feature disabled if absent. `packages/eris/config.js:294`. | Same |
| `DASHBOARD_API_KEY` | Both | No | — | Auth token for non-health dashboard `/api/*` endpoints. When unset, remote dashboard requests are rejected; twin endpoints still use `TWIN_API_SECRET`/HMAC. Read at `packages/eris/api/dashboard.js`, `packages/irene/presence.js`. | `openssl rand -hex 32` |
| `DASHBOARD_ALLOW_LOCALHOST_BYPASS` | Both | No | `0` | Set to `1` only for trusted single-user local development. It lets localhost dashboard requests skip `DASHBOARD_API_KEY`; keep it off behind tunnels, reverse proxies, and hosted deployments. | n/a |
| `DASHBOARD_URL` | Both | No | — | Extra origin allowed by the dashboard CORS policy. Read at `packages/eris/api/dashboard.js:27`, `packages/irene/presence.js:183`. | Whatever URL serves your dashboard frontend |
| `EXTERNAL_URL` | Both | No | — | Manual override for the bot's public URL when not on Render. Used for CORS allow-list and (Irene) the Lavalink TTS callback URL. Read at `packages/eris/api/dashboard.js:27`, `packages/irene/presence.js:141, 182`, `packages/irene/music/player.js:795`. | Your tunnel / reverse-proxy host |
| `RENDER_EXTERNAL_URL` | Both | No (auto-injected by Render) | — | Public URL injected by Render. Drives the self-ping keep-alive and CORS allow-list. Read at `packages/eris/api/dashboard.js:27`, `packages/irene/presence.js:141, 182, 656`, `packages/irene/music/player.js:795`. | Render sets it automatically |
| `NODE_ENV` | Both | No | — | Standard Node convention. Only consumed by `render.yaml` (the bots never branch on it). | Set to `production` in deploys |
| `PC_AGENT_DISABLED` | Eris | No | `0` | Kill switch for owner-only PC-agent tools (terminal, local exec, file browse, launch_app, system_info, list_processes). `1` disables without redeploy. `packages/eris/config.js:210`. | n/a |
| `NO_COLOR` | Both | No | — | Disables ANSI color codes in logger output (useful for log shippers). Read at `packages/eris/utils/logger.js:14`, `packages/irene/utils/logger.js:22`. | n/a |
| `TIMEOUT_QUICK_REPLY` | Both | No | `15000` (Eris) / `5000` (Irene) | Timeout (ms) for the short single-shot quick-reply path. `packages/eris/config.js:363`, `packages/irene/config.js:354`. | n/a |
| `TIMEOUT_WORKER` | Eris | No | `60000` | Timeout (ms) for the worker thread running the full tool-calling loop. `packages/eris/config.js:364`. | n/a |
| `TIMEOUT_WORKER_FAST` | Irene | No | `35000` | Fast-path worker timeout (ms). `packages/irene/config.js:355`. | n/a |
| `TIMEOUT_WORKER_SLOW` | Irene | No | `60000` | Slow-path worker timeout (ms) — full reasoning loop. `packages/irene/config.js:356`. | n/a |
| `TIMEOUT_TOOL_FAST` | Irene | No | `15000` | Tool tier 1 timeout (ms). `packages/irene/config.js:357`. | n/a |
| `TIMEOUT_TOOL_SLOW` | Irene | No | `30000` | Tool tier 2 timeout (ms). `packages/irene/config.js:358`. | n/a |
| `TIMEOUT_TOOL_VERY_SLOW` | Irene | No | `60000` | Tool tier 3 timeout (ms) — long scrapes. `packages/irene/config.js:359`. | n/a |
| `TIMEOUT_TOOL_IMAGE` | Irene | No | `90000` | Image-generation tool timeout (ms). Kept separate because image providers can take longer than normal network tools. | n/a |
| `TIMEOUT_FETCH` | Both | No | `5000` | Outbound HTTP fetch timeout (ms). `packages/eris/config.js:365`, `packages/irene/config.js:360`. | n/a |

---

## 1. Discord identity

Eris and Irene use historically different variable names. Eris uses
`DISCORD_TOKEN` / `CLIENT_ID` / `BOT_OWNER_ID`; Irene uses
`DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` / `DISCORD_USER_ID`. Both `config.js`
files `process.exit(1)` at startup when the token or client ID is missing
(`packages/eris/config.js:374-381`, `packages/irene/config.js:368-375`), so
booting without them is impossible.

`BOT_OWNER_ID` / `DISCORD_USER_ID` is technically optional, but everything that
needs a recognized owner — owner-only commands, PC-agent authorization, and the
personality prompt's relationship block — depends on it. If you leave it blank,
owner-only surfaces fail closed or lose owner-specific context; set it to your
own ID before enabling any owner-only tooling.

`BOT_NAME` controls the row key for personality, longmemory and audit rows in
Supabase. Changing it creates a fresh personality from scratch — treat it as
immutable per deployment.

## 2. AI providers

`AI_PROVIDER` picks the implementation under `ai/providers/`. Three families:

- **Gemini** — `AI_PROVIDER=gemini` (default). Requires at least one
  `GEMINI_API_KEY` (extras `_2` ... `_4` for Eris, `_2` ... `_12` for Irene are
  rotated for rate-limit smoothing). Model IDs default to the values in the
  master table.
- **NVIDIA NIM** — `AI_PROVIDER=nvidia` (generic) or `kimi` (Kimi K2.6 defaults).
  Requires `NVIDIA_API_KEY`. All `NVIDIA_*` tunables default to Kimi-friendly
  values when `AI_PROVIDER=kimi` and stricter values otherwise — see
  `packages/eris/config.js:232-246`.
- **OpenAI-compatible** — `AI_PROVIDER=openai-compatible` or one of the per-
  provider aliases: `openai`, `openrouter`, `groq`, `cerebras`, `mistral`,
  `deepinfra`, `together`, `github`, `cloudflare`, `lmstudio`, `ollama`. Each
  alias pre-fills `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` / provider
  name (see `getOpenAICompatDefaults` at `packages/eris/config.js:113-140` and
  `OPENAI_COMPAT_DEFAULTS` at `packages/irene/config.js:120-133`).

For OpenAI-compat aliases, `OPENAI_COMPAT_API_KEY` is the canonical key, but
provider-specific aliases also work — Groq picks up `GROQ_API_KEY`, OpenRouter
picks up `OPENROUTER_API_KEY` / `OPENROUTER_API_KEYS`, GitHub Models falls
through to `GITHUB_TOKEN`, etc. (see `getOpenAICompatKeyVars` and
`getOpenAICompatKeyListVars`). Local providers (`lmstudio`, `ollama`) implicitly
set `OPENAI_COMPAT_ALLOW_NO_API_KEY=1`.

`VOYAGE_API_KEY` is provider-independent — it backs the embedding lookup used by
semantic memory recall. Without it, recall degrades to keyword search.

## 3. Persistence (Supabase)

Both bots use Supabase Postgres as their backing store. Without
`SUPABASE_URL` + `SUPABASE_KEY` they boot with a `[WARN]` and run fully
in-memory — coins, memories, settings, mood, relationships, moderation state
all reset on every restart (`packages/eris/config.js:404-406`,
`packages/irene/config.js:394-397`).

`REQUIRE_PERSISTENCE=1` flips that warning into a startup failure — production
deploys should set it; dev should leave it at `0`. The check uses the
`supabaseEnabled` getter at `packages/eris/config.js:285-287` /
`packages/irene/config.js:270-272`, which also rejects placeholder URLs
containing `your-`.

Irene also parses `SUPABASE_ANON_KEY`, but the persistence gate still requires
`SUPABASE_KEY`. Treat `SUPABASE_ANON_KEY` as a compatibility alias only; it does
not make `supabaseEnabled` true by itself.

`DUAL_WRITE_PERSISTENCE` (Irene only) is the phase-1 flag for the in-flight DB
refactor: when `true`, every write hits both the legacy single-row blob and the
new per-entity tables in `packages/irene/database/perEntity.js`. Apply the
migrations first, then flip it on in a deploy to validate the new layer before
later PRs migrate read paths.

## 4. Twin coordination (Eris <-> Irene)

`TWIN_API_SECRET` is a shared HMAC secret used to sign `/api/twin/command`
requests and gate `/api/twin/state`. **It must match exactly on both bots** —
any drift produces a 401 / 403 on every twin call. Generate with
`openssl rand -hex 32` and set the same value on both deployments.

Direction is named per-bot:

- Eris -> Irene calls use `IRENE_API_URL` (the public URL of Irene).
- Irene -> Eris calls use `ERIS_API_URL`.

Bot-ID env vars also differ by side:

- `TWIN_BOT_ID` on Eris = Irene's Discord bot ID. Templated into
  `prompts/eris-relationships.md` and used for twin detection in
  `events/messageCreate.js`.
- `ERIS_BOT_ID` on Irene = Eris's Discord bot ID. Templated into
  `prompts/irene-personality.md`. Note that the *template variable name* is
  `{{TWIN_BOT_ID}}` on both sides — only the env var name differs.

`TWIN_API_SECRET` does not authorize normal dashboard routes. It is reserved
for twin endpoints (`/api/twin/*`) through bearer checks on read-only state and
HMAC signatures on state-changing twin calls.

## 5. Optional integrations

Every integration in this section degrades gracefully when missing — the related
tool just refuses to fire (or, for Last.fm, emits a `[WARN]` at startup).

- **Voyage AI** (`VOYAGE_API_KEY`) — semantic-memory embeddings.
- **Ollama local AI** (`OLLAMA_EMBED_URL`, `OLLAMA_VISION_URL`) — optional
  local embeddings and local image evidence. For image analysis, the bots fetch
  Discord attachments with `safeFetch`, send bytes to Ollama only, and pass the
  external chat model a conservative text block instead of raw image bytes.
- **Last.fm** (`LASTFM_API_KEY`, Eris) — `/fm` commands.
- **Klipy** (`KLIPY_API_KEY`, both) — `send_gif` tool.
- **Brave Search / Answers** (`BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWERS_API_KEY`,
  plus the `BRAVE_*_TIMEOUT_MS` knobs) — primary web search.
- **SearXNG / Tavily / Serper / Google CSE** — alternate web search backends.
  Set only the one(s) you actually use.
- **Render** (`RENDER_API_KEY`, Eris) — `check_deploy` / `watch_deploy` tools.
- **GitHub** (`GITHUB_TOKEN`, Eris) — `github_repos` / `github_issues` /
  `github_prs` tools. Also fallback for `GITHUB_MODELS_API_KEY` when
  `AI_PROVIDER=github`.
- **Gmail OAuth** (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` +
  `GOOGLE_REFRESH_TOKEN`, Eris) — `read_emails` tool. All three are required
  together; partial config silently disables the integration via the `enabled`
  getter at `packages/eris/config.js:300`.
- **Twitch** (`TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`, Irene) — live-stream
  notifications.
- **Lavalink** (`LAVALINK_HOST` / `_PORT` / `_PASSWORD` / `_SECURE`, Irene only)
  — music playback. The bot boots fine without it; only `/play` and friends
  fail.

## 6. Deployment

`PORT` is the HTTP bind port. Render and similar PaaS hosts inject their own
value — defer to it.

`RENDER_EXTERNAL_URL` is auto-injected by Render and is the canonical "what's my
public URL" source. `EXTERNAL_URL` is the manual override for self-hosted
setups (tunnel hostnames, reverse-proxy URLs). Both feed the dashboard CORS
allow-list (`packages/eris/api/dashboard.js:27`, `packages/irene/presence.js:182-
183`), Irene's keep-alive self-ping (`packages/irene/presence.js:656-665`), and
Irene's Lavalink TTS callback URL (`packages/irene/music/player.js:795`).

`DASHBOARD_URL` is an extra origin appended to the same CORS allow-list — set
it to wherever your dashboard frontend is hosted, separate from the bot's own
URL.

`DASHBOARD_API_KEY` is the per-dashboard credential. When it's unset, remote
dashboard requests are rejected. For local development only,
`DASHBOARD_ALLOW_LOCALHOST_BYPASS=1` permits localhost requests without the
dashboard key; keep that disabled for hosted or proxied deployments.

`NODE_ENV` is set to `production` by `render.yaml` (root + per-package mirrors)
but the application code never branches on it.

## 7. Feature flags

- `PC_AGENT_DISABLED` (Eris) — `1` kills all owner-only PC-agent tools
  (terminal, local exec, file browse, launch_app, system_info, list_processes)
  without a redeploy. Default `0` (enabled). Production Render uses `1` per
  `render.yaml:55`.
- `DUAL_WRITE_PERSISTENCE` (Irene) — see Persistence above.
- `WEB_SEARCH_GEMINI_GROUNDING` (both) — force-enables (`1`/`true`/`yes`/`on`)
  or force-disables (`0`/`false`/`no`/`off`) Gemini Search Grounding regardless
  of the configured AI provider. Default is "use grounding iff
  `AI_PROVIDER=gemini`/`google`". Read directly at
  `packages/eris/ai/executors/webExecutor.js:42` and
  `packages/irene/ai/executors/advancedExecutor.js:84`.
- `NO_COLOR` (both) — disables ANSI color codes in the logger
  (`packages/eris/utils/logger.js:14`, `packages/irene/utils/logger.js:22`).

## 8. Tuning (timeouts, sampling, rate limits)

All timeouts are in milliseconds and live under the `timeouts` block of each
`config.js`. Only override these if you have a specific reason — defaults are
tuned for the live deployment.

- **Eris** ships three knobs: `TIMEOUT_QUICK_REPLY` (15000),
  `TIMEOUT_WORKER` (60000), `TIMEOUT_FETCH` (5000) — see
  `packages/eris/config.js:362-366`.
- **Irene** ships seven knobs across fast / slow / per-tool tiers:
  `TIMEOUT_QUICK_REPLY` (5000), `TIMEOUT_WORKER_FAST` (35000),
  `TIMEOUT_WORKER_SLOW` (60000), `TIMEOUT_TOOL_FAST` (15000),
  `TIMEOUT_TOOL_SLOW` (30000), `TIMEOUT_TOOL_VERY_SLOW` (60000),
  `TIMEOUT_TOOL_IMAGE` (90000), `TIMEOUT_FETCH` (5000) — see
  `packages/irene/config.js`.
- **Brave / web search** timeouts live alongside the keys:
  `BRAVE_ANSWERS_TIMEOUT_MS` (5000), `BRAVE_SEARCH_TIMEOUT_MS` (3500),
  `WEB_SEARCH_BACKEND_TIMEOUT_MS` (5000), `WEB_SEARCH_DDG_TIMEOUT_MS` (5000).
- **NVIDIA sampling** — `NVIDIA_MAX_TOKENS`, `NVIDIA_TEMPERATURE`,
  `NVIDIA_TOP_P`, `NVIDIA_THINKING`, `NVIDIA_TOOL_STRICTNESS`. Defaults shift
  based on `AI_PROVIDER=kimi` vs `AI_PROVIDER=nvidia`.
- **OpenAI-compat sampling** — `OPENAI_COMPAT_MAX_TOKENS` (4096),
  `OPENAI_COMPAT_TEMPERATURE` (0.4), `OPENAI_COMPAT_TOP_P` (0.95). Note that
  the shipped `.env.example` pre-sets `8192 / 0.9 / 1.0` for the OpenRouter
  defaults.
- **Hard-coded rate limits / budgets** (not env-controlled, for reference):
  `aiCooldownMs=1500`, `aiMaxHistory=10`, `maxQueuedMessages=3`,
  `historyCharBudget=8000`, `toolResultMaxChars=500`, `webRateLimitPerMin=10`
  on both bots; Irene additionally sets `historyToolResultMax=300` and
  `ttsMaxCacheSize=50`. See `packages/eris/config.js:341-347` and
  `packages/irene/config.js:315-332`.

---

## Minimum viable boot

The smallest env set that actually starts each bot (everything else is
additive — missing keys disable one feature each).

**Eris:**

```
DISCORD_TOKEN=...
CLIENT_ID=...
GEMINI_API_KEY=...        # or NVIDIA_API_KEY if AI_PROVIDER=nvidia/kimi
                           # or OPENAI_COMPAT_API_KEY (+ alias) for OpenAI-compat
```

**Irene:**

```
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
GEMINI_API_KEY=...        # same provider rules as Eris
```

Strongly recommended on top of that for either bot:

```
SUPABASE_URL=...
SUPABASE_KEY=...
BOT_OWNER_ID / DISCORD_USER_ID=<your discord user id>
TWIN_API_SECRET=<openssl rand -hex 32>   # if running both bots together
```
