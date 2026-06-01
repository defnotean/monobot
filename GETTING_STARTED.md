# Getting Started

This guide takes you from a fresh `git clone` to a running bot in roughly 15 minutes.

## Prerequisites

- **Node.js 22.12.0+** (`node -v` to check; Node 24.x is the production target)
- **npm 9+** (ships with Node)
- A **Discord bot** for whichever bot you want to run — create one at [discord.com/developers/applications](https://discord.com/developers/applications). You need the bot's **token** and **application ID**.
- An **AI provider key**. Gemini (`AI_PROVIDER=gemini` + `GEMINI_API_KEY`) is the simplest start. See [docs/llm-provider-guide.md](./docs/llm-provider-guide.md) for OpenRouter, Groq, Cerebras, or fully-local Ollama / LM Studio setup (no API key needed for the local options).
- Optional: **Supabase project** (persistence), **Voyage API key** (semantic memory), **Lavalink server** (Irene music features)

## 1. Clone and install

```bash
git clone https://github.com/defnotean/monobot
cd monobot
npm ci
```

`npm ci` installs the locked workspace dependency graph from `package-lock.json`. It should complete cleanly on macOS, Linux, and Windows.

## 2. Pick a bot

The monorepo holds two independent bots. Pick one to start with.

| Bot | What it does | Folder |
|---|---|---|
| **Eris** | Chaotic-twin AI personality, economy, gambling, mini-games (~170 tools) | `packages/eris` |
| **Irene** | Good-twin server moderation, music, auto-mod, giveaways, tickets (~200 tools) | `packages/irene` |

## 3. Configure the environment

Each bot has its own `.env.example` with every variable documented. Copy and fill in the required ones:

```bash
cp packages/eris/.env.example  packages/eris/.env
cp packages/irene/.env.example packages/irene/.env
```

**Minimum to boot Eris:** `DISCORD_TOKEN`, `CLIENT_ID`, and one AI key (e.g. `GEMINI_API_KEY` if `AI_PROVIDER=gemini`). Supabase warns if missing but the bot still runs in-memory (no economy/memory persistence).

**Minimum to boot Irene:** `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_USER_ID`, and one AI key. `SUPABASE_URL`/`SUPABASE_KEY` are strongly recommended — Irene boots without them but **loses all moderation state, custom commands, tickets, reminders, etc. on every restart** (set `REQUIRE_PERSISTENCE=1` to make missing DB a fatal error instead). `TWIN_API_SECRET` is only needed if you're also running Eris and want twin coordination — skip it for single-bot setups.

Want a non-default AI provider (Groq, OpenRouter, Cerebras, local Ollama, LM Studio, etc.)? See [docs/llm-provider-guide.md](./docs/llm-provider-guide.md). Self-hosting on your own hardware? See [docs/self-hosting.md](./docs/self-hosting.md).

The `.env.example` files mark every variable as required, conditional, or optional, and include a link or path to where you obtain each key.

## 4. Invite the bot to your server

In the Discord Developer Portal:

1. Open your application → **Bot** tab → enable **Message Content Intent** (required) and **Server Members Intent** (required for moderation features)
2. **OAuth2** → **URL Generator** → scopes: `bot` + `applications.commands` → permissions: `Administrator` for a dev guild (you can scope down later)
3. Open the generated URL and pick your test guild

Use a dedicated **dev guild** — never test against the production server. The bot has destructive moderation tools.

## 5. Register slash commands (one-time)

```bash
npm run deploy --workspace=@defnotean/eris
# or
npm run deploy --workspace=@defnotean/irene
```

Re-run this only when you add or remove a slash command.

## 6. Run the bot

```bash
npm run start:eris
# or
npm run start:irene
```

You should see logs like:
```
[REGISTRY] 194 tools registered across 18 categories
[AI] Provider: Google Gemini
[Discord] Logged in as eris#1234
[Discord] Online in 1 guild(s)
```

For an auto-restart dev loop, use `npm run dev:eris` from the repo root, or `npm run dev --workspace=@defnotean/eris`; both call `node --watch index.js`.

## 7. Run the tests

```bash
npm run test:eris
npm run test:irene
npm test          # all workspaces with tests
```

Tests use `vitest` and don't touch Discord or Supabase — safe to run anywhere.

## What's next

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — workflow, conventions, your first PR
- **[docs/ai-pipeline-eris.md](./docs/ai-pipeline-eris.md)** / **[docs/ai-pipeline-irene.md](./docs/ai-pipeline-irene.md)** — how a Discord message becomes a reply
- **[docs/presence-api.md](./docs/presence-api.md)** — twin coordination layer (HMAC-signed REST between the two bots)
- **[SECURITY.md](./SECURITY.md)** — how to report a vulnerability + supported versions

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@discordjs/opus'` warning | Harmless - voice listener features are disabled. To enable native Opus, install build tools and add an Opus package explicitly in the Irene workspace, e.g. `npm install @discordjs/opus --workspace=@defnotean/irene` |
| `[WARN] SUPABASE_URL / SUPABASE_KEY missing` | Eris: runs without persistence (fine for testing). Irene: boots but loses state on every restart — set up a free Supabase project, run one locally (see [self-hosting.md](./docs/self-hosting.md)), or set `REQUIRE_PERSISTENCE=1` to fail-fast |
| Bot connects but doesn't respond to mentions | Check **Message Content Intent** is enabled in Developer Portal, and `BOT_OWNER_ID` matches your Discord user ID |
| `[FATAL] DISCORD_TOKEN is required` | `.env` not found or token line malformed — check `packages/<bot>/.env` is in the right folder |
| Slash commands missing in Discord | Re-run `npm run deploy --workspace=@defnotean/<bot>` |
