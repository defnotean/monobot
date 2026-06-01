import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  upserts: [] as any[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: supabaseMock.createClient,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    existsSync: (p: string) =>
      typeof p === "string" && p.replace(/\\/g, "/").endsWith("/.env")
        ? false
        : actual.existsSync(p),
  };
});

function makeSupabaseClient(singleImpl: () => Promise<any>) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(singleImpl),
        })),
      })),
      upsert: vi.fn(async (payload: any) => {
        supabaseMock.upserts.push(payload);
        return { error: null };
      }),
    })),
  };
}

describe("Irene initDatabase REQUIRE_PERSISTENCE fail-fast", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    supabaseMock.createClient.mockReset();
    supabaseMock.upserts.length = 0;

    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.DISCORD_CLIENT_ID = "123456789012345678";
    process.env.DISCORD_USER_ID = "111111111111111111";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.SUPABASE_URL = "";
    process.env.SUPABASE_KEY = "";
    process.env.REQUIRE_PERSISTENCE = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("throws when persistence is required but Supabase credentials are missing", async () => {
    process.env.REQUIRE_PERSISTENCE = "1";

    const db = await import("../../database.js");
    const config = (await import("../../config.js")).default;

    expect(config.requirePersistence).toBe(true);
    expect(config.supabaseEnabled).toBe(false);
    await expect(db.initDatabase()).rejects.toThrow(/REQUIRE_PERSISTENCE=1.*SUPABASE_URL/s);
    expect(db.getSupabase()).toBeNull();
    expect(supabaseMock.createClient).not.toHaveBeenCalled();
  });

  it("throws when persistence is required but Supabase config is invalid", async () => {
    process.env.REQUIRE_PERSISTENCE = "1";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_KEY = "service-key";
    supabaseMock.createClient.mockImplementation(() => {
      throw new Error("bad config");
    });

    const db = await import("../../database.js");

    await expect(db.initDatabase()).rejects.toThrow(/client creation failed: bad config/);
    expect(db.getSupabase()).toBeNull();
  });

  it("clears the client after required initial-load retries fail, preventing default-state upserts", async () => {
    vi.useFakeTimers();
    process.env.REQUIRE_PERSISTENCE = "1";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_KEY = "service-key";
    const client = makeSupabaseClient(async () => {
      throw new Error("network down");
    });
    supabaseMock.createClient.mockReturnValue(client);

    const db = await import("../../database.js");
    const init = db.initDatabase();
    const initExpectation = expect(init).rejects.toThrow(/all 3 Supabase init attempts failed/);

    await vi.advanceTimersByTimeAsync(4_500);
    await initExpectation;
    expect(db.getSupabase()).toBeNull();

    db._internal.save("guild_settings");
    await db._internal.flushSave();
    expect(supabaseMock.upserts).toEqual([]);
  });

  it("still boots in local in-memory mode when persistence is not required", async () => {
    const db = await import("../../database.js");

    await expect(db.initDatabase()).resolves.toBeUndefined();
    expect(db.getSupabase()).toBeNull();
  });
});
