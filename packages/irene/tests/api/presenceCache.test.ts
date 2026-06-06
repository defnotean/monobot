import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  default: {
    port: 3001,
    ownerId: "111111111111111111",
    twinApiSecret: "test-twin-secret",
    botName: "irene-test",
  },
}));

vi.mock("../../utils/logger.js", () => ({ log }));

function makePresence(overrides: any = {}) {
  return {
    status: "online",
    activities: [],
    clientStatus: { desktop: true },
    ...overrides,
  };
}

describe("Irene presence cache", () => {
  beforeEach(() => {
    vi.resetModules();
    log.mockClear();
  });

  it("does not log or rewrite the cache for duplicate presence snapshots", async () => {
    // @ts-expect-error - importing JS module without types
    const { updatePresence, getCachedPresence } = await import("../../presence.js");

    expect(updatePresence(makePresence())).toBe(true);
    const firstUpdatedAt = getCachedPresence().last_updated;

    expect(updatePresence(makePresence())).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(getCachedPresence().last_updated).toBe(firstUpdatedAt);
  });

  it("logs again when the meaningful presence snapshot changes", async () => {
    // @ts-expect-error - importing JS module without types
    const { updatePresence } = await import("../../presence.js");

    updatePresence(makePresence());
    updatePresence(makePresence({ status: "idle" }));

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith("[Presence] idle | 0 activities");
  });
});
