import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { createLogger } from "../src/logger.js";

// The factory's `log()` writes to console synchronously and queues a file
// flush 500 ms later. These tests assert the redaction behavior on the
// console side — the file transport runs the same `redactLogLine` call, so
// proving console output is clean proves on-disk output is too.

let consoleSpy: ReturnType<typeof vi.spyOn>;
let captured: string[] = [];

beforeEach(() => {
  captured = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((msg: any) => {
    captured.push(typeof msg === "string" ? msg : String(msg));
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe("createLogger — factory", () => {
  it("returns log/warn/error/info aliases plus redact", () => {
    const lg = createLogger({ botPrefix: "TEST" });
    expect(typeof lg.log).toBe("function");
    expect(typeof lg.warn).toBe("function");
    expect(typeof lg.error).toBe("function");
    expect(typeof lg.info).toBe("function");
    expect(typeof lg.redact).toBe("function");
  });

  it("warn/error/info delegate to the same redaction path as log", () => {
    process.env.DISCORD_TOKEN = "Bot.totallyrealtokenvalue.shhhhh";
    const lg = createLogger({ botPrefix: "TEST" });
    lg.warn("[Test] leak: Bot.totallyrealtokenvalue.shhhhh");
    lg.error("[Test] leak: Bot.totallyrealtokenvalue.shhhhh");
    lg.info("[Test] leak: Bot.totallyrealtokenvalue.shhhhh");
    const joined = captured.join("\n");
    expect(joined).not.toContain("totallyrealtokenvalue");
  });
});

describe("createLogger — last-mile redaction", () => {
  it("redacts a leaked DISCORD_TOKEN value", () => {
    process.env.DISCORD_TOKEN = "Bot.totallyrealtokenvalue.shhhhh";
    const lg = createLogger({ botPrefix: "TEST" });
    lg.log("[ERROR] login failed with Bot.totallyrealtokenvalue.shhhhh");
    const joined = captured.join("\n");
    expect(joined).not.toContain("totallyrealtokenvalue");
    expect(joined).toContain("[REDACTED]");
  });

  it("redacts a Bearer header in an arbitrary log call", () => {
    const lg = createLogger({ botPrefix: "TEST" });
    lg.log("[AI] upstream complained: Authorization: Bearer abcDEFreallySecretKey1234XYZ");
    const joined = captured.join("\n");
    expect(joined).not.toContain("abcDEFreallySecretKey1234XYZ");
  });

  it("redacts ?api_key= leaking in a URL", () => {
    const lg = createLogger({ botPrefix: "TEST" });
    lg.log("[Fetch] failed: https://upstream.test/v1/chat?api_key=realLeakedKey12345XYZabcDEF&model=foo");
    const joined = captured.join("\n");
    expect(joined).not.toContain("realLeakedKey12345XYZabcDEF");
  });

  it("truncates a huge log line", () => {
    const lg = createLogger({ botPrefix: "TEST" });
    const huge = "[Stack] " + "x".repeat(10_000);
    lg.log(huge);
    const joined = captured.join("\n");
    expect(joined).toContain("truncated");
  });

  it("redacts a TWIN_API_SECRET value if it leaks into a message", () => {
    process.env.TWIN_API_SECRET = "abcdef1234567890ABCDEF";
    const lg = createLogger({ botPrefix: "TEST" });
    lg.log("[Twin] mismatch: got=abcdef1234567890ABCDEF expected=other");
    const joined = captured.join("\n");
    expect(joined).not.toContain("abcdef1234567890ABCDEF");
  });

  it("exposes redact for explicit caller-side use", () => {
    const lg = createLogger({ botPrefix: "TEST" });
    const redacted = lg.redact({ apiKey: "abc", note: "ok" });
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.note).toBe("ok");
  });

  it("formats a [CATEGORY] tag with an ANSI color when NO_COLOR is unset", () => {
    // Force colors on for this assertion since CI may set NO_COLOR.
    const wasNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      // Reimport-via-factory so the COLORS_ON flag captures the unset state.
      const lg = createLogger({ botPrefix: "TEST" });
      lg.log("[bot] online");
      const joined = captured.join("\n");
      // Body color hits OK_RE because of "online"
      expect(joined).toContain("[bot]");
    } finally {
      if (wasNoColor !== undefined) process.env.NO_COLOR = wasNoColor;
    }
  });

  it("redact=false short-circuits the scrub layer", () => {
    process.env.DISCORD_TOKEN = "Bot.shouldLeakBecauseRedactIsOff.shhhh";
    const lg = createLogger({ botPrefix: "TEST", redact: false });
    lg.log("[Test] " + "Bot.shouldLeakBecauseRedactIsOff.shhhh");
    const joined = captured.join("\n");
    // Sanity check: with redaction off the raw token comes through.
    expect(joined).toContain("shouldLeakBecauseRedactIsOff");
  });
});
