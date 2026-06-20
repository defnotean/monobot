<h1 align="center">Monobot</h1>

<h4 align="center">AI Discord twins for moderation, music, economy, games, memory, and server automation.</h4>

<p align="center">
  <a href="#overview">Overview</a> •
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#security">Security</a> •
  <a href="#license">License</a>
</p>

[![Tests](https://github.com/defnotean/monobot/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/defnotean/monobot/actions/workflows/test.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Supabase](https://img.shields.io/badge/supabase-persistence-3ECF8E?logo=supabase&logoColor=white)
![AI](https://img.shields.io/badge/AI-tool--calling-111827)
![Self Hosted](https://img.shields.io/badge/self--hosted-ready-0f172a)

## Overview

**Monobot is a production Discord twin-bot system:** Eris handles economy, games, memory, social chaos, and personality; Irene handles moderation, server operations, music, onboarding, and community automation. They run independently, but when both are online they can coordinate through a signed twin protocol.

This is not a thin slash-command bot. It is a full AI-assisted Discord platform with hundreds of tools, persistent memory, moderation guardrails, economy atomicity, GIF/media reactions, voice/music systems, dashboards, and a serious security posture.

**Tags:** `discord` `discord-bot` `moderation` `ai-agent` `ai-tools` `discord-js` `nodejs` `supabase` `lavalink` `music-bot` `economy-bot` `server-management` `prompt-injection-defense` `self-hosted`

Like Red-DiscordBot, this project is self-hosted and built to be a complete Discord server toolkit. Where Red leans on modular cogs/plugins, Monobot leans on two specialized AI-powered bots: Irene for operations and moderation, Eris for social systems and economy.

## Features

### Irene: The Server Operator

Irene is the "good twin": a moderation and community-management bot that feels like someone is actively helping run the server.

- **Moderation:** warns, mutes, kicks, bans, purge tools, role checks, escalation policies, audit trails, one-click undo flows, anti-raid, anti-nuke, ghost-ping and edit/delete logging.
- **Server setup:** tickets, welcome cards, logging, autoroles, reaction roles, role pickers, starboard, suggestions, custom embeds, custom commands, scheduled messages, reminders, birthdays, AFK, tags, highlights, stats channels, and setup wizards.
- **Music and voice:** Lavalink playback, queue controls, DJ controls, filters, lyrics mode, ElevenLabs/Gemini/local TTS, soundboard, and wake-word listening.
- **Community systems:** leveling, XP rewards, giveaways, polls, trivia, scrims, weekly digests, smart temporary voice channels, feeds for YouTube/GitHub/Twitch/patch notes.
- **AI workflows:** channel summaries, memory, local multi-image vision evidence through Ollama, TikTok embed fixing, ElevenLabs audio tools, owner-only Higgsfield media jobs, web search, web reads, DM-based server management, and contextual tool use with Discord permission gates.

### Eris: The Social Economy Twin

Eris is the chaotic twin: an AI personality bot with economy, gambling, games, memories, and social mechanics.

- **Economy:** wallet/bank, daily/weekly/monthly rewards, shop, inventory, achievements, loans, marriage, bounties, robbery, heists, lottery, pets, crafting, and leaderboards.
- **Games and gambling:** coinflip, dice, slots, roulette, blackjack-style games, poker, Connect 4, tic-tac-toe, hangman, trivia, duels, boss raids, and mood-influenced game flavor.
- **AI personality:** long-term memory, semantic recall, moods with inertia, relationship dimensions, per-channel context, preoccupations, self-canon, natural short replies, and occasional GIF reactions.
- **Media and web:** GIFs, memes, image search, local multi-image analysis, generated images, web search/read, notes, reminders, files, and PC-agent owner workflows.

### Twin Mode

Run one bot or both. When both Eris and Irene are deployed, they can share state and actions through an HMAC-signed twin API:

- Irene can ask Eris for economy/status actions.
- Eris can ask Irene for moderation/server operations.
- Cross-bot requests are signed, replay-checked, rate-limited, and permission-gated.
- Single-bot deployments do not need the twin protocol.

## Why It Is Different

- **Two specialized bots instead of one giant personality.** Irene is operational: moderation, setup, music, voice, server automation. Eris is social: economy, games, memory, media, and personality.
- **AI tool calling is first-class.** The bots do not just chat; they execute bounded tools with central dispatch, permission checks, confirmation gates, duplicate-call protection, and prompt-budget management.
- **Security is built into the architecture.** The codebase includes SSRF-safe fetches, prompt-injection spotlighting/firewalls, Discord role hierarchy guards, HMAC signing, replay caches, rate limits, destructive-command gates, audit logs, and regression tests for exploit surfaces.
- **State makes the bots feel alive.** Mood, energy, relationship dimensions, memory importance, personality drift, dreams, and response-style variation give the bots continuity without letting the model invent unchecked lore.
- **It is built for real servers.** Irene covers moderation, onboarding, logs, feeds, voice, music, leveling, tickets, and server automation. Eris covers engagement, economy, games, and social identity.
- **Self-hosting is supported.** Run locally, on a home server, a VPS, or Render. Supabase persistence is optional for development and recommended for production.

## Packages

| Package | Role | Highlights |
|---|---|---|
| [`packages/eris`](./packages/eris) | Social/economy AI twin | Economy, gambling, games, memory, media, Last.fm, owner PC-agent workflows |
| [`packages/irene`](./packages/irene) | Moderation/server AI twin | Moderation, setup, music, tickets, logging, feeds, voice, server automation |
| [`packages/shared`](./packages/shared) | Shared core | HMAC signing, safe fetch, rate limits, role categorization, prompt/firewall utilities, caches |

## Feature Map

| Area | Included |
|---|---|
| Discord moderation | Warnings, timeouts, kicks, bans, purges, escalation, audit logs, anti-raid, anti-nuke |
| Server management | Tickets, welcome, logging, reaction roles, starboard, suggestions, custom embeds, scheduled messages |
| Music and voice | Lavalink, queue, filters, DJ mode, TTS, lyrics, soundboard, wake-word listening |
| AI agent tooling | Tool registry, permission gates, web search/read, image tools, memory, notes, reminders, file output |
| Economy and games | Wallet, bank, shop, inventory, lottery, heists, pets, gambling, poker, duels, leaderboards |
| Memory/personality | Mood inertia, relationships, long-term memory, semantic recall, self-canon, dreams, response variation |
| Media | GIF reactions, memes, real image search, local image evidence, generated/edited images |
| Observability | Health endpoints, presence API, dashboard surfaces, logs, audit docs, test coverage |
| Security | SSRF protection, prompt-injection defenses, HMAC twin protocol, role hierarchy checks, replay protection |

## Quick Start

Monobot is self-hosted. You create Discord applications, provide tokens in environment files, and run whichever bot(s) you want. You do not need both bots online unless you want twin-mode coordination.

```bash
git clone https://github.com/defnotean/monobot.git
cd monobot
npm ci
```

Run Eris:

```bash
npm run start:eris
```

Run Irene:

```bash
npm run start:irene
```

For full setup, environment variables, Discord application setup, Supabase, Lavalink, and deployment details, start here:

- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [docs/self-hosting.md](./docs/self-hosting.md)
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

## Installation Targets

| Target | Use it when |
|---|---|
| Local machine | You want the fastest dev loop or a personal always-on setup |
| Home server / VPS | You want self-hosted production control |
| Render | You want the deployment shape described by [`render.yaml`](./render.yaml) |
| Single-bot mode | You only need Irene or Eris |
| Twin mode | You want both bots and signed cross-bot coordination |

## Development

```bash
npm run dev:eris                 # Eris with node --watch
npm run dev:irene                # Irene with node --watch
npm test                         # all workspace tests
npm run lint:version-sync        # shared third-party dependency guard
npm run new:tool                 # scaffold a new AI tool
npm run new:command              # scaffold a slash command
npm run provision:gemini-keys    # create restricted Gemini keys with gcloud
```

Current verification baseline:

- Eris: **1,374 tests**
- Irene: **1,613 tests**
- Shared: **367 tests**
- Total: **3,354 tests**

## Documentation

### Start Here

| Doc | Purpose |
|---|---|
| [docs/start-here.md](./docs/start-here.md) | 10-minute orientation and mental model |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | Clone-to-running setup path |
| [docs/where-do-i-edit.md](./docs/where-do-i-edit.md) | Find the right file for a change |
| [docs/cheatsheet.md](./docs/cheatsheet.md) | Common development recipes |

### Architecture And Internals

| Doc | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System map, packages, AI pipeline, persistence, deployment |
| [docs/ai-pipeline-eris.md](./docs/ai-pipeline-eris.md) | Eris message-to-reply pipeline |
| [docs/ai-pipeline-irene.md](./docs/ai-pipeline-irene.md) | Irene message-to-reply pipeline |
| [docs/TOOLCALLING.md](./docs/TOOLCALLING.md) | Tool registry, schemas, dispatch, aliases, contracts |
| [docs/PERSISTENCE.md](./docs/PERSISTENCE.md) | Supabase, migrations, in-memory mode, atomic operations |
| [docs/presence-api.md](./docs/presence-api.md) | Presence/dashboard API |

### Running And Operating

| Doc | Purpose |
|---|---|
| [docs/self-hosting.md](./docs/self-hosting.md) | Linux/Windows/macOS self-hosting |
| [docs/llm-provider-guide.md](./docs/llm-provider-guide.md) | Gemini, NVIDIA, OpenRouter, Ollama, LM Studio |
| [docs/local-dev-loop.md](./docs/local-dev-loop.md) | Fast local development loop |
| [docs/dev-guild-workflow.md](./docs/dev-guild-workflow.md) | Safe Discord guild testing workflow |
| [docs/SCALING.md](./docs/SCALING.md) | Multi-replica and scaling caveats |
| [docs/MONITORING.md](./docs/MONITORING.md) | Monitoring and alert recipes |

### Security

| Doc | Purpose |
|---|---|
| [SECURITY.md](./SECURITY.md) | Private vulnerability disclosure policy |
| [docs/audits/README.md](./docs/audits/README.md) | Security audit index |
| [docs/audits/AUDIT-irene-moderation.md](./docs/audits/AUDIT-irene-moderation.md) | Moderation exploit-surface notes |
| [docs/audits/AUDIT-web-tools.md](./docs/audits/AUDIT-web-tools.md) | Web/SSRF/tooling audit notes |
| [docs/audits/AUDIT-economy-gambling.md](./docs/audits/AUDIT-economy-gambling.md) | Economy/gambling race and integrity notes |

## Deployment

The root [`render.yaml`](./render.yaml) describes the canonical Render deployment shape. You can also self-host locally or on a VPS. Production deployments should configure:

- Discord application tokens and client IDs
- Supabase credentials for persistence
- LLM provider keys
- Lavalink for Irene music features
- `TWIN_API_SECRET` if both bots coordinate
- Owner IDs and trusted admin settings

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for the full environment reference.

## Security Policy

Please do **not** open public issues for vulnerabilities. Use [SECURITY.md](./SECURITY.md) for private reporting and supported-version details.

## License

ISC. See [`package.json`](./package.json).
