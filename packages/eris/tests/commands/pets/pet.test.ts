import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction, makeUser } from "../../_helpers/mockDiscord.js";

const db = vi.hoisted(() => ({
  getPet: vi.fn(),
  createPet: vi.fn(),
  feedPet: vi.fn(),
  trainPet: vi.fn(),
  updateBalance: vi.fn(),
  checkCooldown: vi.fn(),
  setCooldown: vi.fn(),
  getBalance: vi.fn(),
  getPetBattleStats: vi.fn(),
  recordPetBattle: vi.fn(),
  updatePet: vi.fn(),
}));
const visuals = vi.hoisted(() => ({
  petBattleRoundEmbed: vi.fn(),
  petBattleResultEmbed: vi.fn(),
  animateEmbed: vi.fn(),
}));
// pet.js runs SPECIES_MAP = { cat: PET_SPECIES.find(...), ... } at MODULE LOAD,
// so PET_SPECIES must be a real array. Provide the species names the map reads.
const stocks = vi.hoisted(() => ({
  PET_SPECIES: [
    { name: "Shadow Cat", emoji: "🐈", evolvesTo: "Void Cat", evolveLevel: 10 },
    { name: "Tiny Dragon", emoji: "🐉", evolvesTo: "Elder Dragon", evolveLevel: 15 },
    { name: "Neon Fox", emoji: "🦊", evolvesTo: "Plasma Fox", evolveLevel: 12 },
    { name: "Ghost Bunny", emoji: "🐇", evolvesTo: "Wraith Bunny", evolveLevel: 12 },
  ],
  getPetXpForLevel: vi.fn((lvl: number) => lvl * 100),
}));

vi.mock("../../../database.js", () => db);
vi.mock("../../../ai/gameVisuals.js", () => visuals);
vi.mock("../../../ai/stocks.js", () => stocks);

import { execute, data } from "../../../commands/pets/pet.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

function petInteraction(subcommand: string, opts: Record<string, any> = {}) {
  return makeInteraction({ commandName: "pet", subcommand, options: opts });
}

describe("pet command", () => {
  beforeEach(() => {
    for (const k of Object.keys(db)) (db as any)[k].mockReset();
    db.updateBalance.mockResolvedValue(undefined);
    db.updatePet.mockResolvedValue(undefined);
    db.recordPetBattle.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the pet command with subcommands", () => {
    expect(data.name).toBe("pet");
  });

  it("adopt refuses when the user already owns a pet", async () => {
    db.getPet.mockResolvedValue({ name: "Rex" });
    const interaction = petInteraction("adopt", { name: "Spot", species: "cat" });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you already have **Rex**");
    expect(db.createPet).not.toHaveBeenCalled();
  });

  it("adopt creates a pet and confirms when none exists", async () => {
    db.getPet.mockResolvedValue(null);
    db.createPet.mockResolvedValue({ name: "Spot" });
    const interaction = petInteraction("adopt", { name: "Spot", species: "cat" });
    await execute(interaction);

    expect(db.createPet).toHaveBeenCalledWith(interaction.user.id, "Spot", "cat");
    // The success path replies with a plain string (not an object).
    const reply = lastReply(interaction);
    const text = typeof reply === "string" ? reply : reply.content;
    expect(text).toContain("you adopted **Spot**");
  });

  it("feed tells the user to adopt when they have no pet", async () => {
    db.feedPet.mockResolvedValue(null);
    const interaction = petInteraction("feed");
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("/pet adopt");
    expect(db.updatePet).not.toHaveBeenCalled();
  });

  it("train is blocked while on cooldown", async () => {
    db.checkCooldown.mockReturnValue({ onCooldown: true, remainingMs: 120_000 });
    const interaction = petInteraction("train", { stat: "attack" });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("training cooldown");
    expect(db.trainPet).not.toHaveBeenCalled();
    expect(db.updateBalance).not.toHaveBeenCalled();
  });

  it("train refuses when the user can't afford the 100-coin cost", async () => {
    db.checkCooldown.mockReturnValue({ onCooldown: false });
    db.getBalance.mockResolvedValue({ balance: 40 });
    const interaction = petInteraction("train", { stat: "attack" });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("training costs 100 coins");
    expect(db.trainPet).not.toHaveBeenCalled();
    expect(db.updateBalance).not.toHaveBeenCalled();
  });

  it("train charges 100 coins and reports the gain on success", async () => {
    db.checkCooldown.mockReturnValue({ onCooldown: false });
    db.getBalance.mockResolvedValue({ balance: 500 });
    db.trainPet.mockResolvedValue({ gain: 2, newValue: 7 });
    db.getPet.mockResolvedValue({ xp: 0 });
    const interaction = petInteraction("train", { stat: "speed" });
    await execute(interaction);

    expect(db.trainPet).toHaveBeenCalledWith(interaction.user.id, "speed");
    expect(db.updateBalance).toHaveBeenCalledWith(interaction.user.id, -100, "pet_train", "speed");
    expect(db.setCooldown).toHaveBeenCalledWith(interaction.user.id, "pet_train");
  });

  it("battle refuses self-battle", async () => {
    const interaction = makeInteraction({ commandName: "pet", subcommand: "battle" });
    // opponent option resolves to the same user as the caller.
    (interaction.options.getUser as any) = vi.fn(() => ({ id: interaction.user.id, bot: false }));
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you cant battle yourself");
    expect(db.getPetBattleStats).not.toHaveBeenCalled();
  });

  it("battle refuses battling a bot", async () => {
    const interaction = petInteraction("battle", { opponent: makeUser({ bot: true }) });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("bots dont have pets");
    expect(db.getPetBattleStats).not.toHaveBeenCalled();
  });

  it("evolve refuses below the required level", async () => {
    // SPECIES_MAP is keyed by the SIMPLE species name ("cat"), which maps to the
    // PET_SPECIES "Shadow Cat" entry (evolvesTo set, evolveLevel 10). xp 0 => level 1,
    // so it is below the requirement and the level gate fires.
    db.getPet.mockResolvedValue({ species: "cat", xp: 0 });
    const interaction = petInteraction("evolve");
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("needs to be level");
    expect(db.updatePet).not.toHaveBeenCalled();
  });

  it("evolve rejects a species that cannot evolve", async () => {
    // An unknown species key has no SPECIES_MAP entry => speciesInfo undefined =>
    // the "can't evolve" branch.
    db.getPet.mockResolvedValue({ species: "rock", xp: 999999 });
    const interaction = petInteraction("evolve");
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("can't evolve");
    expect(db.updatePet).not.toHaveBeenCalled();
  });
});
