import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { formatEntry, joinEntries, actionLabel, MODERATION_ACTION_TYPES } from "../../utils/auditFormat.js";

function makeEntry(overrides: any = {}) {
  return {
    action: 22, // ban
    createdTimestamp: 1_700_000_000_000,
    executor: { tag: "moderator#0001", id: "100" },
    target: { tag: "spammer#9999", id: "200" },
    reason: "broke rule 3",
    ...overrides,
  };
}

describe("auditFormat.actionLabel", () => {
  it("knows core moderation actions", () => {
    expect(actionLabel(20)).toBe("kick");
    expect(actionLabel(22)).toBe("ban");
    expect(actionLabel(23)).toBe("unban");
    expect(actionLabel(72)).toBe("message delete");
  });

  it("falls back for unknown action numbers", () => {
    expect(actionLabel(9999)).toBe("action 9999");
  });
});

describe("auditFormat.MODERATION_ACTION_TYPES", () => {
  it("includes the core mod actions", () => {
    expect(MODERATION_ACTION_TYPES.has(20)).toBe(true); // kick
    expect(MODERATION_ACTION_TYPES.has(22)).toBe(true); // ban
    expect(MODERATION_ACTION_TYPES.has(23)).toBe(true); // unban
    expect(MODERATION_ACTION_TYPES.has(24)).toBe(true); // member update (timeout)
  });

  it("excludes non-moderation actions", () => {
    expect(MODERATION_ACTION_TYPES.has(10)).toBe(false); // channel create
    expect(MODERATION_ACTION_TYPES.has(30)).toBe(false); // role create
    expect(MODERATION_ACTION_TYPES.has(72)).toBe(false); // message delete
  });
});

describe("auditFormat.formatEntry", () => {
  it("includes timestamp, actor, action, target, reason", () => {
    const out = formatEntry(makeEntry());
    expect(out).toContain("<t:");
    expect(out).toContain("moderator#0001");
    expect(out).toContain("ban");
    expect(out).toContain("spammer#9999");
    expect(out).toContain("broke rule 3");
  });

  it("falls back gracefully when fields are missing", () => {
    const out = formatEntry({ action: 22 });
    expect(out).toContain("(unknown time)");
    expect(out).toContain("unknown actor");
    expect(out).toContain("(no target)");
    expect(out).toContain("no reason");
  });

  it("truncates long reasons at 80 chars + ellipsis", () => {
    const longReason = "x".repeat(200);
    const out = formatEntry(makeEntry({ reason: longReason }));
    // The reason segment should be 77 chars + …
    expect(out).toMatch(/x{77}…/);
    expect(out).not.toMatch(/x{80}/);
  });

  it("handles target with name (channel/role) instead of tag", () => {
    const out = formatEntry(makeEntry({
      target: { name: "general", id: "300" },
      action: 12, // channel delete
    }));
    expect(out).toContain("general");
    expect(out).toContain("channel delete");
  });

  it("uses mention when target has id but no name/tag", () => {
    const out = formatEntry(makeEntry({
      target: { id: "999" },
    }));
    expect(out).toContain("<@999>");
  });
});

describe("auditFormat.joinEntries", () => {
  it("returns empty value for empty list", () => {
    const r = joinEntries([]);
    expect(r.value).toBe("");
    expect(r.shown).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("joins all entries when under limit", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ reason: `r${i}` })
    );
    const r = joinEntries(entries);
    expect(r.shown).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.value.split("\n")).toHaveLength(5);
  });

  it("trims oldest (tail) entries to fit 1024 chars", () => {
    // Each entry is roughly ~100 chars formatted. 30 entries ≈ 3000 chars.
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ reason: `reason number ${i} with extra text to push the size up` })
    );
    const r = joinEntries(entries);
    expect(r.value.length).toBeLessThanOrEqual(1024);
    expect(r.shown).toBeLessThan(30);
    expect(r.truncated).toBe(true);
  });

  it("hard-truncates a single oversized entry", () => {
    const huge = makeEntry({ reason: "x".repeat(80) }); // formatEntry will truncate reason
    // Force a long entry by stuffing actor name (no truncation on actor)
    const massive = makeEntry({
      executor: { tag: "y".repeat(2000), id: "1" },
    });
    const r = joinEntries([massive]);
    expect(r.value.length).toBeLessThanOrEqual(1024);
    expect(r.shown).toBe(1);
  });
});
