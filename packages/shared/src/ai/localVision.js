import { safeFetch as defaultSafeFetch } from "../safeFetch.js";

/**
 * @typedef {object} ImageAttachment
 * @property {string} [url]
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
 * @property {typeof defaultSafeFetch} [safeFetch]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {number} [maxImages]
 * @property {number} [maxBytes]
 * @property {number} [imageFetchTimeoutMs]
 * @property {number} [visionTimeoutMs]
 * @property {number} [timeoutMs]
 * @property {number} [index]
 * @property {string | number} [keepAlive]
 */

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_VISION_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = "qwen2.5vl:7b";
const DEFAULT_KEEP_ALIVE = "30m";
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

/** @param {ImageAttachment} attachment */
export function isImageAttachment(attachment) {
  if (!attachment?.url) return false;
  const contentType = attachment.contentType || "";
  if (contentType && SUPPORTED_IMAGE_TYPES.some((t) => contentType.startsWith(t))) return true;
  const ext = String(attachment.name || attachment.filename || "").split(".").pop()?.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext || "");
}

/** @param {any} message @param {{ maxImages?: number }} [options] */
export function getImageAttachments(message, { maxImages = Infinity } = {}) {
  const values = typeof message?.attachments?.values === "function"
    ? [...message.attachments.values()]
    : [];
  return values.filter(isImageAttachment).slice(0, maxImages);
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

/** @param {Buffer | Uint8Array | string} buffer @param {LocalVisionOptions} [options] */
export async function describeImageBuffer(buffer, {
  prompt = DEFAULT_PROMPT,
  visionUrl,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
  keepAlive = DEFAULT_KEEP_ALIVE,
  fetchImpl = globalThis.fetch,
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
    return truncate(text);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === "AbortError") throw new Error("local vision timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {ImageAttachment} attachment @param {LocalVisionOptions} [options] */
export async function describeImageAttachment(attachment, {
  prompt = DEFAULT_PROMPT,
  visionUrl,
  model = DEFAULT_MODEL,
  safeFetch = defaultSafeFetch,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_IMAGE_MAX_BYTES,
  imageFetchTimeoutMs = DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
  visionTimeoutMs = DEFAULT_VISION_TIMEOUT_MS,
  keepAlive = DEFAULT_KEEP_ALIVE,
  index = 0,
} = {}) {
  const name = imageAttachmentName(attachment, index);
  const url = attachment?.url;
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
    const res = await safeFetch(url, {
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
      timeoutMs: visionTimeoutMs,
      keepAlive,
      fetchImpl,
    });
    return { ok: true, name, url, mimeType, description };
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
