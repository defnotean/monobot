// ─── Economy Sub-Executor ────────────────────────────────────────────────────
// Handles: shop, inventory, loans, bounties, daily challenges, achievements
// Called from main executor.js via delegation.

import * as db from "../database.js";
import { resolveMember } from "../utils/discord.js";
import { ACHIEVEMENTS, DEFAULT_SHOP_ITEMS, generateChallenge, calculateLoanTotal, openMysteryBox } from "./economy.js";
import { randomQuip } from "./gambling.js";
import { PermissionFlagsBits } from "discord.js";

const SELF_ASSIGN_DENY_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

function validateShopRole(guild, role) {
  if (!role) return "that shop role no longer exists";
  if (role.id === guild.id) return "shop roles can't grant @everyone";
  if (role.managed) return `shop roles can't grant **${role.name}** because Discord manages that role`;
  if (SELF_ASSIGN_DENY_PERMS.some((perm) => role.permissions?.has?.(perm))) {
    return `shop roles can't grant **${role.name}** because it has elevated permissions`;
  }
  const botMember = guild.members?.me;
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return "I need Manage Roles to grant shop roles";
  if (botMember.roles?.highest?.position != null && role.position >= botMember.roles.highest.position) {
    return `I can't grant **${role.name}** because it is at or above my top role`;
  }
  return null;
}

