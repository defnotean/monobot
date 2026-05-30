# Cheatsheet

The most common tasks, as copy-paste recipes. Pair with [where-do-i-edit.md](./where-do-i-edit.md) (which tells you WHICH file) and the [pipeline docs](./ai-pipeline-eris.md) (for the WHY).

All examples assume you're in the appropriate `packages/<bot>/` directory.

For three of these recipes (new tool, new slash command, new event), the repo ships scaffolders that print the boilerplate for you:

```bash
node scripts/scaffold-tool.js     eris send_compliment misc    # dry-run; add --write to create the test file
node scripts/scaffold-command.js  eris utility compliment      # dry-run; add --write to create the file
node scripts/scaffold-event.js    eris messageDelete           # dry-run; add --write to create the file
```

The handwritten recipes below show what those scaffolders produce so you can edit by hand when you need to.

---

## 1. Add a new AI tool

**Schema** in `ai/tools.js` under the right TOC section ([packages/eris/ai/tools.js:9-22](../packages/eris/ai/tools.js)):

```js
{
  name: "send_compliment",
  tags: ["fun"],                    // optional; ["fun"] makes it available in twin chat
  description: "Send a sincere compliment to a user. Use when they did something cool, achieved something, or deserve recognition. Don't use for sarcasm — that's `roast`.",
  input_schema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "Discord user ID to compliment" },
      topic: { type: "string", description: "What you're complimenting them about" }
    },
    required: ["user_id", "topic"]
  }
}
```

**Handler** in the relevant `ai/executors/<domain>Executor.js`. Each sub-executor exports a single named `execute` and gates on `HANDLED` — return `undefined` for any tool it doesn't own so the main executor falls through to the next sub-executor ([packages/eris/ai/executor.js:247-260](../packages/eris/ai/executor.js)):

```js
// packages/eris/ai/executors/miscExecutor.js
const HANDLED = new Set([..., "send_compliment"]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;
  switch (toolName) {
    case "send_compliment": {
      const target = await message.guild.members.fetch(input.user_id).catch(() => null);
      if (!target) return "couldn't find that user";
      await message.channel.send(`<@${target.id}> — genuinely, ${input.topic}. respect.`);
      return `complimented @${target.user.username}`;
    }
    // ... existing cases
  }
}
```

If no existing sub-executor fits, create a new file under `ai/executors/`, export `execute`, and append it to `SUB_EXECUTORS` in [`ai/executor.js:247`](../packages/eris/ai/executor.js).

**Test** in `tests/ai/sendCompliment.test.ts` — mirror the reference test [tests/ai/getMoodTool.test.ts](../packages/eris/tests/ai/getMoodTool.test.ts). Mock `../../database.js` *before* importing the sub-executor:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../database.js", () => ({
  // stub only what the handler actually reads
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../ai/executors/miscExecutor.js";

describe("send_compliment", () => {
  it("sends a compliment in the channel and returns confirmation", async () => {
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ id: "123", user: { username: "alice" } });
    const message = { channel: { send }, guild: { members: { fetch } } } as any;

    const result = await execute("send_compliment", { user_id: "123", topic: "your art" }, message, {});

    expect(send).toHaveBeenCalledWith(expect.stringContaining("<@123>"));
    expect(result).toBe("complimented @alice");
  });

  it("returns undefined for tools the misc executor does not own", async () => {
    expect(await execute("not_a_real_tool", {}, {} as any, {})).toBeUndefined();
  });
});
```

**Run** `npm run test:eris -- sendCompliment`. Then start the bot and ask it to compliment someone.

---

## 2. Add a new slash command

Create `commands/<category>/<name>.js`. Slash commands export `data` and `execute` as **named** exports — the loader (`index.js:36-60`) only picks up files with both:

```js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("compliment")
  .setDescription("Get a compliment")
  .addStringOption(opt => opt.setName("topic").setDescription("What for?").setRequired(false));

