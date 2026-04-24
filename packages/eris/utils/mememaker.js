// ─── Custom Meme Maker ──────────────────────────────────────────────────────
// Creates memes from ANY image URL with text overlay using node-canvas.
// No dependency on memegen.link — works with any image from the internet.

import { createCanvas, loadImage, registerFont } from "canvas";
import { AttachmentBuilder } from "discord.js";

/**
 * Create a meme image with text overlay on any background image.
 * @param {string} imageUrl - URL of the background image
 * @param {string} topText - Text for the top of the image
 * @param {string} bottomText - Text for the bottom of the image
 * @param {object} options - { fontSize, fontColor, strokeColor, padding }
 * @returns {Promise<AttachmentBuilder>} Discord attachment ready to send
 */
export async function createCustomMeme(imageUrl, topText = "", bottomText = "", options = {}) {
  const {
    maxWidth = 600,
    fontColor = "white",
    strokeColor = "black",
    strokeWidth = 3,
    padding = 20,
  } = options;

  // Load the background image
  let img;
  try {
    img = await loadImage(imageUrl);
  } catch (e) {
    throw new Error(`couldn't load image: ${e.message}`);
  }

  // Scale image to reasonable size
  const scale = Math.min(maxWidth / img.width, 1);
  const width = Math.floor(img.width * scale);
  const height = Math.floor(img.height * scale);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Draw background
  ctx.drawImage(img, 0, 0, width, height);

  // Configure text style — Impact-like bold
  const fontSize = Math.max(Math.floor(height / 12), 20);
  ctx.textAlign = "center";
  ctx.lineJoin = "round";

  // Draw top text
  if (topText) {
    drawMemeText(ctx, topText.toUpperCase(), width / 2, padding + fontSize, width - padding * 2, fontSize, fontColor, strokeColor, strokeWidth);
  }

  // Draw bottom text
  if (bottomText) {
    drawMemeText(ctx, bottomText.toUpperCase(), width / 2, height - padding, width - padding * 2, fontSize, fontColor, strokeColor, strokeWidth, true);
  }

  // Export as PNG buffer
  const buffer = canvas.toBuffer("image/png");
  return new AttachmentBuilder(buffer, { name: "meme.png" });
}

/**
 * Draw outlined text on canvas with word wrapping.
 */
function drawMemeText(ctx, text, x, y, maxWidth, fontSize, fontColor, strokeColor, strokeWidth, fromBottom = false) {
  ctx.font = `bold ${fontSize}px Impact, Arial Black, sans-serif`;
  ctx.fillStyle = fontColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;

  // Word wrap
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Adjust Y position for bottom text (draw upwards)
  const lineHeight = fontSize * 1.2;
  let startY = fromBottom ? y - (lines.length - 1) * lineHeight : y;

  for (const line of lines) {
    ctx.strokeText(line, x, startY);
    ctx.fillText(line, x, startY);
    startY += lineHeight;
  }
}

/**
 * Create a meme using a user's Discord avatar as background.
 * @param {import("discord.js").User} user - Discord user
 * @param {string} topText
 * @param {string} bottomText
 * @returns {Promise<AttachmentBuilder>}
 */
export async function createAvatarMeme(user, topText = "", bottomText = "") {
  const avatarUrl = user.displayAvatarURL({ size: 512, extension: "png" });
  return createCustomMeme(avatarUrl, topText, bottomText);
}
