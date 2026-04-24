import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle , MessageFlags } from "discord.js";
import { updateBalance, checkCooldown, setCooldown, hasItem, getBalance, getActivityStreak, incrementActivityStreak } from "../../database.js";
import { activityEmbed } from "../../ai/gameVisuals.js";

const RARITY_MAP = { 1: "junk", 5: "common", 15: "uncommon", 35: "rare", 75: "epic", 150: "legendary" };

export const data = new SlashCommandBuilder()
  .setName("dig")
  .setDescription("Dig for treasure");

export async function execute(interaction) {
  const userId = interaction.user.id;
  const cd = checkCooldown(userId, "dig", 30_000);
  if (cd.onCooldown) return interaction.reply({ content: `⛏️ wait **${cd.remainingSec}s** before digging again`, flags: MessageFlags.Ephemeral });
  setCooldown(userId, "dig");

  const hasDetector = await hasItem(userId, "Metal Detector");
  const streak = getActivityStreak(userId, "dig");

  const finds = [
    { name: "rusty nail", emoji: "🔩", coins: 1, weight: 25, rarity: "junk" },
    { name: "bottle cap", emoji: "🧢", coins: 5, weight: 25, rarity: "common" },
    { name: "silver coin", emoji: "🪙", coins: 15, weight: 20, rarity: "uncommon" },
    { name: "gold nugget", emoji: "✨", coins: 35, weight: 14, rarity: "rare" },
    { name: "diamond", emoji: "💎", coins: 75, weight: hasDetector ? 10 : 5, rarity: "epic" },
    { name: "ancient artifact", emoji: "🏺", coins: 150, weight: hasDetector ? 5 : 2, rarity: "legendary" },
  ];

  // Streak boosts rare item weights
  if (streak.count >= 5) {
    finds[4].weight += 2; // diamond
    finds[5].weight += 1; // artifact
  }

  const totalWeight = finds.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  let found = finds[0];
  for (const f of finds) {
    roll -= f.weight;
    if (roll <= 0) { found = f; break; }
  }

  // Apply streak coin bonus
  const bonusMultiplier = 1 + streak.bonus;
  const coins = Math.floor(found.coins * bonusMultiplier);
  const newStreak = incrementActivityStreak(userId, "dig");

  await updateBalance(userId, coins, "dig", found.name);
  const wallet = await getBalance(userId);

  const { embed, row } = activityEmbed("Dig", `Found a **${found.name}** ${found.emoji}`, coins, found.rarity, wallet.balance, "⛏️");
  if (streak.count >= 2) embed.setFooter({ text: `${found.rarity.toUpperCase()} • 🔥 Streak: ${newStreak}${streak.bonus > 0 ? ` (+${Math.round(streak.bonus * 100)}% bonus)` : ""}` });

  // Rare event chance: 5% base + 1% per streak level
  const eventChance = 0.05 + Math.min(streak.count, 10) * 0.01;
  if (Math.random() < eventChance) {
    const eventRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`activity_event_dig_cave_enter_${userId}`).setLabel("Enter the Cave").setEmoji("🕳️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`activity_event_dig_cave_leave_${userId}`).setLabel("Walk Away").setEmoji("🚶").setStyle(ButtonStyle.Secondary),
    );
    embed.addFields({ name: "⚡ Rare Discovery!", value: "You found a **mysterious cave entrance**! Do you dare enter?", inline: false });
    return interaction.reply({ embeds: [embed], components: [row, eventRow] });
  }

  await interaction.reply({ embeds: [embed], components: [row] });
}
