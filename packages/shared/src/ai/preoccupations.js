// @ts-nocheck -- factory binds untyped bot-local config/db clients; behavior is covered by shared and bot tests.
// Rotating "what she's been into lately" topic, shared by the twin bots.

const ROTATION_MIN_DAYS = 3;
const ROTATION_MAX_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_FALLBACK_TOPICS = [
  { topic: "music", flavor: "been on a playlist kick" },
];

export const DEFAULT_SOURCE_FLAVORS = {
  user_topic: "something people keep bringing up",
  server_vibe: "the server's been fixated on this",
  catchphrase: "a line from chat stuck in her head",
  fallback: "she just landed on it",
};

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

function pickFromCatchphrases(data, random) {
  const catches = (data?.catchphrases || []).filter(c => (c.reactions || 0) >= 3);
  if (!catches.length) return null;
  const pick = catches[Math.floor(random() * catches.length)];
  const topic = pick.phrase.split(/\s+/).slice(0, 5).join(" ");
  return { topic, source: "catchphrase" };
}

export function createPreoccupations({
  tableName = "personality_learning",
  defaultBotId = "bot",
  fallbackTopics = DEFAULT_FALLBACK_TOPICS,
  sourceFlavors = {},
  getConfig = async () => ({}),
  getSupabase = async () => null,
  saveDelayMs = 15_000,
  random = Math.random,
  now = Date.now,
} = {}) {
  const flavors = { ...DEFAULT_SOURCE_FLAVORS, ...sourceFlavors };
  const fallbacks = Array.isArray(fallbackTopics) && fallbackTopics.length
    ? fallbackTopics
    : DEFAULT_FALLBACK_TOPICS;

  let _current = null;
  let _loaded = false;
  let _dirty = false;
  let _saveTimer = null;

  async function resolveBotId() {
    const config = await getConfig();
    return config?.botName || defaultBotId;
  }

  async function ensureLoaded() {
    if (_loaded) return;
    try {
      const sb = await getSupabase();
      if (!sb) { _loaded = true; return; }
      const botId = await resolveBotId();
      const { data } = await sb.from(tableName).select("preoccupation").eq("id", botId).maybeSingle();
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
        const sb = await getSupabase();
        if (!sb) return;
        const botId = await resolveBotId();
        await sb.from(tableName).upsert({
          id: botId,
          preoccupation: _current,
          updated_at: new Date(now()).toISOString(),
        });
        _dirty = false;
      } catch {}
    }, saveDelayMs);
  }

  function pickFallback() {
    return { ...fallbacks[Math.floor(random() * fallbacks.length)], source: "fallback" };
  }

  function pickPreoccupation(personalityData) {
    const roll = random();
    const candidates = [];
    if (roll < 0.40) {
      const c = pickFromUserStyles(personalityData); if (c) candidates.push(c);
    } else if (roll < 0.65) {
      const c = pickFromServerVibes(personalityData); if (c) candidates.push(c);
    } else if (roll < 0.80) {
      const c = pickFromCatchphrases(personalityData, random); if (c) candidates.push(c);
    }
    if (!candidates.length) candidates.push(pickFallback());

    const base = candidates[0];
    const days = ROTATION_MIN_DAYS + random() * (ROTATION_MAX_DAYS - ROTATION_MIN_DAYS);
    const ts = now();
    return {
      topic: base.topic,
      flavor: base.flavor ?? null,
      source: base.source,
      startedAt: ts,
      expiresAt: ts + days * DAY_MS,
      lastInjected: 0,
    };
  }

  async function tickPreoccupation(personalityData) {
    await ensureLoaded();
    const ts = now();
    if (!_current || !_current.expiresAt || _current.expiresAt < ts) {
      _current = pickPreoccupation(personalityData || {});
      scheduleSave();
    }
    return _current;
  }

  function buildPreoccupationContext(opts = {}) {
    if (!_current) return "";
    const injectChance = opts.chance ?? 0.12;
    if (random() > injectChance) return "";

    _current.lastInjected = now();
    scheduleSave();

    const flavor = _current.flavor || flavors[_current.source] || "";
    return `[PREOCCUPATION: you've been into "${_current.topic}" lately — ${flavor}. if a natural opening comes up, reference it like any person with something on their mind would. never force it — if it doesn't fit, ignore this entirely]`;
  }

  function getCurrentPreoccupation() { return _current; }

  function _reset() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _current = null;
    _loaded = false;
    _dirty = false;
    _saveTimer = null;
  }

  function _setForTest(p) {
    _current = p;
    _loaded = true;
  }

  return {
    pickPreoccupation,
    tickPreoccupation,
    buildPreoccupationContext,
    getCurrentPreoccupation,
    _reset,
    _setForTest,
  };
}

export const _internal = {
  pickFromUserStyles,
  pickFromServerVibes,
  pickFromCatchphrases,
};
