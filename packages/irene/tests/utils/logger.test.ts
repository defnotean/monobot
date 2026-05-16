import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture console.log — the redactor runs inline before that call, so what
// we see in stdout is what would also land on disk via the buffered file
// transport.

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

describe("irene logger — last-mile redaction", () => {
  it("redacts a leaked DISCORD_BOT_TOKEN value", async () => {
    process.env.DISCORD_BOT_TOKEN = "Bot.totallyrealtokenvalue.shhhhh";
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log("[ERROR] login failed with Bot.totallyrealtokenvalue.shhhhh");
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

  it("redacts a leaked GEMINI_API_KEY value in an unhandled rejection-style line", async () => {
    process.env.GEMINI_API_KEY = "AIzaSyTOTALLYREAL12345Gemini";
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    log(`[UNHANDLED REJECTION] Error: fetch failed
    at https://generativelanguage.googleapis.com/v1?key=AIzaSyTOTALLYREAL12345Gemini`);
    const joined = captured.join("\n");
    expect(joined).not.toContain("AIzaSyTOTALLYREAL12345Gemini");
  });

  it("redacts the dual.js tool-call args pattern", async () => {
    process.env.GEMINI_API_KEY = "AIzaSyTOTALLYREAL12345Gemini";
    // @ts-expect-error - importing JS module without types
    const { log, redact } = await import("../../utils/logger.js");
    // Simulate the dual.js:553 site after the fix.
    const args = { query: "what does AIzaSyTOTALLYREAL12345Gemini do", apiKey: "should-be-redacted" };
    log(`[Gemini] web_search(${JSON.stringify(redact(args))})`);
    const joined = captured.join("\n");
    expect(joined).not.toContain("AIzaSyTOTALLYREAL12345Gemini");
    expect(joined).not.toContain("should-be-redacted");
    expect(joined).toContain("[REDACTED]");
  });

  it("truncates a huge unhandled-rejection stack", async () => {
    // @ts-expect-error - importing JS module without types
    const { log } = await import("../../utils/logger.js");
    const huge = "[UNHANDLED REJECTION] " + "x".repeat(10_000);
    log(huge);
    const joined = captured.join("\n");
    expect(joined).toContain("truncated");
  });

  it("exports redact for explicit caller-side use", async () => {
    // @ts-expect-error - importing JS module without types
    const mod = await import("../../utils/logger.js");
    expect(typeof mod.redact).toBe("function");
    const redacted = mod.redact({ token: "abc", note: "ok" });
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.note).toBe("ok");
  });
});
