import { describe, it, expect, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { createBumpUserPrefs, _internal } from "../../src/ai/bumpUserPrefs.js";

// A tiny stub Supabase that resolves whatever the test queues up. Each method
// returns `this` until a terminator (`maybeSingle`, etc.) that resolves the
// promise.
function makeSupabaseStub(handlers: Record<string, any> = {}) {
  return {
    from: (table: string) => {
      const ctx: any = { _table: table, _filters: {} };
      ctx.select = (_cols: string) => ctx;
      ctx.eq = (col: string, val: any) => { ctx._filters[col] = val; return ctx; };
      ctx.maybeSingle = async () => {
        if (handlers.select) return handlers.select(ctx);
        return { data: null, error: null };
      };
      ctx.upsert = async (row: any) => {
        if (handlers.upsert) return handlers.upsert(row, table);
        return { error: null };
      };
      // The list query in getPersonalPingOptIns chains .from().select().eq()
      // and awaits the eq() — so eq() needs to be awaitable in that path. We
      // do that by attaching a `then` so it acts like a thenable.
      ctx.then = (resolve: any) => {
        if (handlers.list) return resolve(handlers.list(ctx));
        return resolve({ data: [], error: null });
      };
      return ctx;
    },
  };
}

describe("createBumpUserPrefs — input validation", () => {
  it("throws if getSupabase is missing", () => {
    // @ts-expect-error
    expect(() => createBumpUserPrefs({})).toThrow(/getSupabase function is required/);
  });
});

describe("bumpUserPrefs.getUserPrefs", () => {
  it("returns defaults when supabase is unavailable", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => null });
    const out = await prefs.getUserPrefs("u1", "eris");
    expect(out).toEqual({ personal_ping_enabled: false, weekly_mvp_optout: false });
  });

  it("returns defaults when userId is empty", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => makeSupabaseStub() });
    expect(await prefs.getUserPrefs("", "eris")).toEqual({
      personal_ping_enabled: false, weekly_mvp_optout: false,
    });
  });

  it("merges DB row with defaults", async () => {
    const sb = makeSupabaseStub({
      select: () => ({ data: { personal_ping_enabled: true }, error: null }),
    });
    const prefs = createBumpUserPrefs({ getSupabase: () => sb });
    const out = await prefs.getUserPrefs("u1", "eris");
    expect(out.personal_ping_enabled).toBe(true);
    expect(out.weekly_mvp_optout).toBe(false);
  });

  it("caches reads (second call doesnt re-query)", async () => {
    let calls = 0;
    const sb = makeSupabaseStub({
      select: () => { calls++; return { data: { personal_ping_enabled: true }, error: null }; },
    });
    const prefs = createBumpUserPrefs({ getSupabase: () => sb });
    await prefs.getUserPrefs("u1", "eris");
    await prefs.getUserPrefs("u1", "eris");
    expect(calls).toBe(1);
  });

  it("logs and returns defaults on error", async () => {
    const captured: string[] = [];
    const sb = makeSupabaseStub({
      select: () => ({ data: null, error: { message: "boom" } }),
    });
    const prefs = createBumpUserPrefs({
      getSupabase: () => sb,
      log: (m: string) => captured.push(m),
    });
    const out = await prefs.getUserPrefs("u1", "eris");
    expect(out).toEqual({ personal_ping_enabled: false, weekly_mvp_optout: false });
    expect(captured.some(m => /read failed/.test(m))).toBe(true);
  });
});

describe("bumpUserPrefs.setUserPref", () => {
  it("rejects unknown pref keys", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => makeSupabaseStub() });
    // @ts-expect-error testing invalid key
    const r = await prefs.setUserPref("u1", "garbage", true, "eris");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown pref/);
  });

  it("rejects empty userId", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => makeSupabaseStub() });
    const r = await prefs.setUserPref("", "personal_ping_enabled", true, "eris");
    expect(r.ok).toBe(false);
  });

  it("returns failure when no supabase", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => null });
    const r = await prefs.setUserPref("u1", "personal_ping_enabled", true, "eris");
    expect(r.ok).toBe(false);
  });

  it("upserts to the right table per bot", async () => {
    const tables: string[] = [];
    const sb = makeSupabaseStub({
      upsert: (_row: any, table: string) => { tables.push(table); return { error: null }; },
    });
    const prefs = createBumpUserPrefs({ getSupabase: () => sb });
    await prefs.setUserPref("u1", "personal_ping_enabled", true, "eris");
    await prefs.setUserPref("u2", "weekly_mvp_optout", true, "irene");
    expect(tables).toEqual(["eris_bump_user_prefs", "irene_bump_user_prefs"]);
  });

  it("invalidates cache on write so next read reflects it", async () => {
    let selectCalls = 0;
    const sb = makeSupabaseStub({
      select: () => { selectCalls++; return { data: { personal_ping_enabled: false }, error: null }; },
      upsert: () => ({ error: null }),
    });
    const prefs = createBumpUserPrefs({ getSupabase: () => sb });
    await prefs.getUserPrefs("u1", "eris"); // populates cache
    await prefs.setUserPref("u1", "personal_ping_enabled", true, "eris"); // invalidates
    await prefs.getUserPrefs("u1", "eris"); // should re-query
    expect(selectCalls).toBe(2);
  });
});

describe("bumpUserPrefs.getPersonalPingOptIns", () => {
  it("returns [] when no supabase", async () => {
    const prefs = createBumpUserPrefs({ getSupabase: () => null });
    expect(await prefs.getPersonalPingOptIns("eris")).toEqual([]);
  });

  it("maps rows to user_ids", async () => {
    const sb = makeSupabaseStub({
      list: () => ({ data: [{ user_id: "a" }, { user_id: "b" }], error: null }),
    });
    const prefs = createBumpUserPrefs({ getSupabase: () => sb });
    expect(await prefs.getPersonalPingOptIns("eris")).toEqual(["a", "b"]);
  });

  it("returns [] and logs on error", async () => {
    const captured: string[] = [];
    const sb = makeSupabaseStub({
      list: () => ({ data: null, error: { message: "fail" } }),
    });
    const prefs = createBumpUserPrefs({
      getSupabase: () => sb,
      log: (m: string) => captured.push(m),
    });
    expect(await prefs.getPersonalPingOptIns("eris")).toEqual([]);
    expect(captured.some(m => /optins read failed/.test(m))).toBe(true);
  });
});

describe("_internal.tableFor", () => {
  it("maps botName to the correct table prefix", () => {
    expect(_internal.tableFor("irene")).toBe("irene_bump_user_prefs");
    expect(_internal.tableFor("eris")).toBe("eris_bump_user_prefs");
    expect(_internal.tableFor("anything")).toBe("eris_bump_user_prefs"); // default
  });
});
