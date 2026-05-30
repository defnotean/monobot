// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  splitMessage,
  stripLeakedToolSyntax,
  resolveAtMentions,
  enforceCharBudget,
} from "../../../events/messageCreate/responsePostProcess.js";
// @ts-expect-error JS helper, no types
import { makeGuild, makeMember, makeUser, makeClient, Collection } from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("responsePostProcess / splitMessage", () => {
  it("returns the text as a single chunk when under the limit", () => {
    expect(splitMessage("short", 2000)).toEqual(["short"]);
  });

  it("splits long text into chunks each within the limit", () => {
    const text = ("word ".repeat(1000)).trim(); // ~5000 chars
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    // No text lost (modulo whitespace collapsed at split points).
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text);
  });

  it("cuts at a word boundary when the space sits past 75% of the limit", () => {
    // Space at index 90, limit 100 → 90 > 75 so the cut lands on the space.
    const a = "a".repeat(90);
    const b = "b".repeat(90);
    const chunks = splitMessage(`${a} ${b}`, 100);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it("hard-cuts at the limit when the nearest space is before 75% of the limit", () => {
    // Space at index 50 (< 75% of 100) → no usable boundary, cut at 100.
    const a = "a".repeat(50);
    const b = "b".repeat(100);
    const chunks = splitMessage(`${a} ${b}`, 100);
    expect(chunks[0].length).toBe(100);
    expect(chunks[0].startsWith(a + " b")).toBe(true);
  });
});

describe("responsePostProcess / stripLeakedToolSyntax", () => {
  it("removes a leaked function-call line", () => {
    expect(stripLeakedToolSyntax('send_gif(query="cat")')).toBe("");
  });

  it("strips <tool_code> blocks but keeps surrounding prose", () => {
    const out = stripLeakedToolSyntax("hi there\n<tool_code>foo()</tool_code>");
    expect(out).toContain("hi there");
    expect(out).not.toContain("tool_code");
  });

  it("strips bracket-style tool-call markers", () => {
    const out = stripLeakedToolSyntax('[tool call: web_search]{"q":"x"}\nresult text');
    expect(out).not.toMatch(/tool call/i);
    expect(out).toContain("result text");
  });

  it("strips leaked [Irene said] / [Eris said] context labels", () => {
    const out = stripLeakedToolSyntax("[Irene said] hello [Eris said] hi");
    expect(out).not.toMatch(/said/i);
  });

  it("leaves clean prose untouched", () => {
    expect(stripLeakedToolSyntax("just a normal reply")).toBe("just a normal reply");
  });
});

describe("responsePostProcess / resolveAtMentions", () => {
  function guildWithMembers(members) {
    const client = makeClient({ user: makeUser({ id: "SELF" }) });
    const guild = makeGuild({ id: "g1" });
    guild.client = client;
    guild.members.cache = new Collection();
    for (const m of members) guild.members.cache.set(m.id, m);
    return guild;
  }

  it("returns content unchanged when there is no guild (DM)", () => {
    expect(resolveAtMentions("@bob hi", null, "")).toBe("@bob hi");
  });

  it("converts @username to a Discord ping", () => {
    const bob = makeMember({ user: makeUser({ id: "B", username: "bob" }) });
    bob.displayName = "bob";
    const guild = guildWithMembers([bob]);
    expect(resolveAtMentions("hey @bob", guild)).toBe("hey <@B>");
  });

  it("leaves @name as plain text for a self-mention (avoids self-ping)", () => {
    const self = makeMember({ user: makeUser({ id: "SELF", username: "irene" }) });
    self.displayName = "irene";
    const guild = guildWithMembers([self]);
    expect(resolveAtMentions("thanks @irene", guild)).toBe("thanks irene");
  });

  it("leaves an unknown @handle untouched", () => {
    const guild = guildWithMembers([]);
    expect(resolveAtMentions("yo @ghost", guild)).toBe("yo @ghost");
  });
});

describe("responsePostProcess / enforceCharBudget", () => {
  it("returns the text unchanged when no budget is given", () => {
    expect(enforceCharBudget("anything", 0)).toBe("anything");
  });

  it("returns the text unchanged when within budget", () => {
    expect(enforceCharBudget("short", 100)).toBe("short");
  });

  it("returns text unchanged when within the 1.2x grace window", () => {
    const text = "a".repeat(110); // budget 100, grace 120
    expect(enforceCharBudget(text, 100)).toBe(text);
  });

  it("trims to the last sentence boundary when over budget+grace", () => {
    // The terminator ". " sits at index 35, comfortably past budget*0.4 (=32),
    // so the sentence-boundary branch fires and trims to the full sentence.
    const text = "First sentence is a bit longer here. " + "x".repeat(200);
    expect(enforceCharBudget(text, 80)).toBe("First sentence is a bit longer here.");
  });

  it("falls back to a word-boundary cut when no sentence boundary exists", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const out = enforceCharBudget(text, 20);
    expect(out).toBe("alpha beta gamma");
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(" ")).toBe(false); // trimmed
  });
});
