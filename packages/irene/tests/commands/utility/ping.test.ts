import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeClient } from "../../_helpers/mockDiscord.js";

import * as ping from "../../../commands/utility/ping.js";

describe("utility/ping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the ping slash command", () => {
    expect(ping.data.name).toBe("ping");
  });

  it("posts 'Pinging...' then edits with latency fields and a 🟢 status when API ping < 100", async () => {
    const client = makeClient();
    client.ws.ping = 42; // < 100 → Excellent
    const interaction = makeInteraction({ client });

    // fetchReply must return a message with a timestamp slightly after the interaction
    const replyTs = interaction.createdTimestamp + 25;
    interaction.fetchReply = vi.fn(async () => ({ createdTimestamp: replyTs }));

    await ping.execute(interaction);

    // First a placeholder content reply, then an edit with the embed.
    expect(interaction.reply).toHaveBeenCalledWith({ content: "Pinging..." });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);

    const edit = interaction.editReply.mock.calls[0][0];
    expect(edit.content).toBeNull();
    const fields = edit.embeds[0].data.fields;
    const byName = Object.fromEntries(fields.map((f: any) => [f.name, f.value]));
    expect(byName["API Latency"]).toContain("42ms");
    expect(byName["Response Time"]).toContain("25ms");
    expect(byName["Status"]).toContain("🟢");
  });

  it("reports 🟡 Good for mid latency and 🔴 Poor for high latency", async () => {
    for (const [pingMs, marker] of [[150, "🟡"], [400, "🔴"]] as const) {
      const client = makeClient();
      client.ws.ping = pingMs;
      const interaction = makeInteraction({ client });
      interaction.fetchReply = vi.fn(async () => ({ createdTimestamp: interaction.createdTimestamp }));

      await ping.execute(interaction);

      const edit = interaction.editReply.mock.calls[0][0];
      const status = edit.embeds[0].data.fields.find((f: any) => f.name === "Status").value;
      expect(status).toContain(marker);
    }
  });
});
