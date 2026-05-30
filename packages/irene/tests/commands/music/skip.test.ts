import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));
// skip.js dynamically imports ./dj.js for requireDj — mock it so the DJ gate
// is controllable without standing up the whole dj store.
vi.mock("../../../commands/music/dj.js", () => ({
  requireDj: vi.fn(async () => true),
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
import * as dj from "../../../commands/music/dj.js";
import * as skip from "../../../commands/music/skip.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
const requireDj = dj.requireDj as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  requireDj.mockResolvedValue(true);
});

/** Interaction where the bot sits in botVc and the caller in userVc. */
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

  const botMember = makeMember({ user: botUser, guild });
  botMember.voice.channel = botVc;
  guild.members.cache.set(botUser.id, botMember);

  const member = makeMember({ user: callerUser, guild, permissions });
  member.voice.channel = userVc;

  return makeInteraction({ user: callerUser, member, guild, client });
}

describe("/skip", () => {
  it("refuses when nothing is playing (before the DJ gate)", async () => {
    getQueue.mockReturnValue(null);
    const vc = makeChannel({ type: 2 });
    const interaction = buildVoiceInteraction({ botVc: vc, userVc: vc });
    await skip.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
    expect(requireDj).not.toHaveBeenCalled();
  });

  it("stops at the DJ gate when requireDj denies", async () => {
    requireDj.mockResolvedValue(false);
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "A", url: "u" }], player: { stopTrack: vi.fn() } });
    const vc = makeChannel({ type: 2 });
    const interaction = buildVoiceInteraction({ botVc: vc, userVc: vc });
    await skip.execute(interaction);
    // requireDj is responsible for its own reply; skip must NOT proceed to stopTrack.
    expect(requireDj).toHaveBeenCalledWith(interaction);
    expect(interaction.getReplies()).toHaveLength(0);
  });

  it("blocks a non-admin who is not in the bot's voice channel", async () => {
    const stopTrack = vi.fn();
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "A", url: "u" }], player: { stopTrack } });
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const otherVc = makeChannel({ type: 2, name: "other-vc" });
    const interaction = buildVoiceInteraction({ botVc, userVc: otherVc });
    await skip.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not In Channel/i);
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it("sets _skipOnce BEFORE stopTrack and reports the up-next track", async () => {
    const order: string[] = [];
    const queue: any = {
      playing: true,
      looping: true,
      _skipOnce: false,
      songs: [
        { title: "Now", url: "u0" },
        { title: "Next", url: "u1" },
      ],
      player: { stopTrack: vi.fn(() => order.push(`stop:_skipOnce=${queue._skipOnce}`)) },
    };
    getQueue.mockReturnValue(queue);
    const sharedVc = makeChannel({ type: 2, name: "shared" });
    const interaction = buildVoiceInteraction({ botVc: sharedVc, userVc: sharedVc });
    await skip.execute(interaction);

    expect(queue._skipOnce).toBe(true);
    expect(order).toEqual(["stop:_skipOnce=true"]);
    const text = repliedText(interaction);
    expect(text).toMatch(/Skipped/i);
    expect(text).toContain("Now");
    expect(text).toContain("Next");
  });

  it("reports an empty up-next when only one song remains", async () => {
    const queue: any = {
      playing: true,
      _skipOnce: false,
      songs: [{ title: "Only", url: "u0" }],
      player: { stopTrack: vi.fn() },
    };
    getQueue.mockReturnValue(queue);
    const sharedVc = makeChannel({ type: 2, name: "shared" });
    const interaction = buildVoiceInteraction({ botVc: sharedVc, userVc: sharedVc });
    await skip.execute(interaction);
    expect(queue.player.stopTrack).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/queue is empty/i);
  });

  it("lets an Administrator skip from a different channel", async () => {
    const queue: any = {
      playing: true,
      _skipOnce: false,
      songs: [{ title: "A", url: "u0" }, { title: "B", url: "u1" }],
      player: { stopTrack: vi.fn() },
    };
    getQueue.mockReturnValue(queue);
    const botVc = makeChannel({ type: 2, name: "bot-vc" });
    const otherVc = makeChannel({ type: 2, name: "other-vc" });
    const interaction = buildVoiceInteraction({
      botVc,
      userVc: otherVc,
      permissions: [PermissionFlagsBits.Administrator],
    });
    await skip.execute(interaction);
    expect(queue.player.stopTrack).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Skipped/i);
  });
});
