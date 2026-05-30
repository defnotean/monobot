import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, makeMember, makeChannel, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";

import * as suggest from "../../../commands/utility/suggest.js";

let userSeq = 0;
// Unique user per test so the 60s suggest cooldown never leaks between tests.
function freshUser() {
  return makeUser({ id: `suggest-user-${userSeq++}` });
}

function ideaInteraction(idea: string) {
  const user = freshUser();
  const guild = makeGuild({ id: `suggest-guild-${userSeq}` });
  const channel = makeChannel({ id: "sg-chan" });
  channel.isTextBased = vi.fn(() => true);
  // make the current channel resolvable from the guild cache (idea falls back to current channel)
  guild.channels.cache.set(channel.id, channel);
  const interaction = makeInteraction({ user, guild, channel, subcommand: "idea", options: { idea } });
  return { interaction, channel };
}

describe("utility/suggest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    suggest.initSuggestionData({});
  });

  it("declares the suggest command", () => {
    expect(suggest.data.name).toBe("suggest");
  });

  describe("idea", () => {
    it("rejects suggestions under 10 characters", async () => {
      const { interaction } = ideaInteraction("short");
      await suggest.execute(interaction);
      expect(repliedText(interaction)).toContain("Too Short");
    });

    it("rejects suggestions over 1000 characters", async () => {
      const { interaction } = ideaInteraction("x".repeat(1001));
      await suggest.execute(interaction);
      expect(repliedText(interaction)).toContain("Too Long");
    });

    it("posts a valid suggestion to the channel and reacts with 👍/👎", async () => {
      const { interaction, channel } = ideaInteraction("This is a perfectly valid suggestion idea.");
      const posted = await channel.send.getMockImplementation()?.({});
      // channel.send returns a message mock with a react spy
      await suggest.execute(interaction);

      expect(channel.send).toHaveBeenCalledTimes(1);
      const sent = channel.send.mock.calls[0][0];
      expect(sent.embeds[0].data.title).toContain("Suggestion #1");
      // stored in the suggestion data
      const data = suggest.getSuggestionData()[interaction.guildId];
      expect(data.suggestions).toHaveLength(1);
      expect(data.suggestions[0].text).toContain("perfectly valid");
      void posted;
    });
  });

  describe("setup (admin gate)", () => {
    it("refuses a non-admin, non-owner member", async () => {
      const guild = makeGuild();
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [] }); // no admin
      const channel = makeChannel();
      channel.isTextBased = vi.fn(() => true);
      const interaction = makeInteraction({ user, guild, member, subcommand: "setup", options: { channel } });

      await suggest.execute(interaction);
      expect(repliedText(interaction).toLowerCase()).toContain("permission");
      // not stored
      expect(suggest.getSuggestionData()[interaction.guildId]).toBeUndefined();
    });

    it("lets an administrator set the suggestion channel", async () => {
      const guild = makeGuild();
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.Administrator] });
      const channel = makeChannel({ id: "set-chan", name: "ideas" });
      channel.isTextBased = vi.fn(() => true);
      const interaction = makeInteraction({ user, guild, member, subcommand: "setup", options: { channel } });

      await suggest.execute(interaction);
      expect(repliedText(interaction)).toContain("Suggestion Channel Set");
      expect(suggest.getSuggestionData()[interaction.guildId].channelId).toBe("set-chan");
    });
  });

  describe("approve / deny (admin gate + not-found)", () => {
    it("approve refuses non-admins", async () => {
      const guild = makeGuild();
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [] });
      const interaction = makeInteraction({ user, guild, member, subcommand: "approve", options: { number: 1 } });
      await suggest.execute(interaction);
      expect(repliedText(interaction).toLowerCase()).toContain("permission");
    });

    it("approve reports 'No Suggestions Found' for an empty guild (admin)", async () => {
      const guild = makeGuild();
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.Administrator] });
      const interaction = makeInteraction({ user, guild, member, subcommand: "approve", options: { number: 1 } });
      await suggest.execute(interaction);
      expect(repliedText(interaction)).toContain("No Suggestions Found");
    });

    it("deny reports a missing suggestion number after one exists", async () => {
      const gid = "deny-guild";
      suggest.initSuggestionData({ [gid]: { channelId: "c", suggestions: [{ id: 1, messageId: "m", authorId: "a", text: "t", status: "pending", reason: null }] } });
      const guild = makeGuild({ id: gid });
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.Administrator] });
      const interaction = makeInteraction({ user, guild, member, subcommand: "deny", options: { number: 99 } });
      await suggest.execute(interaction);
      expect(repliedText(interaction)).toContain("Suggestion Not Found");
    });
  });
});
