import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushError: null as null | { code?: string; message: string },
  rpcError: null as null | { code?: string; message: string },
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../../database.js", () => ({
  tryDeductBalance: (...args: any[]) => mocks.tryDeductBalance(...args),
  updateBalance: (...args: any[]) => mocks.updateBalance(...args),
  getSupabase: () => ({
    from: () => ({
      upsert: async () => ({ data: null, error: mocks.flushError }),
    }),
    rpc: (...args: any[]) => mocks.rpc(...args),
  }),
}));

import { createTable, getTable, resolveTable } from "../../ai/poker.js";

describe("poker durable settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.flushError = null;
    mocks.rpcError = null;
    mocks.tryDeductBalance.mockReset().mockResolvedValue({ ok: true, newBalance: 900 });
    mocks.updateBalance.mockReset().mockResolvedValue(1000);
    mocks.rpc.mockReset().mockImplementation(async () => ({
      data: mocks.rpcError ? null : { ok: true, payoutCount: 1 },
      error: mocks.rpcError,
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refunds and removes a newly debited table when its recovery record cannot be persisted", async () => {
    mocks.flushError = { code: "08006", message: "database offline" };
    const result = await createTable({
      channelId: "poker-persist-fail",
      guildId: "111111111111111111",
      hostId: "222222222222222222",
      ante: 100,
    });

    expect(result).toEqual({ ok: false, error: "could not persist the poker table; your ante was refunded" });
    expect(mocks.updateBalance).toHaveBeenCalledWith(
      "222222222222222222",
      100,
      "poker_refund",
      "create persistence failed",
    );
    expect(getTable("poker-persist-fail")).toBeUndefined();
  });

  it("keeps a failed refund settlement pending and retries it idempotently through the RPC", async () => {
    const channelId = "poker-settlement-retry";
    expect((await createTable({
      channelId,
      guildId: "111111111111111111",
      hostId: "333333333333333333",
      ante: 100,
    })).ok).toBe(true);

    mocks.rpcError = { code: "503", message: "temporary database failure" };
    const first = await resolveTable(channelId);
    expect(first).toMatchObject({ ok: false, reason: "settlement_pending" });
    expect(getTable(channelId)?.status).toBe("settling");
    expect(mocks.updateBalance).not.toHaveBeenCalled();

    mocks.rpcError = null;
    const second = await resolveTable(channelId);
    expect(second).toEqual({ ok: false, reason: "not_enough_players", refunded: true });
    expect(getTable(channelId)).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1].p_recovery_id).toBe(mocks.rpc.mock.calls[1][1].p_recovery_id);
  });
});
