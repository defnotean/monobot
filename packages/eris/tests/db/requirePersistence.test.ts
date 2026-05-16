import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Verifies the REQUIRE_PERSISTENCE=1 fail-fast guard in database.js. Each
// scenario flips the env vars BEFORE re-importing config.js + database.js so
// `config.requirePersistence` and `config.supabaseEnabled` are recomputed
// against a clean state — module-level reads inside config.js happen at
// import time, not at call time.

describe("initDatabase — REQUIRE_PERSISTENCE fail-fast", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Strip Supabase + persistence env so each test starts from a known floor.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;
    delete process.env.REQUIRE_PERSISTENCE;
  });

  afterEach(() => {
    // Restore env so neighbouring suites don't see our scrub.
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it("throws when REQUIRE_PERSISTENCE=1 and Supabase credentials are missing", async () => {
    process.env.REQUIRE_PERSISTENCE = "1";
    // Supabase URL/KEY intentionally unset → config.supabaseEnabled === false.

    const { initDatabase } = await import("../../database.js");
    const config = (await import("../../config.js")).default;
    expect(config.requirePersistence).toBe(true);
    expect(config.supabaseEnabled).toBe(false);

    // Error message must call out REQUIRE_PERSISTENCE so operators see exactly
    // which guard fired, and must name SUPABASE_URL so the fix is obvious.
    await expect(initDatabase()).rejects.toThrow(/REQUIRE_PERSISTENCE=1.*SUPABASE_URL/s);
  });

  it("throws when REQUIRE_PERSISTENCE=1 and SUPABASE_URL is the placeholder", async () => {
    // supabaseEnabled also rejects URLs containing "your-" (config.js getter),
    // so a half-filled .env should also fail-fast — not silently boot.
    process.env.REQUIRE_PERSISTENCE = "1";
    process.env.SUPABASE_URL = "https://your-project-ref.supabase.co";
    process.env.SUPABASE_KEY = "your-supabase-key-here";

    const { initDatabase } = await import("../../database.js");
    const config = (await import("../../config.js")).default;
    expect(config.requirePersistence).toBe(true);
    expect(config.supabaseEnabled).toBe(false);

    await expect(initDatabase()).rejects.toThrow(/REQUIRE_PERSISTENCE=1/);
  });

  it("boots cleanly when REQUIRE_PERSISTENCE is unset and Supabase is missing", async () => {
    // Default posture for local/dev — bot still runs, just without persistence.
    // No env vars set → config.requirePersistence === false, supabaseEnabled === false.

    const { initDatabase } = await import("../../database.js");

    await expect(initDatabase()).resolves.toBeUndefined();
  });

  it("boots cleanly when REQUIRE_PERSISTENCE=0 explicitly and Supabase is missing", async () => {
    process.env.REQUIRE_PERSISTENCE = "0";

    const { initDatabase } = await import("../../database.js");

    await expect(initDatabase()).resolves.toBeUndefined();
  });
});
