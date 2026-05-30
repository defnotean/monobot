import { describe, it, expect, vi, beforeEach } from "vitest";

const playSoundEffect = vi.fn(async () => {});
vi.mock("../../../music/player.js", () => ({
  playSoundEffect,
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../utils/pagination.js", () => ({ paginate: vi.fn() }));
const validateUrlAsync = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@defnotean/shared/safeFetch", () => ({ validateUrlAsync }));

// @ts-expect-error JS helper without types
import { makeInteraction, makeGuild, makeChannel, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as pagination from "../../../utils/pagination.js";
import * as soundboard from "../../../commands/music/soundboard.js";

const paginate = pagination.paginate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the in-memory store between tests so counts/lists are deterministic.
  soundboard.initSoundboardData({ soundboard: {} });
});

/** Add a sound for `guildId` directly through the command's add path. */
async function addSound(guildId: string, name: string, url = "https://cdn/x.mp3") {
  const interaction = makeInteraction({
    subcommand: "add",
    options: { name, url },
    permissions: [PermissionFlagsBits.ManageGuild],
    guild: makeGuild({ id: guildId }),
  });
  await soundboard.execute(interaction);
  return interaction;
}

describe("/soundboard add", () => {
  it("blocks members without Manage Guild", async () => {
    const interaction = makeInteraction({
      subcommand: "add",
      options: { name: "horn", url: "https://cdn/h.mp3" },
      permissions: [],
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Guild/i);
  });

  it("rejects a non-http(s) url", async () => {
    const interaction = makeInteraction({
      subcommand: "add",
      options: { name: "horn", url: "ftp://cdn/h.mp3" },
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Invalid URL/i);
  });

  it("rejects private or otherwise unsafe URLs", async () => {
    validateUrlAsync.mockRejectedValueOnce(new Error("private/loopback address not allowed"));
    const interaction = makeInteraction({
      subcommand: "add",
      options: { name: "bad", url: "http://127.0.0.1/a.mp3" },
      permissions: [PermissionFlagsBits.ManageGuild],
      guild: makeGuild({ id: "g1" }),
    });

    await soundboard.execute(interaction);

    expect(repliedText(interaction)).toMatch(/private\/loopback/i);
    expect(soundboard.getSoundboardData()).toEqual({});
  });

  it("rejects an over-long name", async () => {
    const interaction = makeInteraction({
      subcommand: "add",
      options: { name: "x".repeat(40), url: "https://cdn/h.mp3" },
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Invalid Name/i);
  });

  it("stores a valid sound and confirms", async () => {
    const interaction = makeInteraction({
      subcommand: "add",
      options: { name: "Airhorn", url: "https://cdn/h.mp3", category: "Memes" },
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Sound Added/i);
    // names are lower-cased on store
    const data = soundboard.getSoundboardData() as Record<string, any>;
    const stored = data[interaction.guild.id];
    expect(stored).toHaveProperty("airhorn");
    expect(stored.airhorn.category).toBe("memes");
  });
});

describe("/soundboard play", () => {
  it("refuses when the caller is not in a voice channel", async () => {
    const interaction = makeInteraction({ subcommand: "play", options: { name: "horn" } });
    interaction.member.voice.channel = null;
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not in Voice/i);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("reports when the sound does not exist", async () => {
    const interaction = makeInteraction({ subcommand: "play", options: { name: "missing" } });
    interaction.member.voice.channel = makeChannel({ type: 2 });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Sound Not Found/i);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("plays an existing sound via playSoundEffect", async () => {
    const guildId = "sb-guild-1";
    await addSound(guildId, "airhorn", "https://cdn/airhorn.mp3");

    const vc = makeChannel({ type: 2 });
    const interaction = makeInteraction({
      subcommand: "play",
      options: { name: "AIRHORN" },
      guild: makeGuild({ id: guildId }),
    });
    interaction.member.voice.channel = vc;
    await soundboard.execute(interaction);

    expect(playSoundEffect).toHaveBeenCalledWith(guildId, "https://cdn/airhorn.mp3", vc);
    expect(repliedText(interaction)).toMatch(/Playing Sound/i);
  });

  it("surfaces a Play Failed error when playSoundEffect throws", async () => {
    const guildId = "sb-guild-2";
    await addSound(guildId, "bruh", "https://cdn/bruh.mp3");
    playSoundEffect.mockRejectedValueOnce(new Error("no node"));

    const interaction = makeInteraction({
      subcommand: "play",
      options: { name: "bruh" },
      guild: makeGuild({ id: guildId }),
    });
    interaction.member.voice.channel = makeChannel({ type: 2 });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Play Failed/i);
    expect(repliedText(interaction)).toContain("no node");
  });
});

describe("/soundboard list", () => {
  it("reports an empty soundboard", async () => {
    const interaction = makeInteraction({ subcommand: "list" });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Soundboard Empty/i);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("lists a small set inline (<=10) without pagination", async () => {
    const guildId = "sb-list-1";
    await addSound(guildId, "one");
    await addSound(guildId, "two");
    const interaction = makeInteraction({ subcommand: "list", guild: makeGuild({ id: guildId }) });
    await soundboard.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("2/30");
    expect(paginate).not.toHaveBeenCalled();
  });

  it("paginates when there are more than 10 sounds", async () => {
    const guildId = "sb-list-2";
    for (let i = 0; i < 12; i++) await addSound(guildId, `sound${i}`);
    const interaction = makeInteraction({ subcommand: "list", guild: makeGuild({ id: guildId }) });
    await soundboard.execute(interaction);
    expect(paginate).toHaveBeenCalledTimes(1);
    const [, opts] = paginate.mock.calls[0] as [any, any];
    expect(opts.items).toHaveLength(12);
    expect(opts.itemsPerPage).toBe(10);
  });
});

describe("/soundboard remove", () => {
  it("blocks members without Manage Guild", async () => {
    const interaction = makeInteraction({ subcommand: "remove", options: { name: "x" }, permissions: [] });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Guild/i);
  });

  it("reports when removing a sound that does not exist", async () => {
    const interaction = makeInteraction({
      subcommand: "remove",
      options: { name: "ghost" },
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Sound Not Found/i);
  });

  it("removes an existing sound", async () => {
    const guildId = "sb-rm-1";
    await addSound(guildId, "byebye");
    const interaction = makeInteraction({
      subcommand: "remove",
      options: { name: "byebye" },
      permissions: [PermissionFlagsBits.ManageGuild],
      guild: makeGuild({ id: guildId }),
    });
    await soundboard.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Sound Removed/i);
    const data = soundboard.getSoundboardData() as Record<string, any>;
    expect(data[guildId]?.byebye).toBeUndefined();
  });
});
