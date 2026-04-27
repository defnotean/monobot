# Cheatsheet

The 10 most common tasks, as copy-paste recipes. Pair with [where-do-i-edit.md](./where-do-i-edit.md) (which tells you WHICH file) and the [pipeline docs](./ai-pipeline-eris.md) (for the WHY).

All examples assume you're in the appropriate `packages/<bot>/` directory.

---

## 1. Add a new AI tool

**Schema** in `ai/tools.js` under the right category:

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

**Handler** in the relevant `ai/executors/<domain>.js`:

```js
const HANDLED = new Set([..., "send_compliment"]);

export async function executeMisc(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;
  switch (toolName) {
    case "send_compliment": {
      const target = await ctx.findMember(input.user_id);
      if (!target) return "couldn't find that user";
      await message.channel.send(`<@${target.id}> — genuinely, ${input.topic}. respect.`);
      return `complimented @${target.user.username}`;
    }
    // ... existing cases
  }
}
```

**Test** in `tests/ai/sendCompliment.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { executeMisc } from "../../ai/executors/miscExecutor.js";

describe("send_compliment", () => {
  it("sends a compliment in the channel and returns confirmation", async () => {
    const send = vi.fn();
    const message = { channel: { send } };
    const ctx = { findMember: vi.fn().mockResolvedValue({ id: "123", user: { username: "alice" } }) };

    const result = await executeMisc("send_compliment", { user_id: "123", topic: "your art" }, message, ctx);

    expect(send).toHaveBeenCalledWith(expect.stringContaining("<@123>"));
    expect(result).toBe("complimented @alice");
  });
});
```

**Run** `npm run test:<bot>`. Then start the bot and ask it to compliment someone.

---

## 2. Add a new slash command

Create `commands/<category>/<name>.js`:

```js
import { SlashCommandBuilder } from "discord.js";
import { embedColor } from "../../utils/discord.js";   // Eris path; Irene uses utils/embeds.js

export default {
  data: new SlashCommandBuilder()
    .setName("compliment")
    .setDescription("Get a compliment")
    .addStringOption(opt => opt.setName("topic").setDescription("What for?").setRequired(false)),

  async execute(interaction) {
    const topic = interaction.options.getString("topic") ?? "just being you";
    await interaction.reply({
      embeds: [{
        description: `<@${interaction.user.id}> — genuinely, ${topic}. respect.`,
        color: embedColor("primary"),
      }],
    });
  },
};
```

**Deploy globally**: `npm run deploy --workspace=@defnotean/<bot>` (~1h propagation).

**Deploy to dev guild only** (instant updates): see [dev-guild-workflow.md §5](./dev-guild-workflow.md).

---

## 3. Add a new event handler

Drop a file in `events/` named after the event:

```js
// events/messageDelete.js
export default async function (message, client) {
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }
  if (message.author?.bot) return;

  // your logic
  log(`[snipe] message ${message.id} deleted in #${message.channel.name}`);
}
```

The auto-loader in `index.js` binds `default` to `client.on("messageDelete", handler)`. Filename = event name.

For one-time events (like `ready`), the loader treats `ready.js` as `client.once`.

---

## 4. Add a Supabase column

**Migration** — `migrations/00X_add_my_feature.sql`:

```sql
ALTER TABLE eris_user_preferences
ADD COLUMN favorite_emoji TEXT;
```

Apply it manually via Supabase SQL editor (no auto-runner).

**Read/write methods** in `database.js`:

```js
// Add to cache shape at top of file:
//   user_preferences: {}  →  userId → { ..., favorite_emoji }

export function getFavoriteEmoji(userId) {
  return cache.user_preferences[userId]?.favorite_emoji ?? null;
}

export function setFavoriteEmoji(userId, emoji) {
  cache.user_preferences[userId] ??= {};
  cache.user_preferences[userId].favorite_emoji = emoji;
  markDirty("user_preferences");
}
```

The debounced flush already handles serialization. SIGTERM will flush pending writes.

---

## 5. Atomic balance update (read-modify-write)

Use `withUserLock` to serialize on a single user without blocking other users:

```js
import { withUserLock, getBalance, updateBalance } from "../database.js";

