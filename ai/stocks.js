// ─── Pet Species + Boss Definitions ──────────────────────────────────────────
// Despite the filename, this module's live exports are pets and bosses.
// The old legacy stock functions (tickPrice / evilManipulation / formatChange)
// were removed after the live stock market moved to ai/stockMarket.js (GBM
// simulation against bot_data). This file was never renamed, kept as-is to
// avoid churning every pet/boss import; a rename is on the tech-debt list.

// ─── Pet Species Definitions ────────────────────────────────────────────────

export const PET_SPECIES = [
  { name: "Shadow Cat", emoji: "🐈‍⬛", baseStats: { luck: 2 }, evolvesTo: "Void Panther", evolveLevel: 10 },
  { name: "Chaos Goblin", emoji: "👺", baseStats: { steal: 3 }, evolvesTo: "Goblin King", evolveLevel: 10 },
  { name: "Golden Hamster", emoji: "🐹", baseStats: { earn: 2 }, evolvesTo: "Golden Dragon", evolveLevel: 15 },
  { name: "Baby Phoenix", emoji: "🐦‍🔥", baseStats: { defense: 3 }, evolvesTo: "Inferno Phoenix", evolveLevel: 12 },
  { name: "Crystal Slime", emoji: "🫧", baseStats: { luck: 1, earn: 1 }, evolvesTo: "Diamond Slime", evolveLevel: 10 },
  { name: "Neon Fox", emoji: "🦊", baseStats: { steal: 1, luck: 1 }, evolvesTo: "Cyber Fox", evolveLevel: 10 },
  { name: "Tiny Dragon", emoji: "🐉", baseStats: { defense: 2, luck: 1 }, evolvesTo: "Elder Dragon", evolveLevel: 20 },
  { name: "Ghost Bunny", emoji: "👻", baseStats: { earn: 3 }, evolvesTo: "Spectral Hare", evolveLevel: 8 },
];

export function getRandomPetSpecies() {
  return PET_SPECIES[Math.floor(Math.random() * PET_SPECIES.length)];
}

export function getPetXpForLevel(level) {
  return 50 * level * level + 25 * level;
}

// ─── Boss Battle Definitions ────────────────────────────────────────────────

export const BOSSES = [
  { name: "The Debt Collector", emoji: "🦈", hp: 5000, phases: 3, lootMultiplier: 2 },
  { name: "Chaos Dragon", emoji: "🐉", hp: 8000, phases: 3, lootMultiplier: 3 },
  { name: "The RNG God", emoji: "🎲", hp: 3000, phases: 2, lootMultiplier: 1.5 },
  { name: "Mega Slot Machine", emoji: "🎰", hp: 6000, phases: 3, lootMultiplier: 2.5 },
  { name: "Shadow Banker", emoji: "🏦", hp: 10000, phases: 4, lootMultiplier: 4 },
  { name: "The Void Entity", emoji: "🌑", hp: 4000, phases: 2, lootMultiplier: 2 },
];

export function getRandomBoss() {
  return BOSSES[Math.floor(Math.random() * BOSSES.length)];
}

export function calculateDamage(attackerLevel = 1, hasWeapon = false) {
  const baseDamage = 50 + Math.floor(Math.random() * 100);
  const levelBonus = attackerLevel * 10;
  const weaponBonus = hasWeapon ? 100 : 0;
  const critChance = Math.random();
  const crit = critChance < 0.1 ? 2 : 1; // 10% crit chance
  return Math.floor((baseDamage + levelBonus + weaponBonus) * crit);
}
