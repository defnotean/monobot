/**
 * @file packages/eris/database/activities.js
 * @module packages/eris/database/activities
 *
 * The server-economy activities: short-term coin loans (overdue sweep),
 * per-guild bounties, the daily server challenge with per-user completion
 * tracking, multi-phase boss battles, per-user pets (hunger/mood decay + PvP
 * battles/training), passive-income territories, multi-participant heists
 * (per-heist join lock), timed item auctions (escrow-on-bid + per-auction
 * lock), and 1v1 roast battles.
 *
 * Depends on economy (the in-process `withEconLock` / `withUserLock` mutex and
 * the coin helpers `tryDeductBalance` / `updateBalance` used by auction escrow)
 * and inventory (auction item escrow). One-directional: economy and inventory
 * never import activities, so the graph stays acyclic.
 */
import { getSupabase } from "./core.js";
import { withEconLock, withUserLock, tryDeductBalance, updateBalance } from "./economy.js";
import { hasItem, removeFromInventory, addToInventory } from "./inventory.js";
import { log } from "../utils/logger.js";

// ─── LOANS ──────────────────────────────────────────────────────────────────

export async function createLoan(userId, amount, interestRate, dueAt) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_loans").insert({ user_id: userId, amount, interest_rate: interestRate, due_at: dueAt }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getActiveLoan(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_loans").select("*").eq("user_id", userId).eq("status", "active").limit(1).single();
  return data;
}

export async function closeLoan(loanId, status = "paid") {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_loans").update({ status }).eq("id", loanId); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getOverdueLoans() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_loans").select("*").eq("status", "active").lt("due_at", new Date().toISOString());
  return data || [];
}

// ─── BOUNTIES ───────────────────────────────────────────────────────────────

export async function createBounty(targetId, placedBy, amount, guildId) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_bounties").insert({ target_user_id: targetId, placed_by: placedBy, amount, guild_id: guildId }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getActiveBounties(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_bounties").select("*").eq("guild_id", guildId).eq("status", "active").order("amount", { ascending: false });
  return data || [];
}

export async function getBountyOnUser(userId, guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_bounties").select("*").eq("target_user_id", userId).eq("guild_id", guildId).eq("status", "active").limit(1).single();
  return data;
}

export async function claimBounty(bountyId) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_bounties").update({ status: "claimed" }).eq("id", bountyId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── DAILY CHALLENGES ───────────────────────────────────────────────────────

export async function getDailyChallenge(guildId, date) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_daily_challenges").select("*").eq("guild_id", guildId).eq("date", date).limit(1).single();
  return data;
}

export async function createDailyChallenge(guildId, type, target, reward, date) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_daily_challenges").insert({ guild_id: guildId, challenge_type: type, challenge_target: target, reward, date }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function completeDailyChallenge(challengeId, userId) {
  const supabase = getSupabase();
  if (!supabase) return;
  const sb = supabase; // narrow non-null across the async closure below
  // Wrap the read-modify-write in a per-challenge lock so two concurrent
  // completions on the same challenge can't both read the same completed_by
  // array, both push their id, and the second write clobber the first
  // (silently dropping the first user's id from the completion list).
  // withUserLock is just a string-keyed mutex — challengeId works fine as the
  // key. Also do an optimistic post-write verification as defense-in-depth
  // for the multi-instance case where the in-process lock can't help.
  return withUserLock(challengeId, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await sb.from("eris_daily_challenges").select("completed_by").eq("id", challengeId).single();
        const completed = data?.completed_by || [];
        if (completed.includes(userId)) return; // already completed — no-op
        const next = [...completed, userId];
        await sb.from("eris_daily_challenges").update({ completed_by: next }).eq("id", challengeId);
        // Defense-in-depth: re-read and confirm our id landed. If a racing
        // writer overwrote us (only possible across instances since the
        // lock above serializes within a process), retry once.
        const { data: verify } = await sb.from("eris_daily_challenges").select("completed_by").eq("id", challengeId).single();
        if ((verify?.completed_by || []).includes(userId)) return;
      } catch (e) { log(`[DB] ${e.message}`); return; }
    }
  });
}

