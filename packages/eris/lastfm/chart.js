// ─── Last.fm Chart Image Generator ───────────────────────────────────────────
// Generates a grid of album art images using canvas.
// Returns a Buffer (PNG) suitable for Discord attachment.

import { createCanvas, loadImage } from "canvas";

const CELL = 200;        // pixels per cell
const GAP  = 2;          // gap between cells
const FONT = "bold 11px sans-serif";

/**
 * @param {Array<{ image: string|null, label?: string }>} items
 * @param {number} cols - grid columns (e.g. 3, 4, 5)
 * @param {boolean} showLabels - overlay artist/album text
 * @returns {Promise<Buffer>}
 */
export async function generateChart(items, cols = 3, showLabels = false) {
  const rows = Math.ceil(items.length / cols);
  const w = cols * CELL + (cols - 1) * GAP;
  const h = rows * CELL + (rows - 1) * GAP;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, w, h);

  const placeholder = createPlaceholder(CELL, CELL);

  for (let i = 0; i < items.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (CELL + GAP);
    const y = row * (CELL + GAP);

    let img = placeholder;
    if (items[i].image) {
      try {
        img = await loadImage(items[i].image);
      } catch {
        // keep placeholder
      }
    }

    ctx.drawImage(img, x, y, CELL, CELL);

    if (showLabels && items[i].label) {
      drawLabel(ctx, items[i].label, x, y, CELL);
    }
  }

  return canvas.toBuffer("image/png");
}

function createPlaceholder(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#555";
  ctx.font = "48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("♫", w / 2, h / 2);
  return c;
}

function drawLabel(ctx, text, x, y, size) {
  const padding = 4;
  const lineH = 14;
  // semi-transparent bar at bottom
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(x, y + size - lineH - padding * 2, size, lineH + padding * 2);

  ctx.font = FONT;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  const maxW = size - padding * 2;
  let label = text;
  while (ctx.measureText(label).width > maxW && label.length > 1) {
    label = label.slice(0, -1);
  }
  if (label !== text) label = label.slice(0, -1) + "…";
  ctx.fillText(label, x + padding, y + size - padding);
}
