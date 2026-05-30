import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config.js", () => ({
  default: { colors: { primary: 0x9333ea }, geminiModel: "gemini-test-model" },
}));

import { makeInteraction, makeClient, makeGuild, getLastReply } from "../../_helpers/mockDiscord.js";
import { execute } from "../../../commands/utility/about.js";

describe("about command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies with an embed exposing guild count and configured model", async () => {
    const client = makeClient({ guilds: [makeGuild(), makeGuild(), makeGuild()] });
    const interaction: any = makeInteraction({ client });

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = getLastReply(interaction)?.payload;
    expect(payload.embeds).toHaveLength(1);
    const data = payload.embeds[0].data;
    expect(data.title).toMatch(/Eris/);

    // guild count field must reflect the client's cached guild count (3).
    const guildField = data.fields.find((f: any) => f.name === "guilds");
    expect(guildField.value).toBe("3");

    // model field must come from config.geminiModel (mocked).
    const modelField = data.fields.find((f: any) => f.name === "model");
    expect(modelField.value).toBe("gemini-test-model");
  });

  it("includes uptime and memory fields", async () => {
    const interaction: any = makeInteraction();
    await execute(interaction);
    const data = getLastReply(interaction)?.payload.embeds[0].data;
    const names = data.fields.map((f: any) => f.name);
    expect(names).toContain("uptime");
    expect(names).toContain("memory");
  });
});
