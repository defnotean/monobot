// ─── Human-Timed Message Delivery ───────────────────────────────────────────
// Replaces "fire the whole reply the instant the model finishes" with a
// realistic typing cadence and occasional multi-message splits.
//
//   calculateTypingDelay(text)  → how long a human would take to type `text`
//   splitHumanReply(text)       → 1-3 natural segments at breakpoint words
//   sendHumanReply(msg, text)   → orchestrates typing indicator + segmented send
//
// Keep the max delay tight — Discord typing indicators auto-expire after
// ~10 seconds, and a user waiting 8 seconds for "lol" is worse than instant.

// ─── Typing delay ───────────────────────────────────────────────────────────

// Human phone typing benchmarks: ~30-50 WPM ≈ 2.5-4.2 chars/sec.
// Use 3.3 chars/sec as the median with ±30% variance per call.
const CHARS_PER_SECOND_MEDIAN = 3.3;
const VARIANCE = 0.3;

export const TYPING_MIN_MS = 350;
export const TYPING_MAX_MS = 4500;

/**
 * Estimate how long a human would take to type `text`, including a small
 * thinking pause for longer replies. Returns milliseconds.
 * @param {string} text
 * @param {{ min?: number, max?: number, cps?: number }} [opts]
 */
export function calculateTypingDelay(text, opts = {}) {
  if (!text) return opts.min ?? TYPING_MIN_MS;
  const len = text.length;
  const cps = (opts.cps ?? CHARS_PER_SECOND_MEDIAN) * (1 + (Math.random() * 2 - 1) * VARIANCE);
  // Longer replies get a pre-typing "thinking" pause so the user can see the
  // typing indicator pop up a beat after the message was sent.
  const thinking = len > 80 ? 300 + Math.random() * 700 : len > 30 ? 150 + Math.random() * 300 : 0;
  const raw = (len / cps) * 1000 + thinking;
  return Math.min(opts.max ?? TYPING_MAX_MS, Math.max(opts.min ?? TYPING_MIN_MS, Math.floor(raw)));
}

// ─── Multi-message splits ───────────────────────────────────────────────────

// Words/phrases that make a natural mid-message split. The split happens
// BEFORE the word — so "... yeah. actually nah" splits after "yeah." and the
// second message starts with "actually nah".
const SPLIT_STARTERS = [
  "wait", "actually", "oh also", "oh wait", "also", "ngl", "also also",
  "oh and", "and actually", "hmm wait", "nvm", "oh!", "actually nah",
];

const PAUSE_BETWEEN_SEGMENTS_MIN = 400;
const PAUSE_BETWEEN_SEGMENTS_MAX = 1400;

/**
 * Split a reply into 1-3 segments at natural breakpoints. Never splits
 * mid-sentence. Short replies always return a single segment.
 * @param {string} text
 * @param {{ minLength?: number, chance?: number }} [opts]
 * @returns {string[]}
 */
export function splitHumanReply(text, opts = {}) {
  const minLength = opts.minLength ?? 50;
  const splitChance = opts.chance ?? 0.22;

  if (!text || text.length < minLength) return [text];
  // Respect the model's own intentional newline pauses — if the reply already
  // uses double newlines, those are likely deliberate, split there 50% of the time.
  const paraParts = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (paraParts.length >= 2 && Math.random() < 0.5) return paraParts.slice(0, 3);

  // Otherwise check for a break-starter word/phrase mid-reply.
  if (Math.random() > splitChance) return [text];

  const lower = text.toLowerCase();
  /** @type {number[]} */
  const candidates = [];
  const escapeRegex = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const marker of SPLIT_STARTERS) {
    // Only split on marker at the start of a clause (after punctuation or comma).
    const re = new RegExp(`([.!?,]\\s+)(${escapeRegex(marker)}\\b)`, "gi");
    let m;
    while ((m = re.exec(lower)) !== null) {
      const splitAt = m.index + m[1].length;
      if (splitAt > 15 && splitAt < text.length - 5) candidates.push(splitAt);
    }
  }
  if (!candidates.length) return [text];

  const splitAt = candidates[Math.floor(Math.random() * candidates.length)];
  const first = text.slice(0, splitAt).trim();
  const second = text.slice(splitAt).trim();
  if (!first || !second) return [text];
  return [first, second];
}

// ─── Orchestrated send ──────────────────────────────────────────────────────

/** @param {number} ms */
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send a reply with human-feeling cadence. Shows typing, waits, sends,
 * optionally splits into follow-up messages.
 *
 * @param {import("discord.js").Message} message  The message we're replying to.
 * @param {string} replyText                      The model's reply.
 * @param {object} [opts]
 * @param {boolean} [opts.isDM]           If true, use channel.send (no reply ping).
 * @param {boolean} [opts.allowSplit]     Defaults to true. Set false for game results etc.
 * @param {object}  [opts.messageOptions] Extra options passed to message.reply / channel.send
 *                                        (e.g. { flags: MessageFlags.SuppressEmbeds }).
 * @returns {Promise<void>}
 */
export async function sendHumanReply(message, replyText, opts = {}) {
  const isDM = !!opts.isDM;
  const allowSplit = opts.allowSplit !== false;
  const extra = opts.messageOptions || null;
  const segments = allowSplit ? splitHumanReply(replyText) : [replyText];

  const buildPayload = (/** @type {string} */ content) => (extra ? { content, ...extra } : content);

  // discord.js types `message.channel` as a union where send/sendTyping only
  // exist on the text-capable members; the bot only ever reaches here with a
  // sendable channel, so cast to sidestep the union narrowing.
  /** @type {any} */
  const channel = message.channel;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;

    // Show typing while we "type" this segment.
    try { await channel.sendTyping(); } catch { /* channel deleted etc. */ }
    await sleep(calculateTypingDelay(seg));

    // First segment replies to the original; follow-ups are plain sends so we
    // don't double-ping the user.
    if (i === 0 && !isDM) {
      try {
        await message.reply(buildPayload(seg));
      } catch {
        try { await channel.send(buildPayload(seg)); } catch {}
      }
    } else {
      try { await channel.send(buildPayload(seg)); } catch {}
    }

    // Brief pause between segments — enough for the user to register the
    // typing indicator on the follow-up.
    if (i < segments.length - 1) {
      await sleep(PAUSE_BETWEEN_SEGMENTS_MIN + Math.random() * (PAUSE_BETWEEN_SEGMENTS_MAX - PAUSE_BETWEEN_SEGMENTS_MIN));
    }
  }
}