// The OLD eris_stocks / eris_portfolios table accessors used to live here
// (getAllStocks / getStock / updateStockPrice / buyStock / sellStock /
// getHolding / getPortfolio). They were dead after the stock market moved
// to the in-memory GBM simulation in ai/stockMarket.js (persisted under
// bot_data.eris_stocks). Removed to prevent future code from accidentally
// writing to the abandoned tables.

// ─── BOSS BATTLES ───────────────────────────────────────────────────────────

export async function createBossBattle(guildId, bossName, hp, expiresAt) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_boss_battles").insert({ guild_id: guildId, boss_name: bossName, boss_hp: hp, max_hp: hp, expires_at: expiresAt }).select().single();
    return data;
  } catch { return null; }
}

export async function getActiveBoss(guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_boss_battles").select("*").eq("guild_id", guildId).gt("boss_hp", 0).order("created_at", { ascending: false }).limit(1).single();
  return data;
}

export async function spawnBoss(guildId, bossName, bossEmoji, hp, phases, lootMultiplier) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_boss_battles").insert({
      guild_id: guildId,
      boss_name: bossName,
      boss_emoji: bossEmoji,
      boss_hp: hp,
      max_hp: hp,
      participants: {},
      phase: 1,
      loot_multiplier: lootMultiplier,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), // 1 hour
      created_at: new Date().toISOString(),
    }).select().single();
    return data;
  } catch { return null; }
}

export async function damageBoss(bossId, userId, damage) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data: boss } = await supabase.from("eris_boss_battles").select("*").eq("id", bossId).single();
    if (!boss) return null;
    if (boss.boss_hp <= 0) return { ...boss, defeated: false, alreadyDead: true }; // Already killed by someone else
    const newHp = Math.max(0, boss.boss_hp - damage);
    const participants = boss.participants || {};
    participants[userId] = (participants[userId] || 0) + damage;
    const phase = newHp <= 0 ? 0 : newHp <= boss.max_hp * 0.25 ? 3 : newHp <= boss.max_hp * 0.5 ? 2 : 1;
    await supabase.from("eris_boss_battles").update({ boss_hp: newHp, participants, phase }).eq("id", bossId);
    return { ...boss, boss_hp: newHp, participants, phase, defeated: newHp <= 0 };
  } catch { return null; }
}

// ─── PETS ───────────────────────────────────────────────────────────────────

/**
 * Apply time-based hunger/mood decay to a pet snapshot. Non-destructive —
 * returns a new object with decayed values but doesn't write back. Graceful
 * when `last_fed` is missing from the row (old pets predating this feature).
 *
 * Rules:
 *   - Hunger drops 2/hour (full → starving in ~50h)
 *   - Mood drops 1/hour once hunger is below 30 (hangry mechanic)
 *   - Mood recovers 0.5/hour while hunger is above 50
 */
function _applyHungerDecay(pet) {
  if (!pet) return pet;
  const now = Date.now();
  const lastFedRaw = pet.last_fed ? new Date(pet.last_fed).getTime() : now;
  // Clamp future timestamps (clock skew / tampering) so a user can't game
  // decay by pointing last_fed at 2099.
  const lastFedTs = Number.isFinite(lastFedRaw) ? Math.min(lastFedRaw, now) : now;
  const hoursSince = Math.max(0, (now - lastFedTs) / 3_600_000);
  if (hoursSince <= 0) return pet;

  const out = { ...pet };
  const baseHunger = pet.hunger ?? 100;
  out.hunger = Math.max(0, Math.floor(baseHunger - hoursSince * 2));

  // Mood drifts based on hunger state. Use <= 30 / >= 50 to avoid the
  // off-by-one where a pet fed to exactly 30 never escapes the hangry zone.
  const baseMood = pet.mood ?? 100;
  if (out.hunger <= 30) {
    out.mood = Math.max(0, Math.floor(baseMood - hoursSince * 1));
  } else if (baseHunger >= 50) {
    out.mood = Math.min(100, Math.floor(baseMood + hoursSince * 0.5));
  } else {
    out.mood = baseMood;
  }
  return out;
}

