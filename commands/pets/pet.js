import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle , MessageFlags } from "discord.js";
import { getPet, createPet, feedPet, trainPet, updateBalance, checkCooldown, setCooldown, getBalance, getPetBattleStats, recordPetBattle, updatePet } from "../../database.js";
import { petBattleRoundEmbed, petBattleResultEmbed, animateEmbed } from "../../ai/gameVisuals.js";
import { PET_SPECIES, getPetXpForLevel } from "../../ai/stocks.js";

// Map simple species names to PET_SPECIES entries for evolution
const SPECIES_MAP = {
  cat: PET_SPECIES.find(s => s.name === "Shadow Cat"),
  dog: PET_SPECIES.find(s => s.emoji === "🐹") ? null : { name: "Storm Hound", emoji: "🐕", evolvesTo: "Thunder Wolf", evolveLevel: 12 },
  dragon: PET_SPECIES.find(s => s.name === "Tiny Dragon"),
  fox: PET_SPECIES.find(s => s.name === "Neon Fox"),
  owl: { name: "Mystic Owl", emoji: "🦉", evolvesTo: "Cosmic Owl", evolveLevel: 12 },
  wolf: { name: "Dire Wolf", emoji: "🐺", evolvesTo: "Alpha Wolf", evolveLevel: 10 },
  bunny: PET_SPECIES.find(s => s.name === "Ghost Bunny"),
  panda: { name: "Bamboo Panda", emoji: "🐼", evolvesTo: "Iron Panda", evolveLevel: 15 },
};

const SIMPLE_SPECIES = ["cat", "dog", "dragon", "fox", "owl", "wolf", "bunny", "panda"];

function getPetLevel(xp) {
  if (!xp || xp <= 0) return 1;
  // Inverse of 50*level^2 + 25*level = xp → level = floor((-25 + sqrt(625 + 200*xp)) / 100)
  const level = Math.floor((-25 + Math.sqrt(625 + 200 * xp)) / 100);
  return Math.max(1, level);
}

function getHungerDecay(pet) {
  if (!pet.last_fed) return pet.hunger || 50;
  const hoursSinceFed = (Date.now() - new Date(pet.last_fed).getTime()) / 3_600_000;
  const decayed = Math.floor(hoursSinceFed * 5); // -5 per hour
  return Math.max(0, (pet.hunger || 50) - decayed);
}

