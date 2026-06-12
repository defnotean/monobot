import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Verifies the security-hardened owner-identity resolution (no hardcoded
// fallback owner ID — unset/invalid DISCORD_USER_ID fails closed with a loud
// [SECURITY] warning), the fastModel→model chain fix (audit F2), the Phase-1
// OpenAI-compat knobs (maxIterations, extraBody, toolCoaching), and the
// turnDeadline timeout.
//
// config.js parses packages/irene/.env into an `envVars` cache at module-eval
// and falls back to it when process.env is empty. We mock fs.existsSync so
// config.js treats .env as absent — the only values that reach env() come
// from process.env, which the tests control directly.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    existsSync: (p: string) =>
      typeof p === "string" && (p.endsWith("/.env") || p.endsWith("\\.env"))
        ? false
        : actual.existsSync(p),
  };
});

const SCRUB_KEYS = [
  "DISCORD_USER_ID",
  "DISCORD_OWNER_NAME",
  "AI_PROVIDER",
  "OPENAI_COMPAT_MAX_ITERATIONS",
  "OPENAI_COMPAT_EXTRA_BODY",
  "OPENAI_COMPAT_TOOL_COACHING",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_FAST_MODEL",
  "TIMEOUT_TURN_DEADLINE",
];

async function loadConfig() {
  return (await import("../../config.js")).default;
}

describe("config — owner identity fails closed (no hardcoded fallback)", () => {
  const originalEnv = { ...process.env };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    // Empty-string assignment (not `delete`) defeats the .env fallback:
    // env() uses ||, so empty-but-defined never falls through to envVars.
    for (const key of SCRUB_KEYS) process.env[key] = "";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  function warnings() {
    return warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  it("ownerId is empty and a [SECURITY] warning fires when DISCORD_USER_ID is unset", async () => {
    const config = await loadConfig();
    expect(config.ownerId).toBe("");
    expect(warnings()).toMatch(/\[SECURITY\] DISCORD_USER_ID is not set/);
    expect(warnings()).toMatch(/owner-only tools are disabled/);
  });

  it("ownerId is empty and warns when DISCORD_USER_ID is not a 17-20 digit snowflake", async () => {
    process.env.DISCORD_USER_ID = "not-a-snowflake";
    const config = await loadConfig();
    expect(config.ownerId).toBe("");
    expect(warnings()).toMatch(/\[SECURITY\]/);
    expect(warnings()).toMatch(/owner-only tools are disabled/);
  });

  it("a valid snowflake passes through without a [SECURITY] warning", async () => {
    process.env.DISCORD_USER_ID = "123456789012345678";
    const config = await loadConfig();
    expect(config.ownerId).toBe("123456789012345678");
    expect(warnings()).not.toMatch(/\[SECURITY\]/);
  });

  it("ownerName defaults to a neutral string, never the old hardcoded identity", async () => {
    const config = await loadConfig();
    expect(config.ownerName).toBe("the owner");
    // Regression: the removed hardcoded fallback must not leak anywhere.
    expect(config.botPersonality).not.toContain("1365814245739987078");
  });
});

describe("config — fastModel chains through OPENAI_COMPAT_MODEL (audit F2)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const key of SCRUB_KEYS) process.env[key] = "";
    process.env.DISCORD_USER_ID = "123456789012345678";
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it("setting only OPENAI_COMPAT_MODEL also redirects the fast lane", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OPENAI_COMPAT_MODEL = "qwen3:14b";
    const config = await loadConfig();
    expect(config.openaiCompat.model).toBe("qwen3:14b");
    expect(config.openaiCompat.fastModel).toBe("qwen3:14b");
  });

  it("an explicit OPENAI_COMPAT_FAST_MODEL still wins", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OPENAI_COMPAT_MODEL = "qwen3:14b";
    process.env.OPENAI_COMPAT_FAST_MODEL = "llama3.2:3b";
    const config = await loadConfig();
    expect(config.openaiCompat.fastModel).toBe("llama3.2:3b");
  });

  it("falls back to the provider default when neither model env is set", async () => {
    process.env.AI_PROVIDER = "ollama";
    const config = await loadConfig();
    expect(config.openaiCompat.fastModel).toBe("llama3.1");
  });
});

