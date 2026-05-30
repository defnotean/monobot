import { describe, it, expect } from "vitest";
import { makeInteraction, makeClient, getReplies } from "../../_helpers/mockDiscord.js";
import { execute } from "../../../commands/utility/ping.js";

describe("ping command", () => {
  it("replies 'pinging...' first, then edits with roundtrip + websocket latency", async () => {
    const interaction: any = makeInteraction({
      client: makeClient({ wsPing: 77 }),
      createdTimestamp: 1000,
    });

    await execute(interaction);

    // First reply is the placeholder.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const replies = getReplies(interaction);
    expect(replies[0].content).toBe("pinging...");

    // fetchReply gives a message with createdTimestamp = interaction.createdTimestamp + 1,
    // so roundtrip is exactly 1ms; websocket comes from client.ws.ping.
    expect(interaction.fetchReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const final = replies[replies.length - 1].content;
    expect(final).toBe("pong — 1ms roundtrip, 77ms websocket");
  });

  it("reads websocket latency from the client", async () => {
    const interaction: any = makeInteraction({ client: makeClient({ wsPing: 5 }) });
    await execute(interaction);
    expect(getReplies(interaction).pop()?.content).toMatch(/5ms websocket/);
  });
});
