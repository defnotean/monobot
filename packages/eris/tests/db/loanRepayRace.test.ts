import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

type State = {
  balance: number;
  loan: { id: string; amount: number; interest_rate: number; due_at: string } | null;
  closeLoanCalls: number;
  balanceUpdateCalls: number;
  totalDeducted: number;
};

const state: State = {
  balance: 1000,
  loan: null,
  closeLoanCalls: 0,
  balanceUpdateCalls: 0,
  totalDeducted: 0,
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from() {
      const chain: any = {};
      const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
        "order", "limit", "insert", "upsert", "update", "delete", "from"];
      for (const m of methods) chain[m] = () => chain;
      chain.single = async () => ({ data: null, error: null });
      chain.then = (resolve: any) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

vi.mock("../../database.js", async () => {
  const real = (await vi.importActual<any>("../../database.js"));
  return {
    ...real,
    // Real lock helper — that's what we're testing.
    withUserLock: real.withUserLock,
    async getActiveLoan(_userId: string) {
      // Force a yield so two parallel calls definitely interleave their
      // read-check-deduct windows when the lock is missing.
      await delay(2);
      return state.loan ? { ...state.loan } : null;
    },
    async getBalance(_userId: string) {
      await delay(2);
      return { balance: state.balance };
    },
    async updateBalance(_userId: string, delta: number, _type: string, _details: string) {
      state.balanceUpdateCalls++;
      state.totalDeducted += -delta;
      state.balance += delta;
      return state.balance;
    },
    async updateBalanceUnsafe(_userId: string, delta: number, _type: string, _details: string) {
      state.balanceUpdateCalls++;
      state.totalDeducted += -delta;
      state.balance += delta;
      return state.balance;
    },
    async closeLoan(_loanId: string, _status: string) {
      state.closeLoanCalls++;
      // Once closed, the loan should disappear from "active" reads. This is
      // exactly the property that the lock+re-read pattern relies on.
      state.loan = null;
    },
    async unlockAchievement() { /* no-op */ },
  };
});

// @ts-expect-error - importing JS module without types
import { executeEconomyTool } from "../../ai/economyExecutor.js";

describe("loan_repay double-pay race", () => {
  beforeEach(() => {
    state.balance = 1000;
    state.loan = {
      id: "loan-1",
      amount: 500,
      interest_rate: 0.2,
      // Not overdue.
      due_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    state.closeLoanCalls = 0;
    state.balanceUpdateCalls = 0;
    state.totalDeducted = 0;
  });

  it("two parallel loan_repay calls only deduct once", async () => {
    const message: any = { author: { id: "loan-race-user" } };

    const results = await Promise.all([
      executeEconomyTool("loan_repay", {}, message),
      executeEconomyTool("loan_repay", {}, message),
    ]);

    // The expected total is 500 + 20% interest = 600 coins.
    const paidReplies = results.filter((r: string) => /paid back/.test(r)).length;
    const noLoanReplies = results.filter((r: string) => /don't have any active loans/.test(r)).length;

    expect(paidReplies).toBe(1);
    expect(noLoanReplies).toBe(1);

    // Critical: only ONE 600-coin deduction landed.
    expect(state.balanceUpdateCalls).toBe(1);
    expect(state.totalDeducted).toBe(600);
    expect(state.closeLoanCalls).toBe(1);
    expect(state.balance).toBe(400);
  });
});
