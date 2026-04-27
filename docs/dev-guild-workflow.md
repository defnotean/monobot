# Dev Guild Workflow

There is **no staging environment** for these bots. Render auto-deploys from `main`, and the production guilds host real users. A dedicated **dev guild** is the only place to safely test changes that touch:

- Moderation actions (ban, kick, timeout, warn, purge)
- Auto-mod rules and rules-enforcer escalation
- Server setup commands (channel/role creation, welcome embeds, ticket panels)
- Twin coordination (`ask_eris`, `ask_irene`, cross-bot punish signals)
- Anything that writes to Supabase

If you skip this step and test in a real server, you *will* eventually delete a real channel or ban a real user.

## 1. Create a dev guild

1. In Discord, click the `+` in the server list → **Create My Own** → **For me and my friends**
2. Name it something obvious like `irene-dev` or `eris-dev`
3. **You** are the only required member. Invite a throwaway alt account if you need a non-admin user to test moderation against.

Use a separate guild per bot when possible. Eris and Irene having different intent requirements (Eris uses fewer mod intents) means a single guild works but adds noise.

## 2. Create a separate Discord application for dev

Don't reuse production tokens locally — a crash dump or a leaked log line exposes your prod bot.

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name it `eris-dev` / `irene-dev`
2. **Bot** tab → **Reset Token** → copy this into `.env` as `DISCORD_TOKEN` (Eris) / `DISCORD_BOT_TOKEN` (Irene)
3. Enable **Privileged Gateway Intents**:
   - **Message Content Intent** — required for both bots
   - **Server Members Intent** — required for moderation features (Irene)
   - **Presence Intent** — only if you're testing presence-related features
4. **General Information** → copy the **Application ID** into `.env` as `CLIENT_ID` / `DISCORD_CLIENT_ID`

## 3. Invite the dev bot to your dev guild

**OAuth2** → **URL Generator**:

| Scope | Required |
|---|---|
| `bot` | ✓ |
| `applications.commands` | ✓ |

| Permissions | Recommended for dev |
|---|---|
| Administrator | ✓ (for dev — much faster than scoping individually) |

Open the generated URL → pick your dev guild → authorize.

For production deploys, scope permissions down per-bot — Administrator is a dev convenience, not a prod default.

## 4. Use a separate Supabase project

Production uses one Supabase project. Local dev should use **its own** so you can drop tables, reset data, and test schema changes without consequences.

1. [supabase.com](https://supabase.com) → **New project** → name it `monobot-dev`
2. **Project Settings** → **API** → copy `URL` and `anon` `public` key into `.env` as `SUPABASE_URL` and `SUPABASE_KEY`
3. Apply any migrations the bots expect (the bots will create tables on first write, but for explicit migrations see `packages/<bot>/migrations/`)

Eris will run without Supabase (warns and uses ephemeral state). Irene requires it.

## 5. Slash commands: dev guild vs global

Discord slash commands have two scopes:

| Scope | Where it shows | Update latency |
|---|---|---|
| **Global** (default for these bots) | Every guild the bot is in | Up to ~1 hour |
| **Guild-specific** | One guild only | Instant |

`npm run deploy --workspace=@defnotean/<bot>` registers commands **globally**. For fast iteration in your dev guild, you can temporarily edit `deploy-commands.js` to register per-guild instead — search for the `Routes.applicationCommands(...)` vs `Routes.applicationGuildCommands(...)` distinction.

Don't commit a guild-scoped deploy script. It's a local-only convenience.

## 6. Testing moderation safely

- Use **throwaway alt accounts** for ban/kick/timeout/warn testing — never test against your main account or another contributor without coordinating
- Disable auto-mod (`/auto-mods` or whatever the toggle is) in your dev guild unless you're explicitly testing it. Otherwise the rules engine fires on your test messages and produces noise.
- Twin coordination calls (`ask_eris`, `ask_irene`) hit whatever URL is in `IRENE_API_URL` / `ERIS_API_URL`. For local dev, either:
  - Run both bots locally and point them at each other (`http://localhost:<port>`)
  - Skip twin features and let the calls fail gracefully — both bots handle "twin unreachable" without crashing

## 7. Pre-merge checklist

Before opening a PR or merging to `main`:

- [ ] Bot starts cleanly (`npm run dev:<bot>`)
- [ ] Affected slash commands work in dev guild (re-deploy if you added/removed any)
- [ ] If you touched moderation: tested ban/kick/timeout against an alt account, confirmed undo works
- [ ] If you touched twin coordination: smoke-tested the affected sub-action with both bots running
- [ ] `npm run test:<bot>` passes
- [ ] `npm run lint:version-sync` passes (catches the bug class from 2026-04-24, see [DEPLOY_MIGRATION.md](../DEPLOY_MIGRATION.md))

## Common dev-guild gotchas

| Symptom | Cause |
|---|---|
| Slash commands don't appear immediately | Global registration takes ~1 hour. Use guild-scoped registration for instant updates during dev |
| Bot connects but doesn't see messages | Message Content Intent disabled in Developer Portal |
| Bot can't add roles to other members | Your bot's role is below the role it's trying to assign — drag the bot's role above in **Server Settings → Roles** |
| Twin call fails with `ECONNREFUSED` | The other bot isn't running, or `IRENE_API_URL`/`ERIS_API_URL` doesn't match the running port |
| Supabase says "permission denied" | RLS policy missing — check `packages/<bot>/migrations/` for the policies that should exist on each table |
