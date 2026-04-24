import { SlashCommandBuilder } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

export const data = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Create a poll")
  .addStringOption((o) => o.setName("question").setDescription("Poll question").setRequired(true))
  .addStringOption((o) => o.setName("option1").setDescription("Option 1").setRequired(true))
  .addStringOption((o) => o.setName("option2").setDescription("Option 2").setRequired(true))
  .addStringOption((o) => o.setName("option3").setDescription("Option 3"))
  .addStringOption((o) => o.setName("option4").setDescription("Option 4"))
  .addStringOption((o) => o.setName("option5").setDescription("Option 5"));

export async function execute(interaction) {
  const question = interaction.options.getString("question");
  const options = [];

  for (let i = 1; i <= 5; i++) {
    const opt = interaction.options.getString(`option${i}`);
    if (opt) options.push(opt);
  }

  const description = options.map((o, i) => `${NUMBER_EMOJI[i]} ${o}`).join("\n\n");

  const msg = await interaction.reply({
    embeds: [
      infoEmbed(`Poll: ${question}`, description)
        .setFooter({ text: `Poll by ${interaction.user.username}` }),
    ],
    fetchReply: true,
  }).catch(() => null);

  if (!msg) return; // reply failed (e.g. permissions or deferred interaction)
  for (let i = 0; i < options.length; i++) {
    await msg.react(NUMBER_EMOJI[i]).catch(() => {}); // ignore individual react failures
  }
}