export async function execute(interaction) {
  const topic = interaction.options.getString("topic") ?? "just being you";
  const embed = new EmbedBuilder()
    .setColor(config.colors.primary)      // Eris brand color; see config.js:349
    .setDescription(`<@${interaction.user.id}> — genuinely, ${topic}. respect.`);
  await interaction.reply({ embeds: [embed] });
}
```

For Irene, swap the embed construction for one of the helpers in [`utils/embeds.js`](../packages/irene/utils/embeds.js): `primaryEmbed`, `successEmbed`, `errorEmbed`, `warnEmbed`, `infoEmbed`, `musicEmbed`, etc.

**Deploy globally**: `npm run deploy --workspace=@defnotean/<bot>` (~1h propagation).

**Deploy to dev guild only** (instant updates): see [dev-guild-workflow.md §5](./dev-guild-workflow.md).

---

## 3. Add a new event handler

Drop a file in `events/` named after the gateway event. The loader binds `default` to `client.on(<filename>, handler)` ([packages/eris/index.js:62-93](../packages/eris/index.js)):

```js
// events/messageDelete.js
import { log } from "../utils/logger.js";

export default async function messageDelete(message, client) {
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }
  if (message.author?.bot) return;

  log(`[snipe] message ${message.id} deleted in #${message.channel.name}`);
}
```

The loader wraps every handler in a try/catch so a thrown handler doesn't crash the process.

`ready.js` is the only special case — the loader binds it to `client.once("clientReady", handler)` (the modern discord.js v14.18+ event name; the old `"ready"` is deprecated). Filename is still `ready.js`.

---

## 4. Add a Supabase column

**Migration** — `migrations/00X_add_my_feature.sql`:

```sql
ALTER TABLE eris_user_preferences
ADD COLUMN favorite_emoji TEXT;
```

Eris has a `npm run migrate` script (`migrate.cjs`) that walks the `migrations/` dir; for ad-hoc schema work the Supabase SQL editor is fine. Apply once per environment.

**Read/write methods** in `database.js`:

```js
export async function getFavoriteEmoji(userId) {
  if (!supabase) return null;
  const { data: row } = await supabase
    .from("eris_user_preferences")
    .select("favorite_emoji")
    .eq("user_id", userId)
    .maybeSingle();
  return row?.favorite_emoji ?? null;
}

export async function setFavoriteEmoji(userId, emoji) {
  if (!supabase) return false;
  const { error } = await supabase
    .from("eris_user_preferences")
    .upsert({ user_id: userId, favorite_emoji: emoji });
  return !error;
}
```

For frequently-read state, also wire it into the in-memory cache at the top of `database.js` (line ~42). SIGTERM/SIGINT handlers drain the debounced flush queue before exit.

---

## 5. Atomic balance update (read-modify-write)

Use `withUserLock` to serialize on a single user without blocking other users. **Critical**: the lock is non-reentrant — call `updateBalanceUnsafe` (not `updateBalance`) inside the lock, or you deadlock. See the note at [database.js:817-823](../packages/eris/database.js):

```js
import { withUserLock, getBalance, updateBalanceUnsafe } from "../database.js";

