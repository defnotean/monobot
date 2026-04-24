import { describe, it, expect, vi } from "vitest";
// @ts-expect-error - importing JS module
import * as br from "../../ai/bumpReminder.js";

describe("detectBumpService", () => {
  it("detects a DISBOARD confirm from the correct bot ID", () => {
    const msg = {
      author: { bot: true, id: "302050872383242240" },
      content: "Bump done! <@123> — see you in 2 hours.",
      embeds: [],
    };
    expect(br.detectBumpService(msg)).toBe("disboard");
  });

  it("detects a DISBOARD confirm when signal is in the embed", () => {
    const msg = {
      author: { bot: true, id: "302050872383242240" },
      content: "",
      embeds: [{ description: "👍 Bump done! <@123>" }],
    };
    expect(br.detectBumpService(msg)).toBe("disboard");
  });

  it("ignores DISBOARD messages that aren't bump confirms", () => {
    const msg = {
      author: { bot: true, id: "302050872383242240" },
      content: "Error: your server has been blacklisted",
      embeds: [],
    };
    expect(br.detectBumpService(msg)).toBeNull();
  });

  it("ignores messages from non-bump bots even with 'bumped' in text", () => {
    const msg = {
      author: { bot: true, id: "9999999999" },
      content: "Bump done!",
      embeds: [],
    };
    expect(br.detectBumpService(msg)).toBeNull();
  });

  it("ignores messages from humans", () => {
    const msg = { author: { bot: false, id: "1" }, content: "bump done" };
    expect(br.detectBumpService(msg)).toBeNull();
  });

  it("detects Discadia confirmations", () => {
    const msg = {
      author: { bot: true, id: "1222663974588911719" },
      content: "You've successfully bumped!",
      embeds: [],
    };
    expect(br.detectBumpService(msg)).toBe("discadia");
  });
});

describe("extractBumperUserId", () => {
  it("extracts from DISBOARD confirm", () => {
    const msg = {
      author: { bot: true, id: "302050872383242240" },
      content: "Bump done! <@987654321012345678>",
      embeds: [],
    };
    expect(br.extractBumperUserId(msg, "disboard")).toBe("987654321012345678");
  });

  it("returns null when no user mention present", () => {
    const msg = {
      author: { bot: true, id: "302050872383242240" },
      content: "Bump done!",
      embeds: [],
    };
    expect(br.extractBumperUserId(msg, "disboard")).toBeNull();
  });
});

describe("isQuietHoursActive", () => {
  it("returns false when no quiet config", () => {
    expect(br.isQuietHoursActive({})).toBe(false);
    expect(br.isQuietHoursActive({ bump_quiet_hours: null })).toBe(false);
  });

  it("returns false for identical start/end (no-op range)", () => {
    const s = { bump_quiet_hours: { start: 3, end: 3, tz: "UTC" } };
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T03:30:00Z"))).toBe(false);
  });

  it("returns true inside a simple same-day window", () => {
    const s = { bump_quiet_hours: { start: 2, end: 7, tz: "UTC" } };
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T03:30:00Z"))).toBe(true);
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T07:00:00Z"))).toBe(false);
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T09:00:00Z"))).toBe(false);
  });

  it("handles windows that wrap midnight", () => {
    const s = { bump_quiet_hours: { start: 22, end: 7, tz: "UTC" } };
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T23:00:00Z"))).toBe(true);
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T02:00:00Z"))).toBe(true);
    expect(br.isQuietHoursActive(s, new Date("2026-01-01T12:00:00Z"))).toBe(false);
  });

  it("respects a non-UTC timezone", () => {
    // 2am in LA (UTC-8 or UTC-7 depending on DST). In January 2026, LA is UTC-8.
    const s = { bump_quiet_hours: { start: 22, end: 7, tz: "America/Los_Angeles" } };
    // 06:00 UTC Jan 15 = 22:00 Jan 14 PT → inside the window
    expect(br.isQuietHoursActive(s, new Date("2026-01-15T06:30:00Z"))).toBe(true);
    // 18:00 UTC Jan 15 = 10:00 Jan 15 PT → outside
    expect(br.isQuietHoursActive(s, new Date("2026-01-15T18:00:00Z"))).toBe(false);
  });
});

describe("SERVICES registry", () => {
  it("has the known services with plausible cooldowns", () => {
    expect(br._internal.SERVICES.disboard.cooldownMinutes).toBe(120);
    expect(br._internal.SERVICES.discadia.cooldownMinutes).toBeGreaterThan(0);
    expect(br._internal.SERVICES.disforge.cooldownMinutes).toBeGreaterThan(0);
  });

  it("all service botIds are 17-20 digit strings", () => {
    for (const svc of Object.values(br._internal.SERVICES)) {
      expect(svc.botId).toMatch(/^\d{17,20}$/);
    }
  });
});
