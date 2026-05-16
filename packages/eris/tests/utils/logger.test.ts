import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We want to assert what the LOGGER writes — both to console and to the file
// transport. The file transport flushes async on a 500ms timer, but it always
// emits to console synchronously, which is the easiest channel to assert on.
//
// Capture console.log here; the redactor runs inline before that call, so
// anything we see in stdout is what would also land on disk.

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

describe("eris logger — last-mile redaction", () => {
  it("redacts a leaked DISCORD_TOKEN value", async () => {
    process.env.DISCORD_TOKEN = "Bot.totallyrealtokenvalue.shhhhh";
    // Re-import — module is module-scoped but the redactor reads env on every
    // call, so a fresh import isn't strictly required.
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log(`[ERROR] login failed with Bot.totallyrealtokenvalue.shhhhh`);
    const joined = captured.join("\n");
    expect(joined).not.toContain("totallyrealtokenvalue");
    expect(joined).toContain("[REDACTED]");
  });

  it("redacts a Bearer header in an arbitrary log call", async () => {
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log("[AI] upstream complained: Authorization: Bearer abcDEFreallySecretKey1234XYZ");
    const joined = captured.join("\n");
    expect(joined).not.toContain("abcDEFreallySecretKey1234XYZ");
  });

  it("redacts ?api_key= leaking in a URL", async () => {
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log("[Fetch] failed: https://upstream.test/v1/chat?api_key=realLeakedKey12345XYZabcDEF&model=foo");
    const joined = captured.join("\n");
    expect(joined).not.toContain("realLeakedKey12345XYZabcDEF");
  });

  it("truncates a huge log line", async () => {
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    const huge = "[Stack] " + "x".repeat(10_000);
    log(huge);
    const joined = captured.join("\n");
    // ANSI codes + timestamp prefix add a bit, so just assert the marker.
    expect(joined).toContain("truncated");
  });

  it("redacts a TWIN_API_SECRET value if it leaks into a message", async () => {
    process.env.TWIN_API_SECRET = "abcdef1234567890ABCDEF";
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log("[Twin] mismatch: got=abcdef1234567890ABCDEF expected=other");
    const joined = captured.join("\n");
    expect(joined).not.toContain("abcdef1234567890ABCDEF");
  });

  it("exports redact for explicit caller-side use", async () => {
    // @ts-expect-error - importing JS module without types
    const mod = await import("../../utils/logger.js");
    expect(typeof mod.redact).toBe("function");
    const redacted = mod.redact({ apiKey: "abc", note: "ok" });
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.note).toBe("ok");
  });
});
