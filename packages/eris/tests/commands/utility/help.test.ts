import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config.js", () => ({
  default: { colors: { primary: 0x9333ea }, geminiModel: "gemini-test-model" },
}));

import { makeInteraction, getLastReply } from "../../_helpers/mockDiscord.js";
import { execute } from "../../../commands/utility/help.js";

describe("help command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies with an embed listing the capability categories", async () => {
    const interaction: any = makeInteraction();
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const data = getLastReply(interaction)?.payload.embeds[0].data;
    expect(data.title).toBe("Eris");

    const names = data.fields.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(["chat", "tools", "memory", "owner tools"]));
    expect(data.color).toBe(0x9333ea);
  });
});