export async function getPet(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_pets").select("*").eq("user_id", userId).single();
  return _applyHungerDecay(data);
}

/** Raw fetch without decay — use sparingly (recordPetBattle / trainPet etc) */
export async function getPetRaw(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_pets").select("*").eq("user_id", userId).single();
  return data;
}

export async function createPet(userId, name, species) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("eris_pets")
      .insert({ user_id: userId, name, species, last_fed: new Date().toISOString() })
      .select()
      .single();
    return data;
  } catch { return null; }
}

export async function updatePet(userId, updates) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_pets").update(updates).eq("user_id", userId); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function feedPet(userId) {
  const supabase = getSupabase();
  if (!supabase) return;
  return withEconLock(userId, async () => {
    // Read RAW so we add to the decayed-forward value but reset last_fed to now.
    const pet = await getPetRaw(userId);
    if (!pet) return null;
    const decayed = _applyHungerDecay(pet);
    const newHunger = Math.min(100, decayed.hunger + 30);
    const newMood = Math.min(100, decayed.mood + 10);
    const newXp = (pet.xp ?? 0) + 5;
    await updatePet(userId, {
      hunger: newHunger,
      mood: newMood,
      xp: newXp,
      last_fed: new Date().toISOString(),
    });
    return { hunger: newHunger, mood: newMood, xp: newXp };
  });
}

// ─── TERRITORIES ────────────────────────────────────────────────────────────

export async function getTerritory(channelId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_territories").select("*").eq("channel_id", channelId).single();
  return data;
}

export async function claimTerritory(guildId, channelId, ownerId) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from("eris_territories").upsert({ guild_id: guildId, channel_id: channelId, owner_id: ownerId, claimed_at: new Date().toISOString(), last_collected: new Date().toISOString() });
  } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getTerritories(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_territories").select("*").eq("guild_id", guildId).not("owner_id", "is", null);
  return data || [];
}

export async function collectTerritoryIncome(territoryId, amount) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_territories").update({ last_collected: new Date().toISOString() }).eq("id", territoryId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── HEISTS ─────────────────────────────────────────────────────────────────

export async function createHeist(guildId, channelId, organizerId, targetId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_heists").insert({ guild_id: guildId, channel_id: channelId, organizer_id: organizerId, target_user_id: targetId, participants: [organizerId] }).select().single();
    return data;
  } catch { return null; }
}

export async function getActiveHeist(guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_heists").select("*").eq("guild_id", guildId).eq("status", "recruiting").order("created_at", { ascending: false }).limit(1).single();
  return data;
}

