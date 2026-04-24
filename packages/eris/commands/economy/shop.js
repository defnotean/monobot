import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder , MessageFlags } from "discord.js";
import { DEFAULT_SHOP_ITEMS } from "../../ai/economy.js";

// ─── Categories ─────────────────────────────────────────────────────────────

const CATEGORIES = [
  { key: "equipment", label: "Equipment", emoji: "⚒️", types: ["equipment"] },
  { key: "consumable", label: "Consumables", emoji: "🧪", types: ["mystery", "passive", "consumable"] },
  { key: "booster", label: "Boosters", emoji: "⚡", types: ["booster"] },
  { key: "protection", label: "Protections", emoji: "🛡️", types: ["shield", "protection", "immunity"] },
  { key: "upgrade", label: "Upgrades", emoji: "⬆️", types: ["upgrade"] },
  { key: "pet", label: "Pet Items", emoji: "🐾", types: ["pet_gear", "pet_cosmetic"] },
  { key: "cosmetic", label: "Cosmetics", emoji: "✨", types: ["cosmetic"] },
  { key: "social", label: "Social", emoji: "💌", types: ["nickname", "special"] },
  { key: "gambling", label: "Gambling", emoji: "🎰", types: ["gambling"] },
  { key: "minion", label: "Minions", emoji: "🤖", types: ["minion", "minion_slot", "minion_upgrade"] },
];

function getItemsForCategory(catKey) {
  const cat = CATEGORIES.find(c => c.key === catKey);
  if (!cat) return [];
  return DEFAULT_SHOP_ITEMS.filter(i => cat.types.includes(i.type));
}

// ─── Embeds ─────────────────────────────────────────────────────────────────

const PURPLE = 0x9333EA;
const PER_PAGE = 10;

function buildOverviewEmbed(balance = null) {
  const lines = CATEGORIES.map(cat => {
    const items = getItemsForCategory(cat.key);
    const min = Math.min(...items.map(i => i.price));
    const max = Math.max(...items.map(i => i.price));
    return `${cat.emoji} **${cat.label}** · ${items.length} items · ${min.toLocaleString()}–${max.toLocaleString()}`;
  });

  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🛒 Eris's Shop")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${DEFAULT_SHOP_ITEMS.length} items${balance != null ? ` · 💰 ${balance.toLocaleString()}` : ""} · pick a category below` });
}

// Types that can only be bought once
const UNIQUE_TYPES = new Set(["equipment", "upgrade", "pet_gear", "pet_cosmetic", "cosmetic"]);

// userItems = Set of item names the user owns, hasPet = bool
function buildCategoryEmbed(catKey, page = 0, balance = null, userItems = null, hasPet = false) {
  const cat = CATEGORIES.find(c => c.key === catKey);
  if (!cat) return null;
  const items = getItemsForCategory(catKey);
  if (!items.length) return null;

  const totalPages = Math.ceil(items.length / PER_PAGE);
  const pageItems = items.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const lines = pageItems.map(i => {
    const e = i.emoji || "·";
    const owned = UNIQUE_TYPES.has(i.type) && userItems?.has(i.name);
    const missingReq = i.requires && !checkRequirement(i.requires, userItems, hasPet);
    const cantAfford = balance != null && balance < i.price;
    let tag = "";
    if (owned) tag = " ✅";
    else if (missingReq) tag = " 🔒";
    else if (cantAfford) tag = " ✘";
    const note = owned ? "" : missingReq ? ` *(needs ${i.requires === "pet" ? "a pet" : i.requires})*` : "";
    return `${e} **${i.name}** — ${i.price.toLocaleString()}${tag}\n╰ *${i.description}*${note}`;
  });

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`${cat.emoji} ${cat.label}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${totalPages > 1 ? `${page + 1}/${totalPages} · ` : ""}${items.length} items${balance != null ? ` · 💰 ${balance.toLocaleString()}` : ""} · select below to buy` });

  return { embed, items: pageItems, totalPages };
}

