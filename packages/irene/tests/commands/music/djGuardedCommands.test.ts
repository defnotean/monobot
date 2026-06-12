// ─── Music slash commands — DJ + same-VC guard wiring ────────────────────────
//
// /dj documents /skip /stop /pause /resume /volume /loop /shuffle as
// DJ-protected, but historically only /skip enforced it (and /stop checked
// same-VC without DJ). Every one of the seven now routes through
// utils/musicGuard.js requireDjAndSameVc. These tests prove the WIRING per
// command: a non-admin outside the bot's VC is denied (ephemeral reply, no
// player mutation), and an authorized member passes through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const player = vi.hoisted(() => ({
  getQueue: vi.fn(),
  deleteQueue: vi.fn(),
}));
vi.mock("../../../music/player.js", () => player);
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error — JS module, no types
import { setDjRole, removeDjRole } from "../../../commands/music/dj.js";

const BOT_ID = "bot-1";
const GUILD_ID = "g-music";

function makeGuild() {
  return {
    id: GUILD_ID,
    ownerId: "owner-1",
    client: { user: { id: BOT_ID } },
    members: { cache: new Map([[BOT_ID, { voice: { channel: { id: "vc-1" } } }]]) },
    roles: { cache: new Map() },
  };
}

function makeInteraction({ inVc = true, roleIds = [] as string[] } = {}) {
  const guild = makeGuild();
  return {
    guild,
    client: guild.client,
    user: { id: "u-1" },
    member: {
      id: "u-1",
      voice: { channel: inVc ? { id: "vc-1" } : null },
      permissions: { has: () => false },
      roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
    },
    options: {
      getInteger: vi.fn(() => 50),
      getString: vi.fn(() => "track"),
    },
    reply: vi.fn(async () => {}),
  };
}

// One row per guarded command: module path + a queue fixture whose mutation
// points we can assert were NOT hit on denial.
const cases: Array<{ name: string; path: string; queue: () => any; mutated: (q: any) => boolean }> = [
  {
    name: "pause",
    path: "../../../commands/music/pause.js",
    queue: () => ({ playing: true, songs: [{ title: "t" }], player: { paused: false, setPaused: vi.fn() } }),
    mutated: (q) => q.player.setPaused.mock.calls.length > 0,
  },
  {
    name: "resume",
    path: "../../../commands/music/resume.js",
    queue: () => ({ playing: true, songs: [{ title: "t" }], player: { paused: true, setPaused: vi.fn() } }),
    mutated: (q) => q.player.setPaused.mock.calls.length > 0,
  },
  {
    name: "volume",
    path: "../../../commands/music/volume.js",
    queue: () => ({ songs: [{ title: "t" }], player: { setGlobalVolume: vi.fn() } }),
    mutated: (q) => q.player.setGlobalVolume.mock.calls.length > 0,
  },
  {
    name: "loop",
    path: "../../../commands/music/loop.js",
    queue: () => ({ playing: true, songs: [{ title: "t" }], looping: false }),
    mutated: (q) => q.looping === true,
  },
  {
    name: "shuffle",
    path: "../../../commands/music/shuffle.js",
    queue: () => ({ songs: [{ title: "a" }, { title: "b" }, { title: "c" }], shuffle: false }),
    mutated: (q) => q.shuffle === true,
  },
  {
    name: "stop",
    path: "../../../commands/music/stop.js",
    queue: () => ({ songs: [{ title: "t" }] }),
    mutated: () => player.deleteQueue.mock.calls.length > 0,
  },
  {
    name: "skip",
    path: "../../../commands/music/skip.js",
    queue: () => ({ playing: true, songs: [{ title: "t", url: "https://x" }], player: { stopTrack: vi.fn() } }),
    mutated: (q) => q.player.stopTrack.mock.calls.length > 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  removeDjRole(GUILD_ID);
});

describe("DJ-protected music commands enforce the shared guard", () => {
  for (const c of cases) {
    it(`/${c.name} denies a non-admin outside the bot's voice channel`, async () => {
      const { execute } = await import(c.path);
      const queue = c.queue();
      player.getQueue.mockReturnValue(queue);

      const interaction = makeInteraction({ inVc: false });
      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      expect((interaction.reply as any).mock.calls[0][0].flags).toBe(64);
      expect(c.mutated(queue)).toBe(false);
    });

    it(`/${c.name} denies a non-DJ in the VC when a DJ role is set`, async () => {
      setDjRole(GUILD_ID, "dj-role-1");
      const { execute } = await import(c.path);
      const queue = c.queue();
      player.getQueue.mockReturnValue(queue);

      const interaction = makeInteraction();
      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      expect((interaction.reply as any).mock.calls[0][0].flags).toBe(64);
      expect(c.mutated(queue)).toBe(false);
    });

    it(`/${c.name} allows a DJ-role holder in the bot's voice channel`, async () => {
      setDjRole(GUILD_ID, "dj-role-1");
      const { execute } = await import(c.path);
      const queue = c.queue();
      player.getQueue.mockReturnValue(queue);

      const interaction = makeInteraction({ roleIds: ["dj-role-1"] });
      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      // Allowed path replies publicly (no ephemeral denial flags).
      expect((interaction.reply as any).mock.calls[0][0].flags).not.toBe(64);
      expect(c.mutated(queue)).toBe(true);
    });
  }
});
