// Regression — /skip used to replay the same song under single-track loop
// because (unlike the working ⏭ button) it called stopTrack() WITHOUT first
// setting queue._skipOnce. The track-end handler then saw queue.looping and
// replayed instead of advancing. /skip must set _skipOnce=true BEFORE
// stopTrack(), mirroring the button path in events/interactionCreate.js.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

// ─── Mock collaborators ──────────────────────────────────────────────────────
let mockQueue: any = null;
vi.mock("../../music/player.js", () => ({
  getQueue: () => mockQueue,
}));
vi.mock("../../utils/embeds.js", () => ({
  successEmbed: (title: string, desc: string) => ({
    title, desc,
    addFields() { return this; },
  }),
  errorEmbed: (title: string, desc: string) => ({ title, desc }),
}));
vi.mock("../../commands/music/dj.js", () => ({
  requireDj: vi.fn(async () => true),
}));

import { execute } from "../../commands/music/skip.js";

// Records the order of operations so we can assert _skipOnce is set BEFORE
// stopTrack — the whole point of the fix.
function makeQueue() {
  const ops: string[] = [];
  const queue: any = {
    playing: true,
    looping: true, // single-track loop active — the broken scenario
    _skipOnce: false,
    songs: [
      { title: "Song A", url: "https://x/a" },
      { title: "Song B", url: "https://x/b" },
    ],
    player: {
      stopTrack() { ops.push(`stopTrack:_skipOnce=${queue._skipOnce}`); },
    },
    _ops: ops,
  };
  return queue;
}

function makeInteraction({ botVcId = "vc1", userVcId = "vc1", admin = false } = {}) {
  const replies: any[] = [];
  return {
    _replies: replies,
    guild: {
      id: "g1",
      ownerId: "owner",
      members: { cache: { get: () => ({ voice: { channel: { id: botVcId } } }) } },
    },
    client: { user: { id: "bot" } },
    member: {
      id: "user1",
      voice: { channel: { id: userVcId } },
      permissions: { has: (p: any) => admin && p === PermissionFlagsBits.Administrator },
    },
    async reply(payload: any) { replies.push(payload); },
  };
}

beforeEach(() => {
  mockQueue = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("/skip under single-track loop", () => {
  it("sets _skipOnce=true BEFORE stopTrack so the song advances, not repeats", async () => {
    mockQueue = makeQueue();
    const interaction = makeInteraction();

    await execute(interaction as any);

    // The flag is set, and it was already true at the moment stopTrack ran.
    expect(mockQueue._skipOnce).toBe(true);
    expect(mockQueue._ops).toEqual(["stopTrack:_skipOnce=true"]);
  });

  it("matches the working button path which sets _skipOnce before stopTrack", async () => {
    // This mirrors interactionCreate.js's "skip" case ordering exactly.
    mockQueue = makeQueue();
    const interaction = makeInteraction();

    await execute(interaction as any);

    // handleTrackEnd in player.js does: wasSkipped = (_skipOnce === true);
    // _skipOnce=false; if (!wasSkipped && looping) replay. With _skipOnce set,
    // wasSkipped is true → it falls through to the advance path.
    expect(mockQueue._ops[0]).toContain("_skipOnce=true");
    const reply = interaction._replies[0];
    expect(reply.embeds[0].title).toBe("Skipped");
  });

  it("rejects when nothing is playing (does not touch _skipOnce)", async () => {
    mockQueue = makeQueue();
    mockQueue.playing = false;
    const interaction = makeInteraction();

    await execute(interaction as any);

    expect(mockQueue._skipOnce).toBe(false);
    expect(interaction._replies[0].embeds[0].title).toBe("Nothing Playing");
  });
});
