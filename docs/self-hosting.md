# Self-hosting MonoBot

Want to run Eris and Irene on your own hardware instead of Render? You can — both bots are plain Node.js processes that talk to Discord over an outbound WebSocket. No serverless platform required.

This guide covers running them on a personal machine (spare laptop, home server, VPS) and keeping them up over time.

## Why self-host vs Render

| | Render | Self-host |
|---|---|---|
| **Cost** | Free tier (spins down) + paid plans | Your hardware + electricity |
| **Spin-down** | Free tier sleeps after 15 min idle | Always on, up to you |
| **Setup** | Web UI + env vars | A process manager + an `.env` |
| **Memory ceiling** | 512 MB / 2 GB plans | Whatever your box has |
| **Update workflow** | `git push` → auto-deploy | `git pull` + restart |
| **Logs** | Render dashboard, 5 MB tail | PM2 logs / `journalctl` / whatever you wire |

A spare laptop with steady power and internet is plenty for both bots plus a few hundred guilds.

## Hardware & OS

| | Minimum | Recommended |
|---|---|---|
| **CPU** | 1 vCPU | 2 vCPU |
| **RAM** | 512 MB (one bot, no music) | 2 GB (both bots + Lavalink) |
| **Disk** | 1 GB | 5 GB (logs + Lavalink jar + Java) |

Runs on anything with **Node.js 22.12+** — Linux, macOS, Windows. Tested daily on Linux and Windows.

## The 5-minute version (PM2)

