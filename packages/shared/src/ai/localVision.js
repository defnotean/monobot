import { safeFetch as defaultSafeFetch } from "../safeFetch.js";

/**
 * @typedef {object} ImageAttachment
 * @property {string} [url]
 * @property {string} [proxyURL]
 * @property {string} [name]
 * @property {string} [filename]
 * @property {string} [contentType]
 */

/**
 * @typedef {object} ImageDescription
 * @property {boolean} ok
 * @property {string} name
 * @property {string} [url]
 * @property {string} [mimeType]
 * @property {string} [error]
 * @property {string} description
 */

/**
 * @typedef {object} LocalVisionOptions
 * @property {string} [prompt]
 * @property {string} [visionUrl]
 * @property {string} [model]
 * @property {string} [fallbackModel]
 * @property {typeof defaultSafeFetch} [safeFetch]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {number} [maxImages]
 * @property {number} [maxBytes]
 * @property {number} [imageFetchTimeoutMs]
 * @property {number} [visionTimeoutMs]
 * @property {number} [timeoutMs]
 * @property {number} [index]
 * @property {string | number} [keepAlive]
 * @property {number} [maxTiles]
 * @property {number} [tileMinLongEdge]
 * @property {number} [tileMinAspect]
 * @property {number} [tileOverlapRatio]
 * @property {number} [detailMaxChars]
 * @property {(buffer: Buffer, options: ImageTileOptions) => Promise<ImageTile[]>} [makeImageTiles]
 */

/**
 * @typedef {object} ImageDimensions
 * @property {number} width
 * @property {number} height
 * @property {string} type
 */

/**
 * @typedef {object} ImageTileRegion
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {string} label
 * @property {"vertical" | "horizontal"} orientation
 */

/**
 * @typedef {object} ImageTile
 * @property {Buffer} buffer
 * @property {string} label
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [sourceWidth]
 * @property {number} [sourceHeight]
 */

/**
 * @typedef {object} ImageTileOptions
 * @property {number} [maxTiles]
 * @property {number} [tileMinLongEdge]
 * @property {number} [tileMinAspect]
 * @property {number} [tileOverlapRatio]
 */

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_VISION_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = "moondream";
const DEFAULT_FALLBACK_MODEL = "moondream";
const DEFAULT_KEEP_ALIVE = "30m";
const DEFAULT_MAX_TILES = 2;
const DEFAULT_TILE_MIN_LONG_EDGE = 1600;
const DEFAULT_TILE_MIN_ASPECT = 1.45;
const DEFAULT_TILE_OVERLAP_RATIO = 0.12;
const DEFAULT_DETAIL_MAX_CHARS = 3600;
const DEFAULT_PROMPT = [
  "You are a strict visual evidence extractor for Discord image attachments.",
  "Return ONLY facts that are directly visible in the image. Do not chat, compliment, guess a backstory, identify the image source, infer intent, or fill in missing details.",
  "Use this exact format:",
  "Visible: direct visible subjects, objects, people/characters, animals, clothing, colors, pose/action, setting, UI/screenshot details, and image quality.",
  "Text: exact readable text only, or 'none visible'.",
  "Unclear: details that are small, blurry, cropped, stylized, ambiguous, or only guessed. Use the word 'uncertain' for each uncertain detail.",
  "Rules: do not invent logos, clothing patterns, outfit details, facial expressions, names, meme context, avatar concepts, relationships, or safety-relevant claims. If you are not sure, put it in Unclear instead of Visible.",
].join("\n");

/** @param {unknown} value @param {number} fallback */
function asPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** @param {unknown} value @param {number} fallback */
function asNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function asClampedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {any} headers @param {string} name */
function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  return headers[name] || headers[name.toLowerCase()] || "";
}

