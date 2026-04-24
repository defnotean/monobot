import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getDailyChallenge, createDailyChallenge } from "../../database.js";
import { generateChallenge } from "../../ai/economy.js";
import { dailyChallengeEmbed } from "../../ai/gameVisuals.js";

export const data = new SlashCommandBuilder()
  .setName("challenge")
  .setDescription("View today's daily challenge");

export async function execute(interaction) {
  const guildId = interaction.guild?.id;
  if (!guildId) return interaction.reply({ content: "this only works in servers", flags: MessageFlags.Ephemeral });

  const today = new Date().toISOString().split("T")[0];
  let challenge = await getDailyChallenge(guildId, today);

  // Auto-generate if none exists for today
  if (!challenge) {
    const gen = generateChallenge();
    await createDailyChallenge(guildId, gen.type, gen.target, gen.reward, today);
    challenge = await getDailyChallenge(guildId, today);
    if (!challenge) return interaction.reply({ content: "couldn't generate challenge — try again", flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.user.id;
  const completed = (challenge.completed_by || []).includes(userId);
  const { embed, row } = dailyChallengeEmbed(challenge, completed);

  await interaction.reply({
    embeds: [embed],
    components: row ? [row] : [],
  });
}