function checkRequirement(requires, userItems, hasPet) {
  if (!requires) return true;
  if (requires === "pet") return hasPet;
  if (userItems) return userItems.has(requires);
  return true; // can't check, allow
}

function isItemBuyable(item, userItems, hasPet) {
  // Already own a unique item
  if (UNIQUE_TYPES.has(item.type) && userItems?.has(item.name)) return false;
  // Missing prerequisite
  if (item.requires && !checkRequirement(item.requires, userItems, hasPet)) return false;
  return true;
}

// ─── Components ─────────────────────────────────────────────────────────────

function buildCategorySelect(selectedKey = null) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("shop_nav")
      .setPlaceholder("📂 Pick a category...")
      .addOptions([
        { label: "Overview", description: "Back to all categories", value: "_overview", emoji: "🏠" },
        ...CATEGORIES.map(cat => ({
          label: cat.label,
          value: cat.key,
          emoji: cat.emoji,
          default: cat.key === selectedKey,
        })),
      ])
  );
}

function buildItemSelect(items, catKey, page, userItems = null, hasPet = false) {
  // Only show items the user can actually buy (not owned unique, not locked)
  const buyable = items.filter(i => isItemBuyable(i, userItems, hasPet));
  if (!buyable.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`shop_item_${catKey}_${page}`)
      .setPlaceholder("🛒 Pick an item to buy...")
      .addOptions(
        buyable.map(i => {
          const safeId = i.name.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 40);
          return {
            label: `${i.name} — ${i.price.toLocaleString()} coins`,
            description: i.description.slice(0, 100),
            value: safeId,
            emoji: i.emoji || "🛒",
          };
        })
      )
  );
}

function buildPageRow(catKey, page, totalPages) {
  if (totalPages <= 1) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop_pg_${catKey}_${page - 1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`shop_pg_${catKey}_${page + 1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

// Assemble all components for a category view (max 5 rows)
function buildCategoryComponents(catKey, page, items, totalPages, userItems = null, hasPet = false) {
  const rows = [buildCategorySelect(catKey)];
  const itemSel = buildItemSelect(items, catKey, page, userItems, hasPet);
  if (itemSel) rows.push(itemSel);
  const pgRow = buildPageRow(catKey, page, totalPages);
  if (pgRow) rows.push(pgRow);
  return rows;
}

// ─── Slash Command ──────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("shop")
  .setDescription("Browse & buy from Eris's shop")
  .addStringOption(opt => opt
    .setName("category")
    .setDescription("Jump to a category")
    .addChoices(...CATEGORIES.map(c => ({ name: c.label, value: c.key }))));

export async function execute(interaction) {
  const category = interaction.options.getString("category");
  const { getBalance, getInventory, getPet } = await import("../../database.js");
  const userId = interaction.user.id;
  const [wallet, inv, pet] = await Promise.all([getBalance(userId), getInventory(userId), getPet(userId)]);
  const userItems = new Set((inv || []).map(i => i.item_name));
  const hasPet = !!pet;

  if (category) {
    const result = buildCategoryEmbed(category, 0, wallet.balance, userItems, hasPet);
    if (!result) return interaction.reply({ content: "empty category", flags: MessageFlags.Ephemeral });
    const components = buildCategoryComponents(category, 0, result.items, result.totalPages, userItems, hasPet);
    await interaction.reply({ embeds: [result.embed], components });
  } else {
    const embed = buildOverviewEmbed(wallet.balance);
    await interaction.reply({ embeds: [embed], components: [buildCategorySelect()] });
  }
}

export { CATEGORIES, UNIQUE_TYPES, getItemsForCategory, buildOverviewEmbed, buildCategoryEmbed, buildCategorySelect, buildItemSelect, buildPageRow, buildCategoryComponents, checkRequirement, isItemBuyable };
