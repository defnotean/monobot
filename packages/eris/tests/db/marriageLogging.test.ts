import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  log: vi.fn(),
  single: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  log: state.log,
}));

vi.mock("../../database/core.js", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      expect(table).toBe("eris_marriages");
      return {
        insert: () => ({
          select: () => ({
            single: state.single,
          }),
        }),
      };
    },
  }),
  isPersistenceHealthy: () => true,
  _assertPersistenceHealthy: () => {},
}));

vi.mock("../../database/cooldowns.js", () => ({
  _cooldowns: new Map(),
  _careerTiers: new Map(),
}));

vi.mock("../../database/inventory.js", () => ({
  getInventory: vi.fn(async () => []),
}));

// @ts-expect-error JS module without types
import { createMarriage } from "../../database/economy.js";

describe("marriage persistence logging", () => {
  beforeEach(() => {
    state.log.mockClear();
    state.single.mockReset();
  });

  it("logs before returning null when createMarriage insert fails", async () => {
    state.single.mockRejectedValueOnce(new Error("insert exploded"));

    const result = await createMarriage("u1", "u2");

    expect(result).toBeNull();
    expect(state.log).toHaveBeenCalledWith("[DB] createMarriage failed: insert exploded");
  });
});
