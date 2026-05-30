// ─── Memory Dreams ──────────────────────────────────────────────────────────
// When Irene "sleeps" (via triggerSleep in messageCreate.js), this module
// generates a short dream — a consolidated narrative that weaves together
// recent episodes, relationships, and mood into a first-person reflection.
//
// The dream persists via bot_data key "irene_dreams_log" (rolling last 30)
// and the most-recent dream is injected into her system prompt for 30min
// after she wakes, so she can reference it organically ("I had the weirdest
// dream about snowski and a piano").
//
// Graceful: if no recent activity OR Gemini is rate-limited, no dream is
// produced and nothing crashes.

import { log } from "../utils/logger.js";
import { GoogleGenAI } from "@google/genai";
import config from "../config.js";

const DREAM_VISIBILITY_MS = 30 * 60_000; // 30 min after wake, dream stays in context
const MAX_DREAM_HISTORY = 30;

let _lastDream = null; // { text, at, type }
let _loaded = false;
let _inflight = null; // mutex for generateDream — concurrent sleeps share one result

async function _loadHistory() {
  if (_loaded) return;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) { _loaded = true; return; }
    const { data } = await sb.from("bot_data").select("data").eq("id", "irene_dreams_log").single();
    if (data?.data?.lastDream) _lastDream = data.data.lastDream;
    _loaded = true;
  } catch (err) {
    // Leave _loaded=false so a later call retries. A persistent boot-time glitch
    // should NOT permanently blind us from reloading prior dream state.
    log(`[Dream] history load failed (will retry): ${err?.message || err}`);
  }
}

async function _persist(dream, history) {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("bot_data").upsert({
      id: "irene_dreams_log",
      data: { lastDream: dream, history: history.slice(0, MAX_DREAM_HISTORY) },
    });
  } catch (err) {
    log(`[Dream] persist failed: ${err.message}`);
  }
}

async function _getRecentSignal() {
  try {
    const longmemory = await import("./longmemory.js");
    // Cast to any: isBadDay is an optional twin-compat export probed below.
    const humanity = /** @type {any} */ (await import("./humanity.js"));
    const { getMood } = await import("../database.js");

    const monologue = longmemory.getMonologue?.() ?? [];
    const episodes = longmemory.getEpisodes?.() ?? new Map();
    const channelEpisodes = longmemory.getChannelEpisodes?.() ?? new Map();
    const mood = getMood?.() ?? { mood_score: 0, energy: 50 };

    // Flatten top N recent episodes across all users
    const allEpisodes = [];
    for (const [uid, list] of episodes) {
      for (const ep of list) allEpisodes.push({ userId: uid, ...ep });
    }
    for (const [ch, list] of channelEpisodes) {
      for (const ep of list) allEpisodes.push({ channelId: ch, ...ep });
    }
    allEpisodes.sort((a, b) => (b.at || 0) - (a.at || 0));
    const recent = allEpisodes.slice(0, 8);

    return {
      moodScore: mood.mood_score ?? 0,
      energy: mood.energy ?? 50,
      isBadDay: humanity.isBadDay?.() ?? false,
      recentEpisodes: recent,
      recentThoughts: monologue.slice(-5),
    };
  } catch (err) {
    log(`[Dream] signal gather failed: ${err.message}`);
    return null;
  }
}

// Strip prompt-injection cues from dream inputs — user-authored content
// shouldn't control the dream model's behavior.
function _sanitizeFragment(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/@everyone|@here/gi, "@<redacted>")
    .replace(/<@&\d+>/g, "<role>")
    .slice(0, 120);
}

/**
 * Generate a dream, persist it, and return the text. Returns null if no
 * activity worth dreaming about, or if Gemini refuses.
 * Concurrent callers share a single inflight generation so two rapid sleeps
 * don't generate two dreams that race on the persisted history.
 */
