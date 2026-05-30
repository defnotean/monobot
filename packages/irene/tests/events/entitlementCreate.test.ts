import { describe, it, expect, beforeEach, vi } from "vitest";

// entitlementCreate is a thin logger: it writes one line with the user + SKU id.

const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({ log: (...args: any[]) => log(...args) }));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/entitlementCreate.js";

beforeEach(() => log.mockClear());

describe("entitlementCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("entitlementCreate");
  });

  it("logs the new subscription with the user and SKU ids", async () => {
    await execute({ userId: "u-42", skuId: "sku-9" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("New subscription");
    expect(line).toContain("u-42");
    expect(line).toContain("sku-9");
  });
});
