import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — JS module without .d.ts; types not needed here.
import { redactString, redactValue, redactLogLine, truncateLine, MAX_LOG_LINE_BYTES } from "../src/logRedact.js";

// Helpers — capture original env so each test can poke at it without leaking.
const ENV_BACKUP: Record<string, string | undefined> = {};
function withEnv(vars: Record<string, string>, fn: () => void) {
  for (const k of Object.keys(vars)) {
    ENV_BACKUP[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try { fn(); }
  finally {
    for (const k of Object.keys(vars)) {
      if (ENV_BACKUP[k] === undefined) delete process.env[k];
      else process.env[k] = ENV_BACKUP[k];
    }
  }
}

describe("redactString — env-var values", () => {
  it("redacts a known DISCORD_TOKEN literal", () => {
    withEnv({ DISCORD_TOKEN: "Bot.totallyrealtokenvalue.shhhhh" }, () => {
      const out = redactString("client.login(Bot.totallyrealtokenvalue.shhhhh) ok");
      expect(out).not.toContain("totallyrealtokenvalue");
      expect(out).toContain("[REDACTED]");
    });
  });

  it("redacts a GEMINI_API_KEY value", () => {
    withEnv({ GEMINI_API_KEY: "AIzaSyTOTALLYREAL12345Gemini" }, () => {
      const out = redactString("calling gemini with key=AIzaSyTOTALLYREAL12345Gemini today");
      expect(out).not.toContain("AIzaSyTOTALLYREAL12345Gemini");
      expect(out).toContain("[REDACTED]");
    });
  });

  it("redacts TWIN_API_SECRET", () => {
    withEnv({ TWIN_API_SECRET: "abcdef1234567890ABCDEF" }, () => {
      const out = redactString("signature payload: abcdef1234567890ABCDEF here");
      expect(out).not.toContain("abcdef1234567890ABCDEF");
    });
  });

  it("redacts SUPABASE_KEY", () => {
    withEnv({ SUPABASE_KEY: "supabasekey1234567890XYZ" }, () => {
      const out = redactString("supabase init: supabasekey1234567890XYZ at boot");
      expect(out).not.toContain("supabasekey1234567890XYZ");
    });
  });

  it("redacts VOYAGE_API_KEY", () => {
    withEnv({ VOYAGE_API_KEY: "pa-voyage-real-key-XYZ123" }, () => {
      const out = redactString("voyage: pa-voyage-real-key-XYZ123 ok");
      expect(out).not.toContain("pa-voyage-real-key-XYZ123");
    });
  });

  it("redacts NVIDIA_API_KEY", () => {
    withEnv({ NVIDIA_API_KEY: "nvapi-totallyrealNvKey1234XYZ" }, () => {
      const out = redactString("nvidia call: nvapi-totallyrealNvKey1234XYZ");
      expect(out).not.toContain("nvapi-totallyrealNvKey1234XYZ");
    });
  });

  it("redacts OPENROUTER_API_KEY", () => {
    withEnv({ OPENROUTER_API_KEY: "sk-or-totallyrealOpenRouter12345" }, () => {
      const out = redactString("auth: sk-or-totallyrealOpenRouter12345");
      expect(out).not.toContain("totallyrealOpenRouter");
    });
  });

  it("ignores too-short env values (placeholder defense)", () => {
    // An env value of length < 8 should NOT be used as a haystack — replacing
    // "0" everywhere would obliterate every digit on disk.
    withEnv({ DISCORD_TOKEN: "0" }, () => {
      const out = redactString("user id 1000 logged in at 0 seconds");
      expect(out).toBe("user id 1000 logged in at 0 seconds");
    });
  });
});

describe("redactString — token-shape patterns (env-free)", () => {
  it("redacts an Authorization: Bearer header", () => {
    const out = redactString("Authorization: Bearer abcDEF123456_XYZsuperlongtokenvalue");
    expect(out).not.toContain("abcDEF123456_XYZsuperlongtokenvalue");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a Bot prefix header", () => {
    const out = redactString('headers: { "authorization": "Bot MTIzNDU2.realbottokenXYZ.aBcDeFgHiJkLmNoPqRsT" }');
    expect(out).not.toContain("MTIzNDU2.realbottokenXYZ");
  });

  it("redacts ?api_key= query string", () => {
    const out = redactString("GET https://api.example.com/v1/x?api_key=k_live_abcDEF12345XYZreallyLong456 HTTP/1.1");
    expect(out).not.toContain("k_live_abcDEF12345XYZreallyLong456");
    expect(out).toMatch(/api_key=\[REDACTED\]/);
  });

  it("redacts ?token= in URL", () => {
    const out = redactString("redirect to https://x.test/?token=abcd1234efgh5678ijkl9012mnop");
    expect(out).not.toContain("abcd1234efgh5678ijkl9012mnop");
  });

  it("redacts sk- prefixed key (OpenAI shape)", () => {
    const out = redactString("provider error: invalid key sk-proj-realOpenAIKey1234XYZ56789abc");
    expect(out).not.toContain("sk-proj-realOpenAIKey1234XYZ56789abc");
  });

  it("redacts sk-ant- (Anthropic shape)", () => {
    const out = redactString("hdr: sk-ant-realAnthropicKey1234XYZ56789abc");
    expect(out).not.toContain("sk-ant-realAnthropicKey1234XYZ56789abc");
  });

  it("redacts gsk_ (Groq shape)", () => {
    const out = redactString("key=gsk_realGroqKey1234XYZ56789abcDEFghi");
    expect(out).not.toContain("gsk_realGroqKey1234XYZ56789abcDEFghi");
  });

  it("redacts a Discord bot-token-shaped string", () => {
    // Discord tokens are <23-28 base64>.<6-7 base64>.<27+ base64>
    const fakeToken = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM.AbCdEf.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";
    const out = redactString(`login fail with ${fakeToken} bad`);
    expect(out).not.toContain(fakeToken);
  });

  it("redacts a JWT-shaped string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactString(`cookie: ${jwt} expired`);
    expect(out).not.toContain(jwt);
  });

  it("redacts a long mixed-case high-entropy run", () => {
    // 60 chars, mixed-case + digits — should match the catch-all pass.
    const out = redactString("found leftover string Abcdef1234GHIJKLmnopQRSTuvwxYZ0987abcDEF12345MNopq xyz");
    expect(out).not.toContain("Abcdef1234GHIJKLmnopQRSTuvwxYZ0987abcDEF12345MNopq");
  });

  it("leaves a plain log message untouched", () => {
    const safe = "[Bot] gateway connected to shard 0 in 1234ms";
    expect(redactString(safe)).toBe(safe);
  });

  it("leaves Discord user IDs alone (numeric snowflakes)", () => {
    // Discord IDs are 17-19 digits — too short and digit-only, should pass.
    const out = redactString("user 123456789012345678 joined channel #general");
    expect(out).toContain("123456789012345678");
  });

  it("redacts Authorization header value with single quotes", () => {
    const out = redactString("curl -H 'authorization: Bearer realtokenshouldnotappear1234XYZ'");
    expect(out).not.toContain("realtokenshouldnotappear1234XYZ");
  });

  it("redacts ?key= query for short-prefix providers", () => {
    const out = redactString("https://provider.test/v1?key=zzzzPROVIDERkey1234567890ABCD");
    expect(out).not.toContain("zzzzPROVIDERkey1234567890ABCD");
  });
});

describe("redactValue — recursive redaction", () => {
  it("redacts string values", () => {
    withEnv({ DISCORD_TOKEN: "Bot.totallyrealtokenvalue.shhhhh" }, () => {
      const out = redactValue("login Bot.totallyrealtokenvalue.shhhhh") as string;
      expect(out).not.toContain("totallyrealtokenvalue");
    });
  });

  it("recursively redacts an object", () => {
    withEnv({ GEMINI_API_KEY: "AIzaSyTOTALLYREAL12345Gemini" }, () => {
      const out = redactValue({ note: "key=AIzaSyTOTALLYREAL12345Gemini", count: 5 }) as any;
      expect(out.note).not.toContain("AIzaSyTOTALLYREAL12345Gemini");
      expect(out.count).toBe("5"); // numbers stringify
    });
  });

  it("blanks out apiKey-named field even when value looks innocuous", () => {
    const out = redactValue({ apiKey: "tiny", message: "ok" }) as any;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.message).toBe("ok");
  });

  it("blanks out token-named fields", () => {
    const out = redactValue({ access_token: "anything", refresh_token: "anything" }) as any;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
  });

  it("walks arrays", () => {
    withEnv({ DISCORD_TOKEN: "Bot.totallyrealtokenvalue.shhhhh" }, () => {
      const out = redactValue(["hi", "Bot.totallyrealtokenvalue.shhhhh", { a: "x" }]) as any[];
      expect(out[0]).toBe("hi");
      expect(out[1]).not.toContain("totallyrealtokenvalue");
    });
  });

  it("does not crash on circular objects", () => {
    const a: any = { name: "loop" };
    a.self = a;
    expect(() => redactValue(a)).not.toThrow();
    const out: any = redactValue(a);
    expect(out.name).toBe("loop");
  });

  it("redacts Error objects via their stack", () => {
    withEnv({ DISCORD_TOKEN: "Bot.totallyrealtokenvalue.shhhhh" }, () => {
      const err = new Error("login failed for Bot.totallyrealtokenvalue.shhhhh");
      const out = redactValue(err) as string;
      expect(typeof out).toBe("string");
      expect(out).not.toContain("totallyrealtokenvalue");
    });
  });

  it("caps depth on deeply nested objects", () => {
    let leaf: any = "Authorization: Bearer realtokenshouldnotappear1234XYZ";
    for (let i = 0; i < 20; i++) leaf = { nested: leaf };
    expect(() => redactValue(leaf, 4)).not.toThrow();
    const out = JSON.stringify(redactValue(leaf, 4));
    expect(out).not.toContain("realtokenshouldnotappear1234XYZ");
  });
});

