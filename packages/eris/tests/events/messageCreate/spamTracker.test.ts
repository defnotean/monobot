import { describe, it, expect } from "vitest";

import {
  jaccardSim,
  trackMessage,
  markBotResponded,
  addWarning,
  // @ts-expect-error - importing JS module without types
} from "../../../events/messageCreate/spamTracker.js";

describe("spamTracker.jaccardSim", () => {
  it("is 1 for identical word sets (order/dupes ignored)", () => {
    expect(jaccardSim("hello there world", "world hello there")).toBe(1);
  });

  it("is 0 for fully disjoint word sets", () => {
    expect(jaccardSim("alpha beta", "gamma delta")).toBe(0);
  });

  it("computes intersection-over-union for partial overlap", () => {
    // {a,b,c} vs {b,c,d}: inter 2, union 4 -> 0.5
    expect(jaccardSim("a b c", "b c d")).toBe(0.5);
  });

  it("is case-insensitive", () => {
    expect(jaccardSim("Hello World", "hello world")).toBe(1);
  });
});

describe("spamTracker.trackMessage / markBotResponded", () => {
  // Each test uses a unique user id so the module-scoped LRU state stays isolated.
  let n = 0;
  const freshUser = () => `user-${Date.now()}-${n++}`;

  it("returns count 1 for a brand-new (guild,user,text) entry", () => {
    const u = freshUser();
    expect(trackMessage("g1", u, "the exact same text")).toEqual({ count: 1 });
  });

  it("does NOT escalate a repeat until the bot has responded once", () => {
    const u = freshUser();
    trackMessage("g1", u, "spam this line"); // count 1, botResponded=false
    // Same normalized text again, but bot never responded -> stays at 1.
    expect(trackMessage("g1", u, "spam this line")).toEqual({ count: 1 });
  });

  it("escalates the repeat count once the bot has responded between repeats", () => {
    const u = freshUser();
    trackMessage("g1", u, "say it again"); // count 1
    markBotResponded("g1", u); // bot replied
    // Identical normalized message after a bot reply -> escalates to 2.
    expect(trackMessage("g1", u, "say it again")).toEqual({ count: 2 });
  });

  it("normalizes punctuation/case so cosmetic edits still count as the same message", () => {
    const u = freshUser();
    // Normalization: lowercase, strip non [a-z0-9 ], trim. Both of these
    // reduce to the same key "hello world" (punctuation/case removed).
    trackMessage("g1", u, "Hello, World!"); // -> "hello world"
    markBotResponded("g1", u);
    expect(trackMessage("g1", u, "hello world???")).toEqual({ count: 2 }); // -> "hello world"
  });

  it("treats different content as a new entry (count resets to 1)", () => {
    const u = freshUser();
    trackMessage("g1", u, "first distinct message");
    markBotResponded("g1", u);
    expect(trackMessage("g1", u, "totally different second message")).toEqual({ count: 1 });
  });

  it("isolates state across guild/user keys", () => {
    const u = freshUser();
    trackMessage("guildA", u, "shared text");
    markBotResponded("guildA", u);
    // Same user+text but different guild -> independent entry.
    expect(trackMessage("guildB", u, "shared text")).toEqual({ count: 1 });
  });

  it("markBotResponded on an unknown key is a harmless no-op", () => {
    expect(() => markBotResponded("g1", "never-seen-user")).not.toThrow();
  });
});

describe("spamTracker.addWarning", () => {
  let n = 0;
  const freshUser = () => `warnuser-${Date.now()}-${n++}`;

  it("starts at 1 and increments on repeated warnings within the window", () => {
    const u = freshUser();
    expect(addWarning("g1", u)).toBe(1);
    expect(addWarning("g1", u)).toBe(2);
    expect(addWarning("g1", u)).toBe(3);
  });

  it("tracks warnings independently per guild/user key", () => {
    const u = freshUser();
    addWarning("g1", u);
    expect(addWarning("g2", u)).toBe(1);
  });
});
