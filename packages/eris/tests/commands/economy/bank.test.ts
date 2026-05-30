// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const getBankBalance = vi.fn();
const getBankCapacity = vi.fn();
const applyBankInterest = vi.fn();
const bankDeposit = vi.fn();
const bankWithdraw = vi.fn();
vi.mock("../../../database.js", () => ({
  getBankBalance: (...a: any[]) => getBankBalance(...a),
  getBankCapacity: (...a: any[]) => getBankCapacity(...a),
  applyBankInterest: (...a: any[]) => applyBankInterest(...a),
  bankDeposit: (...a: any[]) => bankDeposit(...a),
  bankWithdraw: (...a: any[]) => bankWithdraw(...a),
}));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/bank.js"));
});

function bankInteraction(sub: string, values: Record<string, any> = {}) {
  return makeInteraction({ user: makeUser({ id: "u1" }), options: values, subcommand: sub });
}

describe("economy/bank", () => {
  it("declares info/deposit/withdraw subcommands with a min-value amount", () => {
    const json = data.toJSON();
    const names = json.options.map((o: any) => o.name).sort();
    expect(names).toEqual(["deposit", "info", "withdraw"]);
    const deposit = json.options.find((o: any) => o.name === "deposit");
    const amount = deposit.options.find((o: any) => o.name === "amount");
    expect(amount.required).toBe(true);
    expect(amount.min_value).toBe(1);
  });

  describe("info", () => {
    it("shows balance/capacity and notes interest when earned", async () => {
      getBankBalance.mockResolvedValue({ balance: 5000 });
      getBankCapacity.mockResolvedValue(10000);
      applyBankInterest.mockResolvedValue(12);
      const interaction = bankInteraction("info");
      await execute(interaction);
      expect(getBankBalance).toHaveBeenCalledWith("u1");
      const msg = getLastReplyContent(interaction);
      expect(msg).toContain("5,000");
      expect(msg).toContain("10,000");
      expect(msg).toContain("12");
      expect(msg).toContain("interest");
    });

    it("omits the interest line when interest is 0", async () => {
      getBankBalance.mockResolvedValue({ balance: 1 });
      getBankCapacity.mockResolvedValue(100);
      applyBankInterest.mockResolvedValue(0);
      const interaction = bankInteraction("info");
      await execute(interaction);
      expect(getLastReplyContent(interaction)).not.toContain("interest");
    });
  });

  describe("deposit", () => {
    it("confirms a successful deposit", async () => {
      bankDeposit.mockResolvedValue({ ok: true });
      const interaction = bankInteraction("deposit", { amount: 2500 });
      await execute(interaction);
      expect(bankDeposit).toHaveBeenCalledWith("u1", 2500);
      expect(getLastReplyContent(interaction)).toContain("deposited");
      expect(getLastReplyContent(interaction)).toContain("2,500");
    });

    it("reports insufficient wallet ephemerally", async () => {
      bankDeposit.mockResolvedValue({ ok: false, reason: "insufficient_wallet", balance: 7 });
      const interaction = bankInteraction("deposit", { amount: 100 });
      await execute(interaction);
      const last = getLastReply(interaction);
      expect(last?.content).toContain("only have 7");
      expect(last?.payload.flags).toBeDefined(); // ephemeral
    });

    it("reports bank_full with capacity + max deposit", async () => {
      bankDeposit.mockResolvedValue({ ok: false, reason: "bank_full", capacity: 9999, maxDeposit: 3 });
      const interaction = bankInteraction("deposit", { amount: 100 });
      await execute(interaction);
      const msg = getLastReplyContent(interaction);
      expect(msg).toContain("9999");
      expect(msg).toContain("deposit 3 more");
    });

    it("reports a generic failure for unknown reasons", async () => {
      bankDeposit.mockResolvedValue({ ok: false, reason: "weird" });
      const interaction = bankInteraction("deposit", { amount: 100 });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toContain("deposit failed: weird");
    });
  });

  describe("withdraw", () => {
    it("confirms a successful withdraw", async () => {
      bankWithdraw.mockResolvedValue({ ok: true });
      const interaction = bankInteraction("withdraw", { amount: 800 });
      await execute(interaction);
      expect(bankWithdraw).toHaveBeenCalledWith("u1", 800);
      expect(getLastReplyContent(interaction)).toContain("withdrew");
      expect(getLastReplyContent(interaction)).toContain("800");
    });

    it("reports insufficient bank balance ephemerally", async () => {
      bankWithdraw.mockResolvedValue({ ok: false, reason: "insufficient_bank", balance: 4 });
      const interaction = bankInteraction("withdraw", { amount: 50 });
      await execute(interaction);
      const last = getLastReply(interaction);
      expect(last?.content).toContain("only have 4 in the bank");
      expect(last?.payload.flags).toBeDefined();
    });

    it("reports a generic withdraw failure for unknown reasons", async () => {
      bankWithdraw.mockResolvedValue({ ok: false, reason: "locked" });
      const interaction = bankInteraction("withdraw", { amount: 50 });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toContain("withdraw failed: locked");
    });
  });
});
