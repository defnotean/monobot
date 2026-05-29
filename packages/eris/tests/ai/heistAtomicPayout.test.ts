import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the database module so we control balances and observe exactly which
// users get paid. The real gameExecutor heist_execute logic (debit-victim-first,
// pay-only-what-was-taken, fail-closed) runs unmocked.
const balances: Map<string, number> = new Map();
const credited: Array<{ user: string; delta: number; type: string }> = [];
// Simulates the victim being drained between the heist's balance read and the
// atomic debit (the multi-instance / concurrent-spend race the fix guards).
let forceDebitFail = false;

vi.mock("../../database.js", () => ({
  getActiveHeist: vi.fn(),
  getBalance: vi.fn(async (uid: string) => ({ balance: balances.get(uid) ?? 0 })),
  resolveHeist: vi.fn(async () => {}),
  updateBalance: vi.fn(async (uid: string, delta: number, type: string) => {
    credited.push({ user: uid, delta, type });
    balances.set(uid, (balances.get(uid) ?? 0) + delta);
    return balances.get(uid)!;
  }),
  // Atomic debit: only succeeds if the victim actually holds >= amount,
  // mirroring the real tryDeductBalance contract.
  tryDeductBalance: vi.fn(async (uid: string, amount: number, type: string) => {
    const bal = balances.get(uid) ?? 0;
    if (forceDebitFail || bal < amount) return { ok: false, reason: "insufficient", balance: bal };
    balances.set(uid, bal - amount);
    credited.push({ user: uid, delta: -amount, type });
    return { ok: true, newBalance: bal - amount };
  }),
}));

// gambling.js randomQuip is imported dynamically inside the success branch.
vi.mock("../../ai/gambling.js", () => ({ randomQuip: async () => "" }));

// @ts-expect-error - importing JS module without types
import * as db from "../../database.js";
// @ts-expect-error - importing JS module without types
import { execute } from "../../ai/executors/gameExecutor.js";

function makeMessage(authorId: string) {
  return {
    author: { id: authorId },
    guild: { id: "guild-1" },
    channel: { id: "chan-1", send: async () => {} },
  };
}

describe("heist_execute atomic payout", () => {
  beforeEach(() => {
    balances.clear();
    credited.length = 0;
    forceDebitFail = false;
    vi.clearAllMocks();
  });

  it("when the victim is drained below the stolen amount, NO participant is paid and no coins are created", async () => {
    const parts = ["thief1", "thief2", "thief3"];
    balances.set("thief1", 0);
    balances.set("thief2", 0);
    balances.set("thief3", 0);

    // Victim shows 1000 at heist_execute's read (so the >50 gate passes and the
    // intended steal is computed)...
    balances.set("victim", 1000);
    (db.getActiveHeist as any).mockResolvedValue({
      id: "heist-1",
      target_user_id: "victim",
      participants: parts,
    });

    // ...but is drained right before the atomic debit, so tryDeductBalance
    // fails. Force Math.random low enough for "success" so we reach the debit.
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    forceDebitFail = true;

    const result = await execute("heist_execute", {}, makeMessage("thief1"));
    rnd.mockRestore();

    // Heist resolved as failed; nobody credited.
    expect(db.resolveHeist).toHaveBeenCalledWith("heist-1", "failed", 0);
    expect(db.updateBalance).not.toHaveBeenCalled();
    const totalDelta = credited.reduce((s, c) => s + c.delta, 0);
    expect(totalDelta).toBe(0); // no coins minted, none destroyed
    for (const p of parts) expect(balances.get(p)).toBe(0);
    expect(result).toMatch(/nobody got paid/i);
  });

  it("on a clean steal, the sum paid to participants equals exactly what was debited from the victim (coins conserved)", async () => {
    const parts = ["a", "b", "c"];
    for (const p of parts) balances.set(p, 0);
    balances.set("victim", 1000);

    (db.getActiveHeist as any).mockResolvedValue({
      id: "heist-2",
      target_user_id: "victim",
      participants: parts,
    });

    // random=0 → success, intended = floor(1000 * 0.2) = 200.
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    await execute("heist_execute", {}, makeMessage("a"));
    rnd.mockRestore();

    // Exactly 200 left the victim.
    const victimDebit = credited.filter((c) => c.user === "victim").reduce((s, c) => s + c.delta, 0);
    expect(victimDebit).toBe(-200);
    // Participants received floor(200/3) = 66 each → 198 total (the 2-coin
    // rounding remainder simply isn't distributed; never MORE than was taken).
    const paid = credited.filter((c) => parts.includes(c.user)).reduce((s, c) => s + c.delta, 0);
    expect(paid).toBe(198);
    expect(paid).toBeLessThanOrEqual(200); // never mints coins
  });
});