// Per-user loan lock — serializes loan_request so parallel calls can't both
// pass the "no active loan" check and create two loans.
const _loanLocks = new Map();
async function _withLoanLock(userId, fn) {
  const prev = _loanLocks.get(userId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _loanLocks.set(userId, current);
  try { return await current; } finally {
    if (_loanLocks.get(userId) === current) _loanLocks.delete(userId);
  }
}

export async function executeEconomyTool(toolName, input, message) {
  const guild = message.guild;

  switch (toolName) {

    // ─── SHOP ──────────────────────────────────────────────────────────

    case "shop_browse": {
      // Seed shop items if not yet stocked
      const items = await db.getShopItems(guild?.id);
      if (!items.length) {
        for (const item of DEFAULT_SHOP_ITEMS) {
          await db.addShopItem(guild?.id, item);
        }
      }
      // Send the interactive shop embed with category navigation + item select
      const { buildOverviewEmbed, buildCategorySelect } = await import("../commands/economy/shop.js");
      const wallet = await db.getBalance(message.author.id);
      const embed = buildOverviewEmbed(wallet.balance);
      await message.channel.send({ embeds: [embed], components: [buildCategorySelect()] });
      return "here's the shop — pick a category to browse and buy";
    }

    case "shop_buy": {
      const itemName = (input.item || input.name || "").toLowerCase().trim();
      if (!itemName) return "what do you wanna buy?";
      const items = await db.getShopItems(guild?.id);
      const item = items.find(i => i.name.toLowerCase().includes(itemName));
      if (!item) return `"${itemName}" isn't in the shop`;
      const econ = await db.getBalance(message.author.id);
      if (econ.balance < item.price) return `that costs ${item.price} coins but you only have ${econ.balance}`;

      // Check prerequisites BEFORE touching stock so we don't reserve an item
      // we can't actually buy.
      const UNIQUE_TYPES = new Set(["equipment", "upgrade", "pet_gear", "pet_cosmetic", "cosmetic"]);
      if (item.requires) {
        if (item.requires === "pet") {
          const pet = await db.getPet(message.author.id);
          if (!pet) return "you need a pet first — use `/pet adopt`";
        } else {
          const hasReq = await db.hasItem(message.author.id, item.requires);
          if (!hasReq) return `you need **${item.requires}** before you can buy ${item.name}`;
        }
      }
      if (UNIQUE_TYPES.has(item.type)) {
        const alreadyOwns = await db.hasItem(message.author.id, item.name);
        if (alreadyOwns) return `you already own ${item.name}`;
      }
      if (item.type === "role" && item.role_id) {
        if (!guild) return "role shop items only work in servers";
        const role = guild.roles.cache.get(item.role_id);
        const roleErr = validateShopRole(guild, role);
        if (roleErr) return roleErr;
      }

      // Atomically reserve stock (if the item is limited) BEFORE charging.
      // If this fails because someone else just grabbed the last one, we never
      // touch the balance. If the balance deduction later fails, we refund the
      // stock.
      let stockReserved = false;
      if (item.limited_stock !== null && item.limited_stock !== undefined) {
        const result = await db.tryDecrementShopStock(item.id);
        if (!result.ok) {
          if (result.reason === "sold_out" || result.reason === "stock_changed_retry_exhausted") {
            return "that item is sold out";
          }
          return `couldn't reserve that item: ${result.reason}`;
        }
        stockReserved = true;
      }

      try {
        await db.updateBalance(message.author.id, -item.price, "shop_purchase", item.name);
      } catch (err) {
        // Balance update failed (DB offline etc.) — refund the stock reservation
        // via the atomic increment primitive so we don't overwrite someone
        // else's concurrent decrement with our stale pre-reservation value.
        if (stockReserved) {
          await db.tryIncrementShopStock(item.id).catch(() => {});
        }
        return `purchase failed: ${err.message}`;
      }

      // Handle special item types
      if (item.type === "mystery") {
        const result = openMysteryBox();
        await db.updateBalance(message.author.id, result.coins, "mystery_box", result.label);
        // Check first purchase achievement
        await db.unlockAchievement(message.author.id, "first_purchase");
        return `mystery box opened: ${result.label} — net: ${result.coins - item.price} coins`;
      }

      if (item.type === "role" && item.role_id && guild) {
        try { await message.member.roles.add(item.role_id); } catch {}
      }

      // Handle minion purchases
      if (item.type === "minion" && item.minionType) {
        const { hireMinion } = await import("./minions.js");
        const result = hireMinion(message.author.id, item.minionType);
        if (!result.success) {
          // Refund if can't hire
          await db.updateBalance(message.author.id, item.price, "refund", item.name);
          return result.error;
        }
        await db.unlockAchievement(message.author.id, "first_purchase");
        return `hired ${result.minion.name}! they'll start earning coins for you every 30 min`;
      }

      // Handle minion slot upgrades
      if (item.type === "minion_slot") {
        const { upgradeSlots } = await import("./minions.js");
        const result = upgradeSlots(message.author.id);
        if (!result.success) {
          await db.updateBalance(message.author.id, item.price, "refund", item.name);
          return result.error;
        }
        await db.unlockAchievement(message.author.id, "first_purchase");
        return `unlocked minion slot ${result.newMax}! you can now hire ${result.newMax} minions`;
      }

      await db.addToInventory(message.author.id, item.name, item.type);
      // Stock was already decremented atomically above when we reserved it.
      await db.unlockAchievement(message.author.id, "first_purchase");

      const { shopBuyEmbed } = await import("./gameVisuals.js");
      await message.channel.send({ embeds: [shopBuyEmbed(item, econ.balance - item.price)] });
      return `bought ${item.name} for ${item.price} coins`;
    }

    case "inventory_check": {
      const items = await db.getInventory(message.author.id);
      if (!items.length) return "your inventory is empty — buy something from the shop";
      const { inventoryEmbed } = await import("./gameVisuals.js");
      await message.channel.send({ embeds: [inventoryEmbed(message.author.displayName, items)] });
      return "there's your stuff";
    }

    // ─── LOANS ─────────────────────────────────────────────────────────

    case "loan_request": {
      const amount = Math.floor(Number(input.amount) || 0);
      if (!Number.isFinite(amount) || amount < 50) return "minimum loan is 50 coins";
      if (amount > 2000) return "max loan is 2000 coins — i'm a loan shark, not a bank";

      // Serialize per-user via a lightweight in-memory lock so two parallel
      // loan_request calls can't both pass the "no active loan" check and
      // end up creating two loans + double-crediting the wallet.
      return _withLoanLock(message.author.id, async () => {
        const existing = await db.getActiveLoan(message.author.id);
        if (existing) return `you already have an active loan of ${existing.amount} coins. pay it back first`;
        const dueAt = new Date(Date.now() + 24 * 3600_000).toISOString();
        await db.createLoan(message.author.id, amount, 0.2, dueAt);
        await db.updateBalance(message.author.id, amount, "loan", `borrowed ${amount}`);
        await db.unlockAchievement(message.author.id, "loan_shark");
        const total = calculateLoanTotal(amount, 0.2);
        const { loanEmbed } = await import("./gameVisuals.js");
        await message.channel.send({ embeds: [loanEmbed(amount, total, 24)] });
        return `loaned you ${amount} coins. you owe me ${total} within 24 hours. don't make me come collecting 😈`;
      });
    }

    case "loan_status": {
      const loan = await db.getActiveLoan(message.author.id);
      if (!loan) return "you don't have any active loans. good for you";
      const hoursLeft = Math.max(0, (new Date(loan.due_at).getTime() - Date.now()) / 3600_000);
      const hoursOverdue = hoursLeft <= 0 ? Math.abs(hoursLeft) : 0;
      const total = calculateLoanTotal(loan.amount, loan.interest_rate, Math.floor(hoursOverdue));
      return `you owe **${total}** coins (${loan.amount} + interest${hoursOverdue > 0 ? " + OVERDUE PENALTY" : ""}). ${hoursLeft > 0 ? `${Math.floor(hoursLeft)}h left` : "OVERDUE — pay up NOW"}`;
    }

    case "loan_repay": {
      // Serialize the entire flow so two parallel repay calls can't both pass
      // the affordability check and both deduct. Re-read loan + balance INSIDE
      // the lock — values read before the lock may be stale by the time we
      // get our turn.
      return db.withUserLock(message.author.id, async () => {
        const loan = await db.getActiveLoan(message.author.id);
        if (!loan) return "you don't have any active loans";
        const hoursOverdue = Math.max(0, (Date.now() - new Date(loan.due_at).getTime()) / 3600_000);
        const total = calculateLoanTotal(loan.amount, loan.interest_rate, Math.floor(hoursOverdue));
        const econ = await db.getBalance(message.author.id);
        if (econ.balance < total) return `you owe ${total} coins but only have ${econ.balance}. get gambling`;
        // Use the unsafe variant — outer withUserLock is non-reentrant.
        await db.updateBalanceUnsafe(message.author.id, -total, "loan_repay", `paid ${total}`);
        await db.closeLoan(loan.id, "paid");
        if (hoursOverdue <= 0) await db.unlockAchievement(message.author.id, "loan_paid");
        return `paid back **${total}** coins. ${hoursOverdue > 0 ? "you were late but at least you paid" : "on time too, nice"} — balance: **${econ.balance - total}**`;
      });
    }

    // ─── BOUNTIES ──────────────────────────────────────────────────────

    case "place_bounty": {
      const target = input.target || input.username;
      if (!target) return "who are you putting a bounty on?";
      const amount = Math.floor(input.amount || 100);
      if (amount < 50) return "minimum bounty is 50 coins";
      const econ = await db.getBalance(message.author.id);
      if (econ.balance < amount) return `you only have ${econ.balance} coins`;
      // Resolve target
      if (!guild) return "bounties only work in servers";
      const member = await resolveMember(guild, target);
      if (!member) return `couldn't find "${target}"`;
      if (member.id === message.author.id) return "you can't put a bounty on yourself";
      await db.updateBalance(message.author.id, -amount, "bounty_placed", `on ${member.displayName}`);
      await db.createBounty(member.id, message.author.id, amount, guild.id);
      await db.unlockAchievement(member.id, "bounty_target");
      const { bountyEmbed } = await import("./gameVisuals.js");
      await message.channel.send({ embeds: [bountyEmbed(member.displayName, amount, message.author.displayName)] });
      return `bounty of ${amount} coins placed on ${member.displayName}. whoever beats them in a duel collects it`;
    }

    case "bounty_board": {
      const bounties = await db.getActiveBounties(guild?.id);
      if (!bounties.length) return "no active bounties right now. peace reigns... for now";
      const { bountyBoardEmbed } = await import("./gameVisuals.js");
      await message.channel.send({ embeds: [bountyBoardEmbed(bounties, guild)] });
      return "there's the bounty board";
    }

    // ─── DAILY CHALLENGES ──────────────────────────────────────────────

    case "daily_challenge_check": {
      const today = new Date().toISOString().split("T")[0];
      let challenge = await db.getDailyChallenge(guild?.id, today);
      if (!challenge) {
        const c = generateChallenge();
        await db.createDailyChallenge(guild?.id, c.type, c.target, c.reward, today);
        challenge = { ...c, date: today, completed_by: [] };
      }
      const alreadyDone = (challenge.completed_by || []).includes(message.author.id);
      const { dailyChallengeEmbed } = await import("./gameVisuals.js");
      const { embed, row } = dailyChallengeEmbed(challenge, alreadyDone);
      await message.channel.send({ embeds: [embed], components: row ? [row] : [] });
      return alreadyDone ? "you already completed today's challenge" : "there's today's challenge";
    }

    case "daily_challenge_complete": {
      const today = new Date().toISOString().split("T")[0];
      const challenge = await db.getDailyChallenge(guild?.id, today);
      if (!challenge) return "no challenge today — check back tomorrow";
      if ((challenge.completed_by || []).includes(message.author.id)) return "you already completed today's challenge";

      // Verify completion condition based on challenge type using actual stats
      const userId = message.author.id;
      const target = challenge.challenge_target || challenge.target;
      const type = challenge.challenge_type || challenge.type;

      // Map challenge types to their game_type in irene_game_stats
      const GAME_TYPE_MAP = {
        coinflip_wins: "coinflip",
        dice_wins: "dice",
        slots_play: "slots",
        rps_wins: "rps",
        trivia_correct: "trivia",
        duel_wins: "duel",
        survive_roulette: "roulette",
      };

      let progress = 0;
      let verified = false;

      if (GAME_TYPE_MAP[type]) {
        const gameType = GAME_TYPE_MAP[type];
        const stats = await db.getGameStats(userId, gameType);

        if (type === "slots_play") {
          // slots_play counts total plays (wins + losses)
          progress = (stats.wins || 0) + (stats.losses || 0);
        } else if (type === "survive_roulette") {
          progress = stats.wins || 0;
        } else {
          // *_wins types just check wins
          progress = stats.wins || 0;
        }
        verified = progress >= target;
      } else if (type === "total_wagered") {
        // Sum total_wagered across all game types via transactions today
        const supabase = db.getSupabase();
        if (supabase) {
          const { data: rows } = await supabase
            .from("irene_transactions")
            .select("amount")
            .eq("user_id", userId)
            .like("type", "gamble%")
            .gte("created_at", today + "T00:00:00")
            .lt("created_at", today + "T23:59:59.999");
          progress = (rows || []).reduce((sum, r) => sum + Math.abs(r.amount), 0);
        }
        verified = progress >= target;
      } else if (type === "rob_attempt") {
        const supabase = db.getSupabase();
        if (supabase) {
          const { data: rows } = await supabase
            .from("irene_transactions")
            .select("type")
            .eq("user_id", userId)
            .in("type", ["rob_success", "rob_fail", "rob_fine"])
            .gte("created_at", today + "T00:00:00")
            .lt("created_at", today + "T23:59:59.999");
          progress = (rows || []).length;
        }
        verified = progress >= target;
      } else if (type === "earn_coins") {
        const supabase = db.getSupabase();
        if (supabase) {
          const { data: rows } = await supabase
            .from("irene_transactions")
            .select("amount")
            .eq("user_id", userId)
            .gt("amount", 0)
            .gte("created_at", today + "T00:00:00")
            .lt("created_at", today + "T23:59:59.999");
          progress = (rows || []).reduce((sum, r) => sum + r.amount, 0);
        }
        verified = progress >= target;
      }

      if (!verified) return `challenge not complete yet — progress: ${progress}/${target}`;

      const newlyCompleted = await db.completeDailyChallenge(challenge.id, message.author.id);
      if (!newlyCompleted) return "challenge already claimed";
      await db.updateBalance(message.author.id, challenge.reward, "challenge_reward", challenge.challenge_type || challenge.type);
      return `challenge complete! earned **${challenge.reward}** coins 🎉`;
    }

    // ─── ACHIEVEMENTS ──────────────────────────────────────────────────

    case "achievements_list": {
      const unlocked = await db.getUnlockedAchievements(message.author.id);
      const unlockedKeys = new Set(unlocked.map(a => a.achievement_key));
      const { achievementsEmbed } = await import("./gameVisuals.js");
      await message.channel.send({ embeds: [achievementsEmbed(ACHIEVEMENTS, unlockedKeys, message.author.displayName)] });
      return `${unlockedKeys.size}/${Object.keys(ACHIEVEMENTS).length} achievements unlocked`;
    }

    default:
      return `unknown economy tool: ${toolName}`;
  }
}
