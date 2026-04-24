import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { infoEmbed, successEmbed, errorEmbed } from "../../utils/embeds.js";
import { checkCooldown } from "../../utils/cooldown.js";

// ─── Score tracking: userId → { correct, wrong, streak, bestStreak } ──────────
const scoreMap = new Map();

export const data = new SlashCommandBuilder()
  .setName("trivia")
  .setDescription("Answer a random trivia question")
  .addStringOption((o) =>
    o.setName("difficulty").setDescription("Difficulty").addChoices(
      { name: "Easy", value: "easy" },
      { name: "Medium", value: "medium" },
      { name: "Hard", value: "hard" }
    )
  );

export async function execute(interaction) {
  const cooldown = checkCooldown("trivia", interaction.user.id, 10000);
  if (cooldown.onCooldown) {
    return interaction.reply({
      content: `Wait ${cooldown.remaining}s before using this command again.`,
      flags: 64,
    });
  }

  await interaction.deferReply();

  const difficulty = interaction.options.getString("difficulty") || "medium";

  try {
    const res = await fetch(`https://opentdb.com/api.php?amount=1&difficulty=${difficulty}&type=multiple`);
    if (!res.ok) return interaction.editReply({ embeds: [errorEmbed("API Error", "External API returned an error, try again")] });
    const data = await res.json();

    if (!data.results?.length) {
      return interaction.editReply({ embeds: [errorEmbed("Error", "Could not fetch a trivia question.")] });
    }

    const q = data.results[0];
    const decode = (s) => s.replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&rsquo;/g, "'")
      .replace(/&ldquo;/g, '"')
      .replace(/&rdquo;/g, '"')
      .replace(/&#([0-9]{1,5});/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

    const answers = [...q.incorrect_answers, q.correct_answer].map(decode);
    for (let i = answers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [answers[i], answers[j]] = [answers[j], answers[i]];
    }

    const correctIndex = answers.indexOf(decode(q.correct_answer));
    const labels = ["A", "B", "C", "D"];

    const row = new ActionRowBuilder().addComponents(
      answers.map((_, i) =>
        new ButtonBuilder()
          .setCustomId(`trivia_${i}`)
          .setLabel(labels[i])
          .setStyle(ButtonStyle.Primary)
      )
    );

    const answerList = answers.map((a, i) => `**${labels[i]}.** ${a}`).join("\n");

    const msg = await interaction.editReply({
      embeds: [
        infoEmbed(
          `Trivia (${difficulty})`,
          `**${decode(q.question)}**\n\n${answerList}\n\nCategory: *${decode(q.category)}*`
        ),
      ],
      components: [row],
    });

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30000,
      filter: (i) => i.user.id === interaction.user.id,
      max: 1,
    });

    collector.on("collect", async (i) => {
      const selected = parseInt(i.customId.split("_")[1]);
      const correct = selected === correctIndex;

      // Update score
      if (!scoreMap.has(interaction.user.id)) {
        scoreMap.set(interaction.user.id, { correct: 0, wrong: 0, streak: 0, bestStreak: 0 });
      }
      const score = scoreMap.get(interaction.user.id);
      if (correct) {
        score.correct++;
        score.streak++;
        score.bestStreak = Math.max(score.bestStreak, score.streak);
      } else {
        score.wrong++;
        score.streak = 0;
      }

      const resultEmbed = correct
        ? successEmbed("Correct!", `The answer was **${labels[correctIndex]}. ${answers[correctIndex]}**`)
        : errorEmbed("Wrong!", `The correct answer was **${labels[correctIndex]}. ${answers[correctIndex]}**`);

      resultEmbed.addFields({
        name: "Streak",
        value: `${score.streak} (best: ${score.bestStreak})`,
        inline: false,
      });

      await i.update({
        embeds: [resultEmbed],
        components: [],
      });
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "time" && collected.size === 0) {
        const resultEmbed = errorEmbed("Time's Up!", `The correct answer was **${labels[correctIndex]}. ${answers[correctIndex]}**`);

        // Add score on timeout
        if (!scoreMap.has(interaction.user.id)) {
          scoreMap.set(interaction.user.id, { correct: 0, wrong: 0, streak: 0, bestStreak: 0 });
        }
        const score = scoreMap.get(interaction.user.id);
        score.wrong++;
        score.streak = 0;

        resultEmbed.addFields({
          name: "Streak",
          value: `${score.streak} (best: ${score.bestStreak})`,
          inline: false,
        });

        await interaction.editReply({
          embeds: [resultEmbed],
          components: [],
        });
      }
    });
  } catch {
    await interaction.editReply({ embeds: [errorEmbed("Error", "Failed to fetch trivia.")] });
  }
}
