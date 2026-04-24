import { SlashCommandBuilder, EmbedBuilder , MessageFlags } from "discord.js";
import { updateBalance, checkCooldown, setCooldown, getBalance, getCareerTier, incrementCareerCount } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("work")
  .setDescription("Work a job for coins (30min cooldown)");

export async function execute(interaction) {
  const userId = interaction.user.id;
  const cd = checkCooldown(userId, "work", 1_800_000);
  if (cd.onCooldown) {
    const mins = Math.ceil(cd.remainingMs / 60_000);
    return interaction.reply({ content: `⏰ you already worked recently — come back in **${mins}m**`, flags: MessageFlags.Ephemeral });
  }
  setCooldown(userId, "work");

  const jobs = [
    { title: "discord moderator", emoji: "🔨" },
    { title: "meme reviewer", emoji: "😂" },
    { title: "cat photographer", emoji: "📸" },
    { title: "professional napper", emoji: "😴" },
    { title: "vibe checker", emoji: "✨" },
    { title: "cloud shapes analyst", emoji: "☁️" },
    { title: "rubber duck debugger", emoji: "🐤" },
    { title: "wifi signal whisperer", emoji: "📡" },
    { title: "elevator music composer", emoji: "🎵" },
    { title: "fortune cookie writer", emoji: "🥠" },
    { title: "professional procrastinator", emoji: "⏳" },
    { title: "pet rock trainer", emoji: "🪨" },
  ];

  const job = jobs[Math.floor(Math.random() * jobs.length)];
  const career = getCareerTier(userId);

  // Base: 150-450, plus career tier bonus
  const basePay = 150 + Math.floor(Math.random() * 301);
  let coins = basePay + career.bonus;

  // 15% chance of overtime bonus (double pay)
  const overtime = Math.random() < 0.15;
  if (overtime) coins *= 2;

  const newCareer = incrementCareerCount(userId);
  await updateBalance(userId, coins, "work", job.title);
  const wallet = await getBalance(userId);

  const tierStars = "⭐".repeat(Math.min(newCareer.tier, 5));
  const embed = new EmbedBuilder()
    .setColor(overtime ? 0xFFD700 : 0x9333EA)
    .setTitle(overtime ? "💼 OVERTIME! Double Pay!" : `💼 ${job.emoji} Work Complete`)
    .setDescription(`You worked as a **${job.title}**`)
    .addFields(
      { name: "Earned", value: `**${coins}** coins${overtime ? " (2x overtime!)" : ""}`, inline: true },
      { name: "Balance", value: `💰 ${wallet.balance}`, inline: true },
      { name: "Career", value: `${tierStars} Tier ${newCareer.tier} (${newCareer.count} shifts)`, inline: true },
    )
    .setFooter({ text: newCareer.count % 10 === 0 && newCareer.tier < 5 ? `🎉 PROMOTED! Tier ${newCareer.tier} — +${newCareer.bonus} bonus per shift` : `Next promotion: ${10 - (newCareer.count % 10)} shifts` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
