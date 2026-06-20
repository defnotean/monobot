// ─── packages/irene/music/player.js ─────────────────────────────────────
// Lavalink/Shoukaku queue manager. Per-guild mutex + 60s queue auto-save
// + restore-on-clientReady so restarts don't lose state. Karaoke ties in
// via onTrackStart/onTrackEnd events.
// See docs/local-dev-loop.md for "Testing music locally".

// ─── Music Queue Manager — Lavalink Backend via Shoukaku ────────────────────
// Audio streaming handled by Lavalink server (runs on VPS with UDP support).
// Bot sends commands over WebSocket/REST — no local voice, yt-dlp, or ffmpeg.

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { onTrackStart, onTrackEnd, hasSession, extractSongInfo, stopKaraoke } from "../ai/karaoke.js";
import { log } from "../utils/logger.js";
import { saveQueue as dbSaveQueue, getSavedQueues, clearSavedQueue, clearAllSavedQueues } from "../database.js";
import * as settingsStore from "./settingsStore.js";
import { safeDiscordAction, safeDiscordSync } from "../utils/safeDiscord.js";

// Shoukaku instance — set by initMusic() from index.js
let shoukaku = null;

// Per-guild mutex — prevents race conditions in queue operations (skip, stop, play)
const _queueLocks = new Map();
async function withQueueLock(guildId, fn) {
  /** @type {(value?: any) => void} */
  let release = () => {};
  const current = new Promise((r) => (release = r));
  // Set lock BEFORE awaiting — prevents race where two calls see same prev
  const prev = _queueLocks.get(guildId) ?? Promise.resolve();
  _queueLocks.set(guildId, current);
  await prev;
  try { return await fn(); } finally {
    release();
    if (_queueLocks.get(guildId) === current) _queueLocks.delete(guildId);
  }
}

let _autoSaveInterval = null;

export function initMusic(shoukakuInstance) {
  shoukaku = shoukakuInstance;
  log("[Music] Shoukaku initialized");

  // Idempotent: a Shoukaku reconnect can re-call initMusic. Without this guard
  // each call would stack another 60s auto-save interval, multiplying the DB
  // write load. Clear any prior timer first.
  if (_autoSaveInterval) clearInterval(_autoSaveInterval);

  // Auto-save queues every 60s while music is playing — survives ungraceful
  // shutdowns where SIGTERM → SIGKILL happens too fast for the shutdown
  // handler's Supabase flush to complete. Makes redeployments seamless.
  _autoSaveInterval = setInterval(() => {
    let saved = 0;
    for (const [guildId, queue] of queues) {
      if (!queue.playing || !queue.songs.length) continue;
      const currentPos = queue.player?.position || 0;
      const songs = queue.songs.filter(s => !s.isTTS).map((s, i) => ({
        title: s.title, artist: s.artist, url: s.url, duration: s.duration,
        thumbnail: s.thumbnail, lavalinkTrack: s.lavalinkTrack,
        requestedBy: s.requestedBy,
        ...(i === 0 && currentPos > 2000 ? { resumePos: currentPos } : {}),
      }));
      if (!songs.length) continue;
      dbSaveQueue(guildId, {
        voiceChannelId: queue.voiceChannel?.id,
        textChannelId: queue.textChannel?.id,
        songs, volume: queue.volume,
        looping: queue.looping, loopingQueue: queue.loopingQueue,
        shuffle: queue.shuffle,
      });
      saved++;
    }
    if (saved) log(`[Music] Auto-saved ${saved} queue(s)`);
  }, 60_000);

  // Don't let the auto-save timer keep the process alive on shutdown.
  if (typeof _autoSaveInterval?.unref === "function") _autoSaveInterval.unref();
}

// Per-guild queues
const queues = new Map();

const PLAYLIST_LIMIT = 300;

// ─── Durable music/voice settings (soundboard, DJ role, wake word) ──────────
// These were previously in-memory-only and lost on every restart. They now
// live in settingsStore.js (Supabase-backed, degrades to in-memory). Re-export
// the accessors here so the music command files and the voice listener have a
// single import surface and trigger a load-on-demand the first time a guild's
// settings are touched.
//
// Wiring note: commands/music/soundboard.js and commands/music/dj.js (NOT
// owned by this stream) keep their own in-memory Maps. Migrating them to read
// through these accessors (and calling loadGuildSettings on first use) is the
// one remaining step to make soundboard + DJ role survive restarts; recorded
// as an open concern. The voice-listener wake word IS wired here.
export const loadGuildSettings = settingsStore.loadGuild;
export const getSoundboardSetting = settingsStore.getSoundboard;
export const setSoundboardSetting = settingsStore.setSoundboard;
export const getDjRoleSetting = settingsStore.getDjRole;
export const setDjRoleSetting = settingsStore.setDjRole;
export const getWakeWordSetting = settingsStore.getWakeWord;
export const setWakeWordSetting = settingsStore.setWakeWord;

export function getQueue(guildId) {
  return queues.get(guildId);
}

// True only when `queue` is STILL the live queue for its guild. A late Lavalink
// event (track end/exception/stuck firing after the queue was torn down, or
// after `stop` + a fresh `play` replaced it for the same guild) otherwise holds
// a stale `queue` reference. `queues.has(guildId)` alone returns true for the
// replacement queue, so we also require object identity and the not-destroyed
// flag — without this a stale event shifts songs off / re-enters playSong on a
// queue that's already been advanced or replaced, corrupting playback state.
function isQueueLive(queue) {
  return !!queue && !queue._destroyed && queues.get(queue.guildId) === queue;
}

/**
 * @typedef {Object} Song
 * @property {string} [title]
 * @property {string} [artist]
 * @property {string} [url]
 * @property {number} [duration]
 * @property {string} [thumbnail]
 * @property {*} [lavalinkTrack]
 * @property {string} [requestedBy]
 * @property {boolean} [isTTS]
 * @property {number} [resumePos]
 */

export function createQueue(guildId, voiceChannel, textChannel) {
  const queue = {
    guildId,
    voiceChannel,
    textChannel,
    player: null,       // Shoukaku Player — set by connectToChannel
    /** @type {Song[]} */
    songs: [],
    volume: 80,
    playing: false,
    looping: false,
    loopingQueue: false,
    shuffle: false,
    songStartedAt: null,
    nowPlayingMsg: null,  // reference to the control panel message
    _autoLeaveTimer: null,
    _aloneDisconnectTimer: null,  // armed when bot is alone in the VC
    _pausedForEmpty: false,       // true when we auto-paused due to empty VC
    _destroyed: false,            // set by deleteQueue; gates stale Lavalink events
  };

  queues.set(guildId, queue);
  return queue;
}

