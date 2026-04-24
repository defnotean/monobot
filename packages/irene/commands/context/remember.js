import { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } from "discord.js";
import { log } from "../../utils/logger.js";

// Lazy-load memory module — avoids pulling it during command-load if Irene's
// memory system is ever disabled.
async function loadMemoryApi() {
  try {
    const mod = await import("../../ai/memory.js");
    if (typeof mod.addMemory === "function" && typeof mod.getMemories === "function") {
      return mod;
    }
    return null;
  } catch (err) {
    log(`[Remember] memory module import failed: ${err?.message ?? err}`);
    return null;
  }
}

export const data = new ContextMenuCommandBuilder()
  .setName("remember this")
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const targetMsg = interaction.targetMessage;
  const text = String(targetMsg?.content ?? "").trim();

  if (!text) {
    return interaction.reply({
      content: "that message has no text — nothing to remember.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (text.length > 200) {
    // The remember_fact tool documents a 200-char soft limit per fact.
    return interaction.reply({
      content: "that's too long to remember (>200 chars). pick a shorter message or quote just the key part.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!interaction.guildId) {
    return interaction.reply({
      content: "can only remember messages in servers.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const mem = await loadMemoryApi();
  if (!mem) {
    return interaction.reply({
      content: "memory system isn't available right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const targetAuthor = targetMsg.author;
  const targetAuthorId = targetAuthor?.id ?? interaction.user.id;
  const selfAction = targetAuthorId === interaction.user.id;

  // Construct the fact shape Irene's memory system expects. Match the format
  // `remember_fact` uses internally so the fact reads naturally when recalled.
  const authorName = targetAuthor?.username ?? "someone";
  const fact = selfAction
    ? `said: "${text}"`
    : `${authorName} said: "${text}"`;

  // Check for near-duplicates so we don't spam the memory with the same fact.
  const existing = mem.getMemories(interaction.guildId, targetAuthorId);
  const factLower = fact.toLowerCase();
  for (const m of existing) {
    const existLower = String(m.fact ?? "").toLowerCase();
    if (existLower.includes(factLower) || factLower.includes(existLower)) {
      return interaction.reply({
        content: `I already remember that — "${m.fact}"`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  try {
    mem.addMemory(interaction.guildId, targetAuthorId, fact, interaction.user.id);
    await interaction.reply({
      content: selfAction
        ? `remembered what you said. ✅`
        : `remembered what ${authorName} said. ✅`,
      flags: MessageFlags.Ephemeral,
    });
    log(`[Remember] ${interaction.user.tag} saved fact about ${authorName} in ${interaction.guild?.name ?? "?"}`);
  } catch (err) {
    log(`[Remember] failed for ${interaction.user.tag}: ${err?.message ?? err}`);
    await interaction.reply({
      content: `couldn't save that memory — ${err?.message ?? "unknown error"}`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}
