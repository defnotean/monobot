// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// Re-register the logger mock anchored to THIS file's path (see polladvanced
// test for the rationale — the shared setup.ts relative mock mis-anchors for
// tests nested deeper than 2 levels and breaks embeds.js -> config.js loading).
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }));

// vi.hoisted so the hoisted vi.mock factory can reference `db`.
const db = vi.hoisted(() => ({
  saveGiveawayDb: vi.fn(),
  getGiveawayPingRoles: vi.fn(() => []),
}));
vi.mock("../../../database.js", () => db);

// @ts-expect-error - JS helper, no types
import {
  makeInteraction,
  makeUser,
  makeGuild,
  makeChannel,
  makeMember,
  makeMessage,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/giveaway.js";

const MANAGE = [PermissionFlagsBits.ManageMessages];

beforeEach(() => {
  db.saveGiveawayDb.mockReset();
  db.getGiveawayPingRoles.mockReset();
  db.getGiveawayPingRoles.mockReturnValue([]);
  cmd.initGiveawayData([]); // clear the module-level activeGiveaways map
});

describe("fun/giveaway", () => {
  it("requires ManageMessages and refuses members without it", async () => {
    const interaction = makeInteraction({ subcommand: "start", permissions: [], options: { prize: "X", duration: "1h" } });
    await cmd.execute(interaction);
    // requirePermission replies with a "No Permission" embed naming the missing
    // perm, and the handler bails before any state mutation.
    const text = repliedText(interaction);
    expect(text).toContain("No Permission");
    expect(text).toContain("Manage Messages");
    expect(db.saveGiveawayDb).not.toHaveBeenCalled();
  });

  describe("start", () => {
    it("rejects an unparseable duration", async () => {
      const interaction = makeInteraction({ subcommand: "start", permissions: MANAGE, options: { prize: "Nitro", duration: "soon" } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("invalid duration");
    });

    it("posts the giveaway, tracks it, and persists on a valid duration", async () => {
      const channel = makeChannel({ id: "chan-x" });
      const guild = makeGuild({ channels: [channel] });
      const user = makeUser({ id: "host" });
      const member = makeMember({ user, guild, permissions: MANAGE });
      const interaction = makeInteraction({
        subcommand: "start",
        user,
        member,
        guild,
        channel,
        options: { prize: "Nitro", duration: "1h", winners: 2 },
      });
      await cmd.execute(interaction);

      // Posted into the channel and confirmed to host ephemerally.
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(repliedText(interaction)).toContain("giveaway started");
      expect(db.saveGiveawayDb).toHaveBeenCalledTimes(1);

      // The tracked giveaway must round-trip through getGiveawayData.
      const data = cmd.getGiveawayData();
      expect(data).toHaveLength(1);
      expect(data[0].prize).toBe("Nitro");
      expect(data[0].winnerCount).toBe(2);
    });

    it("prepends configured ping roles to the giveaway message", async () => {
      db.getGiveawayPingRoles.mockReturnValue(["role-1", "role-2"]);
      const channel = makeChannel({ id: "chan-y" });
      const guild = makeGuild({ channels: [channel] });
      const member = makeMember({ guild, permissions: MANAGE });
      const interaction = makeInteraction({
        subcommand: "start", member, guild, channel,
        options: { prize: "P", duration: "30m" },
      });
      await cmd.execute(interaction);
      const sent = channel.send.mock.calls[0][0];
      expect(sent.content).toContain("<@&role-1>");
      expect(sent.content).toContain("<@&role-2>");
    });
  });

  describe("end / reroll", () => {
    it("reports not found when ending an unknown giveaway", async () => {
      const interaction = makeInteraction({ subcommand: "end", permissions: MANAGE, options: { message_id: "nope" } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("giveaway not found");
    });

    it("reports not found when rerolling an unknown giveaway", async () => {
      const interaction = makeInteraction({ subcommand: "reroll", permissions: MANAGE, options: { message_id: "nope" } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("giveaway not found");
    });

    it("ends a tracked giveaway: edits the message and announces winners", async () => {
      // Seed an active giveaway with two entrants.
      cmd.initGiveawayData([{
        messageId: "msg-1",
        channelId: "chan-z",
        guildId: "g1",
        prize: "Steam Key",
        hostId: "host",
        endsAt: Date.now() + 1000,
        startedAt: Date.now(),
        winnerCount: 1,
        entries: ["a", "b"],
      }]);

      const giveawayMsg = makeMessage({ content: "" });
      giveawayMsg.edit = vi.fn(async () => {});
      const channel = makeChannel({ id: "chan-z" });
      channel.messages.fetch = vi.fn(async () => giveawayMsg);
      const guild = makeGuild({ channels: [channel] });
      const member = makeMember({ guild, permissions: MANAGE });
      const interaction = makeInteraction({ subcommand: "end", member, guild, options: { message_id: "msg-1" } });
      await cmd.execute(interaction);

      expect(giveawayMsg.edit).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledTimes(1); // congrats message
      expect(repliedText(interaction)).toContain("giveaway ended");
      // Giveaway removed from active tracking.
      expect(cmd.getGiveawayData()).toHaveLength(0);
    });
  });

  describe("handleGiveawayButton", () => {
    function seed(opts: any = {}) {
      cmd.initGiveawayData([{
        messageId: "btn-msg",
        channelId: "chan-b",
        guildId: "g1",
        prize: "P",
        hostId: "host",
        endsAt: Date.now() + 10000,
        startedAt: Date.now(),
        winnerCount: 1,
        entries: opts.entries ?? [],
        minAccountAgeDays: opts.minAccountAgeDays ?? 0,
        minTenureDays: opts.minTenureDays ?? 0,
      }]);
    }

    function buttonInteraction(user: any) {
      const interaction = makeInteraction({ user });
      interaction.message = makeMessage({ content: "", embeds: [{ data: {} }] });
      interaction.message.id = "btn-msg";
      interaction.message.edit = vi.fn(async () => {});
      return interaction;
    }

    it("rejects clicks on an expired/unknown giveaway", async () => {
      const interaction = buttonInteraction(makeUser({}));
      interaction.message.id = "missing";
      await cmd.handleGiveawayButton(interaction);
      expect(repliedText(interaction)).toContain("Giveaway Expired");
    });

    it("enters a new participant and updates the message", async () => {
      seed();
      const user = makeUser({ id: "entrant" });
      const interaction = buttonInteraction(user);
      await cmd.handleGiveawayButton(interaction);
      expect(repliedText(interaction)).toContain("Entered!");
      expect(interaction.message.edit).toHaveBeenCalled();
      expect(cmd.getGiveawayData()[0].entries).toContain("entrant");
    });

    it("toggles a second click to remove the participant", async () => {
      seed({ entries: ["entrant"] });
      const user = makeUser({ id: "entrant" });
      const interaction = buttonInteraction(user);
      await cmd.handleGiveawayButton(interaction);
      expect(repliedText(interaction)).toContain("Removed");
      expect(cmd.getGiveawayData()[0].entries).not.toContain("entrant");
    });

    it("rejects entry when an anti-alt account-age gate is not met", async () => {
      seed({ minAccountAgeDays: 30 });
      // Brand-new account (created now) fails a 30-day gate.
      const user = makeUser({ id: "alt", createdTimestamp: Date.now() });
      const interaction = buttonInteraction(user);
      interaction.member = { joinedTimestamp: Date.now() };
      await cmd.handleGiveawayButton(interaction);
      expect(repliedText(interaction)).toContain("not eligible");
      expect(cmd.getGiveawayData()[0].entries).not.toContain("alt");
    });
  });

  describe("data round-trip", () => {
    it("initGiveawayData/getGiveawayData preserves entries and gates", () => {
      cmd.initGiveawayData([{
        messageId: "m",
        channelId: "c",
        guildId: "g",
        prize: "p",
        hostId: "h",
        endsAt: 123,
        startedAt: 100,
        winnerCount: 3,
        entries: ["x", "y"],
        minAccountAgeDays: 7,
        minTenureDays: 14,
      }]);
      const out = cmd.getGiveawayData();
      expect(out).toHaveLength(1);
      expect(out[0].entries.sort()).toEqual(["x", "y"]);
      expect(out[0].minAccountAgeDays).toBe(7);
      expect(out[0].minTenureDays).toBe(14);
      expect(out[0].winnerCount).toBe(3);
    });
  });
});