// Per-heist in-memory locks — prevents two parallel /heist join calls from
// both reading the same participants array and each push()ing independently,
// which would either duplicate an entry OR lose one depending on write order.
const _heistLocks = new Map();
async function _withHeistLock(heistId, fn) {
  const prev = _heistLocks.get(heistId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _heistLocks.set(heistId, current);
  try { return await current; } finally {
    if (_heistLocks.get(heistId) === current) _heistLocks.delete(heistId);
  }
}

export async function joinHeist(heistId, userId) {
  const supabase = getSupabase();
  if (!supabase) return;
  const sb = supabase; // narrow non-null across the async closure below
  return _withHeistLock(heistId, async () => {
    try {
      // Re-read inside the lock so another concurrent join that already
      // committed is visible here.
      const { data } = await sb.from("eris_heists").select("participants").eq("id", heistId).single();
      const parts = data?.participants || [];
      if (parts.includes(userId)) return; // already joined — no-op
      parts.push(userId);
      await sb.from("eris_heists").update({ participants: parts }).eq("id", heistId);
    } catch (e) { log(`[DB] joinHeist: ${e.message}`); }
  });
}

export async function resolveHeist(heistId, status, loot = 0) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_heists").update({ status, loot }).eq("id", heistId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── AUCTIONS ───────────────────────────────────────────────────────────────

export async function createAuction(sellerId, itemName, startingPrice, guildId, durationMs = 3600_000) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    // Escrow the listed item out of the seller's inventory at list time. Without
    // this the seller keeps a copy while settlement grants another to the
    // winner, duping the item. The item is returned to the winner at settlement
    // (events/ready.js) or refunded to the seller if the auction expires with no
    // bids (closeExpiredAuctions). Refuse to list an item the seller doesn't own.
    if (!(await hasItem(sellerId, itemName))) return null;
    // Capture the item's original category as we escrow it out, so refunds (here
    // or at no-bid expiry) restore it under its real type rather than a lifecycle
    // string. Fall back to "auction" if the row carried no type.
    const itemType = (await removeFromInventory(sellerId, itemName)) || "auction";
    const endsAt = new Date(Date.now() + durationMs).toISOString();
    const baseRow = { seller_id: sellerId, item_name: itemName, starting_price: startingPrice, current_bid: startingPrice, ends_at: endsAt, guild_id: guildId };
    // Persist item_type on the row (migration 005) so closeExpiredAuctions can
    // round-trip it on a no-bid refund. If that column doesn't exist yet (migration
    // unapplied), PostgREST rejects the column — retry without it so listing still
    // works; the no-bid refund then falls back to "auction" as before.
    let { data, error } = await supabase.from("eris_auctions").insert({ ...baseRow, item_type: itemType }).select().single();
    if (error && /item_type/.test(error.message || "")) {
      ({ data, error } = await supabase.from("eris_auctions").insert(baseRow).select().single());
    }
    if (error || !data) {
      // Listing row never landed — give the escrowed item back under its original
      // type so it isn't lost or re-grouped under the wrong inventory category.
      await addToInventory(sellerId, itemName, itemType);
      return null;
    }
    return data;
  } catch { return null; }
}

export async function getActiveAuctions(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_auctions").select("*").eq("guild_id", guildId).eq("status", "active").order("ends_at");
  return data || [];
}

// Per-auction in-memory locks — prevents two parallel /bid calls from both
// reading the same current_bid, both passing amount > current_bid, and the
// second update silently clobbering the first (losing-bidder coins debited
// or the higher bid silently lost). Mirrors _withHeistLock above.
const _auctionLocks = new Map();
async function _withAuctionLock(auctionId, fn) {
  const prev = _auctionLocks.get(auctionId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _auctionLocks.set(auctionId, current);
  try { return await current; } finally {
    if (_auctionLocks.get(auctionId) === current) _auctionLocks.delete(auctionId);
  }
}

export async function bidOnAuction(auctionId, bidderId, amount) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const sb = supabase; // narrow non-null across the async closure below
  return _withAuctionLock(auctionId, async () => {
    // Up to 2 attempts: if the optimistic-concurrency .eq("current_bid", ...)
    // matches zero rows (some other writer slipped in between read and write,
    // e.g. across instances where the in-process lock can't help), re-read
    // and try once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await sb.from("eris_auctions").select("*").eq("id", auctionId).single();
        if (!data || data.status !== "active" || amount <= data.current_bid) return false;
        const lastSeen = data.current_bid;
        const prevBidderId = data.current_bidder_id || null;

        // Escrow-on-bid: take the bid amount from the new bidder up front so
        // settlement just hands the already-held coins to the seller — no coins
        // are minted. If the bidder can't pay, reject the bid.
        const escrow = await tryDeductBalance(bidderId, amount, "auction_bid", `bid on ${auctionId}`);
        if (!escrow.ok) return false;

        // Defensive optimistic-concurrency: only update if current_bid is
        // still what we just read. If a concurrent writer changed it, the
        // .eq() filter matches zero rows and the update is a no-op — refund the
        // escrow and retry the read.
        const { data: updated } = await sb
          .from("eris_auctions")
          .update({ current_bid: amount, current_bidder_id: bidderId })
          .eq("id", auctionId)
          .eq("current_bid", lastSeen)
          .select();
        if (updated && updated.length > 0) {
          // We're now the high bidder — refund the previous escrow. The starting
          // price has no escrowed bidder (current_bidder_id is null on create),
          // so only a real previous bidder gets refunded. This INCLUDES the same
          // bidder raising their own bid: we just escrowed the full new `amount`
          // on top of their already-held `lastSeen`, so refunding `lastSeen` to
          // them leaves their total escrow == their current bid (no over-pay).
          if (prevBidderId && lastSeen > 0) {
            try { await updateBalance(prevBidderId, lastSeen, "auction_refund", `outbid on ${auctionId}`); }
            catch (e) { log(`[DB] bidOnAuction refund failed for ${prevBidderId}: ${e.message} — manual reconciliation needed`); }
          }
          return true;
        }
        // Optimistic check failed — refund our escrow and loop to retry once.
        try { await updateBalance(bidderId, amount, "auction_refund", `bid race lost on ${auctionId}`); }
        catch (e) { log(`[DB] bidOnAuction escrow refund failed for ${bidderId}: ${e.message} — manual reconciliation needed`); }
      } catch { return false; }
    }
    return false;
  });
}