export function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queues.delete(guildId);
  if (queue._autoLeaveTimer) clearTimeout(queue._autoLeaveTimer);
  if (queue._stuckTimeout) clearTimeout(queue._stuckTimeout);
  if (queue._aloneDisconnectTimer) clearTimeout(queue._aloneDisconnectTimer);
  if (queue.nowPlayingMsg) {
    void safeDiscordAction(`music.deleteQueue.deletePanel guild=${guildId}`, () => queue.nowPlayingMsg.delete());
  }
  // Stop lyrics if running — music is gone
  if (hasSession(guildId)) stopKaraoke(guildId, "queue deleted").catch(() => {});
  // Remove all event listeners to prevent memory leak
  if (queue.player) safeDiscordSync(`music.deleteQueue.removeListeners guild=${guildId}`, () => queue.player.removeAllListeners());
  if (queue.player?.stopTrack) void safeDiscordAction(`music.deleteQueue.stopTrack guild=${guildId}`, () => queue.player.stopTrack());
  if (queue.player?.connection?.disconnect) void safeDiscordAction(`music.deleteQueue.disconnect guild=${guildId}`, () => queue.player.connection.disconnect());
  if (shoukaku?.leaveVoiceChannel) void safeDiscordAction(`music.deleteQueue.leaveVoice guild=${guildId}`, () => shoukaku.leaveVoiceChannel(guildId));
  // Null the player reference — stops any post-deletion playSong() call from
  // operating on a freshly-stopped-but-still-referenced player. The queue
  // object itself is also orphaned but anyone holding a reference shouldn't
  // be able to do harm to the old player.
  queue.player = null;
  queue.tracks = [];
  queue._destroyed = true;
}

// ─── Alone-in-VC: pause + scheduled disconnect (cost control) ───────────────
// When the bot is the only non-bot member left in its voice channel it keeps
// streaming to nobody — burning Lavalink bandwidth and (for paid sources) API
// budget for hours. We pause immediately when alone and schedule a disconnect
// after a short grace period; if a human rejoins before the grace expires we
// resume and cancel the disconnect.
//
// Wiring note: the bot's voice membership is observed in
// events/voiceStateUpdate.js (NOT owned by this stream). That handler should
// call handleVoiceMembershipChange(guildId) on any voiceStateUpdate whose
// channel matches the bot's active music VC. Until that one-line wiring lands
// the helper is still exercised by tests and is a no-op otherwise.
const ALONE_DISCONNECT_GRACE_MS = 60_000;

/**
 * Count the non-bot members currently in the queue's voice channel.
 * Reads from the channel's live member cache (discord.js GuildVoiceChannel).
 */
function countHumanMembers(voiceChannel) {
  const members = voiceChannel?.members;
  if (!members || typeof members.filter !== "function") return 0;
  return members.filter((m) => !m.user?.bot).size;
}

/**
 * Re-evaluate whether the bot is alone in its voice channel and react.
 * - Alone  → pause playback (if playing) and schedule a disconnect after the
 *            grace period. Idempotent: an already-scheduled timer is left be.
 * - Joined → cancel a pending disconnect and resume if we auto-paused.
 *
 * Exported so the (unowned) voiceStateUpdate handler can drive it. Returns a
 * small status object for testability.
 *
 * @param {string} guildId
 * @param {{ graceMs?: number }} [opts]
 */
export function handleVoiceMembershipChange(guildId, opts = {}) {
  const queue = queues.get(guildId);
  if (!queue) return { action: "no-queue" };

  const graceMs = opts.graceMs ?? ALONE_DISCONNECT_GRACE_MS;
  const humans = countHumanMembers(queue.voiceChannel);

  if (humans === 0) {
    // Bot is alone — pause now (cheap) and arm the disconnect timer.
    // Only pause an actively-playing queue: pausing an idle player and then
    // resuming it on rejoin would un-pause something that was never playing.
    if (queue.playing && queue.player && !queue.player.paused) {
      const paused = safeDiscordSync(`music.pauseEmptyVc guild=${guildId}`, () => queue.player.setPaused(true));
      queue._pausedForEmpty = paused;
    }
    if (!queue._aloneDisconnectTimer) {
      queue._aloneDisconnectTimer = setTimeout(() => {
        const q = queues.get(guildId);
        if (!q) return;
        q._aloneDisconnectTimer = null;
        // Re-check at fire time — someone may have rejoined without a fresh
        // membership event reaching us (e.g. missed gateway event).
        if (countHumanMembers(q.voiceChannel) === 0) {
          log(`[Music] Alone in VC for ${guildId} past grace — disconnecting`);
          deleteQueue(guildId);
        }
      }, graceMs);
      if (typeof queue._aloneDisconnectTimer?.unref === "function") queue._aloneDisconnectTimer.unref();
      log(`[Music] Bot alone in VC for ${guildId} — paused, disconnecting in ${graceMs}ms`);
    }
    return { action: "alone", scheduledDisconnect: true };
  }

  // Someone is here — cancel any pending disconnect and resume if we paused.
  let resumed = false;
  if (queue._aloneDisconnectTimer) {
    clearTimeout(queue._aloneDisconnectTimer);
    queue._aloneDisconnectTimer = null;
  }
  if (queue._pausedForEmpty) {
    queue._pausedForEmpty = false;
    if (queue.player && queue.player.paused) {
      resumed = safeDiscordSync(`music.resumeOccupiedVc guild=${guildId}`, () => queue.player.setPaused(false));
    }
    log(`[Music] Member rejoined VC for ${guildId} — resumed playback`);
  }
  return { action: "occupied", resumed };
}

// ─── Now Playing Control Panel ──────────────────────────────────────────────

