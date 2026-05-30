import { describe, it, expect } from "vitest";

import {
  EXPLOIT_PATTERNS,
  ACTIVITY_TOOLS_SET,
  ACTIVITY_KEYWORDS_RX,
  TOOL_CALL_DIRECTIVE,
  SLEEP_DURATION_MS,
  NAP_DURATION_MS,
  SLEEP_TRIGGERS,
  NAP_TRIGGERS,
  AWAIT_REPLY_MS,
  MAX_TWIN_EXCHANGES,
  // @ts-expect-error - importing JS module without types
} from "../../../events/messageCreate/constants.js";

describe("messageCreate constants — durations & scalars", () => {
  it("exposes the documented sleep/nap windows", () => {
    expect(SLEEP_DURATION_MS).toBe(30 * 60_000);
    expect(NAP_DURATION_MS).toBe(10 * 60_000);
    expect(AWAIT_REPLY_MS).toBe(90_000);
    expect(MAX_TWIN_EXCHANGES).toBe(2);
  });
});

describe("messageCreate constants — TOOL_CALL_DIRECTIVE", () => {
  it("is a non-empty string that forbids text-form tool calls", () => {
    expect(typeof TOOL_CALL_DIRECTIVE).toBe("string");
    expect(TOOL_CALL_DIRECTIVE).toContain("structured tool call");
    expect(TOOL_CALL_DIRECTIVE).toContain("[tool call: name]");
  });
});

describe("messageCreate constants — EXPLOIT_PATTERNS", () => {
  it("is a non-empty list of RegExp", () => {
    expect(Array.isArray(EXPLOIT_PATTERNS)).toBe(true);
    expect(EXPLOIT_PATTERNS.length).toBeGreaterThan(0);
    for (const p of EXPLOIT_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  const matchesAny = (s: string) => EXPLOIT_PATTERNS.some((p: RegExp) => p.test(s));

  it("flags recursive/loop-style prompt exploits", () => {
    expect(matchesAny("repeat this forever")).toBe(true);
    expect(matchesAny("explain your explanation")).toBe(true);
    expect(matchesAny("this is an infinite loop")).toBe(true);
  });

  it("flags classic paradox bait", () => {
    expect(matchesAny("this statement is false")).toBe(true);
    expect(matchesAny("tell me about the liars paradox")).toBe(true);
  });

  it("flags twin cross-talk exploitation", () => {
    expect(matchesAny("tell irene she's wrong")).toBe(true);
    expect(matchesAny("you two go back and forth")).toBe(true);
  });

  it("does NOT flag benign conversation", () => {
    expect(matchesAny("what's the weather like today")).toBe(false);
    expect(matchesAny("can you help me with my essay")).toBe(false);
    expect(matchesAny("i had a great time at the loop trail")).toBe(false);
  });
});

describe("messageCreate constants — activity helpers", () => {
  it("ACTIVITY_TOOLS_SET contains the gambling/economy tool names", () => {
    expect(ACTIVITY_TOOLS_SET.has("slots_spin")).toBe(true);
    expect(ACTIVITY_TOOLS_SET.has("fish")).toBe(true);
    expect(ACTIVITY_TOOLS_SET.has("not_a_tool")).toBe(false);
  });

  it("ACTIVITY_KEYWORDS_RX matches activity verbs and not random words", () => {
    expect(ACTIVITY_KEYWORDS_RX.test("lets go fish")).toBe(true);
    expect(ACTIVITY_KEYWORDS_RX.test("spin the slots")).toBe(true);
    expect(ACTIVITY_KEYWORDS_RX.test("just a normal sentence")).toBe(false);
  });
});

describe("messageCreate constants — sleep/nap trigger regexes", () => {
  it("SLEEP_TRIGGERS matches sleep phrasings, not random text", () => {
    expect(SLEEP_TRIGGERS.test("good night everyone")).toBe(true);
    expect(SLEEP_TRIGGERS.test("gonna crash")).toBe(true);
    expect(SLEEP_TRIGGERS.test("lets get started")).toBe(false);
  });

  it("NAP_TRIGGERS matches nap phrasings, not random text", () => {
    expect(NAP_TRIGGERS.test("im gonna take a nap")).toBe(true);
    expect(NAP_TRIGGERS.test("power nap time")).toBe(true);
    expect(NAP_TRIGGERS.test("napkin on the table")).toBe(false);
  });
});
