# Local dev loop

The fastest inner-loop workflow for working on this codebase.

## TL;DR

Three terminals, side-by-side:

```bash
# Terminal 1 — bot with file-watch reload
npm run dev:eris        # or dev:irene

# Terminal 2 — tests in watch mode
npm run test:watch --workspace=@defnotean/eris

# Terminal 3 — your editor + ad-hoc commands (deploy, lint, log tail)
```

## Prereqs

You should already be set up per [GETTING_STARTED.md](../GETTING_STARTED.md). The summary:
- Node 18+ (20+ recommended)
- `.env` populated for whichever bot(s) you're working on
- A [dev guild + dev Discord app + dev Supabase project](./dev-guild-workflow.md) — never against prod

## Terminal 1 — auto-reload bot

```bash
npm run dev:eris
# Internally: tsx --watch index.ts
```

`tsx --watch` re-runs `index.ts` on every file save. The bot reconnects to Discord on each reload (~3-5s). Good for iterating on:
- AI tools / executors
- Event handlers
- Slash command code (the slash command **definition** still needs a manual `npm run deploy` if you change `data` — see below)
- Personality prompts (cached at boot, so a reload picks up changes)
- Config / env vars (also cached at boot)

**You DON'T need to redeploy slash commands every time you save** — only when you add/remove a command or change its `data` (name, description, options). Code changes inside `execute()` are picked up by the watch.

## Terminal 2 — tests in watch mode

```bash
npm run test:watch --workspace=@defnotean/eris
```

Vitest re-runs affected tests on every save. Faster than full bot restart for testing pure functions, executors, and DB methods.

To watch a specific file:
```bash
npx vitest packages/eris/tests/ai/getMoodTool.test.ts
```

To watch by name pattern:
```bash
npx vitest -t "send_compliment"
```

See [testing-guide.md](./testing-guide.md) for the full guide.

## Terminal 3 — ad hoc

Common commands:

```bash
# (Re)register slash commands — needed when you change command name/description/options
npm run deploy --workspace=@defnotean/eris

# Lint workspace dep version sync (catches the 2026-04-24 bug class)
npm run lint:version-sync

# Tail the log file
tail -f packages/eris/bot.log

# Run a single test file
npx vitest run packages/eris/tests/ai/getMoodTool.test.ts

# Type-check (no emit)
npm run build --workspace=@defnotean/eris      # tsc --noEmit-ish; check it succeeds before committing
```

## Faster slash command iteration

Global slash command updates take **up to 1 hour** to propagate. For dev work, switch to guild-scoped registration so updates appear instantly.

Edit `packages/<bot>/deploy-commands.js`:

```js
// from this (global):
await rest.put(Routes.applicationCommands(clientId), { body: commands });

// to this (guild-scoped, instant):
await rest.put(
  Routes.applicationGuildCommands(clientId, DEV_GUILD_ID),
  { body: commands }
);
```

**Don't commit this change.** It's a local-only convenience. Stash it before pushing.

## Testing twin coordination locally

Run both bots locally and point them at each other on localhost:

**Eris `.env`:**
```
PORT=3000
TWIN_API_SECRET=local-shared-secret
IRENE_API_URL=http://localhost:3001
```

**Irene `.env`:**
```
PORT=3001
TWIN_API_SECRET=local-shared-secret
ERIS_API_URL=http://localhost:3000
ERIS_BOT_ID=<eris-app-id>
```

Two terminals:
```bash
npm run dev:eris
npm run dev:irene
```

Now `ask_irene`, `ask_eris`, `firePunishSignal` all hit localhost. Useful for testing twin features without deploying.

## Testing music locally (Irene)

You need a Lavalink server. Easiest: Docker.

```bash
docker run -d --name lavalink -p 2333:2333 \
  -e LAVALINK_SERVER_PASSWORD=youshallnotpass \
  ghcr.io/lavalink-devs/lavalink:4
```

Then in Irene's `.env`:
```
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false
```

`npm run dev:irene` and try `/play <youtube url>` in your dev guild.

## Testing the voice listener locally (Irene)

The voice listener needs `@discordjs/opus` to decode received Opus audio. On Windows, this requires Visual Studio Build Tools. On Mac/Linux it usually builds without trouble.

