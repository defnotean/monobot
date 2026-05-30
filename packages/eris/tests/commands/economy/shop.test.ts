// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// Provide a deterministic shop catalog so the pure builder functions are testable.
const SHOP_ITEMS = [
  { name: "Iron Sword", type: "equipment", price: 100, emoji: "⚔️", description: "A basic sword" },
  { name: "Steel Sword", type: "equipment", price: 5000, emoji: "🗡️", description: "Sharper" },
  { name: "Health Potion", type: "consumable", price: 50, emoji: "🧪", description: "Heals you" },
  { name: "Leash", type: "pet_gear", price: 200, emoji: "🦮", description: "Pet item", requires: "pet" },
  { name: "Lockpick", type: "equipment", price: 300, emoji: "🔓", description: "Needs sword", requires: "Iron Sword" },
];
vi.mock("../../../ai/economy.js", () => ({ DEFAULT_SHOP_ITEMS: SHOP_ITEMS }));

// database is dynamically imported inside execute()
const getBalance = vi.fn();
const getInventory = vi.fn();
const getPet = vi.fn();
vi.mock("../../../database.js", () => ({
  getBalance: (...a: any[]) => getBalance(...a),
  getInventory: (...a: any[]) => getInventory(...a),
  getPet: (...a: any[]) => getPet(...a),
}));

import { makeInteraction, makeUser, getLastReply } from "../../_helpers/mockDiscord.js";

let mod: any;
beforeEach(async () => {
  vi.clearAllMocks();
  mod = await import("../../../commands/economy/shop.js");
});

describe("economy/shop pure helpers", () => {
  it("getItemsForCategory filters by the category's type list and returns [] for unknown", () => {
    expect(mod.getItemsForCategory("equipment").map((i: any) => i.name)).toEqual([
      "Iron Sword",
      "Steel Sword",
      "Lockpick",
    ]);
    expect(mod.getItemsForCategory("nope")).toEqual([]);
  });

  it("checkRequirement honors pet and item prerequisites", () => {
    expect(mod.checkRequirement(null, null, false)).toBe(true);
    expect(mod.checkRequirement("pet", null, true)).toBe(true);
    expect(mod.checkRequirement("pet", null, false)).toBe(false);
    expect(mod.checkRequirement("Iron Sword", new Set(["Iron Sword"]), false)).toBe(true);
    expect(mod.checkRequirement("Iron Sword", new Set(), false)).toBe(false);
  });

  it("isItemBuyable blocks owned unique items and unmet requirements", () => {
    const sword = SHOP_ITEMS[0]; // equipment (unique)
    expect(mod.isItemBuyable(sword, new Set(["Iron Sword"]), false)).toBe(false); // already owned
    expect(mod.isItemBuyable(sword, new Set(), false)).toBe(true);
    const leash = SHOP_ITEMS[3]; // requires pet
    expect(mod.isItemBuyable(leash, new Set(), false)).toBe(false); // no pet
    expect(mod.isItemBuyable(leash, new Set(), true)).toBe(true); // has pet
  });

  it("buildCategoryEmbed returns null for unknown/empty categories", () => {
    expect(mod.buildCategoryEmbed("nope")).toBeNull();
    // a real category with no matching items
    expect(mod.buildCategoryEmbed("gambling")).toBeNull();
  });

  it("buildCategoryEmbed marks owned and cant-afford items", () => {
    const result = mod.buildCategoryEmbed("equipment", 0, 200, new Set(["Iron Sword"]), false);
    expect(result).toBeTruthy();
    const desc = (result.embed.toJSON ? result.embed.toJSON() : result.embed.data).description;
    expect(desc).toContain("Iron Sword"); // owned -> ✅
    expect(desc).toContain("✅");
    expect(desc).toContain("✘"); // Steel Sword at 5000 with balance 200 unaffordable
  });

  it("buildCategoryEmbed marks an item with an unmet requirement as locked", () => {
    // Leash (pet category) requires a pet; user has none -> 🔒 + needs-a-pet note
    const result = mod.buildCategoryEmbed("pet", 0, 100000, new Set(), false);
    expect(result).toBeTruthy();
    const desc = (result.embed.toJSON ? result.embed.toJSON() : result.embed.data).description;
    expect(desc).toContain("🔒");
    expect(desc).toContain("needs a pet");
  });

  it("buildItemSelect returns null when nothing is buyable", () => {
    // single owned unique item -> no buyable options
    const sel = mod.buildItemSelect([SHOP_ITEMS[0]], "equipment", 0, new Set(["Iron Sword"]), false);
    expect(sel).toBeNull();
  });

  it("buildItemSelect builds a select with sanitized item values", () => {
    const sel = mod.buildItemSelect([SHOP_ITEMS[2]], "consumable", 0, new Set(), false);
    expect(sel).not.toBeNull();
    const json = sel.toJSON();
    const opt = json.components[0].options[0];
    expect(opt.value).toBe("health_potion"); // lowercased, non-alnum -> _
    expect(opt.label).toContain("Health Potion");
  });

  it("buildPageRow returns null with a single page and buttons otherwise", () => {
    expect(mod.buildPageRow("equipment", 0, 1)).toBeNull();
    const row = mod.buildPageRow("equipment", 1, 3);
    expect(row).not.toBeNull();
    const json = row.toJSON();
    // prev enabled on page 1, next enabled (page 1 < 2)
    expect(json.components.length).toBe(2);
  });

  it("buildCategoryComponents always includes the nav select first", () => {
    const rows = mod.buildCategoryComponents("equipment", 0, mod.getItemsForCategory("equipment"), 1, new Set(), false);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const navJson = rows[0].toJSON();
    expect(navJson.components[0].custom_id).toBe("shop_nav");
  });
});

describe("economy/shop execute", () => {
  it("shows the overview when no category is chosen", async () => {
    getBalance.mockResolvedValue({ balance: 999 });
    getInventory.mockResolvedValue([]);
    getPet.mockResolvedValue(null);
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }), options: {} });
    await mod.execute(interaction);
    expect(getBalance).toHaveBeenCalledWith("u1");
    const payload = getLastReply(interaction)?.payload;
    const embedJson = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data;
    expect(embedJson.title).toContain("Shop");
    // one nav select row
    expect(payload.components[0].toJSON().components[0].custom_id).toBe("shop_nav");
  });

  it("jumps to a category view when category option is supplied", async () => {
    getBalance.mockResolvedValue({ balance: 100000 });
    getInventory.mockResolvedValue([{ item_name: "Iron Sword" }]);
    getPet.mockResolvedValue({ id: "pet1" });
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }), options: { category: "equipment" } });
    await mod.execute(interaction);
    const payload = getLastReply(interaction)?.payload;
    const embedJson = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data;
    expect(embedJson.title).toContain("Equipment");
  });

  it("replies 'empty category' for a category with no items", async () => {
    getBalance.mockResolvedValue({ balance: 1 });
    getInventory.mockResolvedValue([]);
    getPet.mockResolvedValue(null);
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }), options: { category: "gambling" } });
    await mod.execute(interaction);
    expect(getLastReply(interaction)?.content).toContain("empty category");
  });
});
