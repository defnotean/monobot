import { describe, it, expect, vi } from "vitest";

// @ts-expect-error - importing JS module without types
import { loginDiscordWithRetry } from "../../utils/loginRetry.js";

describe("loginDiscordWithRetry", () => {
  it("retries Discord login failures with capped incremental backoff", async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const client = {
        login: vi.fn()
          .mockRejectedValueOnce(new Error("Connect Timeout Error"))
          .mockRejectedValueOnce(new Error("Gateway down"))
          .mockResolvedValueOnce("ready"),
      };

      const result = loginDiscordWithRetry(client, "token", {
        log,
        baseDelayMs: 10,
        maxDelayMs: 15,
      });

      await Promise.resolve();
      expect(client.login).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("attempt 1 failed"));

      await vi.advanceTimersByTimeAsync(10);
      expect(client.login).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 0.015s"));

      await vi.advanceTimersByTimeAsync(15);
      await expect(result).resolves.toBe("ready");
      expect(client.login).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
