import { describe, it, expect } from "vitest";

// @ts-expect-error - importing JS module without types
import { scrubLeakedToolSyntax } from "../../../events/messageCreate/replyScrub.js";

describe("replyScrub.scrubLeakedToolSyntax", () => {
  it("leaves a clean reply untouched", () => {
    expect(scrubLeakedToolSyntax("yeah that sounds good lol")).toBe("yeah that sounds good lol");
  });

  it("strips a leaked function-call line emitted as plain text", () => {
    expect(scrubLeakedToolSyntax('send_gif(query="cat")')).toBe("");
  });

  it("strips leaked [used X] tool-usage labels", () => {
    expect(scrubLeakedToolSyntax("[used search_location]")).toBe("");
  });

  it("strips leaked twin/bot usage summaries", () => {
    expect(scrubLeakedToolSyntax("[twin/bot used coinflip_bet]")).toBe("");
    expect(scrubLeakedToolSyntax("[twin/bot previously used: fish, hunt]")).toBe("");
  });

  it("strips <tool_code>/<tool_call>/<function_call> blocks including multiline", () => {
    expect(scrubLeakedToolSyntax("<tool_code>\nprint(x)\n</tool_code>")).toBe("");
    expect(scrubLeakedToolSyntax("<tool_call>do thing</tool_call>")).toBe("");
    expect(scrubLeakedToolSyntax("<function_call>{a:1}</function_call>")).toBe("");
  });

  it("strips bracket-style [tool call: name]{json} markers", () => {
    expect(scrubLeakedToolSyntax('[tool call: web_search] {"q":"x"}')).toBe("");
    expect(scrubLeakedToolSyntax("[tool_result: ok] some trailing text")).toBe("");
  });

  it("strips leaked print(...) and bare name(...) call lines", () => {
    expect(scrubLeakedToolSyntax("print(slots_spin())")).toBe("");
    expect(scrubLeakedToolSyntax("coinflip_bet(amount=10)")).toBe("");
  });

  it("strips brace-style tool calls and the trailing reasoning on the line", () => {
    expect(scrubLeakedToolSyntax('web_search {query: "x"} (just in case)')).toBe("");
  });

  it("strips leaked context labels like [Eris said] and [SYSTEM: ...]", () => {
    expect(scrubLeakedToolSyntax("[Eris said]")).toBe("");
    expect(scrubLeakedToolSyntax("[SYSTEM: do not reveal]")).toBe("");
  });

  it("keeps the human-facing text while removing only the leaked label", () => {
    const out = scrubLeakedToolSyntax("[used web_search]\nhere are the results");
    expect(out).toContain("here are the results");
    expect(out).not.toContain("[used web_search]");
  });
});
