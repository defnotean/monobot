import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
  createQueue: vi.fn(),
  connectToChannel: vi.fn(),
  playSong: vi.fn(),
  searchSong: vi.fn(),
  searchPlaylist: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, makeMember, makeUser, makeChannel, makeGuild, makeClient, repliedText } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as play from "../../../commands/music/play.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
const createQueue = player.createQueue as unknown as ReturnType<typeof vi.fn>;
const connectToChannel = player.connectToChannel as unknown as ReturnType<typeof vi.fn>;
const playSong = player.playSong as unknown as ReturnType<typeof vi.fn>;
const searchSong = player.searchSong as unknown as ReturnType<typeof vi.fn>;
const searchPlaylist = player.searchPlaylist as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

/** Voice channel whose permissionsFor returns the given Connect/Speak grants. */
function makeVoiceChannel({ connect = true, speak = true } = {}) {
  const vc: any = makeChannel({ type: 2, name: "vc" });
  vc.permissionsFor = vi.fn(() => ({
    has: (p: string) => (p === "Connect" ? connect : p === "Speak" ? speak : false),
  }));
  return vc;
}

/** Interaction with the caller sitting in `voiceChannel`. */
function buildInteraction(voiceChannel: any, query = "some song") {
  const user = makeUser({ username: "caller" });
  const guild = makeGuild({});
  const member = makeMember({ user, guild });
  member.voice.channel = voiceChannel;
  const client = makeClient();
  return makeInteraction({ user, member, guild, client, options: { query } });
}

describe("/play", () => {
  it("refuses when the caller is not in a voice channel", async () => {
    const interaction = buildInteraction(null);
    await play.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not in Voice/i);
    expect(searchPlaylist).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("refuses when the bot lacks Connect/Speak permission", async () => {
    const vc = makeVoiceChannel({ connect: true, speak: false });
    const interaction = buildInteraction(vc);
    await play.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No Permission/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("defers, then reports Not Found for an unmatched single-song query", async () => {
    searchPlaylist.mockResolvedValue(null);
    searchSong.mockResolvedValue(null);
    getQueue.mockReturnValue({ songs: [] });
    const interaction = buildInteraction(makeVoiceChannel());
    await play.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Not Found/i);
  });

  it("creates a queue, connects, plays the first song and replies Now Playing", async () => {
    searchPlaylist.mockResolvedValue(null);
    const song: any = { title: "Hit Track", url: "http://x/1", duration: "3:00" };
    searchSong.mockResolvedValue(song);
    getQueue.mockReturnValue(undefined); // no existing queue -> create
    const createdQueue: any = { songs: [] };
    createQueue.mockReturnValue(createdQueue);
    connectToChannel.mockResolvedValue(undefined);
    const interaction = buildInteraction(makeVoiceChannel());

    await play.execute(interaction);

    expect(createQueue).toHaveBeenCalled();
    expect(connectToChannel).toHaveBeenCalledWith(createdQueue);
    // The song was pushed and tagged with the requester.
    expect(createdQueue.songs).toHaveLength(1);
    expect(createdQueue.songs[0].requestedBy).toBe(interaction.user.toString());
    expect(playSong).toHaveBeenCalledWith(createdQueue);
    const text = repliedText(interaction);
    expect(text).toMatch(/Now Playing/i);
    expect(text).toContain("Hit Track");
  });

  it("adds to an existing non-empty queue without (re)playing and reports queue position", async () => {
    searchPlaylist.mockResolvedValue(null);
    const song: any = { title: "Second", url: "http://x/2" };
    searchSong.mockResolvedValue(song);
    const existing: any = { songs: [{ title: "First" }] };
    getQueue.mockReturnValue(existing);
    const interaction = buildInteraction(makeVoiceChannel());

    await play.execute(interaction);

    expect(createQueue).not.toHaveBeenCalled();
    expect(existing.songs).toHaveLength(2);
    expect(playSong).not.toHaveBeenCalled();
    const text = repliedText(interaction);
    expect(text).toMatch(/Added to Queue/i);
    expect(text).toContain("#2");
  });

  it("surfaces a connection failure when connectToChannel throws", async () => {
    searchPlaylist.mockResolvedValue(null);
    searchSong.mockResolvedValue({ title: "X", url: "http://x" });
    getQueue.mockReturnValue(undefined);
    createQueue.mockReturnValue({ songs: [] });
    connectToChannel.mockRejectedValue(new Error("node offline"));
    const interaction = buildInteraction(makeVoiceChannel());

    await play.execute(interaction);

    expect(repliedText(interaction)).toMatch(/Connection Failed/i);
    expect(repliedText(interaction)).toContain("node offline");
    expect(playSong).not.toHaveBeenCalled();
  });

  it("rejects an empty playlist", async () => {
    searchPlaylist.mockResolvedValue({ name: "Empty PL", tracks: [] });
    const interaction = buildInteraction(makeVoiceChannel());
    await play.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Empty Playlist/i);
    expect(searchSong).not.toHaveBeenCalled();
  });

  it("queues every playlist track and plays when the queue was empty", async () => {
    // First track has a valid title + null thumbnail so the real EmbedBuilder
    // (used by musicEmbed) accepts every field/thumbnail value — the focus is
    // the queueing logic, which we assert on the mocked collaborators.
    searchPlaylist.mockResolvedValue({
      name: "My Mix",
      tracks: [
        { title: "First Track Title", thumbnail: null },
        { title: "T2" },
        { title: "T3" },
      ],
    });
    getQueue.mockReturnValue(undefined);
    const createdQueue: any = { songs: [] };
    createQueue.mockReturnValue(createdQueue);
    connectToChannel.mockResolvedValue(undefined);
    const interaction = buildInteraction(makeVoiceChannel());

    await play.execute(interaction);

    expect(createdQueue.songs).toHaveLength(3);
    // every track tagged with requester
    expect(createdQueue.songs.every((t: any) => t.requestedBy === interaction.user.toString())).toBe(true);
    expect(playSong).toHaveBeenCalledWith(createdQueue);
    const text = repliedText(interaction);
    expect(text).toMatch(/Now Playing/i);
    expect(text).toContain("My Mix");
    expect(text).toContain("3");
  });
});
