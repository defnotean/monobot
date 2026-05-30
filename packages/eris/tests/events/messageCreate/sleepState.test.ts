import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { shiftMoodSpy, logSpy } = vi.hoisted(() => ({
  shiftMoodSpy: vi.fn(),
  logSpy: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  shiftMood: shiftMoodSpy,
}));
vi.mock("../../../utils/logger.js", () => ({ log: logSpy }));
vi.mock("../../../events/messageCreate/constants.js", () => ({
  NAP_DURATION_MS: 10 * 60_000,
  SLEEP_DURATION_MS: 30 * 60_000,
}));

import {
  triggerSleep,
  isSleeping,
  wakeSleep,
  // @ts-expect-error - importing JS module without types
} from "../../../events/messageCreate/sleepState.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  shiftMoodSpy.mockReset();
  logSpy.mockReset();
  wakeSleep(); // reset module state to awake before each test
  shiftMoodSpy.mockReset();
  logSpy.mockReset();
});

afterEach(() => {
  wakeSleep();
  vi.useRealTimers();
});

describe("sleepState.triggerSleep (full sleep)", () => {
  it("marks sleeping for the 30-minute window and restores big energy", () => {
    triggerSleep(false);
    expect(isSleeping()).toBe(true);
    expect(shiftMoodSpy).toHaveBeenCalledWith(10, 50); // +50 energy on full sleep
  });

  it("expires exactly at the 30-minute boundary", () => {
    triggerSleep(false);
    vi.setSystemTime(30 * 60_000 - 1);
    expect(isSleeping()).toBe(true);
    vi.setSystemTime(30 * 60_000);
    expect(isSleeping()).toBe(false); // Date.now() < ts is now false
  });
});

describe("sleepState.triggerSleep (nap)", () => {
  it("marks sleeping for the shorter 10-minute window and gives the nap mood boost", () => {
    triggerSleep(true);
    expect(isSleeping()).toBe(true);
    expect(shiftMoodSpy).toHaveBeenCalledWith(15, 35); // nap boost
    // Past nap window but still inside a full-sleep window -> proves nap is shorter.
    vi.setSystemTime(10 * 60_000);
    expect(isSleeping()).toBe(false);
  });
});

describe("sleepState.isSleeping", () => {
  it("is false before any sleep is triggered", () => {
    expect(isSleeping()).toBe(false);
  });
});

describe("sleepState.wakeSleep", () => {
  it("ends sleep immediately, before the timeout", () => {
    triggerSleep(false);
    expect(isSleeping()).toBe(true);
    wakeSleep();
    expect(isSleeping()).toBe(false);
  });

  it("logs whether it woke from a nap or a full sleep", () => {
    triggerSleep(true);
    logSpy.mockClear();
    wakeSleep();
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toMatch(/woke up from nap/i);

    triggerSleep(false);
    logSpy.mockClear();
    wakeSleep();
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toMatch(/woke up from sleep/i);
  });
});
