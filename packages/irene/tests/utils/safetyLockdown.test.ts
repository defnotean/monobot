import { describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits, PermissionsBitField } from "discord.js";

vi.mock("../../database.js", () => ({
  getBadWords: vi.fn(() => []),
  saveLockdown: vi.fn(),
  clearLockdown: vi.fn(),
  saveSlowmode: vi.fn(),
  clearSlowmode: vi.fn(),
}));
vi.mock("../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}) }));

// @ts-expect-error — JS module without types
import { activateLockdown, deactivateLockdown } from "../../utils/safety.js";

let sequence = 0;

function makeGuild(sendMessages: boolean | null) {
  const everyone = { id: "everyone" };
  const allow: bigint[] = [];
  const deny: bigint[] = [PermissionFlagsBits.ViewChannel];
  if (sendMessages === true) allow.push(PermissionFlagsBits.SendMessages);
  if (sendMessages === false) deny.push(PermissionFlagsBits.SendMessages);
  const overwrite = {
    allow: new PermissionsBitField(allow),
    deny: new PermissionsBitField(deny),
  };
  const channel = {
    id: `channel-${++sequence}`,
    isTextBased: () => true,
    isThread: () => false,
    permissionOverwrites: {
      cache: new Collection([[everyone.id, overwrite]]),
      edit: vi.fn(async () => {}),
    },
  };
  const channels = new Collection([[channel.id, channel]]);
  const guild = {
    id: `guild-${sequence}`,
    roles: { everyone },
    channels: { cache: channels },
  };
  return { guild, channel, everyone };
}

describe("basic lockdown ACL restoration", () => {
  it.each([
    [false, false],
    [null, null],
    [true, true],
  ] as const)("restores an original SendMessages=%s state", async (initial, expected) => {
    const { guild, channel, everyone } = makeGuild(initial);

    expect(await activateLockdown(guild)).toBe(true);
    expect(await deactivateLockdown(guild)).toBe(true);

    expect(channel.permissionOverwrites.edit).toHaveBeenNthCalledWith(1, everyone, { SendMessages: false });
    expect(channel.permissionOverwrites.edit).toHaveBeenNthCalledWith(2, everyone, { SendMessages: expected });
  });

  it("retains failed restoration state and succeeds on a later retry", async () => {
    const { guild, channel } = makeGuild(true);
    channel.permissionOverwrites.edit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient Discord failure"))
      .mockResolvedValueOnce(undefined);

    expect(await activateLockdown(guild)).toBe(true);
    expect(await deactivateLockdown(guild)).toBe(false);
    expect(await deactivateLockdown(guild)).toBe(true);

    expect(channel.permissionOverwrites.edit).toHaveBeenLastCalledWith(
      guild.roles.everyone,
      { SendMessages: true },
    );
  });
});
