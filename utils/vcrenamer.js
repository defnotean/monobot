// ─── VC Auto-Renamer ──────────────────────────────────────────────────────────
// Evaluates templates against current channel state and queues renames while
// respecting Discord's 2-rename-per-10-minutes rate limit per channel.

import { tempChannels, renameTimers, tempVcSeq, tempTextChannels, guildVcSeqCounters, manualRenames } from "./tempvc.js";
import { getGuildSettings, getVcNamingMode, getVcRichPresence } from "../database.js";
import { log } from "./logger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const NATO_ALPHABET = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
  "X-ray", "Yankee", "Zulu",
];

export function toRoman(n) {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ["M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"];
  let out = "";
  for (let i = 0; i < vals.length; i++) while (n >= vals[i]) { out += syms[i]; n -= vals[i]; }
  return out || "I";
}

// Seeded pick so [[word/word]] stays stable across renames for the same channel
function seededPick(choices, channelId) {
  const idx = Number(BigInt(channelId) % BigInt(choices.length));
  return choices[idx] ?? choices[0];
}

// ─── Non-game app blacklist ──────────────────────────────────────────────────
// These show as "Playing X" (activity type 0) but aren't actual games.
// Lowercase for comparison.
const APP_BLACKLIST = new Set([
  "medal", "medal.tv", "medalapp",
  "valorant tracker", "tracker.gg", "blitz", "blitz.gg",
  "overwolf", "op.gg", "porofessor", "mobalytics",
  "discord", "spotify", "obs", "obs studio", "streamlabs", "streamlabs obs",
  "chrome", "google chrome", "firefox", "mozilla firefox", "brave", "edge", "microsoft edge", "opera", "opera gx",
  "visual studio code", "vscode", "code", "intellij idea", "webstorm", "pycharm",
  "file explorer", "explorer", "windows explorer",
  "nvidia geforce experience", "geforce experience", "nvidia share", "nvidia overlay",
  "amd software", "amd radeon", "radeon software",
  "task manager", "system settings", "settings",
  "steam", "epic games launcher", "epic games", "battle.net", "riot client", "ea app", "origin", "ubisoft connect",
  "xbox", "xbox game bar",
  "afterburner", "msi afterburner", "hwinfo", "hwmonitor", "cpu-z", "gpu-z",
  "wallpaper engine", "rainmeter", "lightshot", "sharex", "gyazo",
  "voicemeeter", "voicemeeter banana", "voicemod",
  "logitech g hub", "corsair icue", "razer synapse", "steelseries gg",
  "notion", "obsidian", "todoist",
]);

export function sanitizeGameName(name) {
  if (!name) return name;
  return name.replace(/:\s*(?:with|using)\s+(?:Medal(?:\.tv)?|Overwolf)\b/i, "")
             .replace(/\b(?:with|using)\s+(?:Medal(?:\.tv)?|Overwolf)\b/i, "")
             .replace(/-\s*Medal(?:\.tv)?/i, "")
             .replace(/[:\s]+$/, "")
             .trim();
}

export function isActualGame(activityName) {
  if (!activityName) return false;
  return !APP_BLACKLIST.has(activityName.toLowerCase());
}

// ─── Game analysis (used by vcpanel.js for the detailed breakdown) ────────────

export function getChannelGames(vc) {
  const gameCounts = new Map();
  const enableRpc = getVcRichPresence(vc.guild?.id);
  
  for (const [, m] of vc.members) {
    if (m.user.bot) continue;
    const playActivity = m.presence?.activities?.find((a) => a.type === 0 && isActualGame(a.name));
    if (playActivity) {
      let g = sanitizeGameName(playActivity.name);
      if (enableRpc) {
        let rp = pickRichDetail(playActivity.state, playActivity.details);
        if (rp) g = `${g}: ${sanitizeGameName(rp)}`;
      }
      gameCounts.set(g, (gameCounts.get(g) ?? 0) + 1);
    }
  }
  return gameCounts;
}

// ─── Smart activity detector ──────────────────────────────────────────────────
// Returns a short display string describing what the VC is doing, or null when
// everyone is idle. Priority: Games > Streaming > Music > null.

