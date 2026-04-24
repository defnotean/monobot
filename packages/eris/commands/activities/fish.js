import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle , MessageFlags } from "discord.js";
import { updateBalance, checkCooldown, setCooldown, hasItem, getBalance, getActivityStreak, incrementActivityStreak } from "../../database.js";
import { activityEmbed } from "../../ai/gameVisuals.js";

export const data = new SlashCommandBuilder()
  .setName("fish")
  .setDescription("Cast your line and catch some fish for coins");

export async function execute(interaction) {
  const userId = interaction.user.id;
  const cd = checkCooldown(userId, "fish", 30_000);
  if (cd.onCooldown) return interaction.reply({ content: `🎣 wait **${cd.remainingSec}s** before fishing again`, flags: MessageFlags.Ephemeral });
  setCooldown(userId, "fish");

  const hasRod = await hasItem(userId, "Fishing Rod");
  const streak = getActivityStreak(userId, "fish");

  const catches = [
    { name: "old boot", emoji: "👢", coins: 2, weight: 30, rarity: "junk" },
    { name: "small fish", emoji: "🐟", coins: 8, weight: 25, rarity: "common" },
    { name: "bass", emoji: "🐟", coins: 15, weight: 20, rarity: "uncommon" },
    { name: "salmon", emoji: "🐠", coins: 25, weight: 12, rarity: "rare" },
    { name: "swordfish", emoji: "🗡️", coins: 50, weight: hasRod ? 10 : 5, rarity: "epic" },
    { name: "golden fish", emoji: "✨", coins: 100, weight: hasRod ? 5 : 2, rarity: "epic" },
    { name: "mythic whale", emoji: "🐋", coins: 250, weight: hasRod ? 2 : 0.5, rarity: "mythic" },
  ];

  if (streak.count >= 5) {
    catches[4].weight += 2;
    catches[5].weight += 1;
    catches[6].weight += 0.5;
  }

  const totalWeight = catches.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  let caught = catches[0];
  for (const c of catches) {
    roll -= c.weight;
    if (roll <= 0) { caught = c; break; }
  }

  const bonusMultiplier = 1 + streak.bonus;
  const coins = Math.floor(caught.coins * bonusMultiplier);
  const newStreak = incrementActivityStreak(userId, "fish");

  await updateBalance(userId, coins, "fish", caught.name);
  const wallet = await getBalance(userId);

  const { embed, row } = activityEmbed("Fish", `Caught a **${caught.name}** ${caught.emoji}`, coins, caught.rarity, wallet.balance, "🎣");
  if (streak.count >= 2) embed.setFooter({ text: `${caught.rarity.toUpperCase()} • 🔥 Streak: ${newStreak}${streak.bonus > 0 ? ` (+${Math.round(streak.bonus * 100)}% bonus)` : ""}` });

  // Rare event: Giant Fish Fight
  const eventChance = 0.05 + Math.min(streak.count, 10) * 0.01;
  if (Math.random() < eventChance) {
    const eventRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`activity_event_fish_giant_reel_${userId}`).setLabel("Reel It In!").setEmoji("💪").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`activity_event_fish_giant_cut_${userId}`).setLabel("Cut the Line").setEmoji("✂️").setStyle(ButtonStyle.Secondary),
    );
    embed.addFields({ name: "⚡ Something's Pulling!", value: "A **massive shadow** is tugging your line! Reel it in for a huge catch, or cut the line to play it safe?", inline: false });
    return interaction.reply({ embeds: [embed], components: [row, eventRow] });
  }

  await interaction.reply({ embeds: [embed], components: [row] });
}
