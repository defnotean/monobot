import { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } from "discord.js";
import { quickReply } from "../../ai/providers/index.js";
import { log } from "../../utils/logger.js";

const MAX_CONTENT = 4000; // Discord message max; trim if longer

export const data = new ContextMenuCommandBuilder()
  .setName("translate")
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const targetMsg = interaction.targetMessage;
  const text = String(targetMsg?.content ?? "").trim();

  if (!text) {
    return interaction.reply({
      content: "that message has no text to translate",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const truncated = text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) + "…" : text;
  const systemInstruction =
    "You are a translation tool. Translate the user's message to English. " +
    "If the message is already English, translate to the most likely other language it could be in. " +
    "Reply with ONLY the translation text — no commentary, no quotes, no 'Here is the translation:' preamble. " +
    "Keep the translation faithful to the original's tone and register.";

  try {
    const translation = await quickReply(interaction.client, systemInstruction, truncated, null);
    const clean = String(translation ?? "").trim();
    if (!clean) {
      return interaction.editReply({ content: "the model returned nothing — try again in a moment" });
    }
    const body =
      `**original** (${targetMsg.author?.username ?? "unknown"}): ${truncated.slice(0, 500)}${truncated.length > 500 ? "…" : ""}\n\n` +
      `**translation**: ${clean.slice(0, 1500)}${clean.length > 1500 ? "…" : ""}`;
    await interaction.editReply({ content: body });
    log(`[Translate] ${interaction.user.tag} translated msg ${targetMsg.id} in ${interaction.guild?.name ?? "DM"}`);
  } catch (err) {
    log(`[Translate] failed for ${interaction.user.tag}: ${err?.message ?? err}`);
    await interaction.editReply({ content: `translation failed: ${err?.message ?? "unknown error"}` }).catch(() => {});
  }
}
