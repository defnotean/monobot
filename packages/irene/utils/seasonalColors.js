// ─── Seasonal Color Role System ─────────────────────────────────────────────
// Automatically rotates color role hex values based on the current season/month.
// Users keep their color slot (1-8), but the actual colors shift with the seasons.
// Checks once per hour. Also supports special event palettes (Halloween, Christmas, etc.)

import { log } from "./logger.js";

// ─── Seasonal Palettes (8 colors each, matching slots 1-8) ─────────────────

export const PALETTES = {
  // Spring: March, April, May — pastels, cherry blossom, fresh
  spring: {
    name: "Spring Bloom",
    emoji: "🌸",
    colors: [
      { name: "Cherry Blossom", hex: "#FFB7C5" },
      { name: "Lavender",       hex: "#C4B7EB" },
      { name: "Mint",           hex: "#98E4C8" },
      { name: "Peach",          hex: "#FFCBA4" },
      { name: "Sky Blue",       hex: "#87CEEB" },
      { name: "Lilac",          hex: "#DDA0DD" },
      { name: "Buttercup",      hex: "#F9E79F" },
      { name: "Rose",           hex: "#FF6B81" },
    ],
  },

  // Summer: June, July, August — vibrant, tropical, warm
  summer: {
    name: "Summer Heat",
    emoji: "☀️",
    colors: [
      { name: "Sunset Orange",  hex: "#FF6B35" },
      { name: "Ocean Blue",     hex: "#0077B6" },
      { name: "Coral",          hex: "#FF7F7F" },
      { name: "Lemon",          hex: "#FFF44F" },
      { name: "Tropical Green", hex: "#2ECC71" },
      { name: "Mango",          hex: "#FF8243" },
      { name: "Aqua",           hex: "#00CED1" },
      { name: "Hot Pink",       hex: "#FF69B4" },
    ],
  },

  // Fall: September, October, November — warm, earthy, cozy
  fall: {
    name: "Autumn Warmth",
    emoji: "🍂",
    colors: [
      { name: "Amber",          hex: "#FFBF00" },
      { name: "Rust",           hex: "#B7410E" },
      { name: "Burgundy",       hex: "#800020" },
      { name: "Sage",           hex: "#87AE73" },
      { name: "Burnt Orange",   hex: "#CC5500" },
      { name: "Terracotta",     hex: "#E2725B" },
      { name: "Plum",           hex: "#8E4585" },
      { name: "Gold",           hex: "#DAA520" },
    ],
  },

  // Winter: December, January, February — cool, icy, elegant
  winter: {
    name: "Winter Frost",
    emoji: "❄️",
    colors: [
      { name: "Ice Blue",       hex: "#A5F3FC" },
      { name: "Silver",         hex: "#C0C0C0" },
      { name: "Frost White",    hex: "#E8E8E8" },
      { name: "Midnight Blue",  hex: "#191970" },
      { name: "Pine Green",     hex: "#01796F" },
      { name: "Berry",          hex: "#8B0045" },
      { name: "Slate",          hex: "#708090" },
      { name: "Aurora",         hex: "#78D5D7" },
    ],
  },

  // Special: Halloween (October override)
  halloween: {
    name: "Halloween Night",
    emoji: "🎃",
    colors: [
      { name: "Pumpkin",        hex: "#FF7518" },
      { name: "Witch Purple",   hex: "#6A0DAD" },
      { name: "Blood Red",      hex: "#8B0000" },
      { name: "Ghost White",    hex: "#F8F8FF" },
      { name: "Poison Green",   hex: "#00FF41" },
      { name: "Midnight",       hex: "#1C1C2E" },
      { name: "Cobweb Gray",    hex: "#A9A9A9" },
      { name: "Candy Corn",     hex: "#FBEC5D" },
    ],
  },

  // Special: Christmas/Holiday (December override)
  christmas: {
    name: "Holiday Spirit",
    emoji: "🎄",
    colors: [
      { name: "Holly Red",      hex: "#C41E3A" },
      { name: "Evergreen",      hex: "#006400" },
      { name: "Gold Ornament",  hex: "#FFD700" },
      { name: "Snow White",     hex: "#FFFAFA" },
      { name: "Candy Cane",     hex: "#FF0800" },
      { name: "Pine",           hex: "#2E8B57" },
      { name: "Silver Bell",    hex: "#C0C0C0" },
      { name: "Cranberry",      hex: "#9B111E" },
    ],
  },

  // Special: Valentine's (February override)
  valentines: {
    name: "Valentine's Day",
    emoji: "💕",
    colors: [
      { name: "Rose Red",       hex: "#FF007F" },
      { name: "Blush Pink",     hex: "#FFB6C1" },
      { name: "Deep Wine",      hex: "#722F37" },
      { name: "Soft Mauve",     hex: "#E0B0FF" },
      { name: "Cupid Pink",     hex: "#FF77A9" },
      { name: "Pearl",          hex: "#FDEEF4" },
      { name: "Mulberry",       hex: "#C54B8C" },
      { name: "Love Red",       hex: "#E0115F" },
    ],
  },
};

/** Get the current palette based on month + optional special events */
export function getCurrentPalette() {
  const month = new Date().getMonth(); // 0-11
  const day = new Date().getDate();

  // Special event overrides
  if (month === 9 && day >= 15) return PALETTES.halloween;   // Oct 15-31
  if (month === 11) return PALETTES.christmas;                // All December
  if (month === 1 && day >= 7 && day <= 14) return PALETTES.valentines; // Feb 7-14

  // Seasonal defaults
  if (month >= 2 && month <= 4) return PALETTES.spring;   // Mar-May
  if (month >= 5 && month <= 7) return PALETTES.summer;   // Jun-Aug
  if (month >= 8 && month <= 10) return PALETTES.fall;    // Sep-Nov
  return PALETTES.winter;                                   // Dec-Feb
}

/** Get the season name for the current month */
export function getCurrentSeasonName() {
  return getCurrentPalette().name;
}

/**
 * Update all seasonal color roles in a guild to match the current palette.
 * @param {import("discord.js").Guild} guild - Discord.js Guild object
 * @param {string[]} colorRoleIds - array of role IDs for slots 1-8
 * @returns {Promise<{ updated: number, season: string, emoji: string }>}
 */
export async function rotateSeasonalColors(guild, colorRoleIds) {
  const palette = getCurrentPalette();
  let updated = 0;

  for (let i = 0; i < colorRoleIds.length && i < palette.colors.length; i++) {
    const roleId = colorRoleIds[i];
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    const targetHex = parseInt(palette.colors[i].hex.replace("#", ""), 16);
    const targetName = palette.colors[i].name;

    // Only update if color or name actually changed
    if (role.color !== targetHex || role.name !== targetName) {
      try {
        await role.edit({ color: targetHex, name: targetName, reason: `Seasonal rotation: ${palette.name}` });
        updated++;
        // Small delay to avoid rate limits
        if (updated % 3 === 0) await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        log(`[Seasonal] Failed to update role ${role.name}: ${err.message}`);
      }
    }
  }

  return { updated, season: palette.name, emoji: palette.emoji };
}
