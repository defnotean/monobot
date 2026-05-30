// @ts-check
/**
 * @file packages/irene/ai/colors.js
 *
 * Color parsing helpers for Irene's AI executor. Extracted verbatim from
 * executor.js as part of the barrel-split — behavior is identical.
 *
 * `COLOR_NAMES` is the hex lookup used by the custom-command embed-color cases.
 * `parseHexColor` is passed into the sub-executor `ctx` so domain executors can
 * turn a "#RRGGBB" string into the integer discord.js expects.
 */

export const COLOR_NAMES = { white: "#FFFFFF", black: "#000000", red: "#FF0000", green: "#57F287", blue: "#5865F2", blurple: "#5865F2", yellow: "#FEE75C", orange: "#ED8E00", purple: "#9B59B6", pink: "#FF73FA", cyan: "#1ABC9C" };

export function parseHexColor(hex) {
  if (!hex) return undefined;
  return parseInt(hex.replace(/^#/, ""), 16);
}
