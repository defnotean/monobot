import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  MessageFlags,
} from "discord.js";
import { createState, applyMove, renderBoard, CONNECT4_COLS } from "../../ai/games/connect4.js";

const IDLE_TIMEOUT_MS = 120_000;
const CHALLENGE_TIMEOUT_MS = 60_000;

export const data = new SlashCommandBuilder()
  .setName("connect4")
  .setDescription("Play connect-4 with another user")
  .addUserOption((o) =>
    o.setName("opponent").setDescription("Who you want to challenge").setRequired(true)
  );

function makeColButtons(state, disabled = false) {
  // 7 column buttons across 2 rows (4 + 3) — discord.js max 5 buttons per row
  const labels = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();
  for (let c = 0; c < CONNECT4_COLS; c++) {
    const btn = new ButtonBuilder()
      .setCustomId(`c4_${c}`)
      .setEmoji(labels[c])
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || state.cols[c].length >= 6);
    if (c < 4) row1.addComponents(btn);
    else row2.addComponents(btn);
  }
  return [row1, row2];
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

  const challengeEmbed = buildEmbed({
    title: "connect-4 challenge",
    description: `${opponent} — ${challenger} wants to play. Accept?`,
    color: 0xf1c40f,
  });
  const challengeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c4_accept").setLabel("accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("c4_decline").setLabel("decline").setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [challengeEmbed], components: [challengeRow] });
  const msg = await interaction.fetchReply();

  const challengeCollector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === opponent.id && (i.customId === "c4_accept" || i.customId === "c4_decline"),
    time: CHALLENGE_TIMEOUT_MS,
    max: 1,
  });

  challengeCollector.on("end", async (collected, reason) => {
    const clicked = collected.first();
    if (!clicked || clicked.customId === "c4_decline") {
      const note = reason === "time" ? `${opponent.username} didn't respond in time.` : `${opponent.username} declined.`;
      await msg
        .edit({ embeds: [buildEmbed({ title: "connect-4 challenge", description: note, color: 0x95a5a6 })], components: [] })
        .catch(() => {});
      return;
    }
    await clicked.deferUpdate().catch(() => {});

    let state = createState();
    const playerFor = (sym) => (sym === "X" ? challenger : opponent);

    async function refresh() {
      const turnUser = playerFor(state.currentPlayer);
      const base = `${challenger} (🔴) vs ${opponent} (🟡)\n\n${renderBoard(state)}\n\n`;
      let status;
      if (state.winner) {
        const winUser = playerFor(state.winner);
        status = `**${winUser} wins! 🎉**`;
      } else if (state.draw) {
        status = "**draw — board full.**";
      } else {
        status = `${turnUser}'s turn (${state.currentPlayer === "X" ? "🔴" : "🟡"})`;
      }
      await msg.edit({
        embeds: [buildEmbed({ title: "connect-4", description: base + status })],
        components: makeColButtons(state, state.winner !== null || state.draw),
      }).catch(() => {});
    }

    await refresh();

    const gameCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => (i.user.id === challenger.id || i.user.id === opponent.id) && i.customId.startsWith("c4_"),
      idle: IDLE_TIMEOUT_MS,
    });

    gameCollector.on("collect", async (i) => {
      const expectedUser = playerFor(state.currentPlayer);
      if (i.user.id !== expectedUser.id) {
        return i.reply({ content: "not your turn", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const col = parseInt(i.customId.split("_")[1], 10);
      const r = applyMove(state, col);
      if (!r.ok) {
        return i.reply({ content: `can't drop there (${r.reason})`, flags: MessageFlags.Ephemeral }).catch(() => {});
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
                title: "connect-4",
                description: `${stalled} took too long. game forfeited.`,
                color: 0x95a5a6,
              }),
            ],
            components: makeColButtons(state, true),
          })
          .catch(() => {});
      }
    });
  });
}
