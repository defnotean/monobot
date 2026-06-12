// ─── Music Executor ─────────────────────────────────────────────────────────
//
// Lavalink-backed music playback, queue management, filters, and the
// nickname-synced lyrics ("karaoke") mode. All player state lives in
// music/player.js keyed by guild id.

const HANDLED = new Set([
  "play_music", "skip_song", "stop_music", "pause_music", "resume_music",
  "music_queue", "now_playing", "set_volume", "toggle_loop", "shuffle_queue",
  "music_filter", "start_lyrics_mode", "stop_lyrics_mode", "auto_lyrics_mode",
]);

// Playback-control tools that mirror the DJ-protected slash commands
// (/skip /stop /pause /resume /volume /loop /shuffle). The AI path enforces
// the same DJ + same-VC gate as the slash commands and panel buttons so the
// LLM cannot be used to bypass the documented DJ model.
const DJ_GATED = new Set([
  "skip_song", "stop_music", "pause_music", "resume_music",
  "set_volume", "toggle_loop", "shuffle_queue",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  if (DJ_GATED.has(toolName)) {
    const { checkDjAndSameVc } = await import("../../utils/musicGuard.js");
    const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
    const denial = checkDjAndSameVc(member, guild);
    if (denial) return denial.text;
  }

  switch (toolName) {
    case "play_music": {
      const { getQueue, createQueue, connectToChannel, playSong, searchSong, searchPlaylist } = await import("../../music/player.js");
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      const vc = member?.voice?.channel;
      if (!vc) return "you need to be in a voice channel first so i know where to join";

      const query = input.query;

      try {
        const playlist = await searchPlaylist(query);
        if (playlist && playlist.tracks.length) {
          let queue = getQueue(guild.id);
          if (!queue) {
            queue = createQueue(guild.id, vc, message.channel);
            await connectToChannel(queue);
          }
          const wasEmpty = queue.songs.length === 0;
          for (const track of playlist.tracks) {
            track.requestedBy = message.author.toString();
            queue.songs.push(track);
          }
          if (wasEmpty) await playSong(queue);
          return `queued **${playlist.tracks.length}** tracks from **${playlist.name}** — ${wasEmpty ? "playing now" : "added to queue"}`;
        }

        const song = await searchSong(query);
        if (!song) return `couldn't find anything for "${query}"`;

        let queue = getQueue(guild.id);
        if (!queue) {
        queue = createQueue(guild.id, vc, message.channel);
        await connectToChannel(queue);
      }
        song.requestedBy = message.author.toString();
        queue.songs.push(song);
        if (queue.songs.length === 1) {
          await playSong(queue);
          return `now playing **${song.title}** (${song.duration || "?"})`;
        }
        return `added **${song.title}** to the queue at position #${queue.songs.length}`;
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes("429")) return "YouTube is rate-limiting us right now — try again in a minute or try a different song";
        if (msg.includes("confirm your age") || msg.includes("Sign in")) return "that video is age-restricted and can't be played";
        return `couldn't play that — ${msg}`;
      }
    }

    case "skip_song": {
      const { getQueue, playSong } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "nothing is playing right now";
      const skipped = queue.songs[0].title;
      queue._skipOnce = true;
      queue.player.stopTrack();
      return `skipped **${skipped}**`;
    }

    case "stop_music": {
      const { deleteQueue } = await import("../../music/player.js");
      deleteQueue(guild.id);
      return "stopped the music and left the voice channel";
    }

    case "pause_music": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.playing) return "nothing is playing";
      queue.player.setPaused(true);
      return "paused ⏸";
    }

    case "resume_music": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing to resume";
      queue.player.setPaused(false);
      return "resumed ▶";
    }

    case "music_queue": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "the queue is empty";
      const lines = queue.songs.slice(0, 15).map((s, i) =>
        `${i === 0 ? "▶" : `${i}.`} **${s.title}** (${s.duration || "?"})${i === 0 ? " — now playing" : ""}`
      );
      const extra = queue.songs.length > 15 ? `\n...and ${queue.songs.length - 15} more` : "";
      return lines.join("\n") + extra;
    }

    case "now_playing": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.songs.length) return "nothing is playing right now";
      const s = queue.songs[0];
      const elapsed = queue.songStartedAt ? Math.floor((Date.now() - queue.songStartedAt) / 1000) : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = String(elapsed % 60).padStart(2, "0");
      return `now playing **${s.title}** (${mins}:${secs} / ${s.duration || "?"})${queue.looping ? " 🔂 loop" : ""}${queue.loopingQueue ? " 🔁 queue loop" : ""}`;
    }

    case "set_volume": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
      // Guard NaN — the model occasionally omits volume entirely or sends a
      // non-numeric string. Math.floor(undefined) = NaN, which then propagates
      // into setGlobalVolume(NaN) and throws inside Lavalink. Validate first.
      const raw = Number(input.volume);
      if (!Number.isFinite(raw)) return "give me a volume between 0 and 100";
      const vol = Math.min(Math.max(Math.floor(raw), 0), 100);
      queue.volume = vol;
      if (queue.player) queue.player.setGlobalVolume(vol);
      return `volume set to **${vol}%**`;
    }

    case "toggle_loop": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
      if (input.mode === "song") { queue.looping = true; queue.loopingQueue = false; return "looping current song 🔂"; }
      if (input.mode === "queue") { queue.looping = false; queue.loopingQueue = true; return "looping entire queue 🔁"; }
      queue.looping = false; queue.loopingQueue = false; return "looping disabled";
    }

    case "shuffle_queue": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue) return "nothing is playing";
      queue.shuffle = !queue.shuffle;
      if (queue.shuffle && queue.songs.length > 2) {
        const current = queue.songs[0];
        const rest = queue.songs.slice(1);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        queue.songs = [current, ...rest];
      }
      return queue.shuffle ? "shuffle ON 🔀" : "shuffle OFF";
    }

    case "music_filter": {
      const { getQueue } = await import("../../music/player.js");
      const queue = getQueue(guild.id);
      if (!queue || !queue.player) return "nothing is playing";

      const FILTERS = {
        none:      {},
        bassboost: { equalizer: [{ band: 0, gain: 0.2 }, { band: 1, gain: 0.15 }, { band: 2, gain: 0.1 }] },
        nightcore: { timescale: { speed: 1.3, pitch: 1.2, rate: 1.0 } },
        vaporwave: { timescale: { speed: 0.8, pitch: 0.9, rate: 1.0 } },
        "8d":      { rotation: { rotationHz: 0.17 }, tremolo: { frequency: 0.34, depth: 0.3 }, vibrato: { frequency: 0.17, depth: 0.15 }, lowpass: { smoothing: 20 }, equalizer: [{ band: 0, gain: 0.3 }, { band: 1, gain: 0.2 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.3 }] },
        karaoke:   { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220, filterWidth: 100 } },
        tremolo:   { tremolo: { frequency: 2.0, depth: 0.4 } },
        vibrato:   { vibrato: { frequency: 2.0, depth: 0.4 } },
        lowpass:   { lowPass: { smoothing: 20 } },
      };

      const filterConfig = FILTERS[input.filter];
      if (!filterConfig) return `unknown filter "${input.filter}" — try: ${Object.keys(FILTERS).join(", ")}`;

      await queue.player.setFilters(filterConfig);
      return input.filter === "none" ? "filters cleared ✓" : `**${input.filter}** filter applied 🎵`;
    }

    // ─── Lyrics Mode (nickname displays synced lyrics) ──────────────
    case "start_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { startKaraoke } = await import("../karaoke.js");
      const { getQueue } = await import("../../music/player.js");
      let song = input.song, artist = input.artist;
      const mode = input.mode || "message"; // default to safe message mode
      if (!song) {
        const queue = getQueue(message.guild.id);
        const current = queue?.songs?.[0];
        if (!current) return "nothing is playing — provide a song name or start playing music first";
        artist = artist || current.artist || current.title.split(" - ")[0] || "Unknown";
        song = current.artist ? current.title : (current.title.split(" - ").slice(1).join(" - ") || current.title);
      }
      if (!artist) return "i need an artist name to find the lyrics";
      const r = await startKaraoke(message.client, message.guild.id, {
        trackName: song, artistName: artist, requesterId: message.author.id,
        mode, channelId: message.channel.id,
      });
      return r.ok
        ? `🎤 lyrics mode on (${mode}) — **${r.trackName}** by **${r.artistName}** (${r.lineCount} lines)`
        : `couldn't start lyrics: ${r.reason}`;
    }

    case "stop_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { stopKaraoke } = await import("../karaoke.js");
      const r = await stopKaraoke(message.guild.id, "user requested");
      return r.ok ? "🛑 lyrics mode off, nickname restored" : r.reason;
    }

    case "auto_lyrics_mode": {
      if (!message.guild) return "lyrics mode only works in servers";
      const { enableAutoMode } = await import("../karaoke.js");
      const r = await enableAutoMode(message.client, message.guild.id, message.author.id, {
        mode: input.mode || "message", channelId: message.channel.id,
      });
      return r.ok ? "🎤 auto lyrics mode on — lyrics will follow every track" : r.reason;
    }
  }
}
