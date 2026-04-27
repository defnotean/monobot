import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock out the getGuildSettings + isQuietHoursActive paths so the module
// loads without touching database / config.
const guildSettings = new Map();
vi.mock("../../database.js", () => ({
  getGuildSettings: (id: string) => guildSettings.get(id) || {},
  getSupabase: () => null,
}));

vi.mock("../../ai/bumpReminder.js", () => ({
  isQuietHoursActive: (settings: any) => !!settings?._quietForTest,
}));

// @ts-expect-error
import * as applause from "../../ai/bumpApplause.js";
import { ERIS_APPLAUSE, IRENE_APPLAUSE, GOOD_BOY_CHANCE } from "../../ai/bumpApplause.js";

beforeEach(() => { guildSettings.clear(); });

describe("bumpApplause.pickApplauseLine", () => {
  it("returns a non-empty string with the name substituted", () => {
    const line = applause.pickApplauseLine({ name: "@ean", rng: () => 0.99 });
    expect(typeof line).toBe("string");
    expect(line.length).toBeGreaterThan(0);
    // Default pool sometimes has no {name}, but when it does it's replaced.
    if (line.includes("@")) expect(line).toContain("@ean");
    expect(line).not.toContain("{name}");
    expect(line).not.toContain("{streak}");
  });

  it("routes to the streak-carrier category when eligible", () => {
    // Force the path: goodBoy miss (rng>=0.08), streakCarrier hit (rng<0.5).
    const rngValues = [0.9, 0.1];
    let i = 0;
    const rng = () => rngValues[i++ % rngValues.length];
    const line = applause.pickApplauseLine({
      name: "@ean",
      userStreak: 12,
      rng,
    });
    // Verify the line matches a rendered template from the streakCarrier
    // pool (not every streak template references {streak}, so we can't
    // just grep for "12").
    const found = ERIS_APPLAUSE.streakCarrier.some(tpl =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "12") === line
    );
    expect(found).toBe(true);
    expect(line).not.toContain("{name}");
    expect(line).not.toContain("{streak}");
  });

  it("good-boy easter egg fires when rng() returns < GOOD_BOY_CHANCE", () => {
    const line = applause.pickApplauseLine({
      name: "@ean",
      rng: () => GOOD_BOY_CHANCE / 2,
    });
    // Any of the good-boy phrases contains "good", a dog-themed motif,
    // or the word "bumper" (covers "good bumper" / "good lil bumper" /
    // future variations without re-tightening the regex each time).
    expect(line.toLowerCase()).toMatch(/good boy|atta boy|pets|treat|pat|sweetie|bumper/);
  });

  it("prefers default pool when no context flags are set and rng is high", () => {
    const line = applause.pickApplauseLine({ name: "@ean", rng: () => 0.999 });
    // No streak flavor, no good-boy — must come from default set.
    const found = ERIS_APPLAUSE.default.some(tpl => {
      const rendered = tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0");
      return rendered === line;
    });
    expect(found).toBe(true);
  });

  it("uses irene's pool when botName=irene", () => {
    const line = applause.pickApplauseLine({
      name: "@ean",
      botName: "irene",
      rng: () => 0.999,
    });
    const found = IRENE_APPLAUSE.default.some(tpl => {
      const rendered = tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0");
      return rendered === line;
    });
    expect(found).toBe(true);
  });

  it("routes to topBumper flavor when eligible and RNG allows", () => {
    // rng sequence: good-boy miss, streak-eligible false (streak=0 doesn't hit min),
    // top-bumper gate hits with < 0.5
    const rngValues = [0.9, 0.1];
    let i = 0;
    const rng = () => rngValues[i++ % rngValues.length];
    const line = applause.pickApplauseLine({
      name: "@ean",
      isTopBumper: true,
      rng,
    });
    const found = ERIS_APPLAUSE.topBumper.some(tpl =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0") === line
    );
    expect(found).toBe(true);
  });

  it("falls back to default when bumperName is missing", () => {
    const line = applause.pickApplauseLine({ rng: () => 0.999 });
    // When name is missing, the picker substitutes "bumper" as the default.
    // Many default templates don't have {name} at all (e.g. "logged in the
    // ledger 📓"), so we verify the line came from the default pool — not
    // that it literally contains the substitution.
    const found = ERIS_APPLAUSE.default.some(tpl => {
      const rendered = tpl.replace(/\{name\}/g, "bumper").replace(/\{streak\}/g, "0");
      return rendered === line;
    });
    expect(found).toBe(true);
  });
});

describe("bumpApplause.sendBumpApplause", () => {
  it("skips when bump_applause_enabled is explicitly false", async () => {
    guildSettings.set("g1", { bump_applause_enabled: false });
    const reply = vi.fn();
    const bumpMessage = { reply };
    await applause.sendBumpApplause({
      bumpMessage, guildId: "g1", bumperId: "u1", bumperName: "ean", service: "disboard",
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("skips when firstBumperBonusPaid is true (avoids double-message)", async () => {
    const reply = vi.fn();
    await applause.sendBumpApplause({
      bumpMessage: { reply }, guildId: "g1", bumperId: "u1",
      bumperName: "ean", service: "disboard", firstBumperBonusPaid: true,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("skips during quiet hours", async () => {
    guildSettings.set("g1", { _quietForTest: true });
    const reply = vi.fn();
    await applause.sendBumpApplause({
      bumpMessage: { reply }, guildId: "g1", bumperId: "u1",
      bumperName: "ean", service: "disboard",
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies to the bump message when enabled and not quiet", async () => {
    const reply = vi.fn(async () => ({ id: "m" }));
    await applause.sendBumpApplause({
      bumpMessage: { reply }, guildId: "g1", bumperId: "u1",
      bumperName: "ean", service: "disboard", bumpsTable: "eris_bumps",
    });
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(typeof payload.content).toBe("string");
    expect(payload.content.length).toBeGreaterThan(0);
    expect(payload.allowedMentions).toBeDefined();
  });
});
