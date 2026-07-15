import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  rpc: vi.fn(async () => ({
    data: null,
    error: { code: "PGRST202", message: "Could not find the function" },
  })),
}));

function noRowChain(): any {
  const chain: any = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = () => chain;
  chain.single = async () => ({ data: null, error: { code: "PGRST116", message: "no rows" } });
  return chain;
}

vi.mock("../../database.js", () => ({
  getSupabase: () => ({
    rpc: (...args: any[]) => mocks.rpc(...args),
    from: () => noRowChain(),
  }),
  tryDeductBalance: (...args: any[]) => mocks.tryDeductBalance(...args),
  updateBalance: (...args: any[]) => mocks.updateBalance(...args),
}));

import { buyLotteryTicket } from "../../ai/lottery.js";
import { buyShares } from "../../ai/stockMarket.js";

describe("money-changing features require atomic database migrations", () => {
  it("refuses lottery purchases when the atomic lottery RPC is missing", async () => {
    const result = await buyLotteryTicket("111111111111111111", 1);
    expect(result).toEqual({ ok: false, reason: "atomic_lottery_unavailable" });
    expect(mocks.tryDeductBalance).not.toHaveBeenCalled();
  });

  it("refuses stock purchases when the atomic stock RPC is missing", async () => {
    const result = await buyShares("111111111111111111", "ERIS", 1);
    expect(result).toEqual({ ok: false, reason: "atomic_stock_unavailable" });
    expect(mocks.tryDeductBalance).not.toHaveBeenCalled();
    expect(mocks.updateBalance).not.toHaveBeenCalled();
  });
});
