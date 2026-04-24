import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { parseDuration } from "../../../commands/context/remindme.js";

describe("remindme.parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("45sec")).toBe(45_000);
    expect(parseDuration("10secs")).toBe(10_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(5 * 60_000);
    expect(parseDuration("15min")).toBe(15 * 60_000);
    expect(parseDuration("2mins")).toBe(2 * 60_000);
  });

  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2hr")).toBe(2 * 3_600_000);
    expect(parseDuration("3hrs")).toBe(3 * 3_600_000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2day")).toBe(2 * 86_400_000);
    expect(parseDuration("7days")).toBe(7 * 86_400_000);
  });

  it("parses weeks", () => {
    expect(parseDuration("1w")).toBe(7 * 86_400_000);
    expect(parseDuration("2wk")).toBe(14 * 86_400_000);
    expect(parseDuration("3wks")).toBe(21 * 86_400_000);
  });

  it("is case-insensitive", () => {
    expect(parseDuration("5M")).toBe(5 * 60_000);
    expect(parseDuration("1H")).toBe(3_600_000);
    expect(parseDuration("2D")).toBe(2 * 86_400_000);
  });

  it("strips whitespace", () => {
    expect(parseDuration(" 5m ")).toBe(5 * 60_000);
    expect(parseDuration("1 h")).toBe(3_600_000);
  });

  it("accepts decimals", () => {
    expect(parseDuration("1.5h")).toBe(1.5 * 3_600_000);
    expect(parseDuration("0.5d")).toBe(0.5 * 86_400_000);
  });

  it("rejects invalid formats", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("5")).toBeNull();
    expect(parseDuration("m")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("5minutes")).toBeNull(); // "minutes" is too long, we accept "min"/"mins"
    expect(parseDuration("5x")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration(null as any)).toBeNull();
    expect(parseDuration(undefined as any)).toBeNull();
    expect(parseDuration(42 as any)).toBeNull();
  });

  it("rejects sub-10-second durations (MIN_MS)", () => {
    expect(parseDuration("5s")).toBeNull();
    expect(parseDuration("9s")).toBeNull();
    expect(parseDuration("10s")).toBe(10_000); // boundary allowed
  });

  it("rejects durations over 365 days (MAX_MS)", () => {
    expect(parseDuration("366d")).toBeNull();
    expect(parseDuration("1000d")).toBeNull();
    expect(parseDuration("365d")).toBe(365 * 86_400_000); // boundary allowed
  });

  it("rejects zero", () => {
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
  });
});