[PM2](https://pm2.keymetrics.io/) is the default for self-hosted Node apps and **works the same on Linux, macOS, and Windows**. It restarts on crash, restarts on reboot, and rotates logs. Start here regardless of OS; the platform-specific sections below are for people who want native service integration.

```bash
# Clone your fork (or the upstream repo, github.com/defnotean/monobot)
git clone https://github.com/<your-fork>/monobot
cd monobot
npm ci

# fill in your .env files — see GETTING_STARTED.md for required vars
cp packages/eris/.env.example  packages/eris/.env
cp packages/irene/.env.example packages/irene/.env
# edit both .env files with your tokens / API keys

# install PM2 and start both bots
npm install -g pm2
pm2 start npm --name eris  -- run start:eris
pm2 start npm --name irene -- run start:irene

# persist + auto-start on reboot
pm2 save
pm2 startup     # run the printed command (sudo on Linux/Mac)
```

Useful commands afterwards:

```bash
pm2 ls                # what's running
pm2 logs eris         # tail logs
pm2 logs irene -f
pm2 restart eris      # manual restart
pm2 monit             # interactive CPU/memory dashboard
pm2 stop irene        # stop without removing
pm2 delete irene      # stop and remove
```

## Production setup by platform

PM2 works on all three. If you want native service integration instead, here are platform-specific alternatives.

### Linux + systemd

Drop this into `/etc/systemd/system/monobot-eris.service`:

```ini
[Unit]
Description=MonoBot Eris
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/monobot
ExecStart=/usr/bin/npm run start:eris
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable monobot-eris --now
sudo journalctl -u monobot-eris -f   # follow logs
```

Repeat with `monobot-irene.service` for Irene.

### Windows

**PM2 (easiest):** install `pm2-windows-startup` to handle the auto-start-on-boot piece.

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start npm --name eris  -- run start:eris
pm2 start npm --name irene -- run start:irene
pm2 save
```

**NSSM (real Windows Service):** [NSSM](https://nssm.cc/) wraps a Node process as a proper service that shows up in `services.msc`. Heavier setup but better Windows integration.

### macOS + launchd

PM2 works the same as Linux (`pm2 startup launchd`). Or write a `~/Library/LaunchAgents/com.monobot.eris.plist` with `RunAtLoad` and `KeepAlive` set true and load it with `launchctl load`.

### Docker

No Dockerfile ships in the repo (yet). If you want a containerized deploy, the recipe is straightforward: Node 24 base image, copy the workspace, `npm ci`, `CMD ["npm", "run", "start:eris"]` (or `:irene`). Contributions welcome.

## Networking

Both bots open the **Discord gateway WebSocket outbound** — Discord doesn't connect to you, so basic chat needs **zero inbound ports**.

You only need an exposed port (or a tunnel) if:

- You're running **the twin protocol across two machines** (Eris on one box, Irene on another). The HMAC-signed REST endpoints have to be reachable.
- You're running **the optional dashboard** against the `/api/*` surface from another machine.

If both bots run on the same machine, they talk over `localhost` and you need nothing inbound.

### When you need a tunnel

For laptops on residential ISPs (dynamic IP, NAT, no static DNS), a tunnel beats port-forward + DDNS:

- **[cloudflared](https://github.com/cloudflare/cloudflared)** — free; `cloudflared tunnel --url http://localhost:3001` gives you a public HTTPS endpoint.
- **[Tailscale Funnel](https://tailscale.com/kb/1223/funnel)** — free for personal use; better if you're already on Tailscale.

Set `EXTERNAL_URL` in the bot's `.env` to whatever public URL the tunnel hands you so the bot's CORS policy lets dashboard requests in.

## Local AI providers (Ollama / LM Studio / OpenAI-compatible)

You don't need a cloud AI subscription. Both bots route chat through a generic OpenAI-compatible chat-completions client, and `AI_PROVIDER=ollama` or `AI_PROVIDER=lmstudio` auto-disables the API-key requirement and points at the local default port. Any other OpenAI-compatible local server (vLLM, text-generation-webui, llama.cpp server, etc.) works the same.

See **[docs/llm-provider-guide.md](./llm-provider-guide.md)** for env snippets and the full provider matrix.

### Caveats specific to local models

- **Tool calling.** The bot's task features (commands, moderation, music control, all `tool_calls`-driven flows) require the model to produce well-formed `tool_calls`. Plain chat works on any model, but small or non-instruct models often hallucinate tool names or output malformed JSON. Families that handle tools reliably: **Llama 3.1+ Instruct**, **Qwen 2.5+/Qwen3 Instruct**, **Mistral Nemo Instruct**. Test a simple task command (`/coinflip` on Eris, `/play <song>` on Irene) before relying on it.
- **Context window — the #1 local footgun.** A real prompt is **~17–22k tokens**, not the ~3k an earlier version of this doc claimed: the base personality alone is 32.5 KB (Eris) / 41 KB (Irene), plus 4–30 KB of tool schemas and ~8 KB of conversation history per message. Ollama's stock `num_ctx` (4k on most models) **silently truncates from the head** — the personality and security rules are exactly what gets cut, so the bot "works" but ignores its own instructions. Give the model at least **24576, ideally 32768** context (see the next section) and set `AI_PROMPT_CHAR_BUDGET=24000` so the bot trims its own prompt deliberately instead of letting the runtime slice it blindly.
- **Embeddings are separate.** Semantic memory and the L3 injection-firewall layer use Voyage AI. Set `VOYAGE_API_KEY` to enable them (Voyage has a free tier); both gracefully no-op if it's unset. Local *chat* doesn't switch on local embeddings automatically.
- **Vision works locally.** Image understanding no longer requires Gemini: the local-vision adapter (`packages/shared/src/ai/localVision.js`) is wired into both bots' live message paths and speaks native Ollama (`/api/chat` with base64 images). Set `OLLAMA_VISION_URL=http://localhost:11434` and optionally `OLLAMA_VISION_MODEL` (default `qwen2.5vl:7b`). Leave them unset and image handling falls back to your main provider — Gemini handles images natively; text-only providers degrade gracefully.

### Giving Ollama enough context

Three ways to raise `num_ctx` past the truncation cliff — pick one:

```bash
# 1. Server-wide env (applies to every model the server loads)
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

```bash
# 2. Bake it into a model variant via a Modelfile
cat > Modelfile <<'EOF'
FROM qwen3:14b
PARAMETER num_ctx 32768
EOF
ollama create qwen3-32k -f Modelfile
```

```env
# 3. Per-request, from the bot side — JSON merged into every chat-completion
#    body (Ollama's /v1 endpoint can't express num_ctx any other way)
OPENAI_COMPAT_EXTRA_BODY={"options":{"num_ctx":32768,"think":false}}
```

### Recommended local preset

The defaults are tuned for hosted frontier models. For an Ollama 14B-class setup, start from:

```env
AI_PROVIDER=ollama
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
OPENAI_COMPAT_MODEL=qwen3:14b
OPENAI_COMPAT_ALLOW_NO_API_KEY=1

AI_PROMPT_CHAR_BUDGET=24000      # trim personality + runtime context to fit a 32k window
OPENAI_COMPAT_MAX_ITERATIONS=6   # tool-loop rounds per turn (defaults: 6 local / 12 hosted)
TOOLS_TIER1_MAX=16               # 16-20 full schemas per turn; the rest stay callable by name
OPENAI_COMPAT_TOOL_COACHING=1    # inject the tool-use coaching block (big win on 14B-class)
TIMEOUT_TURN_DEADLINE=120000     # outer per-turn deadline (ms) so a slow model can't wedge a channel
```

### Thinking models (Qwen3, DeepSeek-R1, …)

Reasoning models emit a `<think>…</think>` block before the actual reply. The bots strip it automatically before anything reaches Discord, so Qwen3-14B works out of the box — but the thinking tokens still burn latency and context. Disable thinking at the source with `OPENAI_COMPAT_EXTRA_BODY={"options":{"think":false}}` (native Ollama option, see above); for Qwen3 builds that ignore the option, appending `/nothink` to the system prompt is the documented fallback.

### Hardware notes for local models

- **7B-class, Q4 quantized** — runs on ~6 GB VRAM or CPU + 16 GB RAM. Latency 1–5s, fine for Discord.
- **13B–32B quantized** — wants a real GPU (12–24 GB VRAM) for usable latency.
- **70B** — needs 48+ GB VRAM or aggressive offloading; expect 10–30s per reply. Slash commands defer automatically so the 3-second interaction timeout isn't fatal, but chat will feel slow.

If you don't have a GPU but still want a *free* AI backend, **Groq** and **Cerebras** (both OpenAI-compatible, both with generous free tiers) are excellent fallbacks — see the provider guide.

## Lavalink (Irene's music)

Skip this section if you're not running Irene's music commands.

```bash
# Lavalink requires Java 17+
java -version

# Download Lavalink.jar from https://github.com/lavalink-devs/Lavalink/releases
# Put it in a directory alongside application.yml (template in the Lavalink docs)
java -jar Lavalink.jar
```

Then in `packages/irene/.env`:

```
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=<whatever you set in application.yml>
```

Add Lavalink to your process manager (PM2 / systemd) the same way you did the bots — or run it in `tmux` / `screen` if you don't care about auto-restart.

## Persistence

Both bots talk to the database through `@supabase/supabase-js`, which accepts **any PostgREST-compatible endpoint**. That gives you four options for the data layer — pick whichever fits your setup:

### Path A — Cloud Supabase (zero setup, free tier)

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<your-service-role-key>
```

The default. Free tier is generous enough for hundreds of guilds. Use the
**service-role key** — the RLS migration locks every table to `service_role`,
so an anon/publishable key can't reach the data (see `SECURITY.md`, "Database
posture"). Treat the service-role key like a root password: server-side `.env`
only, never in anything client-facing.

### Path B — Self-hosted Supabase via Docker

Follow [supabase.com/docs/guides/self-hosting](https://supabase.com/docs/guides/self-hosting) — typically a `docker-compose up` from the official supabase/docker repo. Then:

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_KEY=<service-role-key-from-the-docker-env-file>
```

Apply the schema in `packages/<bot>/migrations/*.sql` to the bundled Postgres (`psql` it in, or copy/paste in the Supabase Studio SQL editor).

### Path C — Plain Postgres + PostgREST

If you already run Postgres, install the `pgvector` extension, apply the migrations in `packages/<bot>/migrations/*.sql`, and put [PostgREST](https://postgrest.org/) in front. Point `SUPABASE_URL` at PostgREST's port. For semantic memory to work fully, also define a `search_memories(query_embedding vector, ...)` RPC — without it, semantic search silently degrades to keyword-only (no errors, just less smart).

### Path D — No persistence at all

Leave `SUPABASE_URL` / `SUPABASE_KEY` unset.

| Bot | Without a DB |
|---|---|
| **Eris** | Boots, chat works, no economy/memory/mood tracking. Fine for casual self-host. |
| **Irene** | Boots but **all moderation warns, custom commands, tickets, reminders, giveaways, settings reset on every restart**. Set `REQUIRE_PERSISTENCE=1` in `.env` to make the missing DB a fatal startup error instead of a silent degrade. |

## Common gotchas

- **Laptop sleep = bot offline.** Disable lid-close suspend / sleep timer, or set the machine to a "performance" power profile.
- **Discord intents.** In the Developer Portal for each bot application: enable **Message Content Intent** and **Server Members Intent**. Missing these is the #1 reason "the bot doesn't see messages."
- **Dynamic ISP IP** only matters if you exposed a port. Use a tunnel and forget about it.
- **Power outage** = no auto-restart unless your process manager is wired to start on boot. Test by rebooting the machine — both bots should come back without you logging in.
- **Update routine:** `git pull && npm ci && pm2 restart all`. Pin your fork to a specific upstream commit if you want stability, or live-update from `main`.
- **Logs eat disk** slowly. PM2 caps at ~10 MB per stream by default; `journalctl` rotates on its own. If you `>` your own log file, set up `logrotate` or you'll wake up to a full disk eventually.
- **Both bots on the same Discord account?** No — they're separate Discord applications with separate tokens. Create two bot applications in the Developer Portal.

## Render-only features

Two owner-only tools depend on Render's API and gracefully no-op when you're not on Render:

- **`check_deploy`** — queries Render's service API for current deploy status.
- **`watch_deploy`** — registers a watch on a Render service so new deploys post into the channel.

Both return `"render api not configured"` when `RENDER_API_KEY` is unset — no crash, no noise, just a clear refusal. If you happen to deploy *other* services on Render (even while self-hosting these bots), set `RENDER_API_KEY` and both tools will work against whatever services that key has access to.

Everything else — slash commands, AI tool surface, music, moderation, the twin protocol, the dashboard, persistence, all owner PC-agent tools — works identically on self-host.

## Migrating from Render to self-host

1. Copy your env vars from the Render dashboard into local `packages/eris/.env` and `packages/irene/.env`.
2. Start the bots locally and verify in a dev guild — same flow as `GETTING_STARTED.md`.
3. Once it's running cleanly, **stop** the Render service (don't delete yet — keep it as a rollback target for a week or two).
4. Move production traffic over: invite the same bot user into your real servers. Discord doesn't care which machine the process runs on as long as the token matches.
5. After a few days of clean runtime, archive the Render service.

The bots aren't coupled to Render — once you've set `EXTERNAL_URL` (where applicable), it's pure env-var migration. No code changes needed.