export async function closeExpiredAuctions() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_auctions").select("*").eq("status", "active").lt("ends_at", new Date().toISOString());
  if (!data?.length) return [];
  for (const auction of data) {
    try { await supabase.from("eris_auctions").update({ status: "closed" }).eq("id", auction.id); } catch (e) { log(`[DB] ${e.message}`); }
    // No winning bidder → the item was escrowed out at createAuction time, so
    // return it to the seller. Auctions that sold are settled by the winner-grant
    // path in events/ready.js (the item the seller escrowed becomes the winner's).
    if (!(auction.current_bidder_id && auction.current_bid > 0)) {
      // Restore under the item's original category (captured at list time on the
      // row). Falls back to "auction" if the column is absent / unset so the item
      // is never grouped under a lifecycle string like "auction_unsold".
      try { await addToInventory(auction.seller_id, auction.item_name, auction.item_type || "auction"); }
      catch (e) { log(`[DB] closeExpiredAuctions refund failed for ${auction.seller_id}: ${e.message}`); }
    }
  }
  return data;
}

// ─── ROAST BATTLES ──────────────────────────────────────────────────────────

export async function createRoastBattle(guildId, channelId, player1Id, player2Id) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_roast_battles").insert({ guild_id: guildId, channel_id: channelId, player1_id: player1Id, player2_id: player2Id }).select().single();
    return data;
  } catch { return null; }
}

export async function getPendingRoast(channelId, userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("eris_roast_battles").select("*").eq("channel_id", channelId).eq("player2_id", userId).eq("status", "pending").single();
  return data;
}

export async function updateRoastBattle(roastId, updates) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_roast_battles").update(updates).eq("id", roastId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── PET BATTLES ───────────────────────────────────────────────────────────

export async function getPetBattleStats(userId) {
  const pet = await getPet(userId);
  if (!pet) return null;
  return {
    ...pet,
    attack: pet.attack || 5,
    defense: pet.defense || 5,
    speed: pet.speed || 5,
    battles_won: pet.battles_won || 0,
    battles_lost: pet.battles_lost || 0,
  };
}

export async function recordPetBattle(userId, won) {
  // Serialize so two parallel battles by this user don't both read the same
  // pre-battle W/L counts and both write +1, double-counting one result.
  return withEconLock(userId, async () => {
    const pet = await getPet(userId);
    if (!pet) return;
    const updates = {
      xp: (pet.xp || 0) + (won ? 15 : 5),
      battles_won: (pet.battles_won || 0) + (won ? 1 : 0),
      battles_lost: (pet.battles_lost || 0) + (won ? 0 : 1),
    };
    await updatePet(userId, updates);
  });
}

export async function trainPet(userId, stat) {
  const validStats = ["attack", "defense", "speed"];
  if (!validStats.includes(stat)) return null;
  // Wrap read-modify-write so two parallel /pet train calls can't both read
  // the same baseline and each write only their increment.
  return withEconLock(userId, async () => {
    const pet = await getPet(userId);
    if (!pet) return null;
    const gain = 1 + Math.floor(Math.random() * 3); // +1 to +3
    const current = pet[stat] || 5;
    await updatePet(userId, { [stat]: current + gain });
    return { stat, gain, newValue: current + gain };
  });
}
