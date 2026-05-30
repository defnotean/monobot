import { describe, it, expect, beforeEach, vi } from "vitest";

// entitlementUpdate is a thin logger that reports the NEW entitlement's ids
// (it takes old + new and logs from the new one).

const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({ log: (...args: any[]) => log(...args) }));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/entitlementUpdate.js";

beforeEach(() => log.mockClear());

describe("entitlementUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("entitlementUpdate");
  });

  it("logs the update using the NEW entitlement's user and SKU ids", async () => {
    const oldEnt = { userId: "old-u", skuId: "old-sku" };
    const newEnt = { userId: "new-u", skuId: "new-sku" };
    await execute(oldEnt, newEnt);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("Updated");
    expect(line).toContain("new-u");
    expect(line).toContain("new-sku");
    // It must read from the NEW entitlement, not the old one.
    expect(line).not.toContain("old-u");
  });
});
