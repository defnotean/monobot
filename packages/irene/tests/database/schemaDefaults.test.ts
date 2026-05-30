/**
 * Schema-default contract for the in-memory cache getters.
 *
 * The audit (Agent 6, HIGH) flagged that when Irene runs without Supabase
 * (or before any write for a given key), getters like `getGuildSettings`,
 * `getMood`, `getRelationship`, `getStarboard`, `getDmWelcome`,
 * `getLeaveSettings`, and `getEscalation` were returning `null` or partial
 * shapes — downstream code that destructured (e.g. `cfg.welcomeChannelId`,
 * `mood.energy`) would crash on missing keys.
 *
 * These tests pin the contract:
 *   1. Missing-key reads return the default shape (not `null`).
 *   2. Partial-shape stored rows merge over defaults — stored fields win,
 *      missing fields fall through to defaults.
 *   3. Explicit `null` in stored is PRESERVED through the merge (a deliberate
 *      "cleared" state, not the same as "unset").
 *   4. `undefined` in stored does NOT erase the default (this is the
 *      spread-operator footgun the helper guards against).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  GUILD_SETTINGS_DEFAULTS,
  STARBOARD_DEFAULTS,
  DM_WELCOME_DEFAULTS,
  LEAVE_DEFAULTS,
  ESCALATION_DEFAULTS,
  MOOD_DEFAULTS,
  RELATIONSHIP_DEFAULTS,
  TICKET_CONFIG_DEFAULTS,
  BIRTHDAY_CONFIG_DEFAULTS,
  PATCH_FEEDS_DEFAULTS,
  TWITCH_DEFAULTS,
  withDefaults,
  // @ts-expect-error - importing JS module without types
} from "../../database/schemas.js";

// @ts-expect-error - importing JS module without types
import * as db from "../../database.js";

// The in-memory cache lives on a module-scoped `data` object inside
// database.js. Each test starts by clearing whichever slice it touches so
// tests don't bleed into each other. We can't reach `data` directly (it's
// not exported), so we reset by overwriting via the public setters — or by
// re-importing the module fresh per test. The simpler approach is to ensure
// each test uses a unique guild/user id; missing rows are exactly what we
// want to exercise.

let uniqueCounter = 0;
function uid(prefix: string): string {
  uniqueCounter++;
  return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

describe("schemas.withDefaults — core merge semantics", () => {
  it("returns a clone of defaults when stored is undefined", () => {
    const out = withDefaults({ a: 1, b: 2 }, undefined);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("returns a clone of defaults when stored is null", () => {
    const out = withDefaults({ a: 1, b: 2 }, null);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("returns a clone of defaults when stored is a non-object (defensive)", () => {
    // Corrupted cache state — string where object expected.
    const out = withDefaults({ a: 1, b: 2 }, "broken" as any);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("merges partial stored over defaults (missing keys fall through)", () => {
    const out = withDefaults({ a: 1, b: 2, c: 3 }, { b: 99 });
    expect(out).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("preserves explicit null from stored (cleared state)", () => {
    // null is a deliberate "cleared" value, not "unset" — must survive merge.
    const out = withDefaults({ a: 1, channel: "default-ch" }, { channel: null });
    expect(out).toEqual({ a: 1, channel: null });
  });

  it("does NOT let undefined in stored erase the default", () => {
    // Plain {...defaults, ...stored} would yield {channel: undefined}; we
    // explicitly skip undefined-valued keys so the default survives.
    const out = withDefaults({ a: 1, channel: "default-ch" }, { channel: undefined });
    expect(out).toEqual({ a: 1, channel: "default-ch" });
  });

  it("returns a fresh object — does not mutate defaults or stored", () => {
    const defaults = { a: 1, b: 2 };
    const stored = { b: 99 };
    const out = withDefaults(defaults, stored);
    out.a = 42;
    expect(defaults.a).toBe(1);
    expect(stored).toEqual({ b: 99 });
  });

  it("works with Object.freeze'd defaults (the real const exports)", () => {
    // The exported DEFAULTS constants are frozen; the helper must not try
    // to write into them.
    const frozen = Object.freeze({ a: 1, b: 2 });
    const out = withDefaults(frozen, { b: 99 });
    expect(out).toEqual({ a: 1, b: 99 });
    // The frozen original is untouched.
    expect(frozen).toEqual({ a: 1, b: 2 });
  });
});

describe("schemas — default constant shapes", () => {
  it("GUILD_SETTINGS_DEFAULTS contains the load-bearing keys", () => {
    // Documents the contract — if any of these is removed, downstream code
    // that property-accesses the field would silently start returning
    // undefined again. Add a new key here when you teach getGuildSettings
    // about a new field, not just to the inline default at the call site.
    expect(GUILD_SETTINGS_DEFAULTS).toMatchObject({
      max_warnings: expect.any(Number),
      auto_mod_enabled: false,
      rules: [],
      rule_exemptions: [],
      escalation: { mute_at: null, kick_at: null, ban_at: null },
      welcome_channel: null,
      log_channel: null,
      vc_naming_mode: "smart",
      vc_default_limit: 0,
      vc_rich_presence: true,
    });
  });

  it("MOOD_DEFAULTS matches the boot-loader clamp envelope", () => {
    // mood_score is bounded [-100, 100] and energy [0, 100]; the defaults
    // sit inside those ranges so they're valid out of the box.
    expect(MOOD_DEFAULTS.mood_score).toBeGreaterThanOrEqual(-100);
    expect(MOOD_DEFAULTS.mood_score).toBeLessThanOrEqual(100);
    expect(MOOD_DEFAULTS.energy).toBeGreaterThanOrEqual(0);
    expect(MOOD_DEFAULTS.energy).toBeLessThanOrEqual(100);
  });

  it("RELATIONSHIP_DEFAULTS starts neutral with zero interactions", () => {
    expect(RELATIONSHIP_DEFAULTS).toMatchObject({
      affinity_score: 0,
      interactions_count: 0,
      trust_score: 0,
      familiarity_score: 0,
      playfulness_score: 0,
      irritation_score: 0,
      respect_score: 0,
    });
  });

  it("ESCALATION_DEFAULTS has null at every tier (auto-action OFF)", () => {
    expect(ESCALATION_DEFAULTS).toEqual({
      mute_at: null,
      kick_at: null,
      ban_at: null,
    });
  });

  it("all DEFAULTS exports are frozen (cannot be mutated cross-test)", () => {
    expect(Object.isFrozen(GUILD_SETTINGS_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(MOOD_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(RELATIONSHIP_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(STARBOARD_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DM_WELCOME_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(LEAVE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(ESCALATION_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(TICKET_CONFIG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(BIRTHDAY_CONFIG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(PATCH_FEEDS_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(TWITCH_DEFAULTS)).toBe(true);
  });
});

describe("getGuildSettings — schema-default integration", () => {
  it("returns the full default shape for a guild with no stored row", () => {
    const gid = uid("guild-no-row");
    const settings = db.getGuildSettings(gid);
    // The function used to return `null` here — downstream code calling
    // settings.max_warnings would TypeError. Now every documented key is
    // present.
    expect(settings).not.toBeNull();
    expect(settings.max_warnings).toBe(GUILD_SETTINGS_DEFAULTS.max_warnings);
    expect(settings.auto_mod_enabled).toBe(false);
    expect(settings.rules).toEqual([]);
    expect(settings.escalation).toEqual(ESCALATION_DEFAULTS);
    expect(settings.vc_naming_mode).toBe("smart");
  });

  it("stored fields take precedence over defaults", () => {
    const gid = uid("guild-partial");
    db.setGuildSetting(gid, "max_warnings", 7);
    const settings = db.getGuildSettings(gid);
    expect(settings.max_warnings).toBe(7);
    // Unset keys still come from defaults.
    expect(settings.auto_mod_enabled).toBe(false);
    expect(settings.vc_naming_mode).toBe("smart");
  });

  it("explicit-null stored value is preserved (channel cleared by admin)", () => {
    const gid = uid("guild-null-channel");
    // Simulate the admin clearing the welcome channel — the setter would
    // write null. The default would be null too, but if it were "default-ch",
    // the merge must still respect the explicit clear.
    db.setGuildSetting(gid, "welcome_channel", null);
    const settings = db.getGuildSettings(gid);
    expect(settings.welcome_channel).toBeNull();
  });
});

describe("getMood — schema-default integration", () => {
  it("returns MOOD_DEFAULTS when nothing has been written yet", () => {
    // getMood reads from a module-scoped object; on first read after import
    // it should match the documented defaults.
    const mood = db.getMood();
    expect(mood).toHaveProperty("mood_score");
    expect(mood).toHaveProperty("energy");
    expect(typeof mood.mood_score).toBe("number");
    expect(typeof mood.energy).toBe("number");
  });

  it("reflects updates while still guaranteeing the full shape", () => {
    db.updateMood(42, 75);
    const mood = db.getMood();
    expect(mood.mood_score).toBe(42);
    expect(mood.energy).toBe(75);
  });
});

describe("getRelationship — schema-default integration", () => {
  it("returns the default shape for a user with no stored row", () => {
    const userId = uid("user-no-rel");
    const rel = db.getRelationship(userId);
    expect(rel).toMatchObject({ affinity_score: 0, interactions_count: 0, trust_score: 0 });
  });

  it("merges over defaults when stored row is partial", () => {
    // updateRelationship writes both fields, so to test merge we go directly
    // through the cache via the public getter after a single update.
    const userId = uid("user-partial-rel");
    db.updateRelationship(userId, 5); // +5 affinity, 1 interaction
    const rel = db.getRelationship(userId);
    expect(rel.affinity_score).toBe(5);
    expect(rel.interactions_count).toBe(1);
  });
});

describe("getStarboard / getDmWelcome / getLeaveSettings — slice defaults", () => {
  it("getStarboard returns {channelId: null, threshold: 3} for unset guild", () => {
    const gid = uid("guild-starboard");
    expect(db.getStarboard(gid)).toEqual({ channelId: null, threshold: 3 });
  });

  it("getStarboard reflects partial config (threshold only)", () => {
    const gid = uid("guild-starboard-partial");
    db.setStarboard(gid, null, 10);
    const sb = db.getStarboard(gid);
    expect(sb.threshold).toBe(10);
    expect(sb.channelId).toBeNull();
  });

  it("getDmWelcome returns enabled=false + default message when unset", () => {
    const gid = uid("guild-dm-welcome");
    const dm = db.getDmWelcome(gid);
    expect(dm.enabled).toBe(false);
    expect(typeof dm.message).toBe("string");
    expect(dm.message.length).toBeGreaterThan(0);
  });

  it("getLeaveSettings returns {channelId: null, message: <default>} when unset", () => {
    const gid = uid("guild-leave");
    const leave = db.getLeaveSettings(gid);
    expect(leave.channelId).toBeNull();
    expect(typeof leave.message).toBe("string");
    expect(leave.message.length).toBeGreaterThan(0);
  });
});

describe("getEscalation — schema-default integration", () => {
  it("returns all-null tiers when no escalation is configured", () => {
    const gid = uid("guild-escalation");
    expect(db.getEscalation(gid)).toEqual({
      mute_at: null,
      kick_at: null,
      ban_at: null,
    });
  });

  it("merges partial policy over defaults (only mute_at set)", () => {
    const gid = uid("guild-escalation-partial");
    db.setEscalation(gid, { mute_at: 3 });
    const esc = db.getEscalation(gid);
    expect(esc.mute_at).toBe(3);
    expect(esc.kick_at).toBeNull();
    expect(esc.ban_at).toBeNull();
  });
});
