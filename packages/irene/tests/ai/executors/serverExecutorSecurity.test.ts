import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";

vi.mock("@defnotean/shared/safeFetch", () => ({
  safeFetch: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/serverExecutor.js";
import { safeFetch } from "@defnotean/shared/safeFetch";
import { makeChannel, makeGuild, makeMember, makePermissions, makeUser } from "../../_helpers/mockDiscord.js";

const mockSafeFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;

function buildHarness(memberPermissions: bigint[] = []) {
  const channel = makeChannel({
    id: "channel-1",
    name: "general",
    createInvite: vi.fn(async () => ({ code: "abc123" })),
  });
  const guild = makeGuild({
    channels: [channel],
    ownerId: "owner",
  });
  guild.invites = { fetch: vi.fn(async () => new Collection()) };
  guild.edit = vi.fn(async () => {});
  guild.setIcon = vi.fn(async () => {});
  guild.fetchAuditLogs = vi.fn(async () => ({ entries: new Collection() }));
  channel.guild = guild;

  const member = makeMember({
    user: makeUser({ id: "caller", username: "caller", tag: "caller#0001" }),
    guild,
    permissions: memberPermissions,
  });
  guild.members.cache.set(member.id, member);
  const message = {
    guild,
    member,
    author: member.user,
    channel,
  };
  const ctx = {
    guild,
    by: "by test",
    findChannel: vi.fn((g: any, name: string) => g.channels.cache.find((c: any) => c.name.toLowerCase() === name.toLowerCase()) ?? null),
  };
  return { guild, channel, message, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("serverExecutor security gates", () => {
  it("blocks trusted/upstream-only callers from creating invites without CreateInstantInvite", async () => {
    const { channel, message, ctx } = buildHarness([PermissionFlagsBits.ManageGuild]);

    const result = await execute("create_invite", { channel_name: "general" }, message, ctx);

    expect(result).toMatch(/permission denied/i);
    expect(channel.createInvite).not.toHaveBeenCalled();
  });

  it("allows create_invite with the exact Discord permission", async () => {
    const { channel, message, ctx } = buildHarness([PermissionFlagsBits.CreateInstantInvite]);

    const result = await execute("create_invite", { channel_name: "general", max_uses: 1 }, message, ctx);

    expect(result).toContain("discord.gg/abc123");
    expect(channel.createInvite).toHaveBeenCalled();
  });

  it("requires ViewAuditLog for audit-log reads", async () => {
    const { guild, message, ctx } = buildHarness([PermissionFlagsBits.ManageGuild]);

    const result = await execute("view_audit_log", { count: 5 }, message, ctx);

    expect(result).toMatch(/permission denied/i);
    expect(guild.fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("downloads server icons through safeFetch with a binary size cap", async () => {
    const { guild, message, ctx } = buildHarness([PermissionFlagsBits.ManageGuild]);
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: new Map([["content-type", "image/png"]]),
      bytes: Buffer.from("fake image"),
      url: "https://cdn.example/icon.png",
    });

    const result = await execute("set_server_icon", { url: "https://cdn.example/icon.png" }, message, ctx);

    expect(result).toMatch(/updated/i);
    expect(mockSafeFetch).toHaveBeenCalledWith("https://cdn.example/icon.png", expect.objectContaining({
      binary: true,
      maxBytes: 8 * 1024 * 1024,
    }));
    expect(guild.setIcon).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
  });

  it("rejects non-image server icon responses", async () => {
    const { guild, message, ctx } = buildHarness([PermissionFlagsBits.ManageGuild]);
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      bytes: Buffer.from("<html></html>"),
      url: "https://example.com/not-image",
    });

    const result = await execute("set_server_icon", { url: "https://example.com/not-image" }, message, ctx);

    expect(result).toMatch(/did not return an image/i);
    expect(guild.setIcon).not.toHaveBeenCalled();
  });
});
