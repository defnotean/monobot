// ─── Casino Sub-Executor ────────────────────────────────────────────────────
// Handles the three moonshot economy-adjacent games that share the hardened
// atomic-economy primitives: multi-player poker, GBM stock market, daily
// lottery. Extracted from miscExecutor.js so the split matches the test
// layout (tests/ai/poker.test.ts, stockMarket.test.ts, lottery.test.ts) —
// same code, narrower cognitive surface. No behavior change.
//
// Each tool routes to the atomic implementation in ai/poker.js,
// ai/stockMarket.js, or ai/lottery.js. If you're looking for the lock
// boundaries, they live in those modules, not here.

import { log } from "../../utils/logger.js";

const HANDLED = new Set([
  "start_poker", "join_poker",
  "stock_market", "stock_buy", "stock_sell",
  "buy_lottery_ticket", "lottery_status",
]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    // ─── Poker ────────────────────────────────────────────────────────
    case "start_poker": {
      const { createTable, buildLobbyEmbed, resolveTable, buildResultEmbed } = await import("../poker.js");
      const result = await createTable({
        channelId: message.channel.id,
        guildId: message.guild?.id,
        hostId: message.author.id,
        ante: input.ante,
      });
      if (!result.ok) return result.error;

      const { embed, row } = buildLobbyEmbed(result.table);
      const lobbyMsg = await message.channel.send({ embeds: [embed], components: [row] });
      result.table.messageId = lobbyMsg.id;

      // Schedule resolution when the lobby window closes
      setTimeout(async () => {
        try {
          const resolved = await resolveTable(message.channel.id);
          if (!resolved.ok) {
            if (resolved.reason === "not_enough_players") {
              await lobbyMsg.edit({ components: [], embeds: [embed.setDescription("❌ Not enough players. Antes refunded.")] }).catch(() => {});
            }
            return;
          }
          // Re-fetch table for result payload
          const { getTable } = await import("../poker.js");
          const finishedTable = getTable(message.channel.id);
          const resultEmbed = buildResultEmbed(finishedTable || { result: resolved.result });
          if (resultEmbed) await message.channel.send({ embeds: [resultEmbed] });
          await lobbyMsg.edit({ components: [] }).catch(() => {});
        } catch (err) {
          log(`[Poker] resolution error: ${err.message}`);
        }
      }, 60_000);

      return `🃏 poker table open — ${result.table.ante.toLocaleString()} ante. lobby closes in 60s, min 2 players.`;
    }

    case "join_poker": {
      const { joinTable } = await import("../poker.js");
      const result = await joinTable({ channelId: message.channel.id, userId: message.author.id });
      if (!result.ok) return result.error;
      return `joined the table. pot is now **${result.table.pot.toLocaleString()}** coins with ${result.table.players.size} players.`;
    }

    // ─── Stock market ─────────────────────────────────────────────────
    case "stock_market": {
      const { buildMarketSummary } = await import("../stockMarket.js");
      const { rows, portfolio, nextTickAt } = await buildMarketSummary(message.author.id);
      const { EmbedBuilder } = await import("discord.js");
      const tickerLines = rows.map((r) =>
        `${r.arrow} **${r.symbol}** \`$${r.price.toLocaleString()}\` ${r.pct24h >= 0 ? "+" : ""}${r.pct24h}% · ${r.name}`
      ).join("\n");
      const embed = new EmbedBuilder()
        .setColor(0x10B981)
        .setTitle("📊 Eris Exchange")
        .setDescription(tickerLines)
        .setFooter({ text: `next price update <t:${Math.floor(nextTickAt / 1000)}:R>` })
        .setTimestamp();
      if (portfolio && portfolio.lines.length) {
        const portLines = portfolio.lines
          .sort((a, b) => b.value - a.value)
          .map((l) => `**${l.symbol}** × ${l.shares} @ \`$${l.pricePerShare}\` = **${l.value.toLocaleString()}** coins`)
          .join("\n");
        embed.addFields({
          name: `📁 Your Portfolio — ${portfolio.totalValue.toLocaleString()} coins`,
          value: portLines,
          inline: false,
        });
      } else {
        embed.addFields({
          name: "📁 Your Portfolio",
          value: "*empty — use `stock_buy` to get in on the action*",
          inline: false,
        });
      }
      await message.channel.send({ embeds: [embed] });
      return portfolio?.totalValue
        ? `your portfolio: **${portfolio.totalValue.toLocaleString()}** coins`
        : "market's open — pick a ticker";
    }

    case "stock_buy": {
      const { buyShares } = await import("../stockMarket.js");
      const result = await buyShares(message.author.id, input.symbol, input.shares);
      if (!result.ok) {
        if (result.reason === "insufficient") return `need ${result.required} coins, you have ${result.balance}`;
        if (result.reason === "unknown_ticker") return `unknown ticker. available: ${result.available.join(", ")}`;
        if (result.reason === "invalid_share_count") return "how many shares? use a whole number ≥ 1";
        if (result.reason === "economy_unavailable") return "economy is offline rn, try again later";
        return `couldn't buy: ${result.reason}`;
      }
      return `📈 bought **${result.shares} × ${result.symbol}** @ \`$${result.pricePerShare}\` = **${result.totalCost.toLocaleString()}** coins · you now hold **${result.newShares}** shares · balance: ${result.newBalance.toLocaleString()}`;
    }

    case "stock_sell": {
      const { sellShares } = await import("../stockMarket.js");
      const result = await sellShares(message.author.id, input.symbol, input.shares);
      if (!result.ok) {
        if (result.reason === "insufficient_shares") return `you only have **${result.held}** shares of ${String(input.symbol).toUpperCase()}, not ${result.requested}`;
        if (result.reason === "unknown_ticker") return `unknown ticker. available: ${result.available.join(", ")}`;
        if (result.reason === "invalid_share_count") return "how many shares to sell?";
        return `couldn't sell: ${result.reason}`;
      }
      return `📉 sold **${result.shares} × ${result.symbol}** @ \`$${result.pricePerShare}\` = **+${result.totalProceeds.toLocaleString()}** coins · remaining shares: ${result.remainingShares}`;
    }

    // ─── Lottery ──────────────────────────────────────────────────────
    case "buy_lottery_ticket": {
      const { buyLotteryTicket, getLotteryState } = await import("../lottery.js");
      const count = Math.min(Math.max(Math.floor(Number(input.count) || 1), 1), 100);
      const result = await buyLotteryTicket(message.author.id, count);
      if (!result.ok) {
        if (result.reason === "insufficient") return `need ${result.required} coins for ${count} ticket(s). you have ${result.balance}`;
        if (result.reason === "economy_unavailable") return "economy is offline rn, try again later";
        if (result.reason === "ticket_cap") return `you're already at the ticket cap (${result.held?.toLocaleString?.() ?? result.held}/${result.max?.toLocaleString?.() ?? result.max}). wait for the draw.`;
        if (result.reason === "draw_in_progress") return "a draw is running right now — try again in a few seconds";
        if (result.reason === "draw_pending") return "the draw window just closed — give it a moment";
        return `lottery buy failed: ${result.reason}`;
      }
      const state = await getLotteryState();
      const drawTs = Math.floor(state.drawAt / 1000);
      return `🎟️ bought **${count} ticket(s)** for ${result.cost} coins (you now have ${result.userTotal}). pot: **${result.pot.toLocaleString()}** — draws <t:${drawTs}:R>`;
    }

    case "lottery_status": {
      const { getLotteryState, getTicketPrice } = await import("../lottery.js");
      const state = await getLotteryState();
      const yours = state.tickets[message.author.id] || 0;
      const buyers = Object.keys(state.tickets).length;
      const totalTickets = Object.values(state.tickets).reduce((s, n) => s + n, 0);
      const drawTs = Math.floor(state.drawAt / 1000);
      const yourOdds = totalTickets > 0 ? `${((yours / totalTickets) * 100).toFixed(1)}%` : "—";
      const recentLine = state.history[0]
        ? (state.history[0].winner
            ? `\n🏆 last draw: <@${state.history[0].winner}> won **${state.history[0].prize?.toLocaleString() ?? "?"}** (<t:${Math.floor(state.history[0].at / 1000)}:R>)`
            : `\n🎲 last draw: nobody bought tickets, pot rolled over`)
        : "";
      return [
        `🎰 **Daily Lottery**`,
        `💰 Pot: **${state.pot.toLocaleString()}** coins`,
        `🎟️ Ticket price: ${getTicketPrice()} coins`,
        `👥 Buyers: ${buyers} · Total tickets: ${totalTickets}`,
        `🎫 Your tickets: **${yours}** (${yourOdds} odds)`,
        `⏰ Next draw: <t:${drawTs}:F> (<t:${drawTs}:R>)${recentLine}`,
      ].join("\n");
    }

    default:
      return undefined;
  }
}
