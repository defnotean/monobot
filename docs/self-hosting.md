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

Runs on anything with **Node.js 20+** — Linux, macOS, Windows. Tested daily on Linux and Windows.

## The 5-minute version (PM2)

[PM2](https://pm2.keymetrics.io/) is the default for self-hosted Node apps. It restarts on crash, restarts on reboot, and rotates logs.

```bash
git clone https://github.com/defnotean/monobot
cd monobot
npm install

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

No Dockerfile ships in the repo (yet). If you want a containerized deploy, the recipe is straightforward: Node 20 base image, copy the workspace, `npm ci`, `CMD ["npm", "run", "start:eris"]` (or `:irene`). Contributions welcome.

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

Both bots use **Supabase** for the database. The free tier is generous and works exactly like the Render setup — point them at any Supabase project; nothing is Render-specific.

If you'd rather run Postgres yourself, the schema lives in `packages/<bot>/migrations/*.sql`. Apply them to a local Postgres and either set `SUPABASE_URL`/`SUPABASE_KEY` to a [supabase-js](https://supabase.com/docs/reference/javascript) compatible endpoint, or run [Supabase self-hosted](https://supabase.com/docs/guides/self-hosting).

| Bot | Persistence required? |
|---|---|
| **Eris** | No — runs in a degraded mode without it (no economy, no memory, just chat) |
| **Irene** | Yes |

## Common gotchas

- **Laptop sleep = bot offline.** Disable lid-close suspend / sleep timer, or set the machine to a "performance" power profile.
- **Discord intents.** In the Developer Portal for each bot application: enable **Message Content Intent** and **Server Members Intent**. Missing these is the #1 reason "the bot doesn't see messages."
- **Dynamic ISP IP** only matters if you exposed a port. Use a tunnel and forget about it.
- **Power outage** = no auto-restart unless your process manager is wired to start on boot. Test by rebooting the machine — both bots should come back without you logging in.
- **Update routine:** `git pull && npm install && pm2 restart all`. Pin your fork to a specific upstream commit if you want stability, or live-update from `main`.
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
