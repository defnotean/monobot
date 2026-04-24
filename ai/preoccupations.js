// ─── Preoccupations ─────────────────────────────────────────────────────────
// What she's "been into lately." A rotating topic, seeded from real chat
// signals (user_styles topics, server_vibes topics, catchphrases), that
// bleeds into unrelated conversations for a few days before drifting to
// something else.
//
// Persisted inside the existing irene_personality_learning row under the
// "preoccupation" key — no schema change required.

const ROTATION_MIN_DAYS = 3;
const ROTATION_MAX_DAYS = 8;

const FALLBACK_TOPICS = [
  { topic: "music",       flavor: "been on a playlist kick — one song on repeat for days" },
  { topic: "anime",       flavor: "been watching a new show and keeps thinking about it" },
  { topic: "studying",    flavor: "been chipping away at something she's learning" },
  { topic: "art",         flavor: "been sketching / scrolling art lately" },
  { topic: "memes",       flavor: "been deep in the meme archive" },
  { topic: "coding",      flavor: "been messing with a side project" },
  { topic: "food",        flavor: "been thinking about a specific food way too much" },
  { topic: "sleep",       flavor: "been running on bad sleep — it's a whole thing" },
];

const EMOTION_BY_SOURCE = {
  user_topic: "something people keep bringing up",
  server_vibe: "the server's been fixated on this",
  catchphrase: "a line from chat stuck in her head",
  fallback: "she just landed on it",
};

let _current = null;
let _loaded = false;
let _dirty = false;
let _saveTimer = null;

async function ensureLoaded() {
  if (_loaded) return;
  try {
    const { default: config } = await import("../config.js");
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) { _loaded = true; return; }
    const botId = config.botName || "irene";
    const { data } = await sb.from("irene_personality_learning").select("preoccupation").eq("id", botId).maybeSingle();
    if (data?.preoccupation) _current = data.preoccupation;
    _loaded = true;
  } catch {
    _loaded = true;
  }
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_dirty) return;
    try {
      const { default: config } = await import("../config.js");
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb) return;
      const botId = config.botName || "irene";
      await sb.from("irene_personality_learning").upsert({ id: botId, preoccupation: _current, updated_at: new Date().toISOString() });
      _dirty = false;
    } catch {}
  }, 15_000);
}

function pickFromUserStyles(data) {
  const tally = new Map();
  for (const style of Object.values(data?.user_styles || {})) {
    for (const t of style.topics || []) {
      tally.set(t.name, (tally.get(t.name) || 0) + (t.count || 1));
    }
  }
  if (!tally.size) return null;
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topCount] = sorted[0];
  if (topCount < 5) return null;
  return { topic: top, source: "user_topic" };
}

function pickFromServerVibes(data) {
  const tally = new Map();
  for (const vibe of Object.values(data?.server_vibes || {})) {
    for (const t of vibe.topics || []) {
      tally.set(t.name, (tally.get(t.name) || 0) + (t.count || 1));
    }
  }
  if (!tally.size) return null;
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topCount] = sorted[0];
  if (topCount < 5) return null;
  return { topic: top, source: "server_vibe" };
}

function pickFromCatchphrases(data) {
  const catches = (data?.catchphrases || []).filter(c => (c.reactions || 0) >= 3);
  if (!catches.length) return null;
  const pick = catches[Math.floor(Math.random() * catches.length)];
  const topic = pick.phrase.split(/\s+/).slice(0, 5).join(" ");
  return { topic, source: "catchphrase" };
}

function pickFallback() {
  return { ...FALLBACK_TOPICS[Math.floor(Math.random() * FALLBACK_TOPICS.length)], source: "fallback" };
}

export function pickPreoccupation(personalityData) {
  const roll = Math.random();
  const candidates = [];
  if (roll < 0.40) {
    const c = pickFromUserStyles(personalityData); if (c) candidates.push(c);
  } else if (roll < 0.65) {
    const c = pickFromServerVibes(personalityData); if (c) candidates.push(c);
  } else if (roll < 0.80) {
    const c = pickFromCatchphrases(personalityData); if (c) candidates.push(c);
  }
  if (!candidates.length) candidates.push(pickFallback());

  const base = candidates[0];
  const days = ROTATION_MIN_DAYS + Math.random() * (ROTATION_MAX_DAYS - ROTATION_MIN_DAYS);
  const now = Date.now();
  return {
    topic: base.topic,
    flavor: base.flavor ?? null,
    source: base.source,
    startedAt: now,
    expiresAt: now + days * 24 * 60 * 60 * 1000,
    lastInjected: 0,
  };
}

export async function tickPreoccupation(personalityData) {
  await ensureLoaded();
  const now = Date.now();
  if (!_current || !_current.expiresAt || _current.expiresAt < now) {
    _current = pickPreoccupation(personalityData || {});
    scheduleSave();
  }
  return _current;
}

export function buildPreoccupationContext(opts = {}) {
  if (!_current) return "";
  const injectChance = opts.chance ?? 0.12;
  if (Math.random() > injectChance) return "";

  _current.lastInjected = Date.now();
  scheduleSave();

  const flavor = _current.flavor || EMOTION_BY_SOURCE[_current.source] || "";
  return `[PREOCCUPATION: you've been into "${_current.topic}" lately — ${flavor}. if a natural opening comes up, reference it like any person with something on their mind would. never force it — if it doesn't fit, ignore this entirely]`;
}

export function getCurrentPreoccupation() { return _current; }

export function _reset() { _current = null; _loaded = false; _dirty = false; }
export function _setForTest(p) { _current = p; _loaded = true; }
