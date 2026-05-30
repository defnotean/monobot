import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
  deleteQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import {
  makeInteraction,
  makeGuild,
  makeMember,
  makeUser,
  makeChannel,
  makeClient,
  repliedText,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as stop from "../../../commands/music/stop.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
const deleteQueue = player.deleteQueue as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Build an interaction where the bot is sitting in `botVc` and the calling
 * member is in `userVc`. The bot member is registered in guild.members.cache
 * keyed by the client user's id (which is what stop.js looks up).
 */
function buildVoiceInteraction({
  botVc,
  userVc,
  permissions = [],
  isOwner = false,
}: {
  botVc: any;
  userVc: any;
  permissions?: bigint[];
  isOwner?: boolean;
}) {
  const botUser = makeUser({ tag: "irene-bot#0000", bot: true });
  const client = makeClient({ user: botUser });
  const callerUser = makeUser({ username: "caller" });
  const guild = makeGuild({ ownerId: isOwner ? callerUser.id : makeUser().id });

  // Bot member lives in the cache under client.user.id with a voice channel.
  const botMember = makeMember({ user: botUser, guild });
  botMember.voice.channel = botVc;
  guild.members.cache.set(botUser.id, botMember);

  const member = makeMember({ user: callerUser, guild, permissions });
  member.voice.channel = userVc;

  return makeInteraction({ user: callerUser, member, guild, client });
}

describe("/stop", () => {
  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const vc = makeChannel({ type: 2 });
    const interaction = buildVoiceInteraction({ botVc: vc, userVc: vc });
    await stop.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
    expect(deleteQueue).not.toHaveBeenCalled();
  });

  it("blocks a non-admin who is not in the bot's voice channel", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "A" }] });
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const otherVc = makeChannel({ type: 2, name: "other-vc" });
    const interaction = buildVoiceInteraction({ botVc, userVc: otherVc });
    await stop.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not In Channel/i);
    expect(deleteQueue).not.toHaveBeenCalled();
  });

  it("blocks a non-admin who is not in any voice channel", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "A" }] });
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const interaction = buildVoiceInteraction({ botVc, userVc: null });
    await stop.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not In Channel/i);
    expect(deleteQueue).not.toHaveBeenCalled();
  });

  it("lets a member in the same VC stop and clears the queue (singular wording)", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "Only" }] });
    const sharedVc = makeChannel({ type: 2, name: "shared" });
    const interaction = buildVoiceInteraction({ botVc: sharedVc, userVc: sharedVc });
    await stop.execute(interaction);
    expect(deleteQueue).toHaveBeenCalledWith(interaction.guild.id);
    const text = repliedText(interaction);
    expect(text).toMatch(/Stopped/i);
    expect(text).toContain("**1** song cleared");
  });

  it("lets an Administrator stop even from a different channel (plural wording)", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "A" }, { title: "B" }] });
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const otherVc = makeChannel({ type: 2, name: "other-vc" });
    const interaction = buildVoiceInteraction({
      botVc,
      userVc: otherVc,
      permissions: [PermissionFlagsBits.Administrator],
    });
    await stop.execute(interaction);
    expect(deleteQueue).toHaveBeenCalledWith(interaction.guild.id);
    expect(repliedText(interaction)).toContain("**2** songs cleared");
  });

  it("lets the guild owner stop even when not in any channel", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "A" }] });
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const interaction = buildVoiceInteraction({ botVc, userVc: null, isOwner: true });
    await stop.execute(interaction);
    expect(deleteQueue).toHaveBeenCalledWith(interaction.guild.id);
    expect(repliedText(interaction)).toMatch(/Stopped/i);
  });
});
