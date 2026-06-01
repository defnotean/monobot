# Testing guide

The workspaces use **Vitest**. Tests don't connect to Discord or Supabase — pure unit tests with mocks. Safe to run anywhere.

## TL;DR

```bash
npm run test:eris                            # Eris workspace
npm run test:irene                           # Irene workspace
npm test --workspaces --if-present           # all workspaces

npm run test:watch --workspace=@defnotean/eris   # watch mode
npx vitest run packages/eris/tests/ai/getMoodTool.test.ts   # single file
npx vitest run -t "send_compliment"          # by test name pattern
```

## Test layout

Each package has its own `tests/` directory mirroring the source structure:

```
packages/eris/tests/
├── ai/             — AI logic + tool tests
├── db/             — database layer
├── utils/          — helper modules
├── mocks/          — shared mock helpers (Supabase, Discord)
└── setup.ts        — global setup (env vars, etc.)

packages/irene/tests/
├── ai/
│   └── executors/  — sub-executor-specific tests
├── commands/
│   └── context/    — context-menu commands
├── database/
├── utils/
└── setup.ts
```

## Test file conventions

- Filename: `<thing>.test.ts` — TypeScript even though the source is JS, because Vitest handles `.ts` natively and types help.
- One file per logical unit (one tool, one helper, one DB method group).
- Use `describe` for the unit, `it` for behavior.
- Use `vi.fn()` for mocks; `vi.spyOn()` if you need to track calls on a real object.

## Two reference test files

Annotated with `// ─── REFERENCE TOOL ───` in the source — read these when you're starting:

- **Eris**: [packages/eris/tests/ai/getMoodTool.test.ts](../packages/eris/tests/ai/getMoodTool.test.ts)
- **Irene**: [packages/irene/tests/ai/executors/listEmojis.test.ts](../packages/irene/tests/ai/executors/listEmojis.test.ts)

Both demonstrate the standard shape: import the executor, mock the relevant DB calls + Discord context, call `executeX(toolName, input, message, ctx)`, assert on the returned string and any side effects.

## Test recipes

### Test a sub-executor (the most common case)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeMisc } from "../../ai/executors/miscExecutor.js";
import * as db from "../../database.js";

vi.mock("../../database.js");

describe("send_compliment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compliments the user and returns confirmation", async () => {
    const send = vi.fn();
    const message = { channel: { send }, author: { id: "user-1" } };
    const ctx = {
      findMember: vi.fn().mockResolvedValue({
        id: "target-1",
        user: { username: "alice" },
      }),
    };

    const result = await executeMisc(
      "send_compliment",
      { user_id: "target-1", topic: "your art" },
      message,
      ctx
    );

    expect(send).toHaveBeenCalledWith(expect.stringContaining("<@target-1>"));
    expect(result).toBe("complimented @alice");
  });

  it("returns 'unknown user' when findMember fails", async () => {
    const ctx = { findMember: vi.fn().mockResolvedValue(null) };
    const message = { channel: { send: vi.fn() } };

    const result = await executeMisc(
      "send_compliment",
      { user_id: "missing", topic: "x" },
      message,
      ctx
    );

    expect(result).toBe("couldn't find that user");
  });

  it("returns undefined for tools it doesn't handle", async () => {
    const result = await executeMisc("definitely_not_mine", {}, {}, {});
    expect(result).toBeUndefined();
  });
});
```

The third test (returning `undefined` for non-HANDLED tools) catches the most common bug class: forgetting to add the new tool name to `HANDLED`.

### Test a database method

```ts
import { describe, it, expect, beforeEach } from "vitest";
import * as db from "../database.js";

describe("favorite_emoji", () => {
  beforeEach(() => {
    // Reset the in-memory cache between tests
    db._resetCacheForTests?.();
  });

  it("returns null when not set", () => {
    expect(db.getFavoriteEmoji("user-1")).toBeNull();
  });

  it("round-trips a value", () => {
    db.setFavoriteEmoji("user-1", "🌸");
    expect(db.getFavoriteEmoji("user-1")).toBe("🌸");
  });

  it("doesn't leak between users", () => {
    db.setFavoriteEmoji("user-1", "🌸");
    db.setFavoriteEmoji("user-2", "🌑");
    expect(db.getFavoriteEmoji("user-1")).toBe("🌸");
    expect(db.getFavoriteEmoji("user-2")).toBe("🌑");
  });
});
```

If `_resetCacheForTests` doesn't exist for the bucket you're testing, either add it or use unique IDs per test (`user-${Math.random()}`).

### Test a slash command

```ts
import { describe, it, expect, vi } from "vitest";
import command from "../../commands/utility/compliment.js";

