import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { preFilter, buildJudgePrompt, parseJudgeResponse } from "../../ai/rulesDetector.js";

describe("rulesDetector.preFilter", () => {
  it("returns null for empty / null / non-string input", () => {
    expect(preFilter("")).toBeNull();
    expect(preFilter(null as any)).toBeNull();
    expect(preFilter(undefined as any)).toBeNull();
    expect(preFilter(42 as any)).toBeNull();
  });

  it("returns null for benign messages", () => {
    expect(preFilter("hello, how are you?")).toBeNull();
    expect(preFilter("the soup is delicious")).toBeNull();
    expect(preFilter("I want to crack Mike Wazowski")).toBeNull(); // gross banter, not a trigger
    expect(preFilter("R Kelly has a bbc")).toBeNull(); // edgy joke, not a trigger
    expect(preFilter("she is iconic")).toBeNull();
  });

  it("trips on NSFW patterns from the example chat", () => {
    expect(preFilter("u did this.. i am now blowing loads")).toBe("nsfw");
    expect(preFilter("WE'D all lick dookie off her toes")).toBe("nsfw");
    expect(preFilter("feet = yummy")).toBe("nsfw");
    expect(preFilter("i would def lick latina toes")).toBe("nsfw"); // matches "lick … toes"
  });

  it("trips on hate slurs", () => {
    expect(preFilter("just a casual sentence with the n-word lol")).toBeNull(); // doesn't say it
    expect(preFilter("you fucking faggot")).toBe("hate");
    expect(preFilter("retarded behavior tbh")).toBe("hate");
  });

  it("trips on threats", () => {
    expect(preFilter("kys")).toBe("threat");
    expect(preFilter("Kill yourself")).toBe("threat");
    expect(preFilter("i'll kill you")).toBe("threat");
    expect(preFilter("going to murder him")).toBe("threat");
  });

  it("is case-insensitive", () => {
    expect(preFilter("KILL YOURSELF")).toBe("threat");
    expect(preFilter("Blowing Loads")).toBe("nsfw");
  });

  it("does not trip on benign sentences containing similar words", () => {
    expect(preFilter("i love my feet")).toBeNull(); // not "feet = yummy" pattern
    expect(preFilter("my mom said kill the lights")).toBeNull(); // not "kill yourself"
    expect(preFilter("I'm going to kill it at this exam")).toBeNull(); // not directed at a person
  });
});

describe("rulesDetector.buildJudgePrompt", () => {
  const sampleRules = [
    { number: 1, text: "follow Discord ToS & guidelines", severity: "high" },
    { number: 2, text: "no nsfw or gore", severity: "high" },
    { number: 4, text: "talk shit not hate. banter ok, slurs/harassment not", severity: "medium" },
  ];

  it("includes all rules with numbers, severity, and text", () => {
    const p = buildJudgePrompt(sampleRules, { author: "alice", content: "hi" }, []);
    expect(p).toContain("1. [high] follow Discord ToS");
    expect(p).toContain("2. [high] no nsfw or gore");
    expect(p).toContain("4. [medium] talk shit not hate");
  });

  it("includes the message under review with author", () => {
    const p = buildJudgePrompt(sampleRules, { author: "bob", content: "say something" }, []);
    expect(p).toContain("from bob");
    expect(p).toContain("say something");
  });

  it("includes context messages chronologically (last 8)", () => {
    const ctx = Array.from({ length: 12 }, (_, i) => ({
      author: `u${i}`, content: `msg ${i}`,
    }));
    const p = buildJudgePrompt(sampleRules, { author: "x", content: "y" }, ctx);
    // Should include msgs 4-11 (last 8), not 0-3
    expect(p).toContain("msg 4");
    expect(p).toContain("msg 11");
    expect(p).not.toContain("msg 3");
    expect(p).not.toContain("msg 0");
  });

  it("handles empty context gracefully", () => {
    const p = buildJudgePrompt(sampleRules, { author: "x", content: "y" }, []);
    expect(p).toContain("(no prior context)");
  });

  it("instructs the model to bias conservative", () => {
    const p = buildJudgePrompt(sampleRules, { author: "x", content: "y" }, []);
    expect(p.toLowerCase()).toMatch(/conservative|joking|banter/);
    expect(p.toLowerCase()).toMatch(/clearly_violates|joking_banter|ambiguous/);
  });

  it("sorts rules by number even if input is unsorted", () => {
    const out = buildJudgePrompt(
      [{ number: 5, text: "fifth", severity: "low" }, { number: 1, text: "first", severity: "low" }],
      { author: "x", content: "y" }, []
    );
    const idxFirst = out.indexOf("first");
    const idxFifth = out.indexOf("fifth");
    expect(idxFirst).toBeLessThan(idxFifth);
  });
});

describe("rulesDetector.parseJudgeResponse", () => {
  it("parses a clean JSON response", () => {
    const r = parseJudgeResponse('{"classification":"clearly_violates","rule_number":2,"severity":"high","explanation":"explicit nsfw"}');
    expect(r).toEqual({
      classification: "clearly_violates",
      ruleNumber: 2,
      severity: "high",
      explanation: "explicit nsfw",
    });
  });

  it("strips markdown code fences", () => {
    const r = parseJudgeResponse("```json\n{\"classification\":\"joking_banter\",\"rule_number\":null,\"severity\":null,\"explanation\":\"just friends bantering\"}\n```");
    expect(r?.classification).toBe("joking_banter");
  });

  it("handles preamble text before JSON", () => {
    const r = parseJudgeResponse('Sure! Here is the analysis: {"classification":"ambiguous","rule_number":null,"severity":null,"explanation":"could go either way"}');
    expect(r?.classification).toBe("ambiguous");
  });

  it("returns null on invalid JSON", () => {
    expect(parseJudgeResponse("not json at all")).toBeNull();
    expect(parseJudgeResponse("{")).toBeNull();
    expect(parseJudgeResponse("")).toBeNull();
  });

  it("returns null on unrecognized classification", () => {
    expect(parseJudgeResponse('{"classification":"weird","rule_number":1,"severity":"low","explanation":"x"}')).toBeNull();
  });

  it("returns null on non-string input", () => {
    expect(parseJudgeResponse(null as any)).toBeNull();
    expect(parseJudgeResponse(undefined as any)).toBeNull();
    expect(parseJudgeResponse(42 as any)).toBeNull();
  });

  it("coerces non-integer rule_number to null", () => {
    const r = parseJudgeResponse('{"classification":"clearly_violates","rule_number":"2","severity":"high","explanation":"x"}');
    expect(r?.ruleNumber).toBeNull();
  });

  it("coerces invalid severity to null", () => {
    const r = parseJudgeResponse('{"classification":"clearly_violates","rule_number":1,"severity":"extreme","explanation":"x"}');
    expect(r?.severity).toBeNull();
  });
});