export async function buyItem(userId, itemId, cost) {
  return withUserLock(userId, async () => {
    const { balance } = await getBalance(userId);
    if (balance < cost) return { ok: false, reason: "insufficient" };
    await updateBalanceUnsafe(userId, -cost, "purchase", `item:${itemId}`);
    return { ok: true, newBalance: balance - cost };
  });
}
```

Two different users hitting `buyItem` simultaneously don't block each other. Two operations on the same user serialize. `withUserLock` is just an alias for `withEconLock` — same string-keyed promise chain.

For the "I already have the user's balance and want to deduct only if sufficient" shape, prefer `tryDeductBalanceUnsafe(userId, amount, type, details)` — it returns `{ ok, reason }` and skips a re-read.

---

## 6. Cache a tool result

Add the tool name to `CACHEABLE_TOOLS` in [ai/executor.js:142-150](../packages/eris/ai/executor.js):

```js
const CACHEABLE_TOOLS = new Set([
  "check_balance",
  "get_mood",
  "recall_memories",
  "send_compliment",   // add yours
]);
```

Identical `(userId, toolName, args)` calls within 15 seconds now return the cached value. Error strings (matching `/^(Error:|Couldn't|Failed|Sorry,|You don't|Not enough)/i`) are never cached — they'd mask real failures on retry.

**For write tools that should invalidate the cache:**

```js
const CACHE_INVALIDATING_TOOLS = new Set([
  "give_coins",
  "remember_fact",
  // ...
  "send_compliment",   // if it counts as a write
]);
```

**For tools that mutate a second user**:

```js
const TWO_USER_TOOLS = new Set([
  "give_coins", "rob_user", "trade_offer", "marry", "divorce", "pet_battle",
  "send_compliment",   // if you want target's cache invalidated too
]);
```

The executor pulls the second user's ID from `input.user_id || input.target_id || input.partner_id` and drops their cache group too.

---

## 7. Add a tool alias (model misspells your tool name)

[ai/executor.js:37-135](../packages/eris/ai/executor.js):

```js
const TOOL_ALIASES = {
  ...
  "compliment": "send_compliment",
  "praise": "send_compliment",
};
```

Add aliases as you see drift in production logs. Harmless to over-add — the executor logs `[EXECUTOR] Auto-corrected tool: <bad> → <good>` on every hit so you can track which models hallucinate which names.

---

## 8. Update the personality file

Just edit the `.md`:

- Eris: `packages/eris/prompts/eris-personality.md`, `eris-relationships.md`, `eris-rules.md`, `eris-tool-guide.md`
- Irene: `packages/irene/prompts/irene-personality.md`

Reloads on bot restart. No code change. No tests required (but adding a regression test for tone is wise if you're tightening behavior).

Use `{{OWNER_ID}}` for the owner placeholder; [`prompts/loader.ts:36`](../packages/eris/prompts/loader.ts) interpolates it at boot from `config.ownerId`.

---

## 9. Add a directive (per-server "don't do X here" rule)

These are admin-set behavioral overrides. Example: "in #serious-talk, never use emoji."

The bot already exposes `save_directive` / `list_directives` / `remove_directive` as AI tools — admins can just *ask*. To add programmatically via `database.js` ([database.js:2156-2174](../packages/eris/database.js)):

```js
import { addDirective } from "../database.js";

const result = addDirective(guildId, "in #serious-talk, no emoji", channelId, addedBy);
if (!result.success) console.warn(result.reason);   // "duplicate directive" or "max 50 directives per server"
```

Directives surface in the system prompt under `[DIRECTIVES]` and the model is told to obey them. Owner can override.

**Remove**:

```js
import { removeDirective } from "../database.js";

const result = removeDirective(guildId, indexOrKeyword);
// result.success / result.removed (the directive text) / result.reason on failure
```

---

## 10. HMAC-call the other bot

**Caller** (signing — see [`ai/executors/twinExecutor.js`](../packages/eris/ai/executors/twinExecutor.js) for the full pattern):

```js
import { signTwinRequest } from "@defnotean/shared/twinSign";
import config from "../config.js";

const payload = JSON.stringify({
  requester_id: message.author.id,
  guild_id: message.guild.id,
  channel_id: message.channel.id,
  command: "ban",
  args: { target_id, reason },
});

const headers = signTwinRequest(payload, config.twinApiSecret);
const res = await fetch(`${config.twinApiUrl}/api/twin/command`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: payload,
});

const data = await res.json();
if (!data.success) return `irene refused: ${data.error}`;
return `told irene to ${command} and she did it: ${data.result}`;
```

**Receiver** (verifying — see [`packages/irene/presence.js`](../packages/irene/presence.js) and [`packages/eris/api/dashboard.js`](../packages/eris/api/dashboard.js) for the live patterns):

```js
import { verifyTwinRequest } from "@defnotean/shared/twinSign";

