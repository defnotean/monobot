// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const getInventory = vi.fn();
vi.mock("../../../database.js", () => ({ getInventory: (...a: any[]) => getInventory(...a) }));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/inventory.js"));
});

describe("economy/inventory", () => {
  it("registers /inventory with an optional user option", () => {
    const json = data.toJSON();
    expect(json.name).toBe("inventory");
    const userOpt = json.options.find((o: any) => o.name === "user");
    expect(userOpt.required).toBe(false);
  });

  it("tells you to shop when your own inventory is empty (first-person)", async () => {
    getInventory.mockResolvedValue([]);
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }) });
    await execute(interaction);
    expect(getInventory).toHaveBeenCalledWith("u1");
    expect(getLastReplyContent(interaction)).toContain("you have nothing");
  });

  it("uses third-person empty message when checking someone else", async () => {
    getInventory.mockResolvedValue([]);
    const target = makeUser({ id: "u2", username: "bob" });
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }), options: { user: target } });
    await execute(interaction);
    expect(getInventory).toHaveBeenCalledWith("u2");
    expect(getLastReplyContent(interaction)).toContain("bob has nothing");
  });

  it("groups duplicate items with counts in an embed", async () => {
    getInventory.mockResolvedValue([
      { item_name: "Sword" },
      { item_name: "Potion" },
      { item_name: "Potion" },
      { item_name: "Potion" },
    ]);
    const interaction = makeInteraction({ user: makeUser({ id: "u1", username: "alice" }) });
    await execute(interaction);
    const embed = getLastReply(interaction)?.payload.embeds[0];
    const json = embed.toJSON ? embed.toJSON() : embed.data;
    expect(json.title).toContain("alice");
    expect(json.description).toContain("Potion x3");
    // singletons have no xN suffix
    expect(json.description).toContain("Sword");
    expect(json.description).not.toContain("Sword x");
  });
});
