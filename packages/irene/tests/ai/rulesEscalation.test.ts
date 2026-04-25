import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { decideAction, TIMEOUT_LADDER_MS } from "../../ai/rulesEscalation.js";

describe("rulesEscalation.decideAction — first-offense handling per severity", () => {
  it("low severity, first offense → log_only (no action)", () => {
    const a = decideAction({ severity: "low", priorOffenses: 0, ruleNumber: 5, ruleText: "english only" });
    expect(a.kind).toBe("log_only");
    expect(a.deleteMessage).toBe(false);
    expect(a.timeoutMs).toBe(0);
  });

  it("medium severity, first offense → warn (delete + DM)", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 0, ruleNumber: 4, ruleText: "no harassment" });
    expect(a.kind).toBe("warn");
    expect(a.deleteMessage).toBe(true);
    expect(a.timeoutMs).toBe(0);
  });

  it("high severity, first offense → 10m timeout (skip warn step)", () => {
    const a = decideAction({ severity: "high", priorOffenses: 0, ruleNumber: 2, ruleText: "no nsfw" });
    expect(a.kind).toBe("delete_and_timeout");
    expect(a.deleteMessage).toBe(true);
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[0]);
  });
});

describe("rulesEscalation.decideAction — repeat-offender ladder", () => {
  it("medium, second offense → 10m timeout (ladder[0])", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 1, ruleNumber: 4 });
    expect(a.kind).toBe("delete_and_timeout");
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[0]);
  });

  it("medium, third offense → 1h", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 2, ruleNumber: 4 });
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[1]);
  });

  it("medium, fourth offense → 6h", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 3, ruleNumber: 4 });
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[2]);
  });

  it("medium, fifth offense → 24h", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 4, ruleNumber: 4 });
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[3]);
  });

  it("medium, 100th offense → still capped at 24h (no auto-ban)", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 100, ruleNumber: 4 });
    expect(a.kind).toBe("delete_and_timeout");
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[TIMEOUT_LADDER_MS.length - 1]);
    // Critical: never returns "ban" — auto-bans are off the table
    expect((a as any).kind).not.toBe("ban");
  });
});

describe("rulesEscalation.decideAction — high-severity skips one step", () => {
  it("high, 0 priors → 10m (vs medium 0 priors which would warn)", () => {
    const high = decideAction({ severity: "high", priorOffenses: 0 });
    const med = decideAction({ severity: "medium", priorOffenses: 0 });
    expect(high.kind).toBe("delete_and_timeout");
    expect(med.kind).toBe("warn");
  });

  it("high, 1 prior → 1h (one step ahead of medium 1 prior at 10m)", () => {
    const high = decideAction({ severity: "high", priorOffenses: 1 });
    const med = decideAction({ severity: "medium", priorOffenses: 1 });
    expect(high.timeoutMs).toBe(TIMEOUT_LADDER_MS[1]);
    expect(med.timeoutMs).toBe(TIMEOUT_LADDER_MS[0]);
  });
});

describe("rulesEscalation.decideAction — low-severity is gentler", () => {
  it("low, 1 prior → warn (would be timeout for medium)", () => {
    const a = decideAction({ severity: "low", priorOffenses: 1 });
    expect(a.kind).toBe("warn");
  });

  it("low, 2 priors → 10m (medium would be at 1h)", () => {
    const a = decideAction({ severity: "low", priorOffenses: 2 });
    expect(a.kind).toBe("delete_and_timeout");
    expect(a.timeoutMs).toBe(TIMEOUT_LADDER_MS[0]);
  });
});

describe("rulesEscalation.decideAction — reason field", () => {
  it("includes the rule number in the reason", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 0, ruleNumber: 7, ruleText: "be nice" });
    expect(a.reason).toContain("7");
  });

  it("truncates very long rule text", () => {
    const longRule = "x".repeat(500);
    const a = decideAction({ severity: "medium", priorOffenses: 0, ruleNumber: 1, ruleText: longRule });
    // Should fit reason within the 100-char rule slice + framing
    expect(a.reason.length).toBeLessThan(200);
    expect(a.reason).toContain("…");
  });

  it("annotates offense count for repeat offenders", () => {
    const a = decideAction({ severity: "medium", priorOffenses: 2, ruleNumber: 1 });
    expect(a.reason).toContain("offense 3"); // priorOffenses=2 + 1 = 3rd offense
  });
});