function buildNowPlayingPanel(queue) {
  const song = queue.songs[0];
  if (!song) return null;

  // Build up-next queue preview
  const upcoming = queue.songs.slice(1, 6);
  let queueText = "";
  if (upcoming.length > 0) {
    const lines = upcoming.map((s, i) => `\`${i + 1}.\` [${s.title}](${s.url}) — \`${s.duration || "?"}\``);
    const remaining = queue.songs.length - 1 - upcoming.length;
    if (remaining > 0) lines.push(`*...and ${remaining} more*`);
    queueText = lines.join("\n");
  }

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setAuthor({ name: "Now Playing 🎶" })
    .setTitle(song.title || "Unknown Track")
    .setURL(song.url || null)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: "Duration", value: `\`${song.duration || "Live"}\``, inline: true },
      { name: "Requested by", value: song.requestedBy || "Unknown", inline: true },
      { name: "Volume", value: `\`${queue.volume}%\``, inline: true },
    );

  if (queueText) {
    if (queueText.length > 1000) queueText = queueText.slice(0, 997) + "...";
    embed.addFields({ name: `Up Next (${queue.songs.length - 1})`, value: queueText, inline: false });
  }

  const statusParts = [];
  if (queue.looping)      statusParts.push("🔂 Loop Song");
  if (queue.loopingQueue) statusParts.push("🔁 Loop Queue");
  if (queue.shuffle)      statusParts.push("🔀 Shuffle");
  embed.setFooter({ text: statusParts.length ? statusParts.join(" | ") : "No loop or shuffle active" });

  const gid = queue.guildId;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:pause:${gid}`).setEmoji("⏯").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:skip:${gid}`).setEmoji("⏭").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`music:stop:${gid}`).setEmoji("⏹").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`music:loop:${gid}`).setEmoji("🔂").setStyle(queue.looping || queue.loopingQueue ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:shuffle:${gid}`).setEmoji("🔀").setStyle(queue.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function sendNowPlayingPanel(queue) {
  // Delete old panel
  if (queue.nowPlayingMsg) {
    await safeDiscordAction(`music.sendNowPlaying.deleteOld guild=${queue.guildId}`, () => queue.nowPlayingMsg.delete());
  }
  queue.nowPlayingMsg = null;

  const panel = buildNowPlayingPanel(queue);
  if (!panel) return;

  // Send to the voice channel's built-in text chat if available,
  // otherwise fall back to the text channel where the command was used
  const vc = queue.voiceChannel;
  const targetChannel = vc?.type === ChannelType.GuildVoice // VC has its own chat since Discord update
    ? vc
    : queue.textChannel;

  if (!targetChannel) return;

  try {
    queue.nowPlayingMsg = await targetChannel.send(panel);
  } catch (error) {
    log(`[Music] Failed to send now-playing panel to primary channel in ${queue.guildId}: ${error?.message || error}`);
    // If VC chat fails (permissions), fall back to text channel
    if (targetChannel !== queue.textChannel && queue.textChannel) {
      try {
        queue.nowPlayingMsg = await queue.textChannel.send(panel);
      } catch (err) {
        log(`[Music] Failed to send now-playing panel fallback in ${queue.guildId}: ${err?.message || err}`);
      }
    }
  }
}

// Export for button handler to update the panel
export { buildNowPlayingPanel, sendNowPlayingPanel };

export async function connectToChannel(queue) {
  if (!shoukaku) throw new Error("Music system not initialized — Lavalink not connected");

  const node = shoukaku.options?.nodeResolver?.(shoukaku.nodes) ?? shoukaku.nodes.values().next().value;
  if (!node) throw new Error("No Lavalink nodes available");

  const player = await shoukaku.joinVoiceChannel({
    guildId: queue.guildId,
    channelId: queue.voiceChannel.id,
    shardId: 0,
    deaf: true, // self-deafen for privacy
  });

  // Strip any listeners from prior connect attempts on this player.
  // The "closed" handler re-enters connectToChannel, and Shoukaku's
  // joinVoiceChannel may return the same Player instance — without this
  // we'd accumulate listeners and fire handleTrackEnd N times per end
  // event, which silently skips N-1 songs ahead of schedule.
  safeDiscordSync(`music.connect.removeListeners guild=${queue.guildId}`, () => player.removeAllListeners());

  queue.player = player;

  // ── Wire up track-end events for auto-advance ────────────────────────
  player.on("end", (data) => {
    if (!isQueueLive(queue)) return;
    // If replaced (e.g. skip), don't auto-advance — the skip already handles it
    if (data.reason === "replaced") return;
    log(`[Music] Track ended in ${queue.guildId}: reason=${data.reason}`);
    handleTrackEnd(queue);
  });

  // Track exceptions — Lavalink reports errors like YouTube 403, age-
  // restricted video, deleted video, or stream closed mid-playback as
  // "exception" events. Without this handler the queue gets stuck on
  // the failed track forever (no "end" event is emitted).
  player.on("exception", (data) => {
    if (!isQueueLive(queue)) return;
    const msg = data?.exception?.message || data?.message || "unknown";
    log(`[Music] Track exception in ${queue.guildId}: ${msg} — advancing queue`);
    handleTrackEnd(queue);
  });

  // Track stuck — once Lavalink fires "stuck" the source (usually YouTube)
  // has already stopped delivering audio frames for its own threshold window;
  // waiting longer here only lengthens the silent gap users hear. 3s gives
  // any in-flight buffer time to flush without dragging out the pause.
  player.on("stuck", () => {
    if (!isQueueLive(queue)) return;
    log(`[Music] Track stuck in ${queue.guildId} — waiting 3s before skipping`);
    if (queue._stuckTimeout) return; // already waiting
    queue._stuckTimeout = setTimeout(() => {
      queue._stuckTimeout = null;
      if (isQueueLive(queue) && queue.playing) {
        log(`[Music] Track still stuck after 3s — skipping`);
        handleTrackEnd(queue);
      }
    }, 3_000);
  });

  player.on("closed", (data) => {
    log(`[Music] Voice connection closed in ${queue.guildId}: code=${data.code}`);
    // Only truly fatal: 4014 = channel deleted/kicked
    if (data.code === 4014) {
      deleteQueue(queue.guildId);
      return;
    }
    // Everything else (1000 normal close, 4006 session invalid, 4001, 4003,
    // 4009, 4015) is recoverable — Discord rotates voice sessions regularly,
    // including via plain 1000 closes on voice-server migrations. Attempt to
    // rejoin and resume from current position.
    if (queue.voiceChannel && queue.songs.length > 0) {
      log(`[Music] Attempting voice reconnect in ${queue.guildId} after close code ${data.code}`);
      const currentPos = queue.player?.position || 0;
      if (queue.songs[0] && currentPos > 0) queue.songs[0].resumePos = currentPos;

      // Critical: free Shoukaku's internal connection slot before rejoining.
      // The "closed" event signals the voice WebSocket dropped, but Shoukaku
      // still has the guild in its connections Map — joinVoiceChannel on the
      // next tick would throw "This guild already have an existing connection".
      // Tear it down here so the rejoin gets a fresh slot.
      if (shoukaku?.leaveVoiceChannel) {
        void safeDiscordAction(`music.reconnect.leaveVoice guild=${queue.guildId}`, () => shoukaku.leaveVoiceChannel(queue.guildId));
      }

      setTimeout(async () => {
        try {
          // Bail if the queue was torn down or replaced while we waited — a
          // stale reconnect would otherwise re-attach a player and replay songs
          // onto a guild that already stopped (or restarted) music.
          if (!isQueueLive(queue)) return;
          await connectToChannel(queue);
          if (queue.songs.length) await playSong(queue);
          log(`[Music] Reconnected successfully in ${queue.guildId}`);
        } catch (e) {
          log(`[Music] Reconnect failed in ${queue.guildId}: ${e.message} — giving up`);
          deleteQueue(queue.guildId);
        }
      }, 3000);
    }
  });

  return player;
}

function handleTrackEnd(queue) {
  // Defense-in-depth: never mutate a torn-down/replaced queue. Callers already
  // gate on isQueueLive, but a late event racing deleteQueue could still reach
  // here — bail before shifting songs or re-entering playSong on a dead queue.
  if (!isQueueLive(queue)) return;

  // Clear any pending stuck-timeout so it doesn't fire later and skip the
  // NEXT track. Without this, if a track briefly got stuck but then ended
  // normally, the 10s delayed timeout would wake up, see queue.playing is
  // true (next song playing), and call handleTrackEnd again — truncating
  // the next song.
  if (queue._stuckTimeout) {
    clearTimeout(queue._stuckTimeout);
    queue._stuckTimeout = null;
  }

  // Karaoke hook — notify lyric engine track ended (fire-and-forget)
  if (hasSession(queue.guildId)) {
    onTrackEnd(queue.textChannel?.client, queue.guildId).catch(() => {});
  }

  // TTS messages are always one-shot — remove immediately, never loop
  if (queue.songs[0]?.isTTS) {
    queue.songs.shift();
    queue.songStartedAt = null;
    if (queue.songs.length > 0) {
      playSong(queue).catch((e) => log(`[Music] Auto-advance after TTS: ${e.message}`));
    } else {
      queue.playing = false;
      queue._autoLeaveTimer = setTimeout(() => {
        const q = queues.get(queue.guildId);
        if (q && !q.playing && q.songs.length === 0) deleteQueue(queue.guildId);
      }, 120_000);
    }
    return;
  }

  // Check if this is a skip — bypass loop for this one track end
  const wasSkipped = queue._skipOnce === true;
  queue._skipOnce = false;

  // Single-track loop (only if not skipped)
  if (!wasSkipped && queue.looping && queue.songs.length > 0) {
    playSong(queue).catch((e) => log(`[Music] Loop error: ${e.message}`));
    return;
  }

  const finished = queue.songs.shift();
  queue.songStartedAt = null;

  // Queue loop — push finished song back to end
  if (queue.loopingQueue && finished) queue.songs.push(finished);

  // Shuffle toggle is now fully handled by UI button clicks instantly reshaping the array.

  if (queue.songs.length > 0) {
    playSong(queue).catch((e) => log(`[Music] Auto-advance error: ${e.message}`));
  } else {
    queue.playing = false;
    // Auto-leave after 2 minutes of silence
    queue._autoLeaveTimer = setTimeout(() => {
      const q = queues.get(queue.guildId);
      if (q && !q.playing && q.songs.length === 0) deleteQueue(queue.guildId);
    }, 120_000);
  }
}

export async function playSong(queue, _retries = 0) {
  return withQueueLock(queue.guildId, async () => {
    // Re-check liveness — the queue may have been deleted (or stopped + replaced
    // by a fresh queue for the same guild) while we waited for the lock. Using
    // isQueueLive instead of a bare queues.has() also rejects a stale reconnect
    // that still holds the old queue object.
    if (!isQueueLive(queue)) return;
    if (!queue.songs.length || !queue.player) return;

    const song = queue.songs[0];
    queue.playing = true;

    try {
      // Resolve the track through Lavalink
      const node = shoukaku.nodes.values().next().value;
      if (!node) { log("[Music] No Lavalink nodes available"); throw new Error("No Lavalink nodes available"); }
      let track;
      if (song.encodedTrack) {
        track = { encoded: song.encodedTrack, info: { title: song.title } };
      } else {
        let identifier = song.lavalinkTrack || song.url;
        if (isHttpUrl(identifier)) {
          identifier = assertAllowedMusicUrl(identifier);
        }
        log(`[Music] Resolving: ${identifier}`);
        const result = await node.rest.resolve(identifier);
        log(`[Music] Resolve result: loadType=${result?.loadType}, hasData=${!!result?.data}`);

        if (result?.loadType === "track" || result?.loadType === "TRACK_LOADED") {
          track = result.data ?? result.tracks?.[0] ?? result;
        } else if (result?.loadType === "playlist" || result?.loadType === "PLAYLIST_LOADED") {
          track = result.data?.tracks?.[0] ?? result.tracks?.[0];
        } else if (result?.loadType === "search" || result?.loadType === "SEARCH_RESULT") {
          track = result.data?.[0] ?? result.tracks?.[0];
        } else if (result?.loadType === "empty" || result?.loadType === "NO_MATCHES" || result?.loadType === "error" || result?.loadType === "LOAD_FAILED") {
          // Retry with a shorter/simpler search query if the original was a ytsearch
          if (identifier.startsWith("ytsearch:")) {
            const shortQuery = identifier.replace("ytsearch:", "").split(/[-,|(]/).slice(0, 2).join(" ").trim().slice(0, 60);
            log(`[Music] Retrying with shorter query: ytsearch:${shortQuery}`);
            const retry = await node.rest.resolve(`ytsearch:${shortQuery}`);
            if (retry?.loadType === "search" || retry?.loadType === "SEARCH_RESULT") {
              track = retry.data?.[0] ?? retry.tracks?.[0];
            } else if (retry?.loadType === "track" || retry?.loadType === "TRACK_LOADED") {
              track = retry.data ?? retry.tracks?.[0];
            }
          }
          if (!track) {
            const errMsg = result?.data?.message || result?.exception?.message || "no results";
            log(`[Music] Lavalink error/empty: ${errMsg}`);
            throw new Error(`Lavalink: ${errMsg}`);
          }
        }

        if (!track) {
          throw new Error("Could not resolve track from Lavalink");
        }
      }

      log(`[Music] Playing track: ${track.info?.title} (encoded: ${track.encoded?.slice(0, 30)}...)`);
      const playOpts = { track: { encoded: track.encoded } };
      if (song.resumePos) playOpts.options = { startTime: Math.floor(song.resumePos) };
      await queue.player.playTrack(playOpts);
      
      queue.player.setGlobalVolume(queue.volume);
      queue.songStartedAt = song.resumePos ? Date.now() - Math.floor(song.resumePos) : Date.now();
      delete song.resumePos;

      log(`[Music] ✓ Now playing: ${song.title}`);

      // Karaoke hook — notify lyric engine of new track (fire-and-forget)
      if (hasSession(queue.guildId)) {
        const { title, artist } = extractSongInfo(song);
        onTrackStart(queue.textChannel?.client, queue.guildId, title, artist).catch(() => {});
      }

      // Send the now-playing control panel (skip for TTS messages)
      if (!song.isTTS) await sendNowPlayingPanel(queue);
    } catch (error) {
      log(`[Music] ✗ Failed to play "${song.title}": ${error.message}`);
      queue.songs.shift();
      queue.songStartedAt = null;
      // Skip failed songs but DON'T accumulate retries across different songs.
      // Old behavior: 3 consecutive failures = give up entirely.
      // New behavior: skip the failed song, try the next one fresh. Only give up
      // if we've skipped 10+ songs in a row (entire queue is likely broken).
      if (queue.songs.length > 0 && _retries < 10) {
        log(`[Music] Skipping to next song (${_retries + 1} consecutive failures)`);
        return playSong(queue, _retries + 1);
      } else {
        queue.playing = false;
        if (_retries >= 10) log(`[Music] 10+ consecutive failures in ${queue.guildId} — stopping`);
        throw error;
      }
    }
  });
}

// ─── Search Functions ───────────────────────────────────────────────────────

import getPreview from "spotify-url-info";
import fetch from "node-fetch";
import { safeFetch } from "@defnotean/shared/safeFetch";
const spotifyExt = /** @type {any} */ (getPreview)(fetch);

const ALLOWED_MUSIC_HOSTS = [
  "spotify.com",
  "youtube.com",
  "youtu.be",
  "soundcloud.com",
  "on.soundcloud.com",
];

function hostMatches(host, allowedHost) {
  if (host === allowedHost) return true;
  if (allowedHost === "youtu.be" || allowedHost === "on.soundcloud.com") return false;
  return host.endsWith(`.${allowedHost}`);
}

function parseHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || "").trim()); }
  catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

function isHttpUrl(rawUrl) {
  return !!parseHttpUrl(rawUrl);
}

export function parseAllowedMusicUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_MUSIC_HOSTS.some((allowed) => hostMatches(host, allowed)) ? parsed : null;
}

export function isAllowedMusicUrl(rawUrl) {
  return !!parseAllowedMusicUrl(rawUrl);
}

export function assertAllowedMusicUrl(rawUrl) {
  const parsed = parseAllowedMusicUrl(rawUrl);
  if (!parsed) {
    throw new Error("Only YouTube, Spotify, and SoundCloud URLs are allowed for music playback.");
  }
  return normalizeMusicUrlForResolve(parsed);
}

function normalizeMusicUrlForResolve(parsedUrl) {
  const normalized = new URL(parsedUrl.toString());
  normalized.hash = "";
  if (isSpotifyHost(normalized.toString())) {
    normalized.search = "";
  }
  return normalized.toString();
}

function isSpotifyHost(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return hostMatches(host, "spotify.com");
}

export { isSpotifyHost };

export async function searchPlaylist(query) {
  if (!shoukaku) return null;

  try {
    const node = shoukaku.nodes.values().next().value;
    if (!node) { log("[Music] No Lavalink nodes available"); return null; }

    const parsedMusicUrl = parseAllowedMusicUrl(query);
    if (!parsedMusicUrl) {
      if (isHttpUrl(query)) log(`[Music] Rejected playlist URL from untrusted host: ${query}`);
      return null;
    }

    const isSpotifyUrl = isSpotifyHost(parsedMusicUrl.toString());
    const isYouTubePlaylist = hostMatches(parsedMusicUrl.hostname.toLowerCase(), "youtube.com")
      && (parsedMusicUrl.pathname === "/playlist" || parsedMusicUrl.searchParams.has("list"));
    const isSoundCloudUrl = hostMatches(parsedMusicUrl.hostname.toLowerCase(), "soundcloud.com")
      || hostMatches(parsedMusicUrl.hostname.toLowerCase(), "on.soundcloud.com");
    if (!isSpotifyUrl && !isYouTubePlaylist && !isSoundCloudUrl) {
      return null;
    }

    const resolveQuery = normalizeMusicUrlForResolve(parsedMusicUrl);
    const result = await node.rest.resolve(resolveQuery);

    // Spotify Fallback check
    if ((result?.loadType === "empty" || result?.loadType === "NO_MATCHES" || result?.loadType === "error" || result?.loadType === "LOAD_FAILED" || !result) && isSpotifyUrl) {
      try {
        const tracksRaw = await spotifyExt.getTracks(resolveQuery);
        if (tracksRaw && tracksRaw.length > 0) {
          log(`[Music] Spotify Playlist fallback: fetched ${tracksRaw.length} tracks manually`);
          const tracks = tracksRaw.slice(0, PLAYLIST_LIMIT).map(t => ({
            title: `${t.name} - ${t.artist}`,
            url: resolveQuery,
            duration: formatDuration(Math.floor((t.duration || 0) / 1000)),
            thumbnail: t.previewUrl || null,
            lavalinkTrack: `ytsearch:${t.name.slice(0, 80)} ${t.artist.split(",")[0]} audio`,
          }));
          const preview = await spotifyExt.getData(resolveQuery);
          return { tracks, name: preview?.name || "Spotify Playlist" };
        }
      } catch (err) {
        log(`[Music] Spotify playlist fallback failed: ${err.message}`);
      }
      return null;
    }

    if (result?.loadType !== "playlist" && result?.loadType !== "PLAYLIST_LOADED") return null;

    const tracks = (result?.data?.tracks ?? result?.tracks ?? []).slice(0, PLAYLIST_LIMIT).map((t) => ({
      title: t.info.title ?? "Unknown",
      artist: t.info.author ?? "Unknown",
      url: t.info.uri ?? query,
      duration: formatDuration(t.info.length / 1000),
      durationMs: t.info.length ?? 0,
      thumbnail: t.info.artworkUrl ?? null,
      lavalinkTrack: t.info.uri ?? t.track,
    }));

    return { tracks, name: result?.data?.info?.name ?? result?.playlistInfo?.name ?? "Playlist" };
  } catch (error) {
    log(`[Music] searchPlaylist error: ${error.message}`);
    return null;
  }
}

export async function searchSong(query) {
  if (!shoukaku) return null;

  try {
    const node = shoukaku.nodes.values().next().value;
    if (!node) { log("[Music] No Lavalink nodes available"); return null; }

    let resolveQuery = String(query || "").trim();
    const parsedMusicUrl = parseAllowedMusicUrl(resolveQuery);
    if (isHttpUrl(resolveQuery)) {
      if (!parsedMusicUrl) {
        log(`[Music] Rejected track URL from untrusted host: ${resolveQuery}`);
        return null;
      }
      resolveQuery = normalizeMusicUrlForResolve(parsedMusicUrl);
    }

    // If it's a URL, resolve directly. Otherwise prefix with ytsearch:
    const searchQuery = parsedMusicUrl
      ? resolveQuery
      : `ytsearch:${resolveQuery}`;

    let result = await node.rest.resolve(searchQuery);

    // Spotify Fallback: If Lavalink lacks LavaSrc and rejects the URL, scrape Spotify and search YouTube.
    // Validate the host properly (parsed hostname must be a real *.spotify.com)
    // and route through safeFetch — a raw substring check on the URL is
    // bypassable (evil.com/spotify.com) and the raw fetch was a clean SSRF.
    if ((result?.loadType === "empty" || result?.loadType === "NO_MATCHES" || result?.loadType === "error" || result?.loadType === "LOAD_FAILED" || !result) && isSpotifyHost(resolveQuery)) {
      try {
        const res = await safeFetch(resolveQuery);
        const html = res.text || "";
        const match = html.match(/<title>(.*?)<\/title>/);
        if (match) {
          let title = match[1].replace(/ \| Spotify/gi, "").trim();
          title = title.replace(/- song and lyrics by/gi, "").replace(/- single by/gi, "").replace(/- song by/gi, "").replace(/- playlist by/gi, "").trim();
          log(`[Music] Spotify fallback: fetching YouTube for "${title}" instead`);
          result = await node.rest.resolve(`ytsearch:${title} audio`);
        }
      } catch (err) {
        log(`[Music] Spotify fallback failed: ${err.message}`);
      }
    }

    let track;
    if (result?.loadType === "track" || result?.loadType === "TRACK_LOADED") {
      track = result.data ?? result.tracks?.[0] ?? result;
    } else if (result?.loadType === "playlist" || result?.loadType === "PLAYLIST_LOADED") {
      track = result?.data?.tracks?.[0] ?? result?.tracks?.[0];
    } else if (result?.loadType === "search" || result?.loadType === "SEARCH_RESULT") {
      track = result?.data?.[0] ?? result?.tracks?.[0];
    }

    if (!track) return null;

    return {
      title: track.info.title ?? "Unknown",
      artist: track.info.author ?? "Unknown",
      url: track.info.uri ?? query,
      duration: formatDuration(track.info.length / 1000),
      durationMs: track.info.length ?? 0,
      thumbnail: track.info.artworkUrl ?? null,
      lavalinkTrack: track.info.uri,
    };
  } catch (error) {
    log(`[Music] Search error for "${query}": ${error.message}`);
    return null;
  }
}

// ─── Queue Persistence — save before shutdown, restore on startup ───────────

/**
 * Save all active queues to the database (called on SIGTERM/SIGINT).
 * Only saves serializable data — no player/connection/message refs.
 */
export function saveAllQueues() {
  let saved = 0;
  for (const [guildId, queue] of queues) {
    if (!queue.songs.length) continue;
    // Only save songs that aren't TTS. Include current position so the
    // first song resumes where it left off instead of restarting.
    const currentPos = queue.player?.position || 0;
    const songs = queue.songs.filter((s) => !s.isTTS).map((s, i) => ({
      title: s.title, artist: s.artist, url: s.url, duration: s.duration,
      thumbnail: s.thumbnail, lavalinkTrack: s.lavalinkTrack,
      requestedBy: s.requestedBy,
      ...(i === 0 && currentPos > 2000 ? { resumePos: currentPos } : {}),
    }));
    if (!songs.length) continue;
    dbSaveQueue(guildId, {
      voiceChannelId: queue.voiceChannel?.id,
      textChannelId: queue.textChannel?.id,
      songs,
      volume: queue.volume,
      looping: queue.looping,
      loopingQueue: queue.loopingQueue,
      shuffle: queue.shuffle,
    });
    saved++;
  }
  log(`[Music] Saved ${saved} queue(s) to database`);
}

/**
 * Restore saved queues after bot restart.
 * Rejoins VCs and starts playing from the next song.
 * @param {import("discord.js").Client} client - Discord.js client
 */
export async function restoreQueues(client) {
  const saved = getSavedQueues();
  const entries = Object.entries(saved);
  if (!entries.length) return;

  log(`[Music] Restoring ${entries.length} saved queue(s)...`);
  clearAllSavedQueues(); // Clear immediately so we don't restore twice

  for (const [guildId, queueData] of entries) {
    // Skip if saved more than 10 minutes ago (stale — deploy should take <5min)
    const ageMin = Math.round((Date.now() - (queueData.savedAt ?? 0)) / 60_000);
    if (ageMin > 10) {
      log(`[Music] Skipping stale queue for ${guildId} (saved ${ageMin}min ago)`);
      continue;
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const vc = guild.channels.cache.get(queueData.voiceChannelId);
      const tc = /** @type {import("discord.js").TextChannel | undefined} */ (guild.channels.cache.get(queueData.textChannelId));
      if (!vc) {
        log(`[Music] Cannot restore queue for ${guildId} — voice channel no longer exists`);
        if (tc) tc.send("⚠️ Your music queue couldn't be restored — the voice channel was deleted while I was restarting.").catch(() => {});
        continue;
      }

      // Create queue and connect
      const queue = createQueue(guildId, vc, tc);
      queue.volume = queueData.volume ?? 80;
      queue.looping = queueData.looping ?? false;
      queue.loopingQueue = queueData.loopingQueue ?? false;
      queue.shuffle = queueData.shuffle ?? false;
      queue.songs = queueData.songs ?? [];

      if (!queue.songs.length) { queues.delete(guildId); continue; }

      await connectToChannel(queue);
      await playSong(queue);

      log(`[Music] ✓ Restored queue for "${guild.name}" — ${queue.songs.length} songs, starting with "${queue.songs[0]?.title}"`);

      // Quiet resume notification — don't spam if it's seamless
      if (tc && ageMin > 2) {
        tc.send(`🔄 resuming with **${queue.songs[0]?.title}** (${queue.songs.length} songs)`).catch(() => {});
      }
    } catch (err) {
      log(`[Music] Failed to restore queue for ${guildId}: ${err.message}`);
      queues.delete(guildId);
    }
  }
}

// ─── Text-to-Speech via Gemini TTS + Lavalink HTTP source ───────────────────
// Uses gemini-2.5-flash-preview-tts for natural-sounding speech.
// Generates audio → stores in HTTP cache → Lavalink plays the URL.

import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import config from "../config.js";
import { ttsAudioCache, addTtsCache } from "../presence.js";
import { getTtsVoice } from "../database.js";
import { elevenLabsTextToSpeech } from "@defnotean/shared/elevenLabs";

// Round-robin Gemini client for TTS
const _ttsClients = config.geminiKeys?.map((k) => new GoogleGenAI({ apiKey: k })) ?? [];
let _ttsKeyIdx = 0;
function getTtsClient() {
  if (!_ttsClients.length) return null;
  return _ttsClients[_ttsKeyIdx++ % _ttsClients.length];
}

function normalizeLocalTtsBackend(value) {
  const backend = String(value || "piper").trim().toLowerCase();
  return backend || "piper";
}

function tmpTtsPath(ext) {
  return `/tmp/irene-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

async function generatePiperTTS(text) {
  const { spawn } = await import("node:child_process");
  const { accessSync, constants, readFileSync, unlinkSync } = await import("node:fs");
  const piperBin = config.local?.piperBin || `${process.env.HOME}/.local/piper/piper/piper`;
  const voicePath = config.local?.piperVoice || `${process.env.HOME}/.local/piper/voice.onnx`;
  accessSync(piperBin, constants.X_OK);
  accessSync(voicePath, constants.R_OK);
  const tmpPath = tmpTtsPath("wav");
  try {
    await new Promise(/** @param {(value?: any) => void} resolve @param {(reason?: any) => void} reject */ (resolve, reject) => {
      const proc = spawn(piperBin, ["--model", voicePath, "--output_file", tmpPath]);
      proc.stderr?.on("data", (c) => log(`[TTS] piper: ${c.toString().trim()}`));
      proc.on("error", reject);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`piper exit ${code}`)));
      proc.stdin.write(text.slice(0, 500));
      proc.stdin.end();
    });
    const audioBuffer = readFileSync(tmpPath);
    log(`[TTS] piper produced ${audioBuffer.length} bytes`);
    return audioBuffer;
  } finally {
    safeDiscordSync(`tts.unlinkTmp path=${tmpPath}`, () => unlinkSync(tmpPath));
  }
}