export async function buyItem(userId, itemId, cost) {
  return withUserLock(userId, async () => {
    const balance = getBalance(userId);
    if (balance < cost) return { ok: false, reason: "insufficient" };
    updateBalance(userId, -cost, "purchase", { item: itemId });
    return { ok: true, newBalance: balance - cost };
  });
}
```

Two different users hitting `buyItem` simultaneously don't block each other. Two operations on the same user serialize.

---

## 6. Cache a tool result

Make the tool name an entry in `CACHEABLE_TOOLS` in `ai/executor.js`:

```js
const CACHEABLE_TOOLS = new Set([
  "check_balance",
  "get_mood",
  "recall_memories",
  "send_compliment",   // add yours
]);
```

Now identical `(userId, toolName, args)` calls within 15 seconds return the cached value.

**For write tools that should invalidate the cache:**

```js
const CACHE_INVALIDATING_TOOLS = new Set([
  "give_coins",
  "remember_fact",
  // ...
  "send_compliment",   // if it counts as a write
]);
```

**For tools that affect another user**:

```js
const TWO_USER_TOOLS = new Set([
  "give_coins",
  "rob_user",
  "send_compliment",   // if you want target's cache invalidated too
]);
```

---

## 7. Add a tool alias (model misspells your tool name)

`ai/executor.js`:

```js
const TOOL_ALIASES = {
  ...
  "compliment": "send_compliment",
  "praise": "send_compliment",
};
```

Add aliases as you see drift in production logs. Harmless to over-add.

---

## 8. Update the personality file

Just edit the `.md`:

- Eris: `packages/eris/prompts/eris-personality.md`, `eris-relationships.md`, `eris-rules.md`
- Irene: `packages/irene/prompts/irene-personality.md`

Reloads on bot restart. No code change. No tests required (but adding a regression test for tone is wise if you're tightening behavior).

Use `{{OWNER_ID}}` for the owner placeholder; `loader.ts` interpolates at boot.

---

## 9. Add a directive (per-server "don't do X here" rule)

These are admin-set behavioral overrides. Example: "in #serious-talk, never use emoji."

**Add programmatically** via the `add_directive` AI tool (the bot exposes it as a tool to admins) or via `database.js`:

```js
import { addDirective } from "../database.js";

addDirective(guildId, "in #serious-talk, no emoji", channelId, addedBy);
```

It surfaces in the system prompt under `[DIRECTIVES]`. The model is told to obey them. Owner can override.

**Remove**:

```js
import { removeDirective } from "../database.js";
removeDirective(guildId, indexOrKeyword);
```

---

## 10. HMAC-call the other bot

**Caller** (signing):

```js
import { signTwinRequest } from "@defnotean/shared/twinSign";
import { config } from "../config.js";

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

**Receiver** (verifying — see `presence.js` for the full pattern):

```js
import { verifyTwinRequest } from "@defnotean/shared/twinSign";

const result = verifyTwinRequest(req.headers, rawBody, config.twinApiSecret);
if (!result.ok) {
  res.writeHead(403, { "content-type": "application/json" });
  return res.end(JSON.stringify({ error: result.reason }));
}
// ... re-check requester is trusted, then dispatch
```

Sign and verify the **exact same byte string**. Stringify the JSON once, reuse it for both signing and the body.

---

## Bonus — reload the bot during development

```bash
npm run dev:eris       # tsx --watch index.ts; reloads on every file save
npm run dev:irene
```

For prompt changes, the file watch picks them up — but the loader caches at boot, so a clean restart is safer.

---

## Bonus — run a single test

```bash
npx vitest run packages/eris/tests/ai/getMoodTool.test.ts
# or
npm test --workspace=@defnotean/eris -- getMoodTool
```

Watch mode:

```bash
npm run test:watch --workspace=@defnotean/eris
```

---

## What NOT to do (per [CONTRIBUTING.md](../CONTRIBUTING.md))

- ❌ Don't refactor adjacent code "while you're there"
- ❌ Don't rename things
- ❌ Don't reformat
- ❌ Don't add backwards-compat shims
- ❌ Don't write `// this saves the note` style comments — only WHY-comments
- ❌ Don't touch `personality.js`, `longmemory.js`, `firewall.js`, `bumpReminder*.js` without coordinating (see [drift-inventory.md](./drift-inventory.md))
- ❌ Don't skip writing a test for a new tool — it's mentioned in CONTRIBUTING for a reason
- ❌ Don't deploy without smoke-testing in your dev guild — there's no staging
