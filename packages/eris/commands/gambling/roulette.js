import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { tryDeductBalance, updateBalance, recordGameResult, getBalance } from "../../database.js";
import { spin, colorOf, validateBet, resolveBet, describeBet, BET_TYPES } from "../../ai/gambling/roulette.js";

const SPIN_DELAY_MS = 1500;
const COLOR_RED = 0xe74c3c;
const COLOR_BLACK = 0x2c3e50;
const COLOR_GREEN = 0x27ae60;
const COLOR_LOSS = 0x95a5a6;

const BET_CHOICES = [
  { name: "straight (single number, 35:1)", value: "straight" },
  { name: "red (1:1)", value: "red" },
  { name: "black (1:1)", value: "black" },
  { name: "even (1:1)", value: "even" },
  { name: "odd (1:1)", value: "odd" },
  { name: "low 1-18 (1:1)", value: "low" },
  { name: "high 19-36 (1:1)", value: "high" },
  { name: "dozen 1-12 (2:1)", value: "dozen_1" },
  { name: "dozen 13-24 (2:1)", value: "dozen_2" },
  { name: "dozen 25-36 (2:1)", value: "dozen_3" },
  { name: "column 1 (1, 4, 7, …) (2:1)", value: "column_1" },
  { name: "column 2 (2, 5, 8, …) (2:1)", value: "column_2" },
  { name: "column 3 (3, 6, 9, …) (2:1)", value: "column_3" },
];

export const data = new SlashCommandBuilder()
  .setName("roulette")
  .setDescription("Spin the roulette wheel — European, single zero")
  .addStringOption((o) =>
    o.setName("bet")
      .setDescription("What to bet on")
      .setRequired(true)
      .addChoices(...BET_CHOICES))
  .addIntegerOption((o) =>
    o.setName("amount")
      .setDescription("Coins to wager")
      .setRequired(true)
      .setMinValue(10)
      .setMaxValue(1_000_000))
  .addIntegerOption((o) =>
    o.setName("number")
      .setDescription("Required for straight bets — pick 0–36")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(36));

function spinningEmbed(bet, amount) {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🎡 spinning…")
    .setDescription(`bet: **${describeBet(bet)}** · stake: **${amount.toLocaleString()}** coins`);
}

function resultEmbed({ spunNumber, won, payout, bet, amount, newBalance }) {
  const color = won
    ? (colorOf(spunNumber) === "red" ? COLOR_RED : colorOf(spunNumber) === "black" ? COLOR_BLACK : COLOR_GREEN)
    : COLOR_LOSS;
  const colorEmoji = colorOf(spunNumber) === "red" ? "🔴" : colorOf(spunNumber) === "black" ? "⚫" : "🟢";
  const winnings = payout - amount; // payout includes stake refund on win
  const lines = [
    `**${colorEmoji} ${spunNumber}** (${colorOf(spunNumber)})`,
    "",
    `bet: ${describeBet(bet)}`,
    `stake: ${amount.toLocaleString()}`,
    won
      ? `**won ${winnings.toLocaleString()} coins** (got ${payout.toLocaleString()} back)`
      : `**lost ${amount.toLocaleString()} coins**`,
    `balance: ${newBalance.toLocaleString()}`,
  ];
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(won ? "🎉 winner" : "🎲 no luck")
    .setDescription(lines.join("\n"));
}

export async function execute(interaction) {
  const type = interaction.options.getString("bet");
  const amount = interaction.options.getInteger("amount");
  const number = interaction.options.getInteger("number"); // null if not provided
  const userId = interaction.user.id;

  // Validate the bet shape — straight requires `number`, others reject it (silently, per the
  // module's rule that `number` is ignored on outside bets).
  const bet = { type, amount, number: number ?? undefined };
  const validation = validateBet(bet);
  if (!validation.ok) {
    if (validation.reason === "invalid_number") {
      return interaction.reply({
        content: "straight bets need a number 0–36 in the `number` option",
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: `invalid bet: ${validation.reason}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Atomic deduct — read-check-debit in one lock window. Prevents the
  // double-spend race that exists in coinflip.js's check-then-update pattern.
  const debit = await tryDeductBalance(
    userId,
    amount,
    "roulette_bet",
    `bet:${type}${type === "straight" ? `:${number}` : ""}`
  );
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      return interaction.reply({
        content: `you only have ${debit.balance.toLocaleString()} coins — bet was ${amount.toLocaleString()}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: `couldn't place bet: ${debit.reason}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Show "spinning…" placeholder. Discord doesn't support real animation; the
  // delay is just for vibe — long enough to feel like a spin, short enough not
  // to bore.
  await interaction.reply({ embeds: [spinningEmbed(bet, amount)] });
  await new Promise((r) => setTimeout(r, SPIN_DELAY_MS));

  const spunNumber = spin();
  const result = resolveBet(bet, spunNumber);

  let finalBalance = debit.newBalance;
  if (result.won) {
    // Credit the full payout (stake refund + winnings) in one updateBalance call.
    try {
      finalBalance = await updateBalance(
        userId,
        result.payout,
        "roulette_win",
        `bet:${type}${type === "straight" ? `:${number}` : ""} spun:${spunNumber}`
      );
    } catch (err) {
      // Credit failed — log it loudly so orphaned coins are diagnosable.
      // This is the kind of silent-loss bug the council audit flagged on
      // poker refunds; same defensive pattern here.
      console.error(`[Roulette] win credit failed for ${userId} payout=${result.payout}:`, err);
    }
  }

  await recordGameResult(userId, "roulette", result.won, amount, result.payout).catch(() => {});

  await interaction.editReply({
    embeds: [resultEmbed({
      spunNumber,
      won: result.won,
      payout: result.payout,
      bet,
      amount,
      newBalance: finalBalance,
    })],
  }).catch(() => {});
}