describe("/compliment", () => {
  it("replies with a compliment using the topic option", async () => {
    const reply = vi.fn();
    const interaction = {
      user: { id: "user-1" },
      options: {
        getString: vi.fn((name) => (name === "topic" ? "your art" : null)),
      },
      reply,
    };

    await command.execute(interaction);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining("your art") })],
      })
    );
  });

  it("falls back to a default topic when none is given", async () => {
    const reply = vi.fn();
    const interaction = {
      user: { id: "user-1" },
      options: { getString: vi.fn().mockReturnValue(null) },
      reply,
    };

    await command.execute(interaction);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining("just being you") })],
      })
    );
  });
});
```

### Test a regex / pure function

The easiest case. No mocks.

```ts
import { describe, it, expect } from "vitest";
import { looksLikeTask } from "../../events/messageCreate.js";   // if exported

describe("looksLikeTask", () => {
  it.each([
    ["fish", true],
    ["help me", true],
    ["yo", false],
    ["hi how's your day", false],
  ])("%s → %s", (input, expected) => {
    expect(looksLikeTask(input)).toBe(expected);
  });
});
```

If the function isn't exported, either export it from the source or duplicate it in the test (small functions only).

### Test a tool that calls Supabase

Mock the entire `database.js` module:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../database.js", () => ({
  saveNote: vi.fn().mockResolvedValue(123),
  getNotes: vi.fn().mockResolvedValue([{ id: 1, title: "old" }]),
}));

import { executeNotes } from "../../ai/executors/notesExecutor.js";
import * as db from "../../database.js";

describe("save_note", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves and returns the new ID", async () => {
    const message = { author: { id: "u1" } };
    const result = await executeNotes(
      "save_note",
      { title: "test", content: "body" },
      message,
      {}
    );

    expect(db.saveNote).toHaveBeenCalledWith("u1", "test", "body");
    expect(result).toMatch(/saved.*123/);
  });
});
```

### Test the AI loop without calling Gemini

Mock `ai/dual.js`:

```ts
vi.mock("../../ai/dual.js", () => ({
  runGeminiChat: vi.fn().mockResolvedValue({
    text: "okay sure",
    toolCalls: [],
  }),
}));
```

Then exercise the message handler against your mocked response. Useful for testing gating + post-AI rendering without burning Gemini quota.

### Test the firewall

`ai/firewall.js` exports `checkInjection(text)` which is async. The L3 layer needs Voyage embeddings — mock those if you don't want network calls:

```ts
vi.mock("../../ai/semantic.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(1024)),
  searchSimilar: vi.fn().mockResolvedValue([]),
}));
```

L1 (regex) and L2 (multi-language patterns) work without mocks.

## Common test patterns from the existing suite

### Avoid module-level state leakage

Both bots have modules with module-level state (caches, mood, in-memory buckets). When you import them in tests, that state persists across test files unless you reset it.

```ts
beforeEach(() => {
  // reset any module-level state your test touches
  db._resetCacheForTests?.();
  vi.clearAllMocks();
  vi.useRealTimers();
});
```

### Deterministic time — fake timers + frozen system clock

