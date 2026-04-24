// ai/randomEvents.js — Server-wide random events that affect the economy
// Fires every 30-60 min with 15% chance. Some help, some hurt, some are interactive.

import { log } from "../utils/logger.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const PURPLE = 0x9333EA;
const GOLD = 0xFFD700;
const RED = 0xEF4444;
const GREEN = 0x10B981;

// Active modifiers (time-limited effects)
const _activeModifiers = new Map(); // key → { effect, expiresAt }

export function getActiveModifier(key) {
  const mod = _activeModifiers.get(key);
  if (mod && Date.now() < mod.expiresAt) return mod;
  if (mod) _activeModifiers.delete(key);
  return null;
}

export function isModifierActive(key) { return !!getActiveModifier(key); }

export function getGamblingMultiplier() {
  return isModifierActive("lucky_hour") ? 2 : isModifierActive("inflation") ? 0.75 : 1;
}

export function getGrindingMultiplier() {
  return isModifierActive("bonus_xp") ? 2 : 1;
}

export function isShopInflated() { return isModifierActive("inflation"); }

const EVENTS = [
  // ── Positive ──
  {
    id: "coin_rain",
    name: "💰 Coin Rain",
    description: "Coins are falling from the sky!",
    type: "positive",
    async execute(channel, db) {
      const amount = 50 + Math.floor(Math.random() * 151); // 50-200
      const embed = new EmbedBuilder().setColor(GOLD).setTitle("💰 COIN RAIN!").setDescription(`**${amount} coins** are raining from the sky! Click to claim! (expires in 2 min)`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`event_claim_${amount}`).setLabel(`Claim ${amount} coins`).setEmoji("💰").setStyle(ButtonStyle.Success)
      );
      const msg = await channel.send({ embeds: [embed], components: [row] });
      // Auto-expire after 2 minutes
      setTimeout(async () => {
        try { await msg.edit({ components: [] }).catch(() => {}); } catch {}
      }, 120_000);
      return { claimable: true, amount };
    },
  },
  {
    id: "lucky_hour",
    name: "🎰 Lucky Hour",
    description: "All gambling payouts doubled!",
    type: "positive",
    async execute(channel) {
      _activeModifiers.set("lucky_hour", { effect: "2x gambling", expiresAt: Date.now() + 10 * 60_000 });
      const embed = new EmbedBuilder().setColor(GOLD).setTitle("🎰 LUCKY HOUR!").setDescription("All gambling payouts are **DOUBLED** for the next 10 minutes!\nGo bet something!");
      await channel.send({ embeds: [embed] });
      return {};
    },
  },
  {
    id: "mystery_airdrop",
    name: "🎁 Mystery Airdrop",
    description: "A random user gets 500 coins!",
    type: "positive",
    async execute(channel, db) {
      const embed = new EmbedBuilder().setColor(GOLD).setTitle("🎁 MYSTERY AIRDROP").setDescription("Someone in this server just got **500 coins** dropped into their wallet... but who? 👀");
      await channel.send({ embeds: [embed] });
      return { airdrop: 500 };
    },
  },
  {
    id: "bonus_xp",
    name: "⭐ Bonus XP",
    description: "All grinding rewards doubled!",
    type: "positive",
    async execute(channel) {
      _activeModifiers.set("bonus_xp", { effect: "2x grinding", expiresAt: Date.now() + 15 * 60_000 });
      const embed = new EmbedBuilder().setColor(GREEN).setTitle("⭐ BONUS XP EVENT").setDescription("All grinding activities (fish, hunt, dig, work, beg, search) pay **DOUBLE** for 15 minutes!");
      await channel.send({ embeds: [embed] });
      return {};
    },
  },
  // ── Negative ──
  {
    id: "tax_collector",
    name: "💀 Tax Collector",
    description: "Everyone loses 5% of their wallet!",
    type: "negative",
    async execute(channel) {
      const embed = new EmbedBuilder().setColor(RED).setTitle("💀 TAX COLLECTOR").setDescription("The tax collector has arrived! Everyone loses **5% of their wallet**.\n*(Bank savings are safe)*");
      await channel.send({ embeds: [embed] });
      return { taxPercent: 5 };
    },
  },
  {
    id: "phantom_thief",
    name: "🦹 Phantom Thief",
    description: "The richest user gets robbed!",
    type: "negative",
    async execute(channel) {
      const amount = 50 + Math.floor(Math.random() * 151);
      const embed = new EmbedBuilder().setColor(RED).setTitle("🦹 PHANTOM THIEF").setDescription(`A phantom thief just stole **${amount} coins** from the richest person in the server!`);
      await channel.send({ embeds: [embed] });
      return { stealFromRichest: amount };
    },
  },
  {
    id: "chaos_storm",
    name: "🌪️ Chaos Storm",
    description: "All cooldowns reset!",
    type: "neutral",
    async execute(channel) {
      const embed = new EmbedBuilder().setColor(PURPLE).setTitle("🌪️ CHAOS STORM").setDescription("A chaos storm has reset **ALL cooldowns**! Fish, hunt, dig, work — everything is ready to go again!");
      await channel.send({ embeds: [embed] });
      return { resetCooldowns: true };
    },
  },
  {
    id: "inflation",
    name: "💸 Inflation",
    description: "Shop prices +25% for 1 hour!",
    type: "negative",
    async execute(channel) {
      _activeModifiers.set("inflation", { effect: "+25% shop prices", expiresAt: Date.now() + 60 * 60_000 });
      const embed = new EmbedBuilder().setColor(RED).setTitle("💸 INFLATION!").setDescription("Shop prices have increased by **25%** for the next hour!\nBetter buy what you need fast...");
      await channel.send({ embeds: [embed] });
      return {};
    },
  },
  // ── Interactive ──
  {
    id: "quick_draw",
    name: "🎯 Quick Draw",
    description: "First to click wins 300 coins!",
    type: "interactive",
    async execute(channel) {
      const embed = new EmbedBuilder().setColor(GOLD).setTitle("🎯 QUICK DRAW!").setDescription("First person to click the button wins **300 coins**!");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("event_quickdraw").setLabel("DRAW!").setEmoji("🎯").setStyle(ButtonStyle.Danger)
      );
      const msg = await channel.send({ embeds: [embed], components: [row] });
      // Auto-expire after 30s if nobody clicked
      setTimeout(async () => {
        try {
          // Check if button still exists (wasn't already claimed)
          const fresh = await channel.messages.fetch(msg.id).catch(() => null);
          if (fresh?.components?.length > 0) {
            await fresh.edit({ components: [] }).catch(() => {});
            await channel.send("🎯 nobody was fast enough... 300 coins go unclaimed");
          }
        } catch {}
      }, 30_000);
      return { interactive: true, reward: 300 };
    },
  },
  {
    id: "everyone_roll",
    name: "🎲 Everyone Roll",
    description: "Everyone rolls, highest wins 500!",
    type: "interactive",
    async execute(channel, db) {
      const embed = new EmbedBuilder().setColor(PURPLE).setTitle("🎲 EVERYONE ROLL!").setDescription("Click to roll a d100! Highest roll after 60 seconds wins **500 coins**!");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("event_roll").setLabel("Roll d100").setEmoji("🎲").setStyle(ButtonStyle.Primary)
      );
      const msg = await channel.send({ embeds: [embed], components: [row] });

      // Auto-end after 60 seconds — pick winner and pay out.
      // Atomically remove the entry FIRST so a duplicate-fire of this timeout
      // (extremely rare but possible if the event loop hiccups) can't double-pay.
      // The finally block guarantees cleanup even if msg.edit/send rejects.
      setTimeout(async () => {
        const key = `roll_${msg.id}`;
        let rolls = null;
        if (globalThis._eventParticipants) {
          rolls = globalThis._eventParticipants.get(key);
          globalThis._eventParticipants.delete(key); // claim before pay
        }

        try {
          await msg.edit({ components: [] }).catch(() => {});

          if (!rolls || rolls.size === 0) {
            await channel.send("🎲 nobody rolled... coins stay in the vault i guess").catch(() => {});
            return;
          }

          let best = { userId: null, roll: 0 };
          for (const [uid, r] of rolls) {
            if (r > best.roll) best = { userId: uid, roll: r };
          }

          if (best.userId && db) {
            await db.updateBalance(best.userId, 500, "event_reward", "everyone_roll");
            await channel.send(`🏆 **<@${best.userId}> wins the roll with a ${best.roll}!** +500 coins`).catch(() => {});
          }
        } catch (e) {
          log(`[EVENT] Roll payout error: ${e.message}`);
        }
      }, 60_000);

      return { interactive: true, reward: 500 };
    },
  },
  {
    id: "pirate_raid",
    name: "🏴‍☠️ Pirate Raid",
    description: "Donate 1000 collectively or everyone loses 50!",
    type: "interactive",
    async execute(channel) {
      _activeModifiers.set("pirate_raid", { effect: "raid", expiresAt: Date.now() + 120_000, donated: 0, target: 1000 });
      const embed = new EmbedBuilder().setColor(RED).setTitle("🏴‍☠️ PIRATE RAID!").setDescription("Pirates are attacking! The server must collectively donate **1000 coins** in 2 minutes or everyone loses **50 coins**!\nClick to donate 50 coins each.");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("event_donate_50").setLabel("Donate 50 coins").setEmoji("💰").setStyle(ButtonStyle.Primary)
      );
      await channel.send({ embeds: [embed], components: [row] });
      return { interactive: true };
    },
  },
];

export function pickRandomEvent() {
  return EVENTS[Math.floor(Math.random() * EVENTS.length)];
}

export function getAllEvents() { return EVENTS; }

// Track last event time per guild
const _lastEventTime = new Map();

export function shouldFireEvent(guildId) {
  const last = _lastEventTime.get(guildId) || 0;
  if (Date.now() - last < 30 * 60_000) return false; // Min 30 min between events
  if (Math.random() > 0.15) return false; // 15% chance
  return true;
}

export function markEventFired(guildId) {
  _lastEventTime.set(guildId, Date.now());
}
