import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  MessageFlags,
} from "discord.js";
import { createState, applyMove, renderBoard } from "../../ai/games/hangman.js";

const IDLE_TIMEOUT_MS = 180_000; // 3 min

export const data = new SlashCommandBuilder()
  .setName("hangman")
  .setDescription("Play hangman — guess the word before you run out of misses");

function buildEmbed({ title, description, color = 0x3498db }) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

function makeLetterSelect(state, disabled = false) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  // 25 options max per select — drop already-guessed letters to stay under the cap
  const options = letters
    .filter((L) => !state.guessed.has(L))
    .slice(0, 25)
    .map((L) => ({ label: L, value: L }));
  if (options.length === 0) {
    // Vanishingly rare: every letter guessed. Offer a single placeholder.
    options.push({ label: "—", value: "_" });
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId("hm_select")
    .setPlaceholder(disabled ? "game over" : "pick a letter...")
    .setDisabled(disabled || state.won || state.lost)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(select);
}

function makeGiveUpButton(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hm_giveup")
      .setLabel("give up")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

export async function execute(interaction) {
  const player = interaction.user;

  let state;
  try {
    state = createState();
  } catch (err) {
    return interaction.reply({ content: `could not start: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  function renderStatus() {
    if (state.won) return `**you win! 🎉** the word was **${state.word}**`;
    if (state.lost) return `**you lose.** the word was **${state.word}**`;
    return `pick your next letter below`;
  }

  async function respond(target, { interactionReply = false } = {}) {
    const desc = `${renderBoard(state)}\n\n${renderStatus()}`;
    const embed = buildEmbed({ title: `hangman — ${player.username}`, description: desc });
    const rows = state.won || state.lost
      ? []
      : [makeLetterSelect(state), makeGiveUpButton()];
    const payload = { embeds: [embed], components: rows };
    if (interactionReply) await target.reply(payload);
    else await target.edit(payload).catch(() => {});
  }

  await respond(interaction, { interactionReply: true });
  const msg = await interaction.fetchReply();

  const collector = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === player.id && (i.customId === "hm_select" || i.customId === "hm_giveup"),
    idle: IDLE_TIMEOUT_MS,
  });

  collector.on("collect", async (i) => {
    if (i.customId === "hm_giveup") {
      state = { ...state, lost: true };
      await i.deferUpdate().catch(() => {});
      await respond(msg);
      collector.stop("giveup");
      return;
    }
    // hm_select — letter pick from dropdown
    const letter = i.values?.[0];
    if (!letter) return;
    const r = applyMove(state, letter);
    if (!r.ok) {
      return i.reply({ content: `can't guess that (${r.reason})`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    state = r.state;
    await i.deferUpdate().catch(() => {});
    await respond(msg);
    if (state.won || state.lost) collector.stop("finished");
  });

  collector.on("end", async (_c, reason) => {
    if (reason === "idle" && !state.won && !state.lost) {
      await msg
        .edit({
          embeds: [
            buildEmbed({
              title: `hangman — ${player.username}`,
              description: `you took too long. the word was **${state.word}**.`,
              color: 0x95a5a6,
            }),
          ],
          components: [],
        })
        .catch(() => {});
    }
  });
}