export function getSmartActivity(vc) {
  const members = [...vc.members.values()].filter((m) => !m.user.bot);
  if (!members.length) return null;

  // Gather activities across all members
  const games   = new Map(); // game name → { count, state, details }
  let   streamer = null;
  let   musicCount = 0;

  for (const m of members) {
    const acts    = m.presence?.activities ?? [];
    const game    = acts.find((a) => a.type === 0 && isActualGame(a.name));  // Playing (filtered)
    const stream  = acts.find((a) => a.type === 1);  // Streaming
    const music   = acts.find((a) => a.type === 2 && a.name === "Spotify");

    if (game) {
      const sanitizedName = sanitizeGameName(game.name);
      const prev = games.get(sanitizedName) ?? { count: 0, state: game.state, details: game.details };
      games.set(sanitizedName, { ...prev, count: prev.count + 1 });
    }
    if (stream && !streamer) streamer = stream;
    if (music)  musicCount++;
  }

  // ── Games (highest priority) ────────────────────────────────────────────────
  if (games.size >= 1) {
    const sorted = [...games.entries()].sort((a, b) => b[1].count - a[1].count);

    // On a tie, prefer the game the owner is playing so the name reflects who made the VC
    let [topName, topInfo] = sorted[0];
    if (sorted.length > 1 && sorted[0][1].count === sorted[1][1].count) {
      const ownerId  = tempChannels.get(vc.id);
      const owner    = ownerId ? vc.members.get(ownerId) : null;
      const ownerGame = owner?.presence?.activities?.find((a) => a.type === 0 && isActualGame(a.name));
      if (ownerGame) {
        const ownerSanitized = sanitizeGameName(ownerGame.name);
        const ownerEntry = games.get(ownerSanitized);
        if (ownerEntry) { topName = ownerSanitized; topInfo = ownerEntry; }
      }
    }

    const enableRpc = getVcRichPresence(vc.guild.id);
    const rp = enableRpc ? pickRichDetail(topInfo.state, topInfo.details) : null;
    const gameName = truncateName(topName, 28);
    return rp ? `${gameName}: ${sanitizeGameName(rp)}` : gameName;
  }

  // ── Streaming ───────────────────────────────────────────────────────────────
  if (streamer) {
    // Use stream title only if it's short enough to be readable; otherwise generic label
    const title = streamer.details ?? streamer.name ?? null;
    const label = title && title.length <= 22 ? title : "Streaming";
    return `🔴 ${label}`;
  }

  // ── Music ───────────────────────────────────────────────────────────────────
  if (musicCount > 0) return "🎵 Music";

  return null; // Everyone idle
}

// Picks the most descriptive short rich-presence detail to append.
// Strict filter: only surface genuinely meaningful mode/map names, not status strings.
const RICH_JUNK = new Set([
  "in game", "in match", "in queue", "in lobby", "in menu", "in loading screen",
  "main menu", "loading", "browsing", "spectating", "watching", "afk", "idle",
  "custom game", "practice", "practice range", "tutorial", "intro", "pregame",
  "postgame", "end of game", "character select", "agent select", "pick phase",
  "matchmaking", "searching", "waiting", "ready check", "warmup",
]);

function pickRichDetail(state, details) {
  for (const raw of [state, details]) {
    if (!raw) continue;
    const v = raw.trim();
    // Length: short enough to read at a glance
    if (v.length === 0 || v.length > 18) continue;
    // No special chars that indicate structured data
    if (/[/\\[\]()]/.test(v)) continue;
    // No number-heavy patterns (scores, counts, timers)
    if (/\d+\s*[-/]\s*\d+/.test(v)) continue;
    if (/^\d/.test(v)) continue;
    // No generic status strings
    if (RICH_JUNK.has(v.toLowerCase())) continue;
    return v;
  }
  return null;
}

// ─── Random name pools for anonymous/random mode ───────────────────────────────
const RANDOM_PREFIXES = [
  "The", "Club", "Chill", "Vibe", "Late Night", "After Hours",
  "Downtown", "Underground", "Rooftop", "Back Room", "Main",
  "Secret", "Golden", "Midnight", "Neon",
];

const RANDOM_NOUNS = [
  "Lounge", "Den", "Hub", "Hangout", "Zone", "Spot",
  "Corner", "Room", "Base", "Deck", "Court", "Floor",
  "Stage", "Arena", "Studio", "Quarters", "Loft",
];

function generateRandomName(serverName, seq, channelId) {
  // Use channelId or seq as seed for stability
  const seed = channelId ? Number(BigInt(channelId) % BigInt(1000)) : seq;
  const prefix = RANDOM_PREFIXES[seed % RANDOM_PREFIXES.length];
  const noun = RANDOM_NOUNS[(seed * 7) % RANDOM_NOUNS.length];
  const nato = NATO_ALPHABET[(seq - 1) % NATO_ALPHABET.length];
  return `${prefix} ${noun} • ${nato}`;
}