describe("truncateLine + redactLogLine", () => {
  it("leaves short lines untouched", () => {
    expect(truncateLine("hello world")).toBe("hello world");
  });

  it("truncates long lines past the cap", () => {
    const huge = "x".repeat(MAX_LOG_LINE_BYTES + 1000);
    const out = truncateLine(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(out).toContain("truncated");
  });

  it("redactLogLine does both — redacts AND truncates", () => {
    withEnv({ DISCORD_TOKEN: "Bot.totallyrealtokenvalue.shhhhh" }, () => {
      const huge = "header Bot.totallyrealtokenvalue.shhhhh " + "x".repeat(MAX_LOG_LINE_BYTES + 100);
      const out = redactLogLine(huge);
      expect(out).not.toContain("totallyrealtokenvalue");
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    });
  });

  it("redactLogLine handles non-strings without crashing", () => {
    expect(redactLogLine(undefined as any)).toBeTypeOf("string");
    expect(redactLogLine(null as any)).toBeTypeOf("string");
    expect(redactLogLine(12345 as any)).toBe("12345");
  });
});

describe("upstream-error-body scenarios (audit-driven)", () => {
  it("scrubs an upstream-echoed bearer in a fetch error message", () => {
    const errText =
      'HTTP 401: {"error":{"message":"Invalid auth header","code":"unauthorized","received_header":"Authorization: Bearer sk-totallyrealUpstreamKey12345XYZ"}}';
    const out = redactString(errText);
    expect(out).not.toContain("sk-totallyrealUpstreamKey12345XYZ");
  });

  it("scrubs a URL with query auth in a stack trace", () => {
    const stack = `Error: fetch failed
    at https://upstream.test/chat?api_key=realLeakedKey12345XYZabcDEF&model=foo`;
    const out = redactString(stack);
    expect(out).not.toContain("realLeakedKey12345XYZabcDEF");
  });

  it("scrubs the dual.js fnArgs trace pattern", () => {
    withEnv({ GEMINI_API_KEY: "AIzaSyTOTALLYREAL12345Gemini" }, () => {
      const fakeArgs = JSON.stringify({ query: "what is AIzaSyTOTALLYREAL12345Gemini" });
      const out = redactString(`[Gemini] web_search(${fakeArgs})`);
      expect(out).not.toContain("AIzaSyTOTALLYREAL12345Gemini");
    });
  });
});
