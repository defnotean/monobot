import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  MessageFlags,
} from "discord.js";
import { createState, applyMove, renderBoard } from "../../ai/games/tictactoe.js";

const IDLE_TIMEOUT_MS = 90_000; // forfeit after 90s of inactivity
const CHALLENGE_TIMEOUT_MS = 60_000;

export const data = new SlashCommandBuilder()
  .setName("tictactoe")
  .setDescription("Play tic-tac-toe with another user")
  .addUserOption((o) =>
    o.setName("opponent").setDescription("Who you want to challenge").setRequired(true)
  );

function makeBoardButtons(state, disabled = false) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = state.cells[i];
      const isWinCell = state.winLine?.includes(i);
      const label = v === "X" ? "❌" : v === "O" ? "⭕" : `${i + 1}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt_${i}`)
          .setLabel(label)
          .setStyle(
            isWinCell ? ButtonStyle.Success
              : v ? ButtonStyle.Secondary
              : ButtonStyle.Primary
          )
          .setDisabled(disabled || v !== null)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildEmbed({ title, description, color = 0x3498db }) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

export async function execute(interaction) {
  const challenger = interaction.user;
  const opponent = interaction.options.getUser("opponent");

  if (opponent.bot) {
    return interaction.reply({ content: "you can't challenge a bot", flags: MessageFlags.Ephemeral });
  }
  if (opponent.id === challenger.id) {
    return interaction.reply({ content: "you can't challenge yourself", flags: MessageFlags.Ephemeral });
  }

  // Challenge embed
  const challengeEmbed = buildEmbed({
    title: "tic-tac-toe challenge",
    description: `${opponent} — ${challenger} wants to play. Accept?`,
    color: 0xf1c40f,
  });
  const challengeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ttt_accept").setLabel("accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ttt_decline").setLabel("decline").setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [challengeEmbed], components: [challengeRow] });
  const msg = await interaction.fetchReply();

  const challengeCollector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === opponent.id && (i.customId === "ttt_accept" || i.customId === "ttt_decline"),
    time: CHALLENGE_TIMEOUT_MS,
    max: 1,
  });

  challengeCollector.on("end", async (collected, reason) => {
    const clicked = collected.first();
    if (!clicked || clicked.customId === "ttt_decline") {
      const note = reason === "time" ? `${opponent.username} didn't respond in time.` : `${opponent.username} declined.`;
      await msg
        .edit({ embeds: [buildEmbed({ title: "tic-tac-toe challenge", description: note, color: 0x95a5a6 })], components: [] })
        .catch(() => {});
      return;
    }
    // Accepted — start game
    await clicked.deferUpdate().catch(() => {});

    let state = createState();
    const playerFor = (sym) => (sym === "X" ? challenger : opponent);

    async function refresh(extraText = "") {
      const turnUser = playerFor(state.currentPlayer);
      const base = `${challenger} (❌) vs ${opponent} (⭕)\n\n${renderBoard(state)}\n\n`;
      let status;
      if (state.winner) {
        const winUser = playerFor(state.winner);
        status = `**${winUser} wins! 🎉**`;
      } else if (state.draw) {
        status = "**draw.**";
      } else {
        status = `${turnUser}'s turn (${state.currentPlayer === "X" ? "❌" : "⭕"})`;
      }
      const tail = extraText ? `\n${extraText}` : "";
      await msg.edit({
        embeds: [buildEmbed({ title: "tic-tac-toe", description: base + status + tail })],
        components: makeBoardButtons(state, state.winner !== null || state.draw),
      }).catch(() => {});
    }

    await refresh();

    const gameCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => (i.user.id === challenger.id || i.user.id === opponent.id) && i.customId.startsWith("ttt_"),
      idle: IDLE_TIMEOUT_MS,
    });

    gameCollector.on("collect", async (i) => {
      const expectedUser = playerFor(state.currentPlayer);
      if (i.user.id !== expectedUser.id) {
        return i.reply({ content: "not your turn", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const cellIndex = parseInt(i.customId.split("_")[1], 10);
      const r = applyMove(state, cellIndex);
      if (!r.ok) {
        return i.reply({ content: `can't move there (${r.reason})`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      state = r.state;
      await i.deferUpdate().catch(() => {});
      await refresh();
      if (state.winner || state.draw) gameCollector.stop("finished");
    });

    gameCollector.on("end", async (_c, reason) => {
      if (reason === "idle" && !state.winner && !state.draw) {
        const stalled = playerFor(state.currentPlayer);
        await msg
          .edit({
            embeds: [
              buildEmbed({
                title: "tic-tac-toe",
                description: `${stalled} took too long. game forfeited.`,
                color: 0x95a5a6,
              }),
            ],
            components: makeBoardButtons(state, true),
          })
          .catch(() => {});
      }
    });
  });
}