const result = verifyTwinRequest(req.headers, rawBody, config.twinApiSecret);
if (!result.ok) {
  res.writeHead(403, { "content-type": "application/json" });
  return res.end(JSON.stringify({ error: result.reason }));
}
// ... re-check requester is trusted, then dispatch
```

Sign and verify the **exact same byte string**. Stringify the JSON once, reuse it for both signing and the body. Any framework middleware that re-serializes JSON before verification will silently break signatures.

---

## 11. Add a new tool to Eris (full walkthrough using the registry)

Recipe #1 above covers the schema + handler + test. This recipe walks the *registry* wiring that decides whether the model even sees the tool.

There are three knobs in [`ai/toolRegistry.js`](../packages/eris/ai/toolRegistry.js):

1. **Always-include** — a small set of names registered via `registry.registerAlwaysInclude([...])` ([toolRegistry.js:156-167](../packages/eris/ai/toolRegistry.js)). These ride in Tier 1 every message. Only put a tool here if it's foundational (memory, web search, presence, etc.).

2. **Category + keyword regex** — `registry.registerTools(toolsArray, "categoryName", /regex/i)`. When the user's message matches the regex, every tool in that category is added to Tier 1.

3. **Twin profile** — only tools tagged `tags: ["fun"]` on their schema ride in twin (sister-bot) conversations. See [`toolRegistry.js:42`](../packages/eris/ai/toolRegistry.js).

Tier 1 = full JSON schema sent as the API `tools` parameter. Tier 2 = name + first-sentence description appended to the system prompt as a catalog. The model can still call a Tier 2 tool by name — the executor dispatches regardless of tier. The split exists to keep token costs down.

To add your tool to an existing category, find its `registry.registerTools(...)` block (search for the closest semantic category) and add your tool's `name` to the inclusion filter. To make a new category, follow the same `registerTools(...)` shape with a fresh keyword regex.

Verify with the registry stats line in startup logs: `[REGISTRY] N tools registered across M categories`.

---

## 12. Add a slash command (with subcommands and autocomplete)

The basic shape lives in recipe #2. For richer commands:

**Subcommands** — Discord caps the visible command list at 100 entries, so group related actions:

```js
export const data = new SlashCommandBuilder()
  .setName("notes")
  .setDescription("Manage your notes")
  .addSubcommand(s => s.setName("add").setDescription("Add a note")
    .addStringOption(o => o.setName("text").setDescription("note body").setRequired(true)))
  .addSubcommand(s => s.setName("list").setDescription("Show your notes"))
  .addSubcommand(s => s.setName("delete").setDescription("Delete a note")
    .addIntegerOption(o => o.setName("id").setDescription("note id").setRequired(true).setAutocomplete(true)));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "add")    return handleAdd(interaction);
  if (sub === "list")   return handleList(interaction);
  if (sub === "delete") return handleDelete(interaction);
}

export async function autocomplete(interaction) {
  if (interaction.options.getSubcommand() === "delete") {
    const notes = await getNotes(interaction.user.id);
    await interaction.respond(notes.slice(0, 25).map(n => ({ name: n.title, value: n.id })));
  }
}
```

The autocomplete handler is dispatched in [`events/interactionCreate.js`](../packages/eris/events/interactionCreate.js). Discord rejects autocomplete responses after 3 seconds — keep them cache-hot.

**Long work** — Discord's interaction token expires in 3 seconds. If you can't reply in time, `await interaction.deferReply()` first, then use `interaction.editReply(...)` when you're done.

**Ephemeral replies** — set `flags: 64` on a reply object to make it visible only to the user. Use for confirmations and error messages that don't need to clutter the channel.

---

## 13. Run a single test file

Vitest is bot-local — there's no root-level test runner. Pick the bot first:

```bash
# Run one file
npm run test:eris -- tests/ai/getMoodTool.test.ts

# Filter by name substring (matches the it() / describe() text)
npm run test:eris -- --testNamePattern="great mood"

# Watch mode
npm run test:watch --workspace=@defnotean/eris

# Same patterns, irene:
npm run test:irene -- tests/ai/executors/listEmojis.test.ts
```

The double-dash forwards args to vitest. The bot's `vitest.config.ts` only globs `tests/**/*.test.ts`, so a JS test file silently won't run — use `.ts` even if the module under test is `.js` (just `// @ts-expect-error` the import).

