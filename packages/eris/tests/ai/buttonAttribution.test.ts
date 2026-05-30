import { describe, it, expect, beforeEach, vi } from "vitest";

// The boss_attack / heist_join button handlers in interactionCreate.js used to
// pass `interaction.message` (whose author is the BOT) to executeTool, so every
// clicker was mis-credited and the bot was debited. The fix synthesizes a
// message context attributed to the clicker:
//   { ...interaction.message, author: interaction.user, member, guild, channel }
// We mock the db and drive the gameExecutor directly with two distinct clicker
// contexts to prove (a) two clickers get distinct debits and (b) the bot is
// never touched.
const BOT_ID = "bot-self";
const balances: Map<string, number> = new Map();
const debited: Array<{ user: string; delta: number }> = [];

vi.mock("../../database.js", () => ({
  getActiveBoss: vi.fn(async () => ({
    id: "boss-1", boss_name: "Goblin", boss_hp: 1000, max_hp: 1000, phase: 1, participants: {},
  })),
  getBalance: vi.fn(async (uid: string) => ({ balance: balances.get(uid) ?? 0 })),
  tryDeductBalance: vi.fn(async (uid: string, amount: number) => {
    const balance = balances.get(uid) ?? 0;
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    debited.push({ user: uid, delta: -amount });
    balances.set(uid, balance - amount);
    return { ok: true, newBalance: balance - amount };
  }),
  updateBalance: vi.fn(async (uid: string, delta: number) => {
    debited.push({ user: uid, delta });
    balances.set(uid, (balances.get(uid) ?? 0) + delta);
    return balances.get(uid)!;
  }),
  // Boss survives the hit (not defeated) so the only money move is the -10 cost.
  damageBoss: vi.fn(async () => ({ boss_hp: 950, max_hp: 1000, phase: 1, defeated: false })),
}));

vi.mock("../../ai/stocks.js", () => ({ calculateDamage: () => 50 }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../ai/executors/gameExecutor.js";

// Mirror exactly how interactionCreate.js synthesizes the clicker context from
// a button interaction whose `message` is the bot's embed.
function synthesizeClickerCtx(clickerId: string) {
  const botMessage = {
    author: { id: BOT_ID },            // the embed was posted by the bot
    guild: { id: "guild-1" },
    channel: { id: "chan-1", send: async () => {} },
  };
  const interaction = {
    message: botMessage,
    user: { id: clickerId },
    member: { id: clickerId },
    guild: { id: "guild-1" },
    channel: { id: "chan-1", send: async () => {} },
  };
  // The fixed handler's synthesis:
  return { ...interaction.message, author: interaction.user, member: interaction.member, guild: interaction.guild, channel: interaction.channel };
}

describe("button attribution — clicker is credited, bot is untouched", () => {
  beforeEach(() => {
    balances.clear();
    debited.length = 0;
    balances.set("clickerA", 100);
    balances.set("clickerB", 100);
    balances.set(BOT_ID, 100);
    vi.clearAllMocks();
  });

  it("the synthesized context attributes to the clicker, not the bot", () => {
    const ctx = synthesizeClickerCtx("clickerA");
    expect(ctx.author.id).toBe("clickerA");
    expect(ctx.author.id).not.toBe(BOT_ID);
    expect(ctx.channel.id).toBe("chan-1"); // channel survives (set explicitly)
  });

  it("two different clickers get distinct debits and the bot's balance is never touched", async () => {
    await execute("boss_attack", {}, synthesizeClickerCtx("clickerA"));
    await execute("boss_attack", {}, synthesizeClickerCtx("clickerB"));

    // Each clicker paid the 10-coin attack cost from their OWN balance.
    expect(balances.get("clickerA")).toBe(90);
    expect(balances.get("clickerB")).toBe(90);
    // The bot was never debited.
    expect(balances.get(BOT_ID)).toBe(100);
    expect(debited.some((d) => d.user === BOT_ID)).toBe(false);
    // Exactly the two clickers were debited, distinctly.
    expect(debited).toEqual([
      { user: "clickerA", delta: -10 },
      { user: "clickerB", delta: -10 },
    ]);
  });
});