/** @param {unknown} rawUrl */
function normalizeOllamaUrl(rawUrl) {
  const base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith("/api/chat") ? base : `${base}/api/chat`;
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

/** @param {unknown} value @param {number} [max] */
function truncate(value, max = 1200) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 15)} ...(truncated)` : text;
}

/** @param {Buffer} buffer @param {number} offset @param {number} bytes */
function readUIntLE(buffer, offset, bytes) {
  if (offset < 0 || offset + bytes > buffer.length) return 0;
  let value = 0;
  for (let i = 0; i < bytes; i++) value += buffer[offset + i] << (8 * i);
  return value;
}

/** @param {Buffer} buffer @param {number} offset @param {number} length */
function ascii(buffer, offset, length) {
  if (offset < 0 || offset + length > buffer.length) return "";
  return buffer.toString("ascii", offset, offset + length);
}

/** @param {Buffer | Uint8Array | string} input @returns {ImageDimensions | null} */
export function readImageDimensions(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 10) return null;

  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    ascii(buffer, 1, 3) === "PNG" &&
    ascii(buffer, 12, 4) === "IHDR"
  ) {
    return { type: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (ascii(buffer, 0, 3) === "GIF" && buffer.length >= 10) {
    return { type: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame && segmentLength >= 7) {
        return {
          type: "jpeg",
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }

  if (buffer.length >= 30 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkType = ascii(buffer, offset, 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (dataOffset + chunkSize > buffer.length) break;

      if (chunkType === "VP8X" && chunkSize >= 10) {
        return {
          type: "webp",
          width: readUIntLE(buffer, dataOffset + 4, 3) + 1,
          height: readUIntLE(buffer, dataOffset + 7, 3) + 1,
        };
      }
      if (chunkType === "VP8 " && chunkSize >= 10) {
        return {
          type: "webp",
          width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
          height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
        };
      }
      if (chunkType === "VP8L" && chunkSize >= 5) {
        const bits = buffer.readUInt32LE(dataOffset + 1);
        return {
          type: "webp",
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }

      offset = dataOffset + chunkSize + (chunkSize % 2);
    }
  }

  return null;
}

/** @param {unknown} value */
function indentMultiline(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split("\n").map((line, i) => i === 0 ? line : `  ${line}`).join("\n");
}

/** @param {ImageAttachment} attachment @param {number} index */
function imageAttachmentName(attachment, index) {
  return attachment?.name || attachment?.filename || `image-${index + 1}`;
}

/** @param {unknown} rawUrl */
function extensionFromUrl(rawUrl) {
  try {
    const pathname = new URL(String(rawUrl || "")).pathname;
    return pathname.split(".").pop()?.toLowerCase() || "";
  } catch {
    return "";
  }
}

/** @param {unknown} rawName */
function extensionFromName(rawName) {
  const name = String(rawName || "");
  if (!name.includes(".")) return "";
  return name.split(".").pop()?.toLowerCase() || "";
}

/** @param {ImageAttachment} attachment */
export function isImageAttachment(attachment) {
  const url = attachment?.url || attachment?.proxyURL;
  if (!url) return false;
  const contentType = attachment.contentType || "";
  if (contentType && SUPPORTED_IMAGE_TYPES.some((t) => contentType.startsWith(t))) return true;
  const ext = extensionFromName(attachment.name || attachment.filename)
    || extensionFromUrl(url);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext || "");
}

/** @param {any} message @param {{ maxImages?: number }} [options] */
export function getImageAttachments(message, { maxImages = Infinity } = {}) {
  const attachmentValues = typeof message?.attachments?.values === "function"
    ? [...message.attachments.values()]
    : [];
  const embeddedImages = Array.isArray(message?.embeds)
    ? message.embeds.flatMap(
      /** @param {any} embed @param {number} index @returns {ImageAttachment[]} */
      (embed, index) => {
        /** @type {ImageAttachment[]} */
        const rows = [];
        if (embed?.image?.url) rows.push({
          url: embed.image.url,
          proxyURL: embed.image.proxyURL,
          name: embed.image.proxyURL ? `embed-image-${index + 1}` : `embed-image-${index + 1}.${extensionFromUrl(embed.image.url) || "png"}`,
          contentType: embed.image.contentType || "",
        });
        if (embed?.thumbnail?.url) rows.push({
          url: embed.thumbnail.url,
          proxyURL: embed.thumbnail.proxyURL,
          name: `embed-thumbnail-${index + 1}.${extensionFromUrl(embed.thumbnail.url) || "png"}`,
          contentType: embed.thumbnail.contentType || "",
        });
        return rows;
      })
    : [];
  const stickerValues = typeof message?.stickers?.values === "function"
    ? [...message.stickers.values()].map((sticker, index) => ({
        url: sticker?.url,
        name: sticker?.name || `sticker-${index + 1}.${extensionFromUrl(sticker?.url) || "png"}`,
        contentType: sticker?.contentType || "",
      }))
    : [];
  const seen = new Set();
  return [...attachmentValues, ...embeddedImages, ...stickerValues]
    .filter(isImageAttachment)
    .filter((item) => {
      const key = item.url || item.proxyURL;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxImages);
}

/** @param {ImageDimensions | null} dimensions @param {ImageTileOptions} options */
export function shouldCreateImageTiles(dimensions, {
  maxTiles = DEFAULT_MAX_TILES,
  tileMinLongEdge = DEFAULT_TILE_MIN_LONG_EDGE,
  tileMinAspect = DEFAULT_TILE_MIN_ASPECT,
} = {}) {
  if (!dimensions?.width || !dimensions?.height || maxTiles < 2) return false;
  const longEdge = Math.max(dimensions.width, dimensions.height);
  const shortEdge = Math.max(1, Math.min(dimensions.width, dimensions.height));
  const aspect = longEdge / shortEdge;
  return longEdge >= tileMinLongEdge || (aspect >= tileMinAspect && longEdge >= tileMinLongEdge * 0.75);
}

/** @param {number} index @param {number} total @param {"vertical" | "horizontal"} orientation */
function tileLabel(index, total, orientation) {
  const names = orientation === "vertical"
    ? ["top", "upper-middle", "lower-middle", "bottom"]
    : ["left", "left-center", "right-center", "right"];
  if (total <= names.length) {
    if (total === 2) return orientation === "vertical"
      ? (index === 0 ? "top half" : "bottom half")
      : (index === 0 ? "left half" : "right half");
    return names[Math.round(index * (names.length - 1) / Math.max(1, total - 1))];
  }
  const percent = Math.round(index * 100 / Math.max(1, total - 1));
  return orientation === "vertical" ? `${percent}% down` : `${percent}% across`;
}

/** @param {ImageDimensions} dimensions @param {ImageTileOptions} options */
export function computeImageTileRegions(dimensions, {
  maxTiles = DEFAULT_MAX_TILES,
  tileOverlapRatio = DEFAULT_TILE_OVERLAP_RATIO,
} = {}) {
  const width = dimensions.width;
  const height = dimensions.height;
  if (!width || !height || maxTiles < 2) return [];

  const orientation = height >= width ? "vertical" : "horizontal";
  const longEdge = orientation === "vertical" ? height : width;
  const shortEdge = orientation === "vertical" ? width : height;
  const targetSpan = Math.max(800, Math.round(shortEdge * 0.9));
  const count = Math.min(maxTiles, Math.max(2, Math.ceil(longEdge / targetSpan)));
  const span = Math.min(longEdge, Math.ceil((longEdge / count) * (1 + tileOverlapRatio)));

  /** @type {ImageTileRegion[]} */
  const regions = [];
  for (let i = 0; i < count; i++) {
    const start = count === 1 ? 0 : Math.round((longEdge - span) * (i / (count - 1)));
    regions.push({
      x: orientation === "vertical" ? 0 : start,
      y: orientation === "vertical" ? start : 0,
      width: orientation === "vertical" ? width : span,
      height: orientation === "vertical" ? span : height,
      label: tileLabel(i, count, orientation),
      orientation,
    });
  }
  return regions;
}

/** @param {ImageTile} tile @param {number} index @param {number} total */
function tilePrompt(tile, index, total) {
  const size = tile.width && tile.height ? ` This crop is ${tile.width}x${tile.height}px.` : "";
  const sourceSize = tile.sourceWidth && tile.sourceHeight ? ` Source image is ${tile.sourceWidth}x${tile.sourceHeight}px.` : "";
  return [
    `This is high-resolution crop ${index + 1}/${total} (${tile.label}) from a larger screenshot or image.${size}${sourceSize}`,
    "Extract exact visible facts from this crop only. Prioritize small UI text, usernames, timestamps, buttons, captions, and notification text.",
    "Use this exact format:",
    "Visible: direct visible UI/subjects/details in this crop.",
    "Text: exact readable text only, or 'none visible'.",
    "Unclear: small, blurry, cropped, ambiguous, or uncertain details.",
    "Rules: do not infer content outside this crop; do not guess missing words.",
  ].join("\n");
}

/** @param {Buffer | Uint8Array | string} buffer @param {ImageTileOptions} [options] @returns {Promise<ImageTile[]>} */
export async function createImageTiles(buffer, options = {}) {
  const sourceBuffer = Buffer.from(buffer);
  const maxTiles = asNonNegativeInt(options.maxTiles, DEFAULT_MAX_TILES);
  const tileMinLongEdge = asPositiveInt(options.tileMinLongEdge, DEFAULT_TILE_MIN_LONG_EDGE);
  const tileMinAspect = asClampedNumber(options.tileMinAspect, DEFAULT_TILE_MIN_ASPECT, 1, 10);
  const tileOverlapRatio = asClampedNumber(options.tileOverlapRatio, DEFAULT_TILE_OVERLAP_RATIO, 0, 0.4);
  const dimensions = readImageDimensions(sourceBuffer);
  if (!shouldCreateImageTiles(dimensions, { maxTiles, tileMinLongEdge, tileMinAspect, tileOverlapRatio })) return [];

  const sourceDimensions = /** @type {ImageDimensions} */ (dimensions);
  const regions = computeImageTileRegions(sourceDimensions, { maxTiles, tileMinLongEdge, tileMinAspect, tileOverlapRatio });
  if (!regions.length) return [];

  const { createCanvas, loadImage } = await import("canvas");
  const image = await loadImage(sourceBuffer);
  return regions.map((region) => {
    const canvas = createCanvas(region.width, region.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    return {
      buffer: canvas.toBuffer("image/png"),
      label: region.label,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      sourceWidth: sourceDimensions.width,
      sourceHeight: sourceDimensions.height,
    };
  });
}

/** @param {ImageDescription[]} descriptions @param {{ omittedCount?: number }} [options] */
export function formatImageDescriptions(descriptions, { omittedCount = 0 } = {}) {
  if (!descriptions?.length && !omittedCount) return "";
  const lines = descriptions.map((item, idx) => {
    const label = item.name ? ` (${item.name})` : "";
    return `${idx + 1}${label}: ${indentMultiline(item.description || item.error || "no description available")}`;
  });
  if (omittedCount > 0) lines.push(`+${omittedCount} more image(s) omitted by the local vision limit.`);
  return `[LOCAL IMAGE EVIDENCE — conservative local vision output. Use only these visible facts; do not infer visual content from attachment URLs or filenames. If evidence is uncertain, unclear, or failed, say you cannot tell instead of guessing.\n${lines.join("\n")}\n-- end local image evidence --]`;
}

/** @param {Buffer | Uint8Array | string} buffer @param {LocalVisionOptions & { responseMaxChars?: number }} [options] */
async function describeImageBufferOnce(buffer, {
  prompt = DEFAULT_PROMPT,
  visionUrl,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
  keepAlive = DEFAULT_KEEP_ALIVE,
  fetchImpl = globalThis.fetch,
  responseMaxChars = 1200,
} = {}) {
  const endpoint = normalizeOllamaUrl(visionUrl);
  if (!endpoint) throw new Error("local vision is not configured");
  if (!buffer?.length) throw new Error("empty image");
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt, images: [Buffer.from(buffer).toString("base64")] }],
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0, top_p: 0.25, repeat_penalty: 1.05 },
      }),
    });
    if (!res?.ok) throw new Error(`local vision HTTP ${res?.status || "failed"}`);
    const data = await res.json();
    const text = data?.message?.content || data?.response || "";
    if (!text) throw new Error("empty local vision response");
    return truncate(text, responseMaxChars);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === "AbortError") throw new Error("local vision timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Buffer | Uint8Array | string} buffer @param {LocalVisionOptions & { responseMaxChars?: number }} [options] */
async function describeImageBufferWithFallback(buffer, options = {}) {
  const models = uniqueStrings([
    options.model || DEFAULT_MODEL,
    options.fallbackModel || DEFAULT_FALLBACK_MODEL,
  ]);
  let lastError;
  for (const model of models) {
    try {
      return await describeImageBufferOnce(buffer, { ...options, model });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("local vision failed");
}

/** @param {Buffer} sourceBuffer @param {ImageTileOptions & { makeImageTiles?: LocalVisionOptions["makeImageTiles"] }} options */
async function resolveImageTiles(sourceBuffer, {
  makeImageTiles = createImageTiles,
  maxTiles = DEFAULT_MAX_TILES,
  tileMinLongEdge = DEFAULT_TILE_MIN_LONG_EDGE,
  tileMinAspect = DEFAULT_TILE_MIN_ASPECT,
  tileOverlapRatio = DEFAULT_TILE_OVERLAP_RATIO,
} = {}) {
  if (typeof makeImageTiles !== "function") return [];
  try {
    return await makeImageTiles(sourceBuffer, {
      maxTiles: asNonNegativeInt(maxTiles, DEFAULT_MAX_TILES),
      tileMinLongEdge: asPositiveInt(tileMinLongEdge, DEFAULT_TILE_MIN_LONG_EDGE),
      tileMinAspect: asClampedNumber(tileMinAspect, DEFAULT_TILE_MIN_ASPECT, 1, 10),
      tileOverlapRatio: asClampedNumber(tileOverlapRatio, DEFAULT_TILE_OVERLAP_RATIO, 0, 0.4),
    });
  } catch {
    return [];
  }
}

/** @param {string} fullDescription @param {{ tile: ImageTile, description: string }[]} tileDescriptions @param {number} maxChars */
function formatDetailedVisionDescription(fullDescription, tileDescriptions, maxChars) {
  if (!tileDescriptions.length) return truncate(fullDescription, maxChars);
  const tileLines = tileDescriptions.map(({ tile, description }, idx) => {
    const size = tile.width && tile.height ? `, ${tile.width}x${tile.height}` : "";
    return `Crop ${idx + 1}/${tileDescriptions.length} (${tile.label}${size}): ${indentMultiline(description)}`;
  });
  return truncate([
    `Full image: ${indentMultiline(fullDescription)}`,
    "High-resolution crop pass:",
    ...tileLines,
  ].join("\n"), maxChars);
}

/** @param {Buffer | Uint8Array | string} buffer @param {LocalVisionOptions} [options] */
export async function describeImageBuffer(buffer, {
  prompt = DEFAULT_PROMPT,
  visionUrl,
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
  keepAlive = DEFAULT_KEEP_ALIVE,
  fetchImpl = globalThis.fetch,
  maxTiles = DEFAULT_MAX_TILES,
  tileMinLongEdge = DEFAULT_TILE_MIN_LONG_EDGE,
  tileMinAspect = DEFAULT_TILE_MIN_ASPECT,
  tileOverlapRatio = DEFAULT_TILE_OVERLAP_RATIO,
  detailMaxChars = DEFAULT_DETAIL_MAX_CHARS,
  makeImageTiles = createImageTiles,
} = {}) {
  const sourceBuffer = Buffer.from(buffer);
  const fullDescription = await describeImageBufferWithFallback(sourceBuffer, {
    prompt,
    visionUrl,
    model,
    fallbackModel,
    timeoutMs,
    keepAlive,
    fetchImpl,
    responseMaxChars: 1400,
  });

  const tiles = await resolveImageTiles(sourceBuffer, {
    makeImageTiles,
    maxTiles,
    tileMinLongEdge,
    tileMinAspect,
    tileOverlapRatio,
  });
  if (!tiles.length) return truncate(fullDescription, detailMaxChars);

  const tileDescriptions = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile?.buffer?.length) continue;
    try {
      const description = await describeImageBufferWithFallback(tile.buffer, {
        prompt: tilePrompt(tile, i, tiles.length),
        visionUrl,
        model,
        fallbackModel,
        timeoutMs,
        keepAlive,
        fetchImpl,
        responseMaxChars: 1400,
      });
      tileDescriptions.push({ tile, description });
    } catch {
      // The full-image pass already succeeded; keep that evidence if a crop fails.
    }
  }

  return formatDetailedVisionDescription(fullDescription, tileDescriptions, detailMaxChars);
}

/** @param {ImageAttachment} attachment @param {LocalVisionOptions} [options] */
export async function describeImageAttachment(attachment, {
  prompt = DEFAULT_PROMPT,
  visionUrl,
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  safeFetch = defaultSafeFetch,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_IMAGE_MAX_BYTES,
  imageFetchTimeoutMs = DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
  visionTimeoutMs = DEFAULT_VISION_TIMEOUT_MS,
  keepAlive = DEFAULT_KEEP_ALIVE,
  maxTiles = DEFAULT_MAX_TILES,
  tileMinLongEdge = DEFAULT_TILE_MIN_LONG_EDGE,
  tileMinAspect = DEFAULT_TILE_MIN_ASPECT,
  tileOverlapRatio = DEFAULT_TILE_OVERLAP_RATIO,
  detailMaxChars = DEFAULT_DETAIL_MAX_CHARS,
  makeImageTiles = createImageTiles,
  index = 0,
} = {}) {
  const name = imageAttachmentName(attachment, index);
  const url = attachment?.url || attachment?.proxyURL;
  if (!url) return { ok: false, name, url, error: "missing image URL", description: "[image failed to load: missing URL]" };
  if (!normalizeOllamaUrl(visionUrl)) {
    return {
      ok: false,
      name,
      url,
      error: "local vision is not configured",
      description: "[image skipped: local vision is not configured]",
    };
  }

  try {
    const urls = uniqueStrings([attachment?.url, attachment?.proxyURL]);
    let lastFetchError;
    for (const fetchUrl of urls) {
      try {
        const res = await safeFetch(fetchUrl, {
          binary: true,
          maxBytes,
          timeoutMs: imageFetchTimeoutMs,
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`fetch HTTP ${res.status}`);
        const bytes = res.bytes;
        if (!bytes?.length) throw new Error("empty image response");
        const mimeType = headerValue(res.headers, "content-type") || attachment.contentType || "image/png";
        const description = await describeImageBuffer(bytes, {
          prompt,
          visionUrl,
          model,
          fallbackModel,
          timeoutMs: visionTimeoutMs,
          keepAlive,
          fetchImpl,
          maxTiles,
          tileMinLongEdge,
          tileMinAspect,
          tileOverlapRatio,
          detailMaxChars,
          makeImageTiles,
        });
        return { ok: true, name, url: fetchUrl, mimeType, description };
      } catch (err) {
        lastFetchError = err;
      }
    }
    throw lastFetchError || new Error("image fetch failed");
  } catch (err) {
    const e = /** @type {any} */ (err);
    const reason = truncate(e?.message || String(e), 180);
    return {
      ok: false,
      name,
      url,
      error: reason,
      description: `[image failed local description: ${reason}]`,
    };
  }
}

/** @param {any} message @param {LocalVisionOptions} [options] */
export async function describeImageAttachments(message, {
  maxImages = DEFAULT_MAX_IMAGES,
  ...options
} = {}) {
  const allImageAttachments = getImageAttachments(message);
  const limit = asPositiveInt(maxImages, DEFAULT_MAX_IMAGES);
  const selected = allImageAttachments.slice(0, limit);
  const descriptions = [];
  for (let i = 0; i < selected.length; i++) {
    descriptions.push(await describeImageAttachment(selected[i], { ...options, index: i }));
  }
  const omittedCount = Math.max(0, allImageAttachments.length - selected.length);
  return {
    allImageAttachments,
    describedImageAttachments: selected,
    imageDescriptions: descriptions,
    omittedCount,
    imageDescriptionBlock: formatImageDescriptions(descriptions, { omittedCount }),
  };
}