export async function generateDream(opts = {}) {
  if (_inflight) return _inflight;
  _inflight = _doGenerate(opts).finally(() => { _inflight = null; });
  return _inflight;
}

async function _doGenerate({ isNap = false } = {}) {
  await _loadHistory();

  const signal = await _getRecentSignal();
  if (!signal) return null;

  // Need at least some activity to dream about
  if (signal.recentEpisodes.length === 0 && signal.recentThoughts.length === 0) {
    log(`[Dream] nothing to dream about — no recent episodes or thoughts`);
    return null;
  }

  const keys = (config.geminiKeys || []).filter(Boolean);
  if (!keys.length) return null;
  const client = new GoogleGenAI({ apiKey: keys[Math.floor(Math.random() * keys.length)] });

  const episodeLines = signal.recentEpisodes.map((e) => {
    const who = e.userId ? `user-${String(e.userId).slice(-4)}` : e.channelId ? `channel-${String(e.channelId).slice(-4)}` : "someone";
    return `- ${_sanitizeFragment(e.type || "exchange")}: ${who} — ${_sanitizeFragment(e.content || "")}`;
  }).join("\n");

  const thoughtLines = signal.recentThoughts
    .map((t) => {
      const raw = typeof t === "string" ? t : (typeof t?.thought === "string" ? t.thought : "");
      return raw ? `- "${_sanitizeFragment(raw)}"` : null;
    })
    .filter(Boolean)
    .join("\n");

  const moodLabel = signal.isBadDay ? "bad mood, tired"
    : signal.moodScore > 30 ? "happy, content"
    : signal.moodScore < -30 ? "cranky, annoyed"
    : "neutral, flat";

  const sleepType = isNap ? "nap" : "full sleep";
  const prompt = `You are Irene's dreaming subconscious. Her current mood is ${moodLabel}. She's about to take a ${sleepType}. Generate a VERY SHORT dream (2-3 sentences, first-person as Irene) that remixes the following recent signals into something surreal or poetic. Don't be literal — dreams distort. Don't use quotes. Keep it under 200 characters.

Recent episodes:
${episodeLines || "(none)"}

Recent thoughts:
${thoughtLines || "(none)"}

Write the dream:`;

  try {
    const response = await Promise.race([
      client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 80, temperature: 1.0 },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dream timeout")), 8000)),
    ]);

    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter(p => p && typeof p.text === "string" && !p.thought)
      .map(p => p.text).join("").trim().replace(/^["']|["']$/g, "");
    if (!text || text.length < 10) {
      log(`[Dream] empty dream generated`);
      return null;
    }

    const dream = { text: text.slice(0, 240), at: Date.now(), type: sleepType };

    // Load existing history to append
    let history = [];
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (sb) {
        const { data } = await sb.from("bot_data").select("data").eq("id", "irene_dreams_log").single();
        history = Array.isArray(data?.data?.history) ? data.data.history : [];
      }
    } catch {}
    history.unshift(dream);

    _lastDream = dream;
    // Await the write so a fast crash after return doesn't lose the dream.
    await _persist(dream, history);
    log(`[Dream] generated: "${dream.text}"`);
    return dream;
  } catch (err) {
    log(`[Dream] generate failed: ${err.message}`);
    return null;
  }
}

export function getLastDream() {
  return _lastDream;
}

/**
 * Build a system-prompt fragment that mentions the recent dream, but only
 * for DREAM_VISIBILITY_MS after it was generated. After that window she
 * stops referencing it (dreams fade).
 */
export function buildDreamContext() {
  if (!_lastDream) return "";
  // Guard against clock-rewind (NTP/DST): negative age -> treat as 0.
  const age = Math.max(0, Date.now() - (_lastDream.at || 0));
  if (age > DREAM_VISIBILITY_MS) return "";
  return `\n[Recent dream (~${Math.round(age / 60_000)}min ago, from a ${_lastDream.type}) — you can bring it up naturally if it fits: "${_lastDream.text}"]`;
}
