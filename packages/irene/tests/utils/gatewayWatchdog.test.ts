import { describe, it, expect, vi } from "vitest";

// @ts-expect-error - importing JS module without types
import { createGatewayWatchdog, isGatewayHandshakeTimeout } from "../../utils/gatewayWatchdog.js";

describe("gatewayWatchdog", () => {
  it("recognizes Discord gateway opening-handshake timeouts only", () => {
    expect(isGatewayHandshakeTimeout(new Error("Opening handshake has timed out"))).toBe(true);
    expect(isGatewayHandshakeTimeout("Error: Opening handshake has timed out")).toBe(true);
    expect(isGatewayHandshakeTimeout(new Error("ECONNRESET"))).toBe(false);
  });

  it("exits once after sustained handshake timeouts", () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const exit = vi.fn();
      const sendAlert = vi.fn();
      const watchdog = createGatewayWatchdog({
        errorLimit: 3,
        exitDelayMs: 25,
        log,
        exit,
        sendAlert,
      });

      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      expect(exit).not.toHaveBeenCalled();

      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      expect(sendAlert).toHaveBeenCalledWith(
        "gateway-handshake-timeout",
        expect.stringContaining("3 consecutive"),
        expect.objectContaining({ bot: "IRENE", log }),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining("exiting for supervisor restart"));

      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      vi.advanceTimersByTime(25);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the consecutive timeout counter after recovery", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const watchdog = createGatewayWatchdog({ errorLimit: 2, exitDelayMs: 1, exit });

      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      expect(watchdog.getConsecutiveHandshakeErrors()).toBe(1);

      watchdog.reset();
      expect(watchdog.getConsecutiveHandshakeErrors()).toBe(0);

      watchdog.recordShardError(new Error("Opening handshake has timed out"), 0);
      vi.advanceTimersByTime(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores non-handshake shard errors", () => {
    const watchdog = createGatewayWatchdog({ errorLimit: 1, exit: vi.fn() });

    expect(watchdog.recordShardError(new Error("WebSocket closed with code 1006"), 0)).toBe(false);
    expect(watchdog.getConsecutiveHandshakeErrors()).toBe(0);
  });
});
