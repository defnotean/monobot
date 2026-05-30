import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";

vi.mock("../../database.js", () => ({
  getShopItems: vi.fn(),
  getBalance: vi.fn(async () => ({ balance: 10_000 })),
  hasItem: vi.fn(async () => false),
  getPet: vi.fn(async () => ({ name: "pet" })),
  tryDecrementShopStock: vi.fn(async () => ({ ok: true })),
  tryIncrementShopStock: vi.fn(async () => ({ ok: true })),
  updateBalance: vi.fn(async () => {}),
  unlockAchievement: vi.fn(async () => {}),
  addToInventory: vi.fn(async () => {}),
}));

import * as db from "../../database.js";
import { executeEconomyTool } from "../../ai/economyExecutor.js";

function permissions(...flags: bigint[]) {
  return { has: (flag: bigint) => flags.includes(flag) };
}

function role({ id, name, position = 1, perms = [] as bigint[] }: any) {
  return {
    id,
    name,
    position,
    permissions: permissions(...perms),
  };
}

function messageWithRole(shopRole: any) {
  const roles = new Collection<string, any>([[shopRole.id, shopRole]]);
  const memberRoles = { add: vi.fn(async () => {}) };
  const guild = {
    id: "guild-1",
    roles: { cache: roles },
    members: {
      me: {
        permissions: permissions(PermissionFlagsBits.ManageRoles),
        roles: { highest: { position: 100 } },
      },
    },
  };
  return {
    guild,
    author: { id: "user-1" },
    member: { roles: memberRoles },
    channel: { send: vi.fn(async () => {}) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("economy role shop safety", () => {
  it("does not sell roles with elevated permissions", async () => {
    const adminRole = role({
      id: "role-admin",
      name: "Adminish",
      perms: [PermissionFlagsBits.ManageRoles],
    });
    vi.mocked(db.getShopItems).mockResolvedValue([
      { id: "item-1", name: "Admin Role", type: "role", role_id: adminRole.id, price: 100, limited_stock: null } as any,
    ]);
    const message = messageWithRole(adminRole);

    const result = await executeEconomyTool("shop_buy", { item: "admin" }, message);

    expect(result).toMatch(/elevated permissions/i);
    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(message.member.roles.add).not.toHaveBeenCalled();
  });

  it("sells harmless role items", async () => {
    const memberRole = role({ id: "role-member", name: "Member" });
    vi.mocked(db.getShopItems).mockResolvedValue([
      { id: "item-1", name: "Member Role", type: "role", role_id: memberRole.id, price: 100, limited_stock: null } as any,
    ]);
    const message = messageWithRole(memberRole);

    const result = await executeEconomyTool("shop_buy", { item: "member" }, message);

    expect(result).toMatch(/bought|purchased|member role/i);
    expect(db.updateBalance).toHaveBeenCalled();
    expect(message.member.roles.add).toHaveBeenCalledWith(memberRole.id);
  });
});
