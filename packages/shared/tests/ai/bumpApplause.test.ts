import { describe, it, expect, vi } from "vitest";
import {
  // @ts-expect-error - importing JS module without types
  pickApplauseLine, createBumpApplause, ERIS_APPLAUSE, IRENE_APPLAUSE, GOOD_BOY_CHANCE,
} from "../../src/ai/bumpApplause.js";

describe("createBumpApplause — input validation", () => {
  it("throws if getGuildSettings is missing", () => {
    // @ts-expect-error
    expect(() => createBumpApplause({ isQuietHoursActive: () => false })).toThrow();
  });
  it("throws if isQuietHoursActive is missing", () => {
    // @ts-expect-error
    expect(() => createBumpApplause({ getGuildSettings: () => ({}) })).toThrow();
  });
});

describe("pickApplauseLine — pure picker", () => {
  it("returns a non-empty string with the name substituted", () => {
    const line = pickApplauseLine({ name: "@ean", rng: () => 0.99 });
    expect(typeof line).toBe("string");
    expect(line.length).toBeGreaterThan(0);
    if (line.includes("@")) expect(line).toContain("@ean");
    expect(line).not.toContain("{name}");
    expect(line).not.toContain("{streak}");
  });

  it("routes to the streak-carrier category when eligible", () => {
    const rngValues = [0.9, 0.1];
    let i = 0;
    const rng = () => rngValues[i++ % rngValues.length];
    const line = pickApplauseLine({ name: "@ean", userStreak: 12, rng });
    const found = ERIS_APPLAUSE.streakCarrier.some((tpl: string) =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "12") === line
    );
    expect(found).toBe(true);
    expect(line).not.toContain("{name}");
    expect(line).not.toContain("{streak}");
  });

  it("good-boy easter egg fires when rng() returns < GOOD_BOY_CHANCE", () => {
    const line = pickApplauseLine({
      name: "@ean",
      rng: () => GOOD_BOY_CHANCE / 2,
    });
    expect(line.toLowerCase()).toMatch(/good boy|atta boy|pets|treat|pat|sweetie|bumper/);
  });

  it("prefers default pool when no context flags are set and rng is high", () => {
    const line = pickApplauseLine({ name: "@ean", rng: () => 0.999 });
    const found = ERIS_APPLAUSE.default.some((tpl: string) =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0") === line
    );
    expect(found).toBe(true);
  });

  it("uses irene's pool when botName=irene", () => {
    const line = pickApplauseLine({
      name: "@ean",
      botName: "irene",
      rng: () => 0.999,
    });
    const found = IRENE_APPLAUSE.default.some((tpl: string) =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0") === line
    );
    expect(found).toBe(true);
  });

  it("routes to topBumper flavor when eligible and RNG allows", () => {
    const rngValues = [0.9, 0.1];
    let i = 0;
    const rng = () => rngValues[i++ % rngValues.length];
    const line = pickApplauseLine({
      name: "@ean",
      isTopBumper: true,
      rng,
    });
    const found = ERIS_APPLAUSE.topBumper.some((tpl: string) =>
      tpl.replace(/\{name\}/g, "@ean").replace(/\{streak\}/g, "0") === line
    );
    expect(found).toBe(true);
  });

  it("falls back to default when bumperName is missing", () => {
    const line = pickApplauseLine({ rng: () => 0.999 });
    const found = ERIS_APPLAUSE.default.some((tpl: string) =>
      tpl.replace(/\{name\}/g, "bumper").replace(/\{streak\}/g, "0") === line
    );
    expect(found).toBe(true);
  });
});

describe("createBumpApplause.sendBumpApplause", () => {
  it("skips when bump_applause_enabled is explicitly false", async () => {
    const reply = vi.fn();
    const applause = createBumpApplause({
      getGuildSettings: () => ({ bump_applause_enabled: false }),
      isQuietHoursActive: () => false,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean", service: "disboard",
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("skips when firstBumperBonusPaid is true", async () => {
    const reply = vi.fn();
    const applause = createBumpApplause({
      getGuildSettings: () => ({}),
      isQuietHoursActive: () => false,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean", service: "disboard",
      firstBumperBonusPaid: true,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("skips during quiet hours", async () => {
    const reply = vi.fn();
    const applause = createBumpApplause({
      getGuildSettings: () => ({}),
      isQuietHoursActive: () => true,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean", service: "disboard",
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies to the bump message when enabled and not quiet", async () => {
    const reply = vi.fn(async () => ({ id: "m" }));
    const applause = createBumpApplause({
      getGuildSettings: () => ({}),
      isQuietHoursActive: () => false,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean",
      service: "disboard", bumpsTable: "eris_bumps",
    });
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(typeof payload.content).toBe("string");
    expect(payload.content.length).toBeGreaterThan(0);
    expect(payload.allowedMentions).toBeDefined();
  });

  it("uses injected getUserStreak + getBumpLeaderboard when present", async () => {
    const reply = vi.fn(async () => ({ id: "m" }));
    const getUserStreak = vi.fn(async () => 7);
    const getBumpLeaderboard = vi.fn(async () => [{ user_id: "u1" }]);
    const applause = createBumpApplause({
      getGuildSettings: () => ({}),
      isQuietHoursActive: () => false,
      getUserStreak,
      getBumpLeaderboard,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean",
      service: "disboard", bumpsTable: "eris_bumps",
    });
    expect(getUserStreak).toHaveBeenCalledWith("u1", "g1", "disboard");
    expect(getBumpLeaderboard).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("works without optional deps (getSupabase / getUserStreak / etc.)", async () => {
    const reply = vi.fn(async () => ({ id: "m" }));
    const applause = createBumpApplause({
      getGuildSettings: () => ({}),
      isQuietHoursActive: () => false,
    });
    await applause.sendBumpApplause({
      bumpMessage: { reply },
      guildId: "g1", bumperId: "u1", bumperName: "ean",
      service: "disboard", bumpsTable: "eris_bumps",
    });
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