// ─── Name truncation helper ───────────────────────────────────────────────────
// Cuts at a word boundary where possible; appends ellipsis only if needed.
function truncateName(str, max) {
  if (!str || str.length <= max) return str;
  const cut = str.slice(0, max - 1).trimEnd();
  // Try to cut at last space so we don't chop a word mid-way
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

// Discord sidebar comfortably shows ~40 chars. Hard cap keeps names readable.
const MAX_VC_NAME = 45;

// ─── Smart name builder ───────────────────────────────────────────────────────
// Builds the full channel name dynamically based on naming mode.
// Modes:
//   smart     — "{activity} • {creator}" (default, shows person's name)
//   anonymous — "{activity} • VC #{seq}" (no person's name)
//   random    — "{activity} • The Lounge • Bravo" (random server-themed names)

function buildSmartVcName(params) {
  const { creatorName, activity, mode, seq, serverName, channelId } = params;

  // Cap creator name so long display names don't blow out the format
  const name = truncateName(creatorName, 16);

  let result;
  switch (mode) {
    case "anonymous":
      result = activity ? `${activity} • VC #${seq ?? 1}` : `VC #${seq ?? 1}`;
      break;

    case "random": {
      const randomName = generateRandomName(serverName, seq ?? 1, channelId);
      result = activity ? `${activity} • ${randomName}` : randomName;
      break;
    }

    case "smart":
    default:
      result = activity ? `${activity} • ${name}` : `${name}'s VC`;
      break;
  }

  // Hard cap — trim at word boundary if possible
  return result.length > MAX_VC_NAME ? truncateName(result, MAX_VC_NAME) : result;
}

// ─── Core template substitution ──────────────────────────────────────────────

function substitute(template, { creator, game, streamName, server, seq, numVal, numOthers, nato, channelId }) {
  creator = creator ?? "Unknown";
  let text = template;

  // Name vars
  text = text.replace(/@@creator_name@@/gi, creator);
  text = text.replace(/@@creator@@/gi,      creator);
  text = text.replace(/\{creator\}/gi,      creator);
  text = text.replace(/@@server_name@@/gi,  server);
  text = text.replace(/\{server\}/gi,       server);
  text = text.replace(/@@nato@@/gi,         nato);

  // User count vars
  text = text.replace(/@@num_others@@/gi, String(numOthers));
  text = text.replace(/@@num@@/gi,        String(numVal));

  // Activity vars (with fallback support: {game|Fallback} and dangling separator cleanup)
  text = text.replace(/(?:\s*[\-•\|~:]\s*)?(?:\{game(?:\|([^}]+))?\}|@@game_name(?:\|([^@]+))?@@)/gi, (match, fall1, fall2) => {
    const fallback = fall1 || fall2;
    if (game) return match.replace(/\{game(?:\|[^}]+)?\}|@@game_name(?:\|[^@]+)?@@/gi, game);
    if (fallback) return match.replace(/\{game(?:\|[^}]+)?\}|@@game_name(?:\|[^@]+)?@@/gi, fallback.trim());
    return ""; // Vaporize entire section including separator
  });

  const stream = streamName ?? game;
  text = text.replace(/(?:\s*[\-•\|~:]\s*)?(?:\{stream(?:\|([^}]+))?\}|@@stream_name(?:\|([^@]+))?@@)/gi, (match, fall1, fall2) => {
    const fallback = fall1 || fall2;
    if (stream) return match.replace(/\{stream(?:\|[^}]+)?\}|@@stream_name(?:\|[^@]+)?@@/gi, stream);
    if (fallback) return match.replace(/\{stream(?:\|[^}]+)?\}|@@stream_name(?:\|[^@]+)?@@/gi, fallback.trim());
    return "";
  });

  // Numbering — longest patterns first
  text = text.replace(/\$000#/g, String(seq).padStart(4, "0"));
  text = text.replace(/\$00#/g,  String(seq).padStart(3, "0"));
  text = text.replace(/\$0#/g,   String(seq).padStart(2, "0"));
  text = text.replace(/\+#/g,    toRoman(seq));
  text = text.replace(/\$#/g,    String(seq));
  text = text.replace(/##/g,     `#${seq}`);
  text = text.replace(/\{num\}/gi, `#${seq}`);

  // Singular/plural
  text = text.replace(/<<([^/\\>]+)\/([^>]+)>>/g, (_, s, p) => numVal    === 1 ? s : p);
  text = text.replace(/<<([^/\\>]+)\\([^>]+)>>/g, (_, s, p) => numOthers === 1 ? s : p);

  // Random word — seeded by channelId so stable across renames
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, opts) =>
    channelId ? seededPick(opts.split("/"), channelId) : opts.split("/")[0]
  );

  // Clean horizontal spacing and hanging decorators that fell out of bounds
  text = text.replace(/\s+/g, " ");
  text = text.replace(/^[ \-•\|~:]+/, "");
  text = text.replace(/[ \-•\|~:]+$/, "");

  return text.trim();
}

// ─── Creation-time name ───────────────────────────────────────────────────────
// Called before the channel exists (no VC ID, no members yet — only creator).

export function applyVcTemplate(template, member) {
  const guild  = member.guild;
  // Use per-guild counter (O(1)) — voiceStateUpdate.js increments it right after calling this
  const seq    = (guildVcSeqCounters.get(guild.id) ?? 0) + 1;

  const playActivity   = member.presence?.activities?.find((a) => a.type === 0 && isActualGame(a.name));
  const streamActivity = member.presence?.activities?.find((a) => a.type === 1);
  const musicActivity  = member.presence?.activities?.find((a) => a.type === 2 && a.name === "Spotify");

  let game         = playActivity ? sanitizeGameName(playActivity.name) : null;
  const enableRpc  = getVcRichPresence(guild.id);

  if (game && enableRpc) {
    let rp = pickRichDetail(playActivity.state, playActivity.details);
    if (rp) {
      rp = sanitizeGameName(rp);
      game = `${game}: ${rp}`;
    }
  }

  const streamName = streamActivity
    ? (streamActivity.url?.split("/").pop() ?? streamActivity.name ?? null)
    : null;

  // Smart mode (no custom template)
  if (!template) {
    const namingMode = getVcNamingMode(guild.id);
    let activity = null;
    if (game) {
      activity = game; // Already includes rich presence if enabled
    } else if (streamActivity) {
      activity = `🔴 ${streamActivity.details ?? streamActivity.name ?? "Stream"}`;
    } else if (musicActivity) {
      activity = "🎵 Music";
    }
    return buildSmartVcName({
      creatorName: member.displayName,
      activity,
      mode: namingMode,
      seq,
      serverName: guild.name,
      channelId: null,
    });
  }

  return substitute(template, {
    creator: member.displayName,
    game,
    streamName,
    server:    guild.name,
    seq,
    numVal:    1,
    numOthers: 0,
    nato:      NATO_ALPHABET[(seq - 1) % NATO_ALPHABET.length],
    channelId: null,
  });
}

// ─── Dynamic name (for auto-rename) ──────────────────────────────────────────
// Called with the live VC channel — uses current member data.

export function applyTemplateToVc(vc, guild) {
  const template = getGuildSettings(guild.id)?.vc_template ?? null;
  const seq      = tempVcSeq.get(vc.id) ?? 1;

  const ownerId  = tempChannels.get(vc.id);
  const owner    = ownerId ? guild.members.cache.get(ownerId) : null;
  const nonBots  = vc.members.filter((m) => !m.user.bot);
  const numVal   = nonBots.size;
  const numOthers = Math.max(0, numVal - 1);

  const creatorName = owner?.displayName ?? "Unknown";

  // Smart mode (no custom template) — full activity scan across all members
  if (!template) {
    const namingMode = getVcNamingMode(guild.id);
    const activity = getSmartActivity(vc);
    return buildSmartVcName({
      creatorName,
      activity,
      mode: namingMode,
      seq,
      serverName: guild.name,
      channelId: vc.id,
    });
  }

  // Custom template mode — {game} always resolves to the most-played game
  const gameCounts = getChannelGames(vc);
  let topGame = null, topCount = 0;
  for (const [g, c] of gameCounts) if (c > topCount) { topGame = g; topCount = c; }
  const gameDisplay = topGame ?? null;

  const ownerStream = owner?.presence?.activities?.find((a) => a.type === 1);
  const streamName  = ownerStream
    ? (ownerStream.url?.split("/").pop() ?? ownerStream.name ?? null)
    : null;

  return substitute(template, {
    creator:   creatorName,
    game:      gameDisplay,
    streamName,
    server:    guild.name,
    seq,
    numVal,
    numOthers,
    nato:      NATO_ALPHABET[(seq - 1) % NATO_ALPHABET.length],
    channelId: vc.id,
  });
}

// ─── Rename queue ─────────────────────────────────────────────────────────────
// Discord allows 2 renames per 10 minutes. We use a 1-min cooldown so game
// switches register quickly while the debounce prevents rapid-fire API calls.

const DEBOUNCE_MS = 8_000;         // 8 s after last change before executing rename
const COOLDOWN_MS = 60_000;       // 1 min between actual Discord API calls

const MANUAL_LOCK_MS = 30 * 60_000; // 30 minutes

export function queueRename(vc, guild) {
  // Respect manual renames — the owner explicitly set this name, don't overwrite it yet
  const manualAt = manualRenames.get(vc.id);
  if (manualAt && Date.now() - manualAt < MANUAL_LOCK_MS) {
    log(`[VC] Auto-rename suppressed for "${vc.name}" — manually renamed ${Math.round((Date.now() - manualAt) / 60_000)}m ago`);
    return;
  }

  const now   = Date.now();
  const entry = renameTimers.get(vc.id) ?? { timer: null, lastRenameAt: 0 };

  // Cancel any pending rename — latest activity wins
  if (entry.timer) {
    clearTimeout(entry.timer);
    log(`[VC] Cancelled pending rename for #${vc.name} (superseded by new activity)`);
  }

  const timeSinceLast = now - entry.lastRenameAt;
  const inCooldown = timeSinceLast < COOLDOWN_MS;
  const wait = inCooldown
    ? Math.max(DEBOUNCE_MS, COOLDOWN_MS - timeSinceLast)
    : DEBOUNCE_MS;

  log(`[VC] Queuing rename for #${vc.name} — wait ${Math.round(wait / 1000)}s${inCooldown ? ` (cooldown: ${Math.round((COOLDOWN_MS - timeSinceLast) / 1000)}s left)` : " (no cooldown)"}`);

  const timer = setTimeout(async () => {
    renameTimers.set(vc.id, { timer: null, lastRenameAt: Date.now() });
    try {
      const freshVc = guild.channels.cache.get(vc.id);
      if (!freshVc || !tempChannels.has(freshVc.id)) {
        log(`[VC] Rename skipped — channel no longer exists or is not a temp VC`);
        return;
      }
      // Skip rename if music is playing in this VC — Discord briefly
      // reconnects voice connections when a channel is renamed, which
      // causes audio interruption. Defer until music stops.
      try {
        const { getQueue } = await import("../music/player.js");
        const q = getQueue(guild.id);
        if (q?.playing && q?.voiceChannel?.id === freshVc.id) {
          log(`[VC] Rename deferred — music playing in #${freshVc.name}`);
          return;
        }
      } catch {}
      const newName = applyTemplateToVc(freshVc, guild);
      if (newName === freshVc.name) {
        log(`[VC] Rename skipped — name unchanged: "${freshVc.name}"`);
        return;
      }
      log(`[VC] Renaming: "${freshVc.name}" → "${newName}"`);
      await freshVc.setName(newName, "Auto-rename: activity change");
      log(`[VC] ✓ Rename successful`);
    } catch (err) {
      log(`[VC] ✗ Rename failed: ${err.message}`);
    }
  }, wait);

  renameTimers.set(vc.id, { timer, lastRenameAt: entry.lastRenameAt });
}

// Initialize rename timer for a newly created VC.
// lastRenameAt: 0 so the first game-switch renames immediately (no artificial delay)
export function initRenameTimer(channelId) {
  renameTimers.set(channelId, { timer: null, lastRenameAt: 0 });
}

// ─── Periodic polling — catches game switches that presenceUpdate misses ──────
// Runs every 30s and checks if any temp VC's name is stale. Only queues a rename
// if the computed name differs from the current one, so it doesn't waste API calls.

const POLL_INTERVAL_MS = 30_000; // 30 seconds

export function startVcPolling(client) {
  setInterval(() => {
    const now = Date.now();
    for (const [channelId, ownerId] of tempChannels) {
      try {
        // Skip if owner manually renamed recently — respect their choice
        const manualAt = manualRenames.get(channelId);
        if (manualAt && now - manualAt < MANUAL_LOCK_MS) continue;

        const vc = client.channels.cache.get(channelId);
        if (!vc || !vc.guild || !vc.isVoiceBased()) continue;

        const newName = applyTemplateToVc(vc, vc.guild);
        if (newName === vc.name) continue;

        // Name needs updating — check cooldown before queuing
        const entry = renameTimers.get(channelId);
        if (entry?.timer) continue; // already has a pending rename

        log(`[VC] Poll detected stale name: "${vc.name}" → should be "${newName}"`);
        queueRename(vc, vc.guild);
      } catch (err) {
        // Silently skip — channel might be deleted mid-iteration
      }
    }
  }, POLL_INTERVAL_MS);
  log(`[VC] Activity polling started (every ${POLL_INTERVAL_MS / 1000}s)`);
}
