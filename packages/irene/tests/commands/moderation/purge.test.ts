// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as purge from "../../../commands/moderation/purge.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember, makeChannel, makeMessage,
  makePermissions, repliedText, Collection,
} from "../../_helpers/mockDiscord.js";

const NOW = Date.now();
const fresh = (n) => {
  const c = new Collection();
  for (let i = 0; i < n; i++) {
    const m = makeMessage({ author: makeUser() });
    m.createdTimestamp = NOW - 1000;
    c.set(m.id, m);
  }
  return c;
};

function setup({ count = 5, user, botPerms = "all", invokerOwner = true, msgs } = {}) {
  const guild = makeGuild({ botPermissions: botPerms });
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [] });
  const channel = makeChannel({ guild });
  channel.messages.fetch = vi.fn(async () => (msgs ?? fresh(count)));
  channel.bulkDelete = vi.fn(async (coll) => coll); // returns the deleted set
  const interaction = makeInteraction({
    guild, user: invoker, member, channel,
    options: { count, ...(user ? { user } : {}) },
  });
  return { interaction, channel };
}

beforeEach(() => vi.clearAllMocks());

describe("purge command", () => {
  it("declares purge metadata", () => {
    expect(purge.data.name).toBe("purge");
  });

  it("refuses a non-admin invoker", async () => {
    const { interaction, channel } = setup({ invokerOwner: false });
    interaction.member.permissions = makePermissions([]);
    await purge.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it("requires the bot to have ManageMessages", async () => {
    const { interaction } = setup({ botPerms: [] });
    await purge.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Messages/);
  });

  it("bulk-deletes fresh messages and logs", async () => {
    const { interaction, channel } = setup({ count: 4 });
    await purge.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(channel.bulkDelete).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/Purged|deleted/i);
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });

  it("filters to a specific user's messages", async () => {
    const target = makeUser({ tag: "noisy#0001" });
    const coll = new Collection();
    const mine = makeMessage({ author: target }); mine.createdTimestamp = NOW - 1000; coll.set(mine.id, mine);
    const other = makeMessage({ author: makeUser() }); other.createdTimestamp = NOW - 1000; coll.set(other.id, other);
    const { interaction, channel } = setup({ user: target, msgs: coll });
    await purge.execute(interaction);
    const deletedArg = channel.bulkDelete.mock.calls[0][0];
    expect(deletedArg.size).toBe(1); // only the target's message survived the filter
  });

  it("reports Nothing to Delete when every match is older than 14 days", async () => {
    const coll = new Collection();
    const old = makeMessage({ author: makeUser() });
    old.createdTimestamp = NOW - 20 * 24 * 60 * 60 * 1000;
    coll.set(old.id, old);
    const { interaction, channel } = setup({ msgs: coll });
    await purge.execute(interaction);
    expect(channel.bulkDelete).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Nothing to Delete|older than/i);
  });

  it("reports a failure embed when bulkDelete throws", async () => {
    const { interaction, channel } = setup({});
    channel.bulkDelete = vi.fn(async () => { throw new Error("rate limited"); });
    await purge.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Purge Failed/i);
    expect(repliedText(interaction)).toContain("rate limited");
  });
});
