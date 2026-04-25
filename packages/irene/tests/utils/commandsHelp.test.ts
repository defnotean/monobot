import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { formatCommandLine, buildCommandsContext, __internals } from "../../utils/commandsHelp.js";

function fakeCommand(name: string, description = "") {
  return { data: { name, description } };
}

describe("commandsHelp.formatCommandLine", () => {
  it("formats name + description", () => {
    expect(formatCommandLine("ping", fakeCommand("ping", "Check bot latency"))).toBe("/ping — Check bot latency");
  });

  it("falls back to just slash-name when description is empty", () => {
    expect(formatCommandLine("ping", fakeCommand("ping", ""))).toBe("/ping");
    expect(formatCommandLine("ping", fakeCommand("ping"))).toBe("/ping");
  });

  it("truncates very long descriptions", () => {
    const long = "x".repeat(200);
    const out = formatCommandLine("ping", fakeCommand("ping", long));
    // Should fit within MAX + framing
    expect(out.length).toBeLessThan(__internals.MAX_DESCRIPTION_CHARS + 30);
  });

  it("handles a missing command object gracefully", () => {
    expect(formatCommandLine("ping", null as any)).toBe("/ping");
    expect(formatCommandLine("ping", undefined as any)).toBe("/ping");
    expect(formatCommandLine("ping", {} as any)).toBe("/ping");
  });
});

describe("commandsHelp.buildCommandsContext", () => {
  it("returns empty string for no input", () => {
    expect(buildCommandsContext(null as any)).toBe("");
    expect(buildCommandsContext(undefined as any)).toBe("");
    expect(buildCommandsContext(new Map())).toBe("");
  });

  it("builds a block with all commands listed", () => {
    const commands = new Map<string, any>([
      ["ping", fakeCommand("ping", "Check latency")],
      ["help", fakeCommand("help", "Show help")],
      ["rules", fakeCommand("rules", "Manage server rules")],
    ]);
    const block = buildCommandsContext(commands);
    expect(block).toContain("/ping");
    expect(block).toContain("/help");
    expect(block).toContain("/rules");
    expect(block).toContain("YOUR SLASH COMMANDS");
    expect(block).toContain("DO NOT invent commands");
  });

  it("sorts commands alphabetically", () => {
    const commands = new Map<string, any>([
      ["zebra", fakeCommand("zebra", "")],
      ["alpha", fakeCommand("alpha", "")],
      ["mike", fakeCommand("mike", "")],
    ]);
    const block = buildCommandsContext(commands);
    const idxAlpha = block.indexOf("/alpha");
    const idxMike = block.indexOf("/mike");
    const idxZebra = block.indexOf("/zebra");
    expect(idxAlpha).toBeLessThan(idxMike);
    expect(idxMike).toBeLessThan(idxZebra);
  });

  it("works with a Map-shaped iterable that has .entries()", () => {
    const fake = {
      entries: () => [
        ["a", fakeCommand("a", "")],
        ["b", fakeCommand("b", "")],
      ][Symbol.iterator](),
    };
    expect(buildCommandsContext(fake as any)).toContain("/a");
  });

  it("handles commands missing data gracefully", () => {
    const commands = new Map<string, any>([
      ["broken", { /* no .data */ }],
      ["ok", fakeCommand("ok", "fine"),],
    ]);
    const block = buildCommandsContext(commands);
    expect(block).toContain("/broken");
    expect(block).toContain("/ok");
  });
});
