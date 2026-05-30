import { describe, it, expect } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeClient, makeUser, makeGuild, lastReply, repliedText, Collection } from "../../_helpers/mockDiscord.js";

import * as aboutCmd from "../../../commands/utility/about.js";

function lastEmbed(interaction: any) {
  const p = lastReply(interaction);
  return p.embeds[0].data ?? p.embeds[0];
}
function field(embed: any, name: string) {
  return embed.fields.find((f: any) => f.name.includes(name))?.value;
}

describe("utility/about", () => {
  it("aggregates server / user / command counts across the client caches", async () => {
    const guilds = new Collection();
    guilds.set("g1", makeGuild({ id: "g1", members: [] }));
    guilds.get("g1").memberCount = 10;
    guilds.set("g2", makeGuild({ id: "g2", members: [] }));
    guilds.get("g2").memberCount = 25;

    const commands = new Collection();
    commands.set("ping", {});
    commands.set("about", {});
    commands.set("help", {});

    const client = makeClient({
      user: makeUser({ username: "Irene" }),
      uptime: 0,
      guilds: { cache: guilds },
      commands,
    });
    // Reuse g1 as the interaction guild so makeInteraction's cross-reference
    // wiring (client.guilds.cache.set) doesn't inject a third guild.
    const interaction = makeInteraction({ client, guild: guilds.get("g1") });

    await aboutCmd.execute(interaction);

    const embed = lastEmbed(interaction);
    // 2 servers, 10+25=35 users, 3 commands
    expect(field(embed, "Servers")).toBe("`2`");
    expect(field(embed, "Users")).toBe("`35`");
    expect(field(embed, "Commands")).toBe("`3`");
  });

  it("formats uptime as days/hours/minutes when over a day", async () => {
    const uptime = 2 * 86400000 + 3 * 3600000 + 4 * 60000; // 2d 3h 4m
    const client = makeClient({ uptime, guilds: { cache: new Collection() }, commands: new Collection() });
    const interaction = makeInteraction({ client });

    await aboutCmd.execute(interaction);

    expect(field(lastEmbed(interaction), "Uptime")).toBe("`2d 3h 4m`");
  });

  it("formats uptime as minutes-only when under an hour", async () => {
    const client = makeClient({ uptime: 5 * 60000, guilds: { cache: new Collection() }, commands: new Collection() });
    const interaction = makeInteraction({ client });

    await aboutCmd.execute(interaction);

    expect(field(lastEmbed(interaction), "Uptime")).toBe("`5m`");
  });

  it("attaches GitHub + invite link buttons to the reply", async () => {
    const client = makeClient({ uptime: 0, guilds: { cache: new Collection() }, commands: new Collection() });
    const interaction = makeInteraction({ client });

    await aboutCmd.execute(interaction);

    const payload = lastReply(interaction);
    expect(payload.components).toHaveLength(1);
    const row = payload.components[0];
    const buttons = (row.components ?? []).map((c: any) => c.data ?? c);
    expect(buttons.length).toBe(2);
    // one of the buttons embeds the bot's client id in the OAuth invite URL
    const urls = buttons.map((b: any) => b.url).join(" ");
    expect(urls).toContain("github.com");
    expect(urls).toContain(`client_id=${client.user.id}`);
  });
});