---

## 14. Use the shared rate-limiter in a new endpoint

The HMAC twin endpoints use a shared sliding-window limiter from [`packages/shared/src/rateLimit.js`](../packages/shared/src/rateLimit.js). It's a tiny in-memory limiter — fine for a handful of long-lived keys per process, not designed for high cardinality or multi-process correctness.

```js
import { createRateLimiter } from "@defnotean/shared/rateLimit";

// Create one limiter per logical endpoint at module scope (not per request)
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1000 });

export async function handleSomething(req, res) {
  const identityKey = req.headers["x-twin-identity"] || req.socket.remoteAddress;
  if (!limiter.allow(identityKey)) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    return res.end(JSON.stringify({ error: "rate limited" }));
  }
  // ... do the work
}
```

Live examples: [`packages/irene/presence.js`](../packages/irene/presence.js) (the `/api/twin/state` endpoint, 10/min/IP) and [`packages/eris/api/dashboard.js`](../packages/eris/api/dashboard.js). Pass a `string` key — `null`/`undefined` keys are not rate-limited, so default to the source IP if you have no better identity.

For per-user limits on AI tools specifically, the bot already has [`utils/toolRateLimit.js`](../packages/eris/utils/toolRateLimit.js) with one limiter per expensive tool (web_search, scrape_url, analyze_image, etc.).

---

## 15. Add a per-user lock around a sensitive op

Any read-modify-write that touches a single user's state (balance, inventory, pet, partner, etc.) needs serialization — without it, two concurrent tool calls can both read `balance=100`, both subtract 80, and one user just got a free 80 coins.

```js
import { withUserLock, updateBalanceUnsafe } from "../database.js";

export async function consumeItem(userId, itemId) {
  return withUserLock(userId, async () => {
    const inv = await getInventory(userId);
    const stack = inv.find(i => i.id === itemId);
    if (!stack || stack.qty < 1) return { ok: false, reason: "no_such_item" };

    // All mutations inside the lock use the *Unsafe variants — the
    // outer withUserLock prevents re-entry, calling updateBalance
    // (which re-acquires the lock) would deadlock. See database.js:817.
    await decrementItemUnsafe(userId, itemId, 1);
    await updateBalanceUnsafe(userId, +rewardForItem(itemId), "consume", `item:${itemId}`);

    return { ok: true };
  });
}
```

Notes from the live code:

- The lock is keyed by string. Different users don't block each other; same-user ops serialize.
- The implementation is a single-process promise chain ([database.js:625-634](../packages/eris/database.js)). On Render this is fine because each bot runs as one dyno; on a multi-instance deploy, fall back to Supabase optimistic versioning (the `version` column on `eris_economy`, already wired into `_updateBalanceUnsafe`).
- Don't hold the lock across a network call you don't need to. Read the inputs first, do the I/O, then enter the lock for the verify-and-commit only.
- For 2-user ops (transfers, robbery, trading), acquire both locks in a deterministic order (sorted by user ID) to avoid AB/BA deadlocks. See `transferBalance` in `database.js` for the pattern.

---

## Bonus — reload the bot during development

```bash
npm run start:eris   # node index.js — current dev loop
npm run start:irene
```

Both packages declare `"dev": "tsx --watch index.ts"` but the entry file is still `index.js`; `start` is the working command. Restart on edits.

For prompt changes, the prompt loader caches at boot, so a clean restart is required for `.md` edits to take effect.

---

## What NOT to do (per [CONTRIBUTING.md](../CONTRIBUTING.md))

- Don't refactor adjacent code "while you're there"
- Don't rename things
- Don't reformat
- Don't add backwards-compat shims
- Don't write `// this saves the note` style comments — only WHY-comments
- Don't touch `personality.js`, `longmemory.js`, `firewall.js`, or `bumpReminder*.js` without checking whether the matching bot needs the same change.
- Don't skip writing a test for a new tool — it's mentioned in CONTRIBUTING for a reason
- Don't deploy without smoke-testing in your dev guild — there's no staging
