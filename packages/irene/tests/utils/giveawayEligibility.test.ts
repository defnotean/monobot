import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { checkEligibility, formatRejection, describeRequirements } from "../../utils/giveawayEligibility.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

describe("checkEligibility — no gates", () => {
  it("passes when no gates are set", () => {
    expect(checkEligibility({
      accountCreatedAtMs: NOW - DAY_MS, // 1 day old account
      guildJoinedAtMs: NOW - 60_000,    // joined 1 minute ago
      now: NOW,
    })).toEqual({ ok: true });
  });

  it("ignores account age when min is 0", () => {
    expect(checkEligibility({
      accountCreatedAtMs: NOW - 1000, // brand new account
      minAccountAgeDays: 0,
      now: NOW,
    })).toEqual({ ok: true });
  });

  it("ignores tenure when min is 0", () => {
    expect(checkEligibility({
      guildJoinedAtMs: NOW - 1000, // joined 1s ago
      minTenureDays: 0,
      now: NOW,
    })).toEqual({ ok: true });
  });
});

describe("checkEligibility — account age gate", () => {
  it("passes when account old enough", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 10 * DAY_MS,
      minAccountAgeDays: 7,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("fails when account too young", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 3 * DAY_MS,
      minAccountAgeDays: 7,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account_too_young");
    expect(r.required).toBe(7);
    expect(r.actualDays).toBe(3);
  });

  it("fails when no account creation timestamp", () => {
    const r = checkEligibility({
      accountCreatedAtMs: undefined,
      minAccountAgeDays: 7,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_account_data");
  });

  it("boundary: exactly at threshold passes", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 7 * DAY_MS,
      minAccountAgeDays: 7,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkEligibility — tenure gate", () => {
  it("passes when tenure long enough", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 365 * DAY_MS,
      guildJoinedAtMs: NOW - 30 * DAY_MS,
      minTenureDays: 14,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("fails when tenure too short", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 365 * DAY_MS,
      guildJoinedAtMs: NOW - 5 * DAY_MS,
      minTenureDays: 14,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("tenure_too_short");
    expect(r.required).toBe(14);
    expect(r.actualDays).toBe(5);
  });

  it("fails when no member data", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 365 * DAY_MS,
      guildJoinedAtMs: undefined,
      minTenureDays: 14,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_member_data");
  });
});

describe("checkEligibility — both gates combined", () => {
  it("passes when both met", () => {
    expect(checkEligibility({
      accountCreatedAtMs: NOW - 30 * DAY_MS,
      guildJoinedAtMs: NOW - 20 * DAY_MS,
      minAccountAgeDays: 7,
      minTenureDays: 14,
      now: NOW,
    }).ok).toBe(true);
  });

  it("fails on account age first if both fail", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 1 * DAY_MS,
      guildJoinedAtMs: NOW - 1 * DAY_MS,
      minAccountAgeDays: 7,
      minTenureDays: 14,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account_too_young");
  });

  it("fails on tenure when only tenure fails", () => {
    const r = checkEligibility({
      accountCreatedAtMs: NOW - 30 * DAY_MS,
      guildJoinedAtMs: NOW - 1 * DAY_MS,
      minAccountAgeDays: 7,
      minTenureDays: 14,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("tenure_too_short");
  });
});

describe("formatRejection", () => {
  it("returns null for eligible result", () => {
    expect(formatRejection({ ok: true })).toBeNull();
  });

  it("formats account_too_young with required + actual", () => {
    const msg = formatRejection({
      ok: false, reason: "account_too_young", required: 7, actualDays: 2,
    });
    expect(msg).toContain("7d");
    expect(msg).toContain("2d");
    expect(msg).toContain("account");
  });

  it("formats tenure_too_short with required + actual", () => {
    const msg = formatRejection({
      ok: false, reason: "tenure_too_short", required: 14, actualDays: 5,
    });
    expect(msg).toContain("14d");
    expect(msg).toContain("5d");
    expect(msg).toContain("server");
  });

  it("falls back for unknown reason", () => {
    const msg = formatRejection({ ok: false, reason: "weird" });
    expect(typeof msg).toBe("string");
    expect(msg!.length).toBeGreaterThan(0);
  });
});

describe("describeRequirements", () => {
  it("returns null when no gates set", () => {
    expect(describeRequirements({})).toBeNull();
    expect(describeRequirements({ minAccountAgeDays: 0, minTenureDays: 0 })).toBeNull();
  });

  it("describes account age only", () => {
    expect(describeRequirements({ minAccountAgeDays: 7 })).toContain("7d");
  });

  it("describes tenure only", () => {
    expect(describeRequirements({ minTenureDays: 14 })).toContain("14d");
  });

  it("joins both with separator", () => {
    const out = describeRequirements({ minAccountAgeDays: 7, minTenureDays: 14 });
    expect(out).toContain("7d");
    expect(out).toContain("14d");
    expect(out).toContain("·");
  });
});
