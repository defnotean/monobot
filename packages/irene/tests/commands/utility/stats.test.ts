import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeChannel, makeClient, Collection } from "../../_helpers/mockDiscord.js";

import * as stats from "../../../commands/utility/stats.js";

function statsGuild(id: string, channels: any[] = []) {
  const guild = makeGuild({ id });
  guild.premiumTier = 2;
  guild.premiumSubscriptionCount = 4;
  guild.createdAt = new Date("2020-01-01T00:00:00Z");
  guild.icon = "abc";
  guild.iconURL = vi.fn(() => "https://cdn.example/icon.png");
  // members.fetch is awaited; default mock returns null which is fine.
  guild.members.fetch = vi.fn(async () => new Collection());
  for (const c of channels) guild.channels.cache.set(c.id, c);
  return guild;
}

describe("utility/stats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stats.initStatsData({}); // reset ai stats map view (best-effort)
  });

  it("declares the stats command", () => {
    expect(stats.data.name).toBe("stats");
  });

  it("builds a dashboard embed with member, boost, channel, role and uptime fields", async () => {
    const voiceCh = makeChannel({ id: "vc1", name: "Voice", type: 2 });
    voiceCh.isVoiceBased = vi.fn(() => true);
    voiceCh.isTextBased = vi.fn(() => false);
    voiceCh.members = new Collection([["u1", {}], ["u2", {}]]); // 2 in VC

    const guild = statsGuild("guild-stats-A", [voiceCh]);
    guild.memberCount = 50;
    const client = makeClient();
    client.uptime = 1000 * 60 * 60 * 3 + 1000 * 60 * 15; // 3h 15m

    const interaction = makeInteraction({ guild, client });
    await interaction; // no-op, keep async tidy
    await stats.execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0];
    const byName = Object.fromEntries(embed.data.fields.map((f: any) => [f.name, f.value]));
    expect(byName["Members"]).toContain("50 total");
    expect(byName["Boosts"]).toContain("Level 2");
    expect(byName["Boosts"]).toContain("4 boosts");
    expect(byName["Voice Activity"]).toContain("2 users");
    expect(byName["Bot Uptime"]).toBe("3h 15m");
    // ephemeral flag
    expect(interaction.reply.mock.calls[0][0].flags).toBe(64);
  });

  it("identifies the most-active text channel by message count", async () => {
    const quiet = makeChannel({ id: "q", name: "quiet" });
    quiet.isTextBased = vi.fn(() => true);
    quiet.isVoiceBased = vi.fn(() => false);
    quiet.messages.fetch = vi.fn(async () => new Collection([["m1", {}]])); // 1 msg

    const busy = makeChannel({ id: "b", name: "busy" });
    busy.isTextBased = vi.fn(() => true);
    busy.isVoiceBased = vi.fn(() => false);
    busy.messages.fetch = vi.fn(async () => new Collection([["m1", {}], ["m2", {}], ["m3", {}]])); // 3 msgs

    const guild = statsGuild("guild-stats-B", [quiet, busy]);
    const interaction = makeInteraction({ guild });
    await stats.execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0];
    const active = embed.data.fields.find((f: any) => f.name === "Most Active Channel").value;
    expect(active).toBe("#busy");
  });

  it("serves a cached embed on the second call within the TTL (no second members.fetch)", async () => {
    const guild = statsGuild("guild-stats-cache");
    const i1 = makeInteraction({ guild });
    await stats.execute(i1);
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);

    const i2 = makeInteraction({ guild });
    await stats.execute(i2);
    // cache hit → members.fetch not called again
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(i2.reply).toHaveBeenCalled();
  });

  it("trackAiMessage increments today's AI count surfaced by getAiStats", () => {
    const before = stats.getAiStats("guild-ai").count;
    stats.trackAiMessage("guild-ai");
    stats.trackAiMessage("guild-ai");
    expect(stats.getAiStats("guild-ai").count).toBe(before + 2);
  });
});