async function generateExternalLocalTTS(text, voice) {
  const { spawn } = await import("node:child_process");
  const { accessSync, constants, readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
  const command = String(config.local?.ttsCommand || "").trim();
  if (!command) throw new Error("LOCAL_TTS_COMMAND is required when LOCAL_TTS_BACKEND=external");
  accessSync(command, constants.X_OK);

  const textPath = tmpTtsPath("txt");
  const outPath = tmpTtsPath("wav");
  const timeoutMs = Number(config.local?.ttsTimeoutMs) || 120_000;
  try {
    writeFileSync(textPath, text.slice(0, 500), "utf8");
    await new Promise(/** @param {(value?: any) => void} resolve @param {(reason?: any) => void} reject */ (resolve, reject) => {
      const proc = spawn(command, ["--text-file", textPath, "--output-file", outPath, "--voice", String(voice || "")], {
        env: {
          ...process.env,
          IRENE_TTS_TEXT: text.slice(0, 500),
          IRENE_TTS_TEXT_FILE: textPath,
          IRENE_TTS_OUTPUT: outPath,
          IRENE_TTS_VOICE: String(voice || ""),
        },
      });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`external local TTS timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      proc.stderr?.on("data", (c) => log(`[TTS] external: ${c.toString().trim()}`));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`external local TTS exit ${code}`));
      });
    });
    const audioBuffer = readFileSync(outPath);
    log(`[TTS] external local backend produced ${audioBuffer.length} bytes`);
    return audioBuffer;
  } finally {
    safeDiscordSync(`tts.unlinkTmp path=${textPath}`, () => unlinkSync(textPath));
    safeDiscordSync(`tts.unlinkTmp path=${outPath}`, () => unlinkSync(outPath));
  }
}

async function generateLocalTTS(text, voice) {
  const backend = normalizeLocalTtsBackend(config.local?.ttsBackend);
  if (backend === "piper") return generatePiperTTS(text);
  if (backend === "external") return generateExternalLocalTTS(text, voice);
  throw new Error(`unsupported LOCAL_TTS_BACKEND="${backend}"`);
}

function resolveElevenLabsVoiceId(voice) {
  const map = config.elevenLabs?.voiceMap || {};
  const requested = String(voice || "").trim();
  return map[requested]
    || map[requested.toLowerCase?.()]
    || config.elevenLabs?.voiceId;
}

async function generateElevenLabsTTS(text, voice) {
  const voiceId = resolveElevenLabsVoiceId(voice);
  const result = await elevenLabsTextToSpeech({
    apiKey: config.elevenLabs?.apiKey,
    baseUrl: config.elevenLabs?.baseUrl,
    text,
    voiceId,
    modelId: config.elevenLabs?.ttsModel,
    outputFormat: config.elevenLabs?.outputFormat,
    timeoutMs: config.elevenLabs?.timeoutMs,
  });
  log(`[TTS] ElevenLabs produced ${result.buffer.length} bytes voice=${voiceId}`);
  return result;
}

// PCM → WAV header helper (Gemini returns raw PCM 24kHz 16-bit mono)
function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // Apply 50% attenuation on a copy to prevent clipping without mutating the source buffer
  const attenuated = Buffer.alloc(pcmBuffer.length);
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    attenuated.writeInt16LE(Math.floor(pcmBuffer.readInt16LE(i) / 2), i);
  }
  const dataSize = attenuated.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, attenuated]);
}

export async function playTTS(guildId, text, voiceChannel, textChannel) {
  const localTts = !!config.local?.tts;
  const elevenLabsTts = !!config.elevenLabs?.ttsEnabled && !!config.elevenLabs?.apiKey;
  const client = localTts ? null : getTtsClient();
  if (!localTts && !elevenLabsTts && !client) return;

  let queue = getQueue(guildId);
  if (!queue) {
    queue = createQueue(guildId, voiceChannel, textChannel);
    await connectToChannel(queue);
  }

  try {
    const voice = getTtsVoice(guildId);
    log(`[TTS] Generating: "${text.slice(0, 60)}..." voice=${voice}`);

    let audioBuffer;
    let contentType = "audio/wav";

    if (localTts) {
      audioBuffer = await generateLocalTTS(text, voice);
    } else if (elevenLabsTts) {
      try {
        const result = await generateElevenLabsTTS(text.slice(0, 1_000), voice);
        audioBuffer = result.buffer;
        contentType = result.contentType;
      } catch (err) {
        log(`[TTS] ElevenLabs failed: ${err?.message || err} — falling back to Gemini TTS`);
      }
      if (!audioBuffer && !client) return;
    }

    if (!audioBuffer && !localTts) {
      if (!client) return;
      // Use exact format from Google's TTS docs. `client` is guaranteed
      // non-null in this branch (localTts is false → getTtsClient() ran, and
      // the early return above bailed when it produced no client unless
      // ElevenLabs was the primary path).
      const transcript = `Say naturally: ${text.slice(0, 500)}`;

      let response;
      try {
        response = await client.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: transcript }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        });
      } catch (ttsErr) {
        // If TTS model fails, try with simpler prompt format
        log(`[TTS] First attempt failed: ${ttsErr.message} — retrying with simpler prompt`);
        response = await client.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: text.slice(0, 500) }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        });
      }

      // Find the audio part — might not be the first part
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const audioPart = parts.find((p) => p.inlineData?.data);
      if (!audioPart?.inlineData?.data) { log("[TTS] No audio data in response"); return; }

      const mimeType = audioPart.inlineData.mimeType ?? "audio/L16;rate=24000";
      const rawBuffer = Buffer.from(audioPart.inlineData.data, "base64");
      log(`[TTS] Got ${rawBuffer.length} bytes, mime=${mimeType}`);

      if (mimeType.includes("wav") || mimeType.includes("wave") || rawBuffer.toString("utf8", 0, 4) === "RIFF") {
        audioBuffer = rawBuffer;
        contentType = "audio/wav";
      } else if (mimeType.includes("L16") || mimeType.includes("pcm") || mimeType.includes("raw")) {
        // Raw PCM — wrap in WAV header so Lavalink can decode it
        const rateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
        audioBuffer = pcmToWav(rawBuffer, sampleRate);
        contentType = "audio/wav";
      } else {
        // MP3, OGG, etc — Lavalink handles natively
        audioBuffer = rawBuffer;
        contentType = mimeType.startsWith("audio/") ? mimeType : "audio/mpeg";
      }
    }

    // Store in HTTP cache (addTtsCache handles eviction + TTL)
    const id = randomUUID();
    addTtsCache(id, { buffer: audioBuffer, contentType });

    const selfUrl = process.env.EXTERNAL_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${config.port}`;
    const ttsUrl = `${selfUrl}/tts/${id}`;

    // Resolve through Lavalink
    const node = shoukaku.nodes.values().next().value;
    if (!node) { log("[Music] No Lavalink nodes available"); return; }
    const result = await node.rest.resolve(ttsUrl);

    let track;
    if (result?.loadType === "track") track = result.data;
    else if (result?.loadType === "search") track = result.data?.[0];
    if (!track) { log(`[TTS] Lavalink resolve failed: loadType=${result?.loadType}`); return; }

    const ttsSong = {
      title: "TTS",
      url: ttsUrl,
      duration: "TTS",
      thumbnail: null,
      lavalinkTrack: ttsUrl,
      requestedBy: "TTS",
      isTTS: true,
      encodedTrack: track.encoded,
    };

    if (!track?.encoded) { log("[TTS] No track to play"); return; }

    if (!queue.playing || !queue.songs.length) {
      // Nothing playing — just play TTS directly
      queue.songs.unshift(ttsSong);
      await playSong(queue);
    } else {
      const isPlayingMusic = !queue.songs[0].isTTS;

      // Find the first non-TTS index to inject the new TTS track
      let insertIdx = 0;
      while (insertIdx < queue.songs.length && queue.songs[insertIdx].isTTS) {
        insertIdx++;
      }

      if (isPlayingMusic && insertIdx === 0) {
        // We are directly interrupting a MUSIC track right now! Save its playback position.
        queue.songs[0].resumePos = queue.player.position;
      }

      // Inject the TTS track at the end of the current TTS block
      queue.songs.splice(insertIdx, 0, ttsSong);

      if (isPlayingMusic && insertIdx === 0) {
        // We literally just interrupted music, so play this new TTS immediately.
        await queue.player.playTrack({ track: { encoded: track.encoded } });
        queue.player.setGlobalVolume(queue.volume);
      }
      // If insertIdx > 0, a TTS is already playing, so Lavalink will auto-advance to this one!
    }
    log("[TTS] ✓ Queued/Playing");
  } catch (err) {
    log(`[TTS] Error: ${err.message}`);
    throw err;
  }
}

export async function playSoundEffect(guildId, url, voiceChannel) {
  const resolveUrl = assertAllowedMusicUrl(url);

  let queue = getQueue(guildId);
  if (!queue) {
    queue = createQueue(guildId, voiceChannel, null);
    await connectToChannel(queue);
  }

  const node = shoukaku.nodes.values().next().value;
  if (!node) throw new Error("No Lavalink nodes available");

  const result = await node.rest.resolve(resolveUrl);
  let track;
  if (result?.loadType === "track") track = result.data;
  else if (result?.loadType === "search") track = result.data?.[0];

  if (!track || !track.encoded) {
    log(`[Soundboard] Lavalink couldn't resolve ${url} — skipping playback`);
    throw new Error("Could not resolve sound effect URL through Lavalink");
  }

  const sfxSong = {
    title: "Sound Effect",
    url: resolveUrl,
    duration: "SFX",
    thumbnail: null,
    lavalinkTrack: resolveUrl,
    requestedBy: "Soundboard",
    isTTS: true, // Acts exactly like a TTS priority skip
    encodedTrack: track.encoded,
  };

  if (!queue.playing || !queue.songs.length) {
    queue.songs.unshift(sfxSong);
    await playSong(queue);
  } else {
    // Inject natively just below ongoing interruptions
    let insertIdx = 0;
    while (insertIdx < queue.songs.length && queue.songs[insertIdx].isTTS) {
      insertIdx++;
    }

    if (!queue.songs[0].isTTS && queue.player && !queue.player.paused) {
      queue.player.setPaused(true);
      setTimeout(() => { if (queue.player) queue.player.stopTrack(); }, 200);
    }
    queue.songs.splice(insertIdx, 0, sfxSong);
  }
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "Unknown";
  const s = Math.floor(seconds);
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, "0");
    return `${m}:${sec}`;
  }
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}
