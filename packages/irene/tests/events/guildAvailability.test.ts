import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.fn();

vi.mock("../../utils/logger.js", () => ({ log }));

const { execute: markUnavailable } = await import("../../events/guildUnavailable.js");
const { execute: markAvailable } = await import("../../events/guildAvailable.js");

describe("guild availability outage logging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses transient unavailable events that recover quickly", async () => {
    const guild = { id: "guild-fast", name: "Fast Guild" };

    await markUnavailable(guild);
    vi.advanceTimersByTime(30_000);
    await markAvailable(guild);

    expect(log).not.toHaveBeenCalled();
  });

  it("logs long outages once and logs recovery duration", async () => {
    const guild = { id: "guild-long", name: "Long Guild" };

    await markUnavailable(guild);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await markAvailable(guild);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("has been unavailable for 5m"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("back online after 300s"));
  });
});
