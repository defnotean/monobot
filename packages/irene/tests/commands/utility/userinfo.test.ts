import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, makeMember, makeRole } from "../../_helpers/mockDiscord.js";

import * as userinfo from "../../../commands/utility/userinfo.js";

describe("utility/userinfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the userinfo command", () => {
    expect(userinfo.data.name).toBe("userinfo");
  });

  it("defaults to the invoking user when no 'user' option is given", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ guild });
    // No member cached for this user → fetch returns null → member-only fields skipped
    guild.members.fetch = vi.fn(async () => null);

    await userinfo.execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0];
    // username/id of the invoking user appear
    expect(JSON.stringify(embed.data.fields)).toContain(interaction.user.username);
    expect(JSON.stringify(embed.data.fields)).toContain(interaction.user.id);
    // joined/nickname/roles fields are NOT present without a member
    expect(embed.data.fields.some((f: any) => f.name.includes("Joined"))).toBe(false);
  });

  it("uses the supplied user option and includes member fields (joined, nickname, roles) when found", async () => {
    const guild = makeGuild();
    const target = makeUser({ username: "targetUser", bot: false });
    const extraRole = makeRole({ id: "role-x", name: "VIP" });
    const member = makeMember({ user: target, guild, nickname: "Nicky", roles: [extraRole] });
    member.joinedTimestamp = 1_650_000_000_000;
    guild.members.fetch = vi.fn(async (id: string) => (id === target.id ? member : null));

    const interaction = makeInteraction({ guild, options: { user: target } });
    await userinfo.execute(interaction);

    expect(guild.members.fetch).toHaveBeenCalledWith(target.id);
    const embed = interaction.reply.mock.calls[0][0].embeds[0];
    const blob = JSON.stringify(embed.data.fields);
    expect(blob).toContain("targetUser");
    expect(blob).toContain("Nicky");
    expect(embed.data.fields.some((f: any) => f.name.includes("Joined"))).toBe(true);
    // roles field excludes @everyone (guild.id role) and lists VIP
    const roleField = embed.data.fields.find((f: any) => f.name.includes("Roles"));
    expect(roleField.value).toContain("role-x");
  });

  it("marks bot accounts as Bot: Yes", async () => {
    const guild = makeGuild();
    const botUser = makeUser({ username: "robo", bot: true });
    guild.members.fetch = vi.fn(async () => null);
    const interaction = makeInteraction({ guild, options: { user: botUser } });

    await userinfo.execute(interaction);
    const botField = interaction.reply.mock.calls[0][0].embeds[0].data.fields.find((f: any) => f.name.includes("Bot"));
    expect(botField.value).toBe("Yes");
  });
});