Any code that calls `Date.now()`, `new Date()`, or `setTimeout`/`setInterval` flakes on slow CI if you let the wall clock drive it. Freeze both:

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});
```

`setSystemTime` pins `Date.now()` / `new Date()` to a fixed instant so dedupe windows (e.g. `Date.now() - prev.at < 20h`) and timestamp comparisons land identically across calls — no wall-clock drift between two `Date.now()` reads. `advanceTimersByTime(ms)` then lets you skip forward deterministically.

Reference tests:
- [packages/eris/tests/ai/bumpCelebrations.test.ts](../packages/eris/tests/ai/bumpCelebrations.test.ts) — frozen clock so 20h dedupe windows behave the same on every run
- [packages/eris/tests/utils/lruCache.test.ts](../packages/eris/tests/utils/lruCache.test.ts) — `advanceTimersByTime` for TTL eviction (the real-timer version raced `setTimeout(r, 60)` against the cache's own `Date.now()` check on slow runners)

### Time-dependent code → fake timers

```ts
import { vi } from "vitest";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("expires after TTL", () => {
  cache.set("key", "value");
  vi.advanceTimersByTime(16_000);   // > 15s TTL
  expect(cache.get("key")).toBeUndefined();
});
```

### Deterministic RNG — seeded mulberry32 over `Math.random`

Anything driven by `Math.random()` (gambling odds, randomized cooldown jitter, sampled responses) will flake on statistical assertions. Replace `Math.random` with a seeded PRNG for the duration of the suite:

```ts
// mulberry32 — small deterministic PRNG. Same seed -> same sequence every run.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  const rng = mulberry32(0xC0FFEE);
  vi.spyOn(Math, "random").mockImplementation(() => rng());
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

This keeps statistical-band assertions (e.g. "coinflip win rate between 0.45 and 0.55 over 10,000 trials") reproducible. Change the seed if you need to test multiple sequences.

Reference test: [packages/eris/tests/ai/gambling.test.ts](../packages/eris/tests/ai/gambling.test.ts)

### Testing the shared rate-limiter

`createRateLimiter` from `@defnotean/shared` takes an explicit `now` argument on every `allow()` call — no fake timers needed, just pass the timestamp you want. This is the canonical test pattern for any utility that should accept injected time:

```ts
import { createRateLimiter } from "@defnotean/shared/rateLimit";

const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
const now = 1_000_000;
expect(rl.allow("a", now)).toBe(true);
expect(rl.allow("a", now + 1)).toBe(true);
expect(rl.allow("a", now + 2)).toBe(true);
expect(rl.allow("a", now + 3)).toBe(false);
// Sliding window recovery — fast-forward past windowMs:
expect(rl.allow("a", now + 60_001)).toBe(true);
```

Full coverage example (per-key isolation, soft-cap eviction, reset, bad-args fail-loud): [packages/shared/tests/rateLimit.test.ts](../packages/shared/tests/rateLimit.test.ts)

### Mocking Discord.js

Don't mock the whole `discord.js` package. Instead, hand the executor / command a hand-crafted fake whose shape matches only the fields the code under test reaches. Use the real `Collection` and enum imports (`ChannelType`, `PermissionFlagsBits`) so type checks pass.

Good examples to copy:
- [packages/irene/tests/ai/executorCreateVc.test.ts](../packages/irene/tests/ai/executorCreateVc.test.ts) — fakes `guild.channels.cache` with a real `Collection`, mocks `channels.create` to assert it isn't called when an existing voice channel should be reused
- [packages/eris/tests/utils/roleCategorizer.test.ts](../packages/eris/tests/utils/roleCategorizer.test.ts) — minimal role-shape fakes
- [packages/eris/tests/ai/bumpCelebrations.test.ts](../packages/eris/tests/ai/bumpCelebrations.test.ts) — `fakeClient()` helper with just enough surface for `channel.send`

Pattern: a `fake<Thing>()` factory returns the minimal object plus any `vi.fn()` spies you'll need to assert on. Skip every property the production code doesn't read.

### Mocking Supabase

There are two paths. **Easiest: in-memory fallback** — when `SUPABASE_URL` is empty the database layer routes everything to in-memory Maps. `tests/setup.ts` already clears the env var, so most tests get this for free; just read/write through `database.js` and reset between tests:

```ts
beforeEach(() => {
  db._resetCacheForTests?.();
});
```

When the bucket you're touching is Supabase-only (no in-memory fallback), mock the module:

```ts
const guildSettings = new Map();
vi.mock("../../database.js", () => ({
  getSupabase: () => null,           // force the no-Supabase path
  getGuildSettings: (id: string) => guildSettings.get(id) || {},
  setGuildSetting: (id: string, key: string, val: unknown) => {
    const cur = guildSettings.get(id) || {};
    cur[key] = val;
    guildSettings.set(id, cur);
  },
}));
```

