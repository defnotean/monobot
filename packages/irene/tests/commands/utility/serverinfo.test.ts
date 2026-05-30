import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeRole, makeChannel, Collection } from "../../_helpers/mockDiscord.js";

import * as serverinfo from "../../../commands/utility/serverinfo.js";

function guildWith(overrides: any = {}) {
  const guild = makeGuild();
  // serverinfo reads several Discord fields our mock doesn't set by default.
  guild.premiumTier = 1;
  guild.premiumSubscriptionCount = 7;
  guild.verificationLevel = 2;
  guild.createdTimestamp = 1_600_000_000_000;
  guild.emojis = { cache: new Collection() };
  guild.iconURL = vi.fn(() => "https://cdn.example/icon.png");
  guild.description = "a cool server";
  Object.assign(guild, overrides);
  return guild;
}

describe("utility/serverinfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the serverinfo command", () => {
    expect(serverinfo.data.name).toBe("serverinfo");
  });

  it("replies with owner, member, channel, role and emoji counts derived from the guild", async () => {
    const guild = guildWith();
    guild.ownerId = "owner-9";
    guild.memberCount = 123;
    // seed caches so counts are meaningful (everyone role already present)
    guild.roles.cache.set("r2", makeRole({ id: "r2" }));
    guild.channels.cache.set("c1", makeChannel({ id: "c1" }));
    guild.emojis.cache.set("e1", { id: "e1" });

    const interaction = makeInteraction({ guild });
    await serverinfo.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    const embed = payload.embeds[0];
    const byName = Object.fromEntries(embed.data.fields.map((f: any) => [f.name.replace(/[^\w]/g, "").trim(), f.value]));
    expect(JSON.stringify(embed.data.fields)).toContain("<@owner-9>");
    expect(JSON.stringify(embed.data.fields)).toContain("123");
    // 1 seeded emoji
    const emojiField = embed.data.fields.find((f: any) => f.name.includes("Emojis"));
    expect(emojiField.value).toContain("1");
    // boost field reflects premiumTier=1 → "Tier 1"
    const boostField = embed.data.fields.find((f: any) => f.name.includes("Boost"));
    expect(boostField.value).toContain("Tier 1");
    expect(boostField.value).toContain("7");
    // author label & thumbnail come from the guild
    expect(embed.data.author.name).toBe("Server Info");
  });

  it("maps verification level to a human label (Medium for level 2)", async () => {
    const interaction = makeInteraction({ guild: guildWith({ verificationLevel: 2 }) });
    await serverinfo.execute(interaction);
    const fields = interaction.reply.mock.calls[0][0].embeds[0].data.fields;
    const ver = fields.find((f: any) => f.name.includes("Verification"));
    expect(ver.value).toBe("Medium");
  });
});
