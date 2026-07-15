import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits, PermissionsBitField } from "discord.js";

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../utils/embeds.js", () => ({
  warnEmbed: vi.fn(),
  logEmbed: vi.fn(),
  LC: {},
}));

// @ts-expect-error — JS module without types
import { lockdownServer, unlockServer } from "../../utils/raid.js";

let sequence = 0;

function overwriteState(sendMessages: boolean | null, connect: boolean | null) {
  const allow: bigint[] = [];
  const deny: bigint[] = [PermissionFlagsBits.ViewChannel];
  if (sendMessages === true) allow.push(PermissionFlagsBits.SendMessages);
  if (sendMessages === false) deny.push(PermissionFlagsBits.SendMessages);
  if (connect === true) allow.push(PermissionFlagsBits.Connect);
  if (connect === false) deny.push(PermissionFlagsBits.Connect);
  return {
    allow: new PermissionsBitField(allow),
    deny: new PermissionsBitField(deny),
  };
}

function makeGuild(sendMessages: boolean | null, connect: boolean | null) {
  const everyone = { id: "everyone" };
  const overwrite = overwriteState(sendMessages, connect);
  const channel = {
    id: `channel-${++sequence}`,
    isTextBased: () => true,
    isVoiceBased: () => true,
    permissionOverwrites: {
      cache: new Collection([[everyone.id, overwrite]]),
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  };
  const guild = {
    id: `guild-${sequence}`,
    roles: { everyone },
    channels: { cache: new Collection([[channel.id, channel]]) },
  };
  return { guild, channel, everyone };
}

describe("enhanced raid lockdown ACL restoration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores only the permissions changed by lockdown and never deletes the overwrite", async () => {
    const { guild, channel, everyone } = makeGuild(null, true);

    await lockdownServer(guild);
    await unlockServer(guild);

    expect(channel.permissionOverwrites.edit).toHaveBeenNthCalledWith(1, everyone, {
      SendMessages: false,
      Connect: false,
    });
    expect(channel.permissionOverwrites.edit).toHaveBeenNthCalledWith(2, everyone, {
      SendMessages: null,
      Connect: true,
    });
    expect(channel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it("does not overwrite the original snapshot when lockdown is triggered repeatedly", async () => {
    const { guild, channel, everyone } = makeGuild(false, null);

    await lockdownServer(guild);
    await lockdownServer(guild);
    await unlockServer(guild);

    expect(channel.permissionOverwrites.edit).toHaveBeenLastCalledWith(everyone, {
      SendMessages: false,
      Connect: null,
    });
  });

  it("fails closed when no pre-lockdown snapshot exists", async () => {
    const { guild, channel } = makeGuild(null, null);

    await expect(unlockServer(guild)).resolves.toBe(false);

    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it("retains a snapshot after a failed restore so a retry can recover it", async () => {
    const { guild, channel } = makeGuild(true, null);
    channel.permissionOverwrites.edit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient Discord failure"))
      .mockResolvedValueOnce(undefined);

    await lockdownServer(guild);
    await expect(unlockServer(guild)).resolves.toBe(false);
    await expect(unlockServer(guild)).resolves.toBe(true);

    expect(channel.permissionOverwrites.edit).toHaveBeenCalledTimes(3);
  });
});
