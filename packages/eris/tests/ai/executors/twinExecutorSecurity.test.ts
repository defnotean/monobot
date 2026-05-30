import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../../utils/permissions.js", () => ({
  isOwner: vi.fn((id: string) => id === "owner-id"),
}));

vi.mock("@defnotean/shared/twinSign", () => ({
  signTwinRequest: vi.fn(() => ({ "x-twin-signature": "sig", "x-twin-timestamp": "1" })),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/twinExecutor.js";

function permissions(...flags: bigint[]) {
  return { has: (flag: bigint) => flags.includes(flag) };
}

function messageWith(perms: bigint[] = [], authorId = "user-id") {
  return {
    author: { id: authorId },
    guild: { id: "guild-1" },
    channel: { id: "channel-1" },
    member: { permissions: permissions(...perms) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    status: 200,
    json: async () => ({ success: true, result: "ok" }),
  })));
});

describe("twinExecutor relay permissions", () => {
  it("blocks announce without ManageMessages", async () => {
    const result = await execute("ask_irene", { command: "announce", announcement: "hello" }, messageWith(), {});

    expect(result).toMatch(/cute attempt|adorable|wish|dreams|built|power|clearance/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("allows announce with ManageMessages", async () => {
    const result = await execute(
      "ask_irene",
      { command: "announce", announcement: "hello" },
      messageWith([PermissionFlagsBits.ManageMessages]),
      {},
    );

    expect(result).toMatch(/told irene/i);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("blocks role relays without ManageRoles even if command is known", async () => {
    const result = await execute("ask_irene", { command: "give_role", role_name: "VIP" }, messageWith(), {});

    expect(result).toMatch(/cute attempt|adorable|wish|dreams|built|power|clearance/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("lets the bot owner relay any known command", async () => {
    const result = await execute("ask_irene", { command: "give_role", role_name: "VIP" }, messageWith([], "owner-id"), {});

    expect(result).toMatch(/told irene/i);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
