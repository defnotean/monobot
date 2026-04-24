import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle , MessageFlags } from "discord.js";
import { updateBalance, checkCooldown, setCooldown, hasItem, getBalance, getActivityStreak, incrementActivityStreak } from "../../database.js";
import { activityEmbed } from "../../ai/gameVisuals.js";

export const data = new SlashCommandBuilder()
  .setName("hunt")
  .setDescription("Go hunting for coins");

export async function execute(interaction) {
  const userId = interaction.user.id;
  const cd = checkCooldown(userId, "hunt", 45_000);
  if (cd.onCooldown) return interaction.reply({ content: `🏹 wait **${cd.remainingSec}s** before hunting again`, flags: MessageFlags.Ephemeral });
  setCooldown(userId, "hunt");

  const hasRifle = await hasItem(userId, "Hunting Rifle");
  const streak = getActivityStreak(userId, "hunt");

  const encounters = [
    { name: "squirrel", emoji: "🐿️", coins: 5, weight: 30, rarity: "common" },
    { name: "rabbit", emoji: "🐇", coins: 12, weight: 25, rarity: "common" },
    { name: "deer", emoji: "🦌", coins: 25, weight: 18, rarity: "uncommon" },
    { name: "bear", emoji: "🐻", coins: 45, weight: 12, rarity: "rare" },
    { name: "dragon", emoji: "🐉", coins: 80, weight: hasRifle ? 8 : 4, rarity: "epic" },
    { name: "phoenix", emoji: "🔥", coins: 200, weight: hasRifle ? 4 : 1, rarity: "legendary" },
  ];

  if (streak.count >= 5) {
    encounters[4].weight += 2;
    encounters[5].weight += 1;
  }

  const totalWeight = encounters.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  let found = encounters[0];
  for (const e of encounters) {
    roll -= e.weight;
    if (roll <= 0) { found = e; break; }
  }

  const bonusMultiplier = 1 + streak.bonus;
  const coins = Math.floor(found.coins * bonusMultiplier);
  const newStreak = incrementActivityStreak(userId, "hunt");

  await updateBalance(userId, coins, "hunt", found.name);
  const wallet = await getBalance(userId);

  const { embed, row } = activityEmbed("Hunt", `Tracked a **${found.name}** ${found.emoji}`, coins, found.rarity, wallet.balance, "🏹");
  if (streak.count >= 2) embed.setFooter({ text: `${found.rarity.toUpperCase()} • 🔥 Streak: ${newStreak}${streak.bonus > 0 ? ` (+${Math.round(streak.bonus * 100)}% bonus)` : ""}` });

  // Rare event: Dragon Nest
  const eventChance = 0.05 + Math.min(streak.count, 10) * 0.01;
  if (Math.random() < eventChance) {
    const eventRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`activity_event_hunt_nest_fight_${userId}`).setLabel("Fight the Dragon!").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`activity_event_hunt_nest_retreat_${userId}`).setLabel("Retreat").setEmoji("🏃").setStyle(ButtonStyle.Secondary),
    );
    embed.addFields({ name: "⚡ Dragon Nest!", value: "You stumbled upon a **dragon's nest** filled with treasure! Do you fight or retreat?", inline: false });
    return interaction.reply({ embeds: [embed], components: [row, eventRow] });
  }

  await interaction.reply({ embeds: [embed], components: [row] });
}