For a richer client surface (chained `from().select().eq().single()`), use the shared helper at [packages/eris/tests/mocks/supabase.ts](../packages/eris/tests/mocks/supabase.ts) — it implements enough of the PostgREST chain to back simple CRUD without writing each chain by hand.

### Race conditions → assert via lock

When testing `withUserLock`, simulate concurrent calls with `Promise.all`:

```ts
const results = await Promise.all([
  buyItem("u1", "sword", 50),
  buyItem("u1", "shield", 60),
]);

// Both shouldn't succeed if balance is only 80
expect(results.filter(r => r.ok).length).toBe(1);
```

### Snapshot testing for embeds

Vitest supports inline snapshots. Useful for embed structures that have a lot of fields:

```ts
expect(embed).toMatchInlineSnapshot(`
  {
    "color": 9648362,
    "description": "expected text",
    "title": "expected title",
  }
`);
```

Run `npx vitest -u` to update snapshots after intentional changes.

## What NOT to test

- **Real Discord API calls.** Tests should never hit `discord.com`.
- **Real Supabase queries.** Mock the whole `database.js` module or use `_resetCacheForTests` + in-memory writes.
- **Real Gemini calls.** Mock `ai/dual.js`. Tests pay zero LLM tokens.
- **`messageCreate.js` end-to-end.** Too many integration points. Test the gates as pure functions, the executor logic as units, and trust that they're wired up correctly via the dev-guild smoke test (see [dev-guild-workflow.md](./dev-guild-workflow.md)).

## Critical paths with thin coverage

These are flagged in [CONTRIBUTING.md](../CONTRIBUTING.md) — good places to add tests when you touch them:

- Irene AI router / sub-executors (`packages/irene/ai/executor.js` is now a compact router with direct `executeTool` coverage; add focused tests for touched routes or executors)
- `ai/toolRegistry.js` (selection logic)
- `events/messageCreate.js` (the gauntlet — easy to add gate-by-gate tests)

## When tests are flaky

### Flake-busting checklist

When a test fails intermittently, walk this list before assuming it's a real bug:

1. **Is it using real `setTimeout` / `setInterval`?** Replace with `vi.useFakeTimers()` + `vi.advanceTimersByTime(ms)`. Real timers race the code's own `Date.now()` checks on slow CI.
2. **Is it depending on `Math.random()`?** Wire in the seeded `mulberry32` pattern above. Statistical bands and "is the result in this set" assertions both flake without it.
3. **Is it depending on `Date.now()` / `new Date()`?** Use `vi.setSystemTime(...)` (in addition to `vi.useFakeTimers()`) to freeze the wall clock. Two `Date.now()` calls in the same test can otherwise return different ms.
4. **Is it depending on test ordering?** Run the file in isolation (`npx vitest run path/to/file.test.ts`) and then with `--shuffle`. If it passes alone but fails in the suite, you have module-level state leaking — add a `beforeEach` reset, `vi.clearAllMocks()`, and call your `_resetCacheForTests?.()` helpers.

### Other usual suspects

- **Async ordering** — `await` everything; never rely on Promise resolution order.
- **Test depends on file system** — `vi.mock("node:fs")`.
- **Network calls** — find the leak (look for un-mocked `fetch`, embeddings, or Discord REST calls) and mock the module that owns it.

Known flakes: none currently documented here. If a test flakes, capture the exact command, retry behavior, and failing output before treating it as pre-existing.

## Setup file

`tests/setup.ts` (each package). Loaded via `vitest.config.ts`'s `setupFiles`. Set test-only env vars here, register globals, etc.

```ts
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "";   // force in-memory mode
process.env.GEMINI_API_KEY = "test-key";
```

## CI

GitHub Actions is wired at `.github/workflows/test.yml`. It runs the same gates you should run locally before pushing:

```yaml
- run: npm ci
- run: npm run lint:version-sync
- run: npm audit --audit-level=moderate
- run: npm test --workspaces --if-present
- run: npm run build --workspaces --if-present
```

`lint:version-sync` is the guard against the 2026-04-24 hoisting bug class — it catches divergent non-local dependency ranges across workspaces and intentionally skips local `@defnotean/*` workspace links.
