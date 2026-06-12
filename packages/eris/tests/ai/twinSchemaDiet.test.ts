import { describe, expect, it } from "vitest";

// @ts-expect-error - importing JS modules without types
import { OWNER_TOOLS } from "../../ai/tools.js";
// @ts-expect-error - importing JS module without types
import { normalizeAskIreneArgs } from "../../ai/executors/twinExecutor.js";

const askIrene = OWNER_TOOLS.find((tool: { name: string }) => tool.name === "ask_irene")!;

describe("ask_irene schema diet", () => {
  it("normalizes params-object inputs while preserving flat inputs", () => {
    const flat = { command: "announce", announcement: "hello" };
    expect(normalizeAskIreneArgs(flat)).toEqual(flat);
    expect(normalizeAskIreneArgs({
      command: "announce",
      params: { message: "hello", channel_id: "123" },
    })).toEqual({
      command: "announce",
      message: "hello",
      channel_id: "123",
    });
    expect(normalizeAskIreneArgs({
      command: "nickname",
      params: { target_username: "alice", nickname: "Spark" },
    })).toEqual({
      command: "nickname",
      target_username: "alice",
      nickname: "Spark",
    });
  });

  it("uses one params object instead of per-command flat schema keys", () => {
    expect(askIrene.description.length).toBeLessThanOrEqual(300);
    expect(askIrene.input_schema.properties).toHaveProperty("params");
    expect(askIrene.input_schema.properties).not.toHaveProperty("target_username");
    expect(askIrene.input_schema.properties.command.enum).toContain("purge");
    expect(askIrene.input_schema.properties.params.description).toMatch(/nickname\{target_username,nickname/);
  });
});
