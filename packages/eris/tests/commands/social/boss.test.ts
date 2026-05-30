import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  getBalance: vi.fn(),
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  getActiveBoss: vi.fn(),
  spawnBoss: vi.fn(),
  damageBoss: vi.fn(),
  getPetBattleStats: vi.fn(),
}));

vi.mock("../../../ai/gameVisuals.js", () => ({
  bossEmbed: vi.fn(() => {
    const embed: any = {
      data: { description: "BOSS DESC", fields: [] },
      setDescription: vi.fn((d: string) => {
        embed.data.description = d;
        return embed;
      }),
      addFields: vi.fn((...fields: any[]) => {
        // discord.js accepts either addFields(...objs) or addFields([objs]).
        embed.data.fields.push(...fields.flat());
        return embed;
      }),
    };
    return { embed, row: { components: [] } };
  }),
}));

vi.mock("../../../ai/stocks.js", () => ({
  getRandomBoss: vi.fn(() => ({
    name: "Crypto Dragon",
    emoji: "🐉",
    hp: 1000,
    phases: 4,
    lootMultiplier: 2,
  })),
  calculateDamage: vi.fn(() => 100),
}));

import { makeInteraction, makeUser, makeGuild, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { execute } from "../../../commands/social/boss.js";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("boss command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateBalance.mockResolvedValue(0);
    m.tryDeductBalance.mockImplementation(async (uid: string, amount: number, type: string, detail: string) => {
      const wallet = await m.getBalance(uid);
      const balance = wallet?.balance ?? 0;
      if (balance < amount) return { ok: false, reason: "insufficient", balance };
      await m.updateBalance(uid, -amount, type, detail);
      return { ok: true, newBalance: balance - amount };
    });
  });

  it("rejects use outside a server (no guild)", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
    expect(m.getActiveBoss).not.toHaveBeenCalled();
  });

  describe("spawn", () => {
    it("refuses when a boss is already active", async () => {
      m.getActiveBoss.mockResolvedValue({ boss_name: "Goblin", boss_hp: 50, max_hp: 100 });
      const interaction: any = makeInteraction({ subcommand: "spawn" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/already an active boss.*Goblin/i);
      expect(m.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses when the spawner can't afford 500 coins", async () => {
      m.getActiveBoss.mockResolvedValue(null);
      m.getBalance.mockResolvedValue({ balance: 499 });
      const interaction: any = makeInteraction({ subcommand: "spawn" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/costs 500 coins/i);
      expect(m.spawnBoss).not.toHaveBeenCalled();
    });

    it("reports failure if spawnBoss returns falsy after charging", async () => {
      m.getActiveBoss.mockResolvedValue(null);
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.spawnBoss.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "spawn", user: makeUser({ id: "u1" }) });
      await execute(interaction);
      expect(m.updateBalance).toHaveBeenCalledWith("u1", -500, "boss_spawn", "Crypto Dragon");
      expect(getLastReplyContent(interaction)).toMatch(/failed to spawn boss/i);
    });

    it("spawns the boss, charges the user, and posts the embed", async () => {
      m.getActiveBoss.mockResolvedValue(null);
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.spawnBoss.mockResolvedValue({ id: "boss-1" });
      const interaction: any = makeInteraction({ subcommand: "spawn", user: makeUser({ id: "u1" }) });
      await execute(interaction);
      expect(m.spawnBoss).toHaveBeenCalledWith(
        interaction.guild.id, "Crypto Dragon", "🐉", 1000, 4, 2,
      );
      const payload = getLastReply(interaction)?.payload;
      expect(payload.embeds).toHaveLength(1);
    });
  });

  describe("attack", () => {
    it("refuses when there is no active boss", async () => {
      m.getActiveBoss.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "attack" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no active boss/i);
      expect(m.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses when the attacker can't afford 10 coins", async () => {
      m.getActiveBoss.mockResolvedValue({ id: "b", boss_name: "X", max_hp: 100 });
      m.getBalance.mockResolvedValue({ balance: 9 });
      const interaction: any = makeInteraction({ subcommand: "attack" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/attacking costs 10 coins/i);
      expect(m.damageBoss).not.toHaveBeenCalled();
    });

    it("reports 'already defeated' when damageBoss says so", async () => {
      m.getActiveBoss.mockResolvedValue({ id: "b", boss_name: "X", max_hp: 100 });
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.getPetBattleStats.mockResolvedValue(null);
      m.damageBoss.mockResolvedValue({ alreadyDead: true });
      const interaction: any = makeInteraction({ subcommand: "attack" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/already defeated/i);
    });

    it("adds a pet bonus to the damage dealt", async () => {
      m.getActiveBoss.mockResolvedValue({ id: "b", boss_name: "X", max_hp: 100, phase: 1 });
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.getPetBattleStats.mockResolvedValue({ attack: 20 }); // bonus = floor(20*1.5)=30
      m.damageBoss.mockResolvedValue({ defeated: false, phase: 1, boss_hp: 50 });
      const interaction: any = makeInteraction({ subcommand: "attack", user: makeUser({ id: "u1" }) });
      await execute(interaction);
      // calculateDamage mocked to 100, + pet bonus 30 = 130 total.
      expect(m.damageBoss).toHaveBeenCalledWith("b", "u1", 130);
      const content = getLastReplyContent(interaction);
      expect(content).toMatch(/Pet bonus: \+30/);
    });

    it("distributes loot proportionally on defeat", async () => {
      const boss = { id: "b", boss_name: "Dragon", boss_emoji: "🐉", max_hp: 1000, loot_multiplier: 2, phase: 3 };
      m.getActiveBoss.mockResolvedValue(boss);
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.getPetBattleStats.mockResolvedValue(null);
      // participants: u1 dealt 150, u2 dealt 50 -> total 200
      m.damageBoss.mockResolvedValue({
        defeated: true,
        phase: 3,
        participants: { u1: 150, u2: 50 },
      });
      const guild = makeGuild();
      // displayName lookups
      guild.members.cache.set("u1", { displayName: "Alice" } as any);
      guild.members.cache.set("u2", { displayName: "Bob" } as any);

      const interaction: any = makeInteraction({
        subcommand: "attack",
        user: makeUser({ id: "u1", username: "alice" }),
        guild,
      });
      await execute(interaction);

      // totalLoot = floor(1000 * 2 * 0.1) = 200
      // u1 share = floor(200 * 150/200) = 150 ; u2 = floor(200 * 50/200) = 50
      expect(m.updateBalance).toHaveBeenCalledWith("u1", 150, "boss_loot", "Dragon");
      expect(m.updateBalance).toHaveBeenCalledWith("u2", 50, "boss_loot", "Dragon");
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/DEFEATED/);
      const lootField = data.fields.find((f: any) => f.name === "💰 Loot Distribution");
      expect(lootField.value).toMatch(/Alice/);
      expect(lootField.value).toMatch(/Bob/);
    });

    it("shows a phase-change notice when the boss escalates phase", async () => {
      m.getActiveBoss.mockResolvedValue({ id: "b", boss_name: "X", max_hp: 100, phase: 1 });
      m.getBalance.mockResolvedValue({ balance: 1000 });
      m.getPetBattleStats.mockResolvedValue(null);
      m.damageBoss.mockResolvedValue({ defeated: false, phase: 2, boss_hp: 40 });
      const interaction: any = makeInteraction({ subcommand: "attack" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/Phase 2/);
    });
  });

  describe("status", () => {
    it("reports when there is no active boss", async () => {
      m.getActiveBoss.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "status" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no active boss right now/i);
    });

    it("renders the boss embed with a sorted top-attacker list", async () => {
      m.getActiveBoss.mockResolvedValue({
        id: "b", boss_name: "Dragon", boss_emoji: "🐉", boss_hp: 300, max_hp: 1000, phase: 2,
        participants: { u1: 50, u2: 200 },
      });
      const guild = makeGuild();
      guild.members.cache.set("u1", { displayName: "Alice" } as any);
      guild.members.cache.set("u2", { displayName: "Bob" } as any);
      const interaction: any = makeInteraction({ subcommand: "status", guild });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      const attackers = data.fields.find((f: any) => f.name === "Top Attackers");
      // Bob (200) should be ranked above Alice (50)
      expect(attackers.value.indexOf("Bob")).toBeLessThan(attackers.value.indexOf("Alice"));
      const phaseField = data.fields.find((f: any) => f.name === "Phase");
      expect(phaseField.value).toMatch(/Enraged/);
    });
  });
});