export const data = new SlashCommandBuilder()
  .setName("pet")
  .setDescription("Manage your pet")
  .addSubcommand(sub => sub
    .setName("adopt")
    .setDescription("Adopt a new pet")
    .addStringOption(opt => opt.setName("name").setDescription("Name your pet").setRequired(true))
    .addStringOption(opt => opt
      .setName("species")
      .setDescription("Choose species")
      .setRequired(true)
      .addChoices(...SIMPLE_SPECIES.map(s => ({ name: s, value: s })))))
  .addSubcommand(sub => sub.setName("feed").setDescription("Feed your pet"))
  .addSubcommand(sub => sub.setName("status").setDescription("Check your pet's stats"))
  .addSubcommand(sub => sub
    .setName("rename")
    .setDescription("Rename your pet")
    .addStringOption(opt => opt.setName("name").setDescription("New name").setRequired(true)))
  .addSubcommand(sub => sub
    .setName("train")
    .setDescription("Train your pet (100 coins)")
    .addStringOption(opt => opt
      .setName("stat")
      .setDescription("Stat to train")
      .setRequired(true)
      .addChoices(
        { name: "attack", value: "attack" },
        { name: "defense", value: "defense" },
        { name: "speed", value: "speed" }
      )))
  .addSubcommand(sub => sub
    .setName("battle")
    .setDescription("Battle your pet against another user's pet")
    .addUserOption(opt => opt.setName("opponent").setDescription("Who to battle").setRequired(true)))
  .addSubcommand(sub => sub.setName("evolve").setDescription("Evolve your pet if it meets the level requirement"));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === "adopt") {
    const existing = await getPet(userId);
    if (existing) return interaction.reply({ content: `you already have **${existing.name}**!`, flags: MessageFlags.Ephemeral });
    const name = interaction.options.getString("name");
    const species = interaction.options.getString("species");
    const pet = await createPet(userId, name, species);
    if (!pet) return interaction.reply({ content: "something went wrong", flags: MessageFlags.Ephemeral });
    const speciesInfo = SPECIES_MAP[species];
    const evolutionHint = speciesInfo?.evolvesTo ? `\nEvolves into **${speciesInfo.evolvesTo}** at level ${speciesInfo.evolveLevel}!` : "";
    return interaction.reply(`🎉 you adopted **${name}** the **${species}**! use \`/pet feed\` and \`/pet train\` to raise them${evolutionHint}`);
  }

  if (sub === "feed") {
    const result = await feedPet(userId);
    if (!result) return interaction.reply({ content: "you dont have a pet — use `/pet adopt`", flags: MessageFlags.Ephemeral });
    // Update last_fed timestamp
    await updatePet(userId, { last_fed: new Date().toISOString() });
    return interaction.reply(`🍖 fed your pet! hunger: ${result.hunger}/100 | mood: ${result.mood}/100 | +5 XP`);
  }

  if (sub === "status") {
    const pet = await getPet(userId);
    if (!pet) return interaction.reply({ content: "you dont have a pet — use `/pet adopt`", flags: MessageFlags.Ephemeral });
    const level = getPetLevel(pet.xp || 0);
    const nextLevelXp = getPetXpForLevel(level + 1);
    const currentXp = pet.xp || 0;
    const hunger = getHungerDecay(pet);
    const speciesInfo = SPECIES_MAP[pet.species];
    const hungerWarning = hunger < 25 ? " ⚠️ HUNGRY!" : "";
    const moodWarning = (pet.mood || 50) < 25 ? " ⚠️ UNHAPPY!" : "";

    const embed = new EmbedBuilder()
      .setTitle(`${speciesInfo?.emoji || "🐾"} ${pet.name} the ${pet.species}`)
      .setColor(level >= 10 ? 0xFFD700 : 0x9333EA)
      .addFields(
        { name: "Level", value: `⭐ **${level}** (${currentXp}/${nextLevelXp} XP)`, inline: true },
        { name: "Stats", value: `⚔️ ATK: **${pet.attack || 5}** | 🛡️ DEF: **${pet.defense || 5}** | 💨 SPD: **${pet.speed || 5}**`, inline: false },
        { name: "Status", value: `❤️ Hunger: ${hunger}/100${hungerWarning} | 😊 Mood: ${pet.mood || 50}/100${moodWarning}`, inline: false },
        { name: "Record", value: `⚔️ Wins: ${pet.battles_won || 0} | Losses: ${pet.battles_lost || 0}`, inline: true },
      );

    if (speciesInfo?.evolvesTo) {
      const canEvolve = level >= speciesInfo.evolveLevel;
      embed.addFields({
        name: "Evolution",
        value: canEvolve
          ? `✅ Ready to evolve into **${speciesInfo.evolvesTo}**! Use \`/pet evolve\``
          : `🔒 Evolves into **${speciesInfo.evolvesTo}** at level ${speciesInfo.evolveLevel}`,
        inline: false
      });
    }

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === "rename") {
    const pet = await getPet(userId);
    if (!pet) return interaction.reply({ content: "you dont have a pet", flags: MessageFlags.Ephemeral });
    const newName = interaction.options.getString("name");
    await updatePet(userId, { name: newName });
    return interaction.reply(`✅ renamed your pet to **${newName}**`);
  }

  if (sub === "train") {
    const cd = checkCooldown(userId, "pet_train", 3_600_000);
    if (cd.onCooldown) {
      const mins = Math.ceil(cd.remainingMs / 60_000);
      return interaction.reply({ content: `⏰ training cooldown — **${mins}m** left`, flags: MessageFlags.Ephemeral });
    }
    const wallet = await getBalance(userId);
    if (wallet.balance < 100) return interaction.reply({ content: "training costs 100 coins", flags: MessageFlags.Ephemeral });

    const stat = interaction.options.getString("stat");
    const result = await trainPet(userId, stat);
    if (!result) return interaction.reply({ content: "you dont have a pet", flags: MessageFlags.Ephemeral });

    await updateBalance(userId, -100, "pet_train", stat);
    setCooldown(userId, "pet_train");

    const pet = await getPet(userId);
    const level = getPetLevel(pet.xp || 0);
    return interaction.reply(`🎯 trained **${stat}** — +${result.gain}! now at **${result.newValue}** (Level ${level})`);
  }

  if (sub === "battle") {
    const target = interaction.options.getUser("opponent");
    if (target.id === userId) return interaction.reply({ content: "you cant battle yourself", flags: MessageFlags.Ephemeral });
    if (target.bot) return interaction.reply({ content: "bots dont have pets", flags: MessageFlags.Ephemeral });

    const pet1 = await getPetBattleStats(userId);
    const pet2 = await getPetBattleStats(target.id);
    if (!pet1) return interaction.reply({ content: "you dont have a pet — use `/pet adopt`", flags: MessageFlags.Ephemeral });
    if (!pet2) return interaction.reply({ content: `**${target.username}** doesn't have a pet`, flags: MessageFlags.Ephemeral });

    await interaction.deferReply();

    // Apply hunger/mood modifiers
    const pet1Raw = await getPet(userId);
    const pet2Raw = await getPet(target.id);
    const hunger1 = getHungerDecay(pet1Raw);
    const hunger2 = getHungerDecay(pet2Raw);
    const hungerMod1 = hunger1 >= 50 ? 1.0 : hunger1 >= 25 ? 0.85 : 0.7;
    const hungerMod2 = hunger2 >= 50 ? 1.0 : hunger2 >= 25 ? 0.85 : 0.7;
    const moodMod1 = (pet1Raw.mood || 50) >= 50 ? 1.0 : (pet1Raw.mood || 50) >= 25 ? 0.9 : 0.75;
    const moodMod2 = (pet2Raw.mood || 50) >= 50 ? 1.0 : (pet2Raw.mood || 50) >= 25 ? 0.9 : 0.75;

    const atk1 = Math.floor(pet1.attack * hungerMod1 * moodMod1);
    const def1 = Math.floor(pet1.defense * hungerMod1 * moodMod1);
    const spd1 = Math.floor(pet1.speed * hungerMod1 * moodMod1);
    const atk2 = Math.floor(pet2.attack * hungerMod2 * moodMod2);
    const def2 = Math.floor(pet2.defense * hungerMod2 * moodMod2);
    const spd2 = Math.floor(pet2.speed * hungerMod2 * moodMod2);

    // 3-round battle
    const maxHp1 = 100 + def1 * 5;
    const maxHp2 = 100 + def2 * 5;
    let hp1 = maxHp1;
    let hp2 = maxHp2;
    const frames = [];

    for (let round = 1; round <= 3; round++) {
      // Speed determines who attacks first
      const p1First = spd1 >= spd2;
      const dmg1to2 = Math.max(1, Math.floor(10 + Math.random() * 10 + atk1 * 2 - def2));
      const dmg2to1 = Math.max(1, Math.floor(10 + Math.random() * 10 + atk2 * 2 - def1));

      let log = "";
      if (p1First) {
        hp2 = Math.max(0, hp2 - dmg1to2);
        log += `**${pet1.name}** attacks for **${dmg1to2}** damage!\n`;
        if (hp2 > 0) {
          hp1 = Math.max(0, hp1 - dmg2to1);
          log += `**${pet2.name}** retaliates for **${dmg2to1}** damage!`;
        }
      } else {
        hp1 = Math.max(0, hp1 - dmg2to1);
        log += `**${pet2.name}** attacks for **${dmg2to1}** damage!\n`;
        if (hp1 > 0) {
          hp2 = Math.max(0, hp2 - dmg1to2);
          log += `**${pet1.name}** retaliates for **${dmg1to2}** damage!`;
        }
      }

      // Add debuff notices
      if (hungerMod1 < 1) log += `\n⚠️ ${pet1.name} is hungry! (-${Math.round((1 - hungerMod1) * 100)}% stats)`;
      if (hungerMod2 < 1) log += `\n⚠️ ${pet2.name} is hungry! (-${Math.round((1 - hungerMod2) * 100)}% stats)`;

      frames.push({ embed: petBattleRoundEmbed(pet1, pet2, hp1, hp2, maxHp1, maxHp2, round, log) });

      if (hp1 <= 0 || hp2 <= 0) break;
    }

    // Determine winner
    const p1Wins = hp1 > hp2 || (hp1 === hp2 && spd1 >= spd2);
    const winnerId = p1Wins ? userId : target.id;
    const loserId = p1Wins ? target.id : userId;
    const winnerPet = p1Wins ? pet1 : pet2;
    const loserPet = p1Wins ? pet2 : pet1;

    // Record results and award coins
    await recordPetBattle(winnerId, true);
    await recordPetBattle(loserId, false);
    await updateBalance(winnerId, 50, "pet_battle_win", `defeated ${loserPet.name}`);

    const resultEmbed = petBattleResultEmbed(winnerPet.name, loserPet.name, 50);
    frames.push({ embed: resultEmbed });

    // Animate the battle
    await interaction.editReply({ embeds: [frames[0].embed] });
    for (let i = 1; i < frames.length; i++) {
      await new Promise(r => setTimeout(r, 1200));
      await interaction.editReply({ embeds: [frames[i].embed] });
    }
  }

  if (sub === "evolve") {
    const pet = await getPet(userId);
    if (!pet) return interaction.reply({ content: "you dont have a pet — use `/pet adopt`", flags: MessageFlags.Ephemeral });

    const speciesInfo = SPECIES_MAP[pet.species];
    if (!speciesInfo || !speciesInfo.evolvesTo) return interaction.reply({ content: "your pet species can't evolve", flags: MessageFlags.Ephemeral });

    const level = getPetLevel(pet.xp || 0);
    if (level < speciesInfo.evolveLevel) {
      return interaction.reply({ content: `your pet needs to be level **${speciesInfo.evolveLevel}** to evolve (currently level ${level})`, flags: MessageFlags.Ephemeral });
    }

    // Evolve: change species, boost stats
    await updatePet(userId, {
      species: speciesInfo.evolvesTo,
      attack: (pet.attack || 5) + 3,
      defense: (pet.defense || 5) + 3,
      speed: (pet.speed || 5) + 3,
    });

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle("🌟 EVOLUTION!")
      .setDescription(`**${pet.name}** evolved from **${pet.species}** into **${speciesInfo.evolvesTo}**!`)
      .addFields(
        { name: "Stat Boost", value: "⚔️ ATK +3 | 🛡️ DEF +3 | 💨 SPD +3", inline: false },
        { name: "New Stats", value: `⚔️ ${(pet.attack || 5) + 3} | 🛡️ ${(pet.defense || 5) + 3} | 💨 ${(pet.speed || 5) + 3}`, inline: false },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
}
