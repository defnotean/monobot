import { describe, it, expect, beforeEach, vi } from "vitest";

// entitlementDelete is a thin logger: one line for a cancelled/expired sub.

const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({ log: (...args: any[]) => log(...args) }));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/entitlementDelete.js";

beforeEach(() => log.mockClear());

describe("entitlementDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("entitlementDelete");
  });

  it("logs the cancellation/expiry with the user and SKU ids", async () => {
    await execute({ userId: "u-7", skuId: "sku-1" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("Cancelled/expired");
    expect(line).toContain("u-7");
    expect(line).toContain("sku-1");
  });
});