describe("config — Phase-1 OpenAI-compat knobs + turn deadline", () => {
  const originalEnv = { ...process.env };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    for (const key of SCRUB_KEYS) process.env[key] = "";
    process.env.DISCORD_USER_ID = "123456789012345678";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it("hosted defaults: maxIterations 12, extraBody null, toolCoaching false, compactSchemas false, turnDeadline 180000", async () => {
    const config = await loadConfig();
    expect(config.openaiCompat.maxIterations).toBe(12);
    expect(config.openaiCompat.extraBody).toBeNull();
    expect(config.openaiCompat.toolCoaching).toBe(false);
    expect(config.openaiCompat.compactSchemas).toBe(false);
    expect(config.timeouts.turnDeadline).toBe(180000);
  });

  it("local provider defaults: maxIterations 6, toolCoaching true, compactSchemas true", async () => {
    process.env.AI_PROVIDER = "lmstudio";
    const config = await loadConfig();
    expect(config.openaiCompat.maxIterations).toBe(6);
    expect(config.openaiCompat.toolCoaching).toBe(true);
    expect(config.openaiCompat.compactSchemas).toBe(true);
  });

  it("env overrides win over the local/hosted defaults", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OPENAI_COMPAT_MAX_ITERATIONS = "3";
    process.env.OPENAI_COMPAT_TOOL_COACHING = "false";
    process.env.OPENAI_COMPAT_COMPACT_SCHEMAS = "false";
    process.env.TIMEOUT_TURN_DEADLINE = "60000";
    const config = await loadConfig();
    expect(config.openaiCompat.maxIterations).toBe(3);
    expect(config.openaiCompat.toolCoaching).toBe(false);
    expect(config.openaiCompat.compactSchemas).toBe(false);
    expect(config.timeouts.turnDeadline).toBe(60000);
  });

  it("toolCoaching accepts 1 on hosted providers", async () => {
    process.env.OPENAI_COMPAT_TOOL_COACHING = "1";
    const config = await loadConfig();
    expect(config.openaiCompat.toolCoaching).toBe(true);
  });

  it("extraBody parses a valid JSON object", async () => {
    process.env.OPENAI_COMPAT_EXTRA_BODY = '{"options":{"num_ctx":32768,"think":false}}';
    const config = await loadConfig();
    expect(config.openaiCompat.extraBody).toEqual({ options: { num_ctx: 32768, think: false } });
  });

  it("extraBody falls back to null with a warning on invalid JSON", async () => {
    process.env.OPENAI_COMPAT_EXTRA_BODY = "{not json";
    const config = await loadConfig();
    expect(config.openaiCompat.extraBody).toBeNull();
    const logged = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toMatch(/OPENAI_COMPAT_EXTRA_BODY/);
  });

  it("extraBody rejects non-object JSON (arrays/scalars) as null", async () => {
    process.env.OPENAI_COMPAT_EXTRA_BODY = "[1,2,3]";
    const config = await loadConfig();
    expect(config.openaiCompat.extraBody).toBeNull();
  });

  it("maxIterations falls back to the default on a non-numeric typo (no NaN brick)", async () => {
    process.env.OPENAI_COMPAT_MAX_ITERATIONS = "abc";
    const config = await loadConfig();
    expect(config.openaiCompat.maxIterations).toBe(12); // hosted default, not NaN
  });

  it("maxIterations clamps a zero/negative value up to the floor of 1", async () => {
    process.env.OPENAI_COMPAT_MAX_ITERATIONS = "0";
    const config = await loadConfig();
    expect(config.openaiCompat.maxIterations).toBe(1); // never silently runs the loop zero times
  });

  it("turnDeadline falls back to the default on a non-numeric typo", async () => {
    process.env.TIMEOUT_TURN_DEADLINE = "soon";
    const config = await loadConfig();
    expect(config.timeouts.turnDeadline).toBe(180000);
  });
});
