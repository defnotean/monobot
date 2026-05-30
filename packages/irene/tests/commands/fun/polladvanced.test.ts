// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// Re-register the logger mock anchored to THIS file's path. The shared
// tests/setup.ts mocks "../utils/logger.js" relative to setup.ts; for test
// files nested deeper than 2 levels Vitest anchors that relative specifier to
// the wrong base, which corrupts the embeds.js -> config.js module resolution.
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }));

// @ts-expect-error - JS helper, no types
import {
  makeInteraction,
  makeUser,
  makeChannel,
  makeMessage,
  makeClient,
  makePermissions,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/polladvanced.js";

const MANAGE = makePermissions([PermissionFlagsBits.ManageMessages]);
const NONE = makePermissions([]);

beforeEach(() => {
  cmd.initPollData([]); // reset module-level activePolls
});

// A create interaction whose fetchReply returns a known message id so the poll
// gets tracked under that id.
function createInteraction(opts: any, replyMsgId = "poll-msg") {
  const interaction = makeInteraction({ subcommand: "create", ...opts });
  // The command tracks the poll under interaction.fetchReply().id.
  interaction.fetchReply = vi.fn(async () => ({ id: replyMsgId }));
  return interaction;
}

describe("fun/polladvanced", () => {
  it("declares create/close subcommands", () => {
    const names = cmd.data.toJSON().options.map((o: any) => o.name).sort();
    expect(names).toEqual(["close", "create"]);
  });

  describe("create", () => {
    it("rejects fewer than 2 options", async () => {
      const interaction = createInteraction({ options: { question: "Q?", option1: "only" } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("at least 2 options");
      expect(cmd.getPollData()).toHaveLength(0);
    });

    it("rejects an invalid duration format", async () => {
      const interaction = createInteraction({ options: { question: "Q?", option1: "A", option2: "B", duration: "later" } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("Invalid duration");
    });

    it("creates and tracks a poll with the supplied options", async () => {
      const interaction = createInteraction({ options: { question: "Best color?", option1: "Red", option2: "Blue", option3: "Green" } }, "p1");
      await cmd.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const payload = lastReply(interaction);
      expect(payload.components).toHaveLength(1); // a vote-button row
      const polls = cmd.getPollData();
      expect(polls).toHaveLength(1);
      expect(polls[0].messageId).toBe("p1");
      expect(polls[0].options).toEqual(["Red", "Blue", "Green"]);
      expect(polls[0].anonymous).toBe(false);
    });

    it("parses a duration into an endsAt timestamp", async () => {
      const interaction = createInteraction({ options: { question: "Q?", option1: "A", option2: "B", duration: "1h" } }, "p2");
      await cmd.execute(interaction);
      const poll = cmd.getPollData()[0];
      expect(poll.endsAt).toBeGreaterThan(Date.now());
    });
  });

  describe("close", () => {
    function seedPoll(hostId = "host") {
      cmd.initPollData([{
        messageId: "close-me",
        question: "Q?",
        options: ["A", "B"],
        votes: [["voter1", 0], ["voter2", 1]],
        endsAt: null,
        anonymous: false,
        hostId,
        guildId: "g1",
        channelId: "chan-c",
      }]);
    }

    it("reports not found for an unknown poll", async () => {
      const interaction = makeInteraction({ subcommand: "close", options: { message_id: "ghost" } });
      interaction.memberPermissions = MANAGE;
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("Poll not found");
    });

    it("forbids a non-host without ManageMessages from closing", async () => {
      seedPoll("host");
      const interaction = makeInteraction({ subcommand: "close", user: makeUser({ id: "rando" }), options: { message_id: "close-me" } });
      interaction.memberPermissions = NONE;
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("Only the poll creator or admins");
      // Poll remains tracked since close was denied.
      expect(cmd.getPollData()).toHaveLength(1);
    });

    it("lets the host close their own poll and edits the result message", async () => {
      seedPoll("host");
      const pollMsg = makeMessage({ content: "" });
      pollMsg.edit = vi.fn(async () => {});
      const channel = makeChannel({ id: "chan-c" });
      channel.messages.fetch = vi.fn(async () => pollMsg);
      const client = makeClient();
      client.channels.cache.set("chan-c", channel);

      const interaction = makeInteraction({ subcommand: "close", user: makeUser({ id: "host" }), client, options: { message_id: "close-me" } });
      interaction.memberPermissions = NONE; // host bypasses permission requirement
      await cmd.execute(interaction);

      expect(pollMsg.edit).toHaveBeenCalledTimes(1);
      expect(repliedText(interaction)).toContain("Poll closed successfully");
      expect(cmd.getPollData()).toHaveLength(0);
    });

    it("lets an admin (ManageMessages) close someone else's poll", async () => {
      seedPoll("host");
      const channel = makeChannel({ id: "chan-c" });
      channel.messages.fetch = vi.fn(async () => null); // message gone, but close still proceeds
      const client = makeClient();
      client.channels.cache.set("chan-c", channel);

      const interaction = makeInteraction({ subcommand: "close", user: makeUser({ id: "admin" }), client, options: { message_id: "close-me" } });
      interaction.memberPermissions = MANAGE;
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("Poll closed successfully");
      expect(cmd.getPollData()).toHaveLength(0);
    });
  });

  describe("handlePollButton", () => {
    function seedPoll() {
      cmd.initPollData([{
        messageId: "vote-msg",
        question: "Q?",
        options: ["A", "B", "C"],
        votes: [],
        endsAt: null,
        anonymous: false,
        hostId: "host",
        guildId: "g1",
        channelId: "chan-v",
      }]);
    }

    function voteInteraction(user: any, customId: string) {
      const interaction = makeInteraction({ user, customId });
      interaction.message = makeMessage({ content: "" });
      interaction.message.id = "vote-msg";
      interaction.message.edit = vi.fn(async () => {});
      return interaction;
    }

    it("rejects a vote on an inactive poll", async () => {
      const interaction = voteInteraction(makeUser({}), "poll_vote_0");
      interaction.message.id = "gone";
      await cmd.handlePollButton(interaction);
      expect(repliedText(interaction)).toContain("no longer active");
    });

    it("rejects an out-of-range option index", async () => {
      seedPoll();
      const interaction = voteInteraction(makeUser({ id: "v" }), "poll_vote_9");
      await cmd.handlePollButton(interaction);
      expect(repliedText(interaction)).toContain("Invalid option");
    });

    it("records a new vote and updates the message", async () => {
      seedPoll();
      const interaction = voteInteraction(makeUser({ id: "v1" }), "poll_vote_1");
      await cmd.handlePollButton(interaction);
      expect(lastReply(interaction).content).toContain("voted for **B**");
      expect(interaction.message.edit).toHaveBeenCalled();
      const votes = cmd.getPollData()[0].votes;
      expect(votes).toContainEqual(["v1", 1]);
    });

    it("toggles off a vote when the same option is clicked again", async () => {
      cmd.initPollData([{
        messageId: "vote-msg",
        question: "Q?",
        options: ["A", "B"],
        votes: [["v1", 0]],
        endsAt: null,
        anonymous: false,
        hostId: "host",
        guildId: "g1",
        channelId: "chan-v",
      }]);
      const interaction = voteInteraction(makeUser({ id: "v1" }), "poll_vote_0");
      await cmd.handlePollButton(interaction);
      expect(lastReply(interaction).content).toContain("removed your vote");
      expect(cmd.getPollData()[0].votes).toHaveLength(0);
    });
  });
});
