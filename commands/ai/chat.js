import { SlashCommandBuilder } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import config from "../../config.js";
import { errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";

const MAX_INPUT_LENGTH = 2000;

const geminiClients = config.geminiKeys?.map((k) => new GoogleGenAI({ apiKey: k })) ?? [];
let keyIdx = 0;
function getClient() {
  if (!geminiClients.length) return null;
  return geminiClients[keyIdx++ % geminiClients.length];
}

const cooldowns = new Map();

export const data = new SlashCommandBuilder()
  .setName("chat")
  .setDescription("Chat with Irene, the server's friendly assistant")
  .addStringOption((o) => o.setName("message").setDescription("Your message").setRequired(true));

export async function execute(interaction) {
  const client = getClient();
  if (!client) {
    return interaction.reply({
      embeds: [errorEmbed("Not Configured", "AI chat is not configured.")],
      flags: 64,
    });
  }

  const key = `${interaction.guild?.id}-${interaction.user.id}`;
  const now = Date.now();
  if (cooldowns.has(key) && now - cooldowns.get(key) < config.aiCooldownMs) {
    return interaction.reply({
      embeds: [errorEmbed("cooldown active", "slow down a sec")],
      flags: 64,
    });
  }

  const message = interaction.options.getString("message");

  // Validate input length
  if (message.length > MAX_INPUT_LENGTH) {
    return interaction.reply({
      embeds: [errorEmbed("input too long", `maximum ${MAX_INPUT_LENGTH} characters (you sent ${message.length})`)],
      flags: 64,
    });
  }

  await interaction.deferReply();

  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ parts: [{ text: message }] }],
      config: { systemInstruction: config.botPersonality },
    });

    const reply = response.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("\n")
      .trim() || "no response";

    const MAX_RESPONSE = 4000;
    const text = reply.slice(0, MAX_RESPONSE);
    const wasTruncated = reply.length > MAX_RESPONSE;

    // Set cooldown AFTER success so failed requests don't consume the rate limit
    cooldowns.set(key, Date.now());

    const embed = infoEmbed("Irene", text).setFooter({
      text: `Chatting with ${interaction.user.username}${wasTruncated ? " [truncated]" : ""}`,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`AI chat error: ${error.message}`);
    await interaction.editReply({
      embeds: [errorEmbed("AI Error", "something went wrong, try again")],
    });
  }
}
