import { describe, it, expect, beforeEach, vi } from "vitest";

// guildSettings.js is PURE in-memory (mutates the shared `data.guild_settings`
// cache held in database/core.js and marks it dirty via the debounced save()).
// No Supabase calls happen in these helpers, so we run in in-memory mode and
// reset the shared cache between tests by re-importing the module fresh.

let db: any;

beforeEach(async () => {
  vi.resetModules();
  db = await import("../../database.js");
  // No initDatabase() needed — in-memory cache starts empty for these helpers.
});

describe("guildSettings.js — generic settings", () => {
  it("getGuildSettings returns {} for an unknown guild", () => {
    expect(db.getGuildSettings("g-unknown")).toEqual({});
  });

  it("setGuildSetting persists a key and getGuildSettings reflects it", () => {
    db.setGuildSetting("g1", "welcome_channel", "123");
    expect(db.getGuildSettings("g1")).toMatchObject({ welcome_channel: "123" });
  });

  it("multiple settings accumulate on the same guild", () => {
    db.setGuildSetting("g2", "a", 1);
    db.setGuildSetting("g2", "b", 2);
    expect(db.getGuildSettings("g2")).toMatchObject({ a: 1, b: 2 });
  });
});

describe("guildSettings.js — directives", () => {
  it("getDirectives is [] before any are added", () => {
    expect(db.getDirectives("g3")).toEqual([]);
  });

  it("addDirective stores text (truncated to 300 chars) and returns its index", () => {
    const res = db.addDirective("g4", "always be polite", "chan-1", "admin-1");
    expect(res).toEqual({ success: true, index: 0 });
    const dirs = db.getDirectives("g4");
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({ text: "always be polite", channel: "chan-1", addedBy: "admin-1" });
    expect(typeof dirs[0].addedAt).toBe("number");
  });

  it("truncates directive text to 300 characters", () => {
    db.addDirective("g4b", "x".repeat(500));
    expect(db.getDirectives("g4b")[0].text).toHaveLength(300);
  });

  it("defaults channel to null when not supplied", () => {
    db.addDirective("g4c", "no channel rule");
    expect(db.getDirectives("g4c")[0].channel).toBeNull();
  });

  it("rejects a case-insensitive duplicate directive", () => {
    db.addDirective("g5", "Be Nice");
    const res = db.addDirective("g5", "  be nice  ");
    expect(res).toEqual({ success: false, reason: "duplicate directive" });
    expect(db.getDirectives("g5")).toHaveLength(1);
  });

  it("enforces a 50-directive cap per server", () => {
    for (let i = 0; i < 50; i++) db.addDirective("g6", `rule number ${i}`);
    expect(db.getDirectives("g6")).toHaveLength(50);
    const res = db.addDirective("g6", "one too many");
    expect(res).toEqual({ success: false, reason: "max 50 directives per server" });
  });

  it("removeDirective by numeric index returns the removed text", () => {
    db.addDirective("g7", "first rule");
    db.addDirective("g7", "second rule");
    const res = db.removeDirective("g7", 0);
    expect(res).toEqual({ success: true, removed: "first rule" });
    expect(db.getDirectives("g7").map((d: any) => d.text)).toEqual(["second rule"]);
  });

  it("removeDirective by keyword matches the first containing directive", () => {
    db.addDirective("g8", "respect the rules");
    db.addDirective("g8", "no spamming allowed");
    const res = db.removeDirective("g8", "spam");
    expect(res).toEqual({ success: true, removed: "no spamming allowed" });
    expect(db.getDirectives("g8")).toHaveLength(1);
  });

  it("removeDirective returns not-found for an out-of-range index", () => {
    db.addDirective("g9", "only rule");
    expect(db.removeDirective("g9", 5)).toEqual({ success: false, reason: "directive not found" });
    expect(db.removeDirective("g9", "missing keyword")).toEqual({ success: false, reason: "directive not found" });
  });

  it("removeDirective returns 'no directives saved' when none exist", () => {
    expect(db.removeDirective("g10", 0)).toEqual({ success: false, reason: "no directives saved" });
  });
});

describe("guildSettings.js — feature config", () => {
  it("getFeatureConfig returns the known defaults for a feature", () => {
    expect(db.getFeatureConfig("g11", "economy")).toEqual({ enabled: true, channel_id: null, ping_role_ids: [] });
    expect(db.getFeatureConfig("g11", "pets")).toEqual({ enabled: true });
  });

  it("falls back to { enabled: true } for an unknown feature", () => {
    expect(db.getFeatureConfig("g12", "nonexistent_feature")).toEqual({ enabled: true });
  });

  it("setFeatureConfig overrides merge over the defaults", () => {
    db.setFeatureConfig("g13", "gambling", { enabled: false, channel_id: "777" });
    const cfg = db.getFeatureConfig("g13", "gambling");
    expect(cfg.enabled).toBe(false);
    expect(cfg.channel_id).toBe("777");
    expect(cfg.ping_role_ids).toEqual([]); // untouched default still present
  });

  it("setFeatureConfig is incremental — later partial updates merge in", () => {
    db.setFeatureConfig("g14", "events", { channel_id: "111" });
    db.setFeatureConfig("g14", "events", { enabled: false });
    const cfg = db.getFeatureConfig("g14", "events");
    expect(cfg.channel_id).toBe("111");
    expect(cfg.enabled).toBe(false);
  });
});