```bash
npm install --include=optional @discordjs/opus
```

If install fails, voice receive doesn't work locally. Music playback (Lavalink-side) is unaffected.

## Hot-reload for personality prompts

Prompt files (`prompts/<bot>-personality.md`) are cached at boot via `prompts/loader.ts`. **A file save alone doesn't reload them.** You need to either:

- Restart the bot (`tsx --watch` does this on any source save, but `.md` saves don't trigger watch; touch any `.js` file to force).
- Add a slash command that calls `loader.clearCache()` and reloads — owner-only.

For AI-side iteration on personality, the second approach is faster. Add this temporarily:

```js
// commands/owner/reload-personality.js
import { SlashCommandBuilder } from "discord.js";
import { clearCache } from "../../prompts/loader.ts";
import { isOwner } from "../../utils/permissions.js";

export default {
  data: new SlashCommandBuilder().setName("reload-personality").setDescription("Reload prompt files"),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: "no", ephemeral: true });
    clearCache();
    await interaction.reply({ content: "reloaded", ephemeral: true });
  },
};
```

Don't commit it. Local dev convenience.

## Useful one-liners

### Tail just errors / warnings
```bash
tail -f packages/eris/bot.log | grep -E "ERROR|WARN"
```

### Check what env vars the bot read on boot
```bash
grep "^\[Config\]" packages/eris/bot.log
```

### See the last AI exchange
```bash
grep -A 5 "AI \[reply\]" packages/eris/bot.log | tail -20
```

### Force re-deploy of slash commands (clear the hash)
Connect to Supabase SQL editor:
```sql
DELETE FROM bot_data WHERE id = 'eris_commands_hash:<your-client-id>';
```
Next bot restart will re-PUT all commands.

### Reset Eris's economy for one user (test wipe)
```sql
UPDATE eris_economy SET balance = 0 WHERE user_id = '<your-id>';
```
The cache is loaded at boot — restart to pick up the change, OR use the in-memory mutator via a temporary admin command.

## Faster than running the bot at all

For changes that don't need real Discord — pure-function tests, executor tests, DB layer tests — `npm test` is **way faster** than restarting the bot. ~641 tests run in seconds.

Reach for the bot only when:
- You changed event handler logic
- You changed gating
- You're iterating on AI prompt / response shape
- You're testing integration with Discord (slash command flow, voice, music)

## Editor setup

Both packages have a `tsconfig.json`. Most editors with TypeScript support will give you JSDoc-based hints even though the source is JS. VS Code config that works:

`.vscode/settings.json`:
```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "javascript.implicitProjectConfig.checkJs": true,
  "files.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/*.log": true
  }
}
```

(Don't commit this if your team uses different editors.)

## Stuck in a long debug loop?

If you've been debugging the same thing for >30 min:
1. Stop. Read [debugging-playbook.md](./debugging-playbook.md) — your symptom is probably listed.
2. Search for a UX string in the code: `git grep "exact error message"`.
3. Check `git log -10 --oneline` for recent changes near the file.
4. Ask in your dev channel rather than thrashing alone.

## Pre-commit checklist

Before opening a PR — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the full list. Quick version:

- [ ] `npm test` passes
- [ ] `npm run lint:version-sync` passes
- [ ] Bot starts cleanly (`npm run dev:<bot>`)
- [ ] Affected slash commands work in dev guild
- [ ] If you touched moderation: tested against an alt account
- [ ] If you touched twin: smoke-tested with both bots running locally

## What NOT to do in dev

- **Don't run dev bots against your production Discord guild.** They'll respond to messages real users send, ban people for real, modify prod state. Use a dev guild + dev bot token.
- **Don't run dev bots against your production Supabase project.** Make a `monobot-dev` Supabase project; copy the schema; isolate.
- **Don't commit `deploy-commands.js` changes that scope to one guild.** It's a local-only optimization.
- **Don't commit a temporary `/reload-personality` (or similar) owner debug command.** Same reason.
- **Don't `npm install <single-package>` without committing the lockfile changes** — `package-lock.json` going out of sync trips `npm ci` on Render.
