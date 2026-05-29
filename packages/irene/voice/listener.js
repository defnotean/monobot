// ─── Voice Listener — Wake-Word Triggered AI Conversations in VC ────────────
// Listens to users in a voice channel. When someone speaks, their audio is
// buffered and sent to Gemini multimodal for transcription. If the transcript
// contains the wake word ("irene" by default), the full utterance is processed
// by the AI and a TTS response is played back.
//
// Architecture:
//   @discordjs/voice  →  per-user Opus stream  →  PCM decode  →  buffer
//   →  silence detection (end of speech)  →  Gemini audio input (STT + AI)
//   →  TTS response via existing music/player.js pipeline

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  getVoiceConnection,
} from "@discordjs/voice";
import { GoogleGenAI } from "@google/genai";
import { Transform } from "stream";
import config from "../config.js";
import { log } from "../utils/logger.js";
import { playTTS } from "../music/player.js";
import * as settingsStore from "../music/settingsStore.js";

// ─── State ──────────────────────────────────────────────────────────────────
// guildId → { connection, channelId, textChannelId, wakeWord, listening: Map<userId, AudioState> }
const listeners = new Map();

// Gemini client pool for STT/multimodal (reuses existing keys)
const _sttClients = config.geminiKeys?.filter(Boolean).map((k) => new GoogleGenAI({ apiKey: k })) ?? [];
let _sttKeyIdx = 0;
function getSttClient() {
  if (!_sttClients.length) return null;
  return _sttClients[_sttKeyIdx++ % _sttClients.length];
}

// Configurable defaults
const DEFAULT_WAKE_WORD = "irene";
const SILENCE_THRESHOLD_MS = 1500;   // How long to wait after speech stops before processing
const MAX_AUDIO_DURATION_MS = 30000; // Max 30 seconds of audio per utterance
const MIN_AUDIO_DURATION_MS = 500;   // Ignore very short audio (clicks, coughs)
const COOLDOWN_MS = 3000;            // Per-user cooldown between responses
// Hard cap on a single voice-listener session. Without this a forgotten
// `/voice listen` (or a Discord voice-gateway hiccup that leaves the listener
// in a half-connected state) can keep the bot occupied indefinitely.
// 60 min is generous for legitimate uses; anything beyond that is essentially
// always a leak.
const MAX_SESSION_MS = 60 * 60 * 1000;
// If no audio packets have arrived for this long the room is effectively
// empty (or the receiver has been silently disconnected). Tear down.
const NO_DATA_TIMEOUT_MS = 10 * 60 * 1000;

// Per-guild settings
const guildSettings = new Map(); // guildId → { wakeWord, enabled }

// ─── STT capability gate ────────────────────────────────────────────────────
// The original wake-word pipeline concatenated raw Opus frames and sent them
// to Gemini as mimeType "audio/ogg". Gemini cannot decode that — raw Opus
// frames are NOT an Ogg container — so every utterance produced "[inaudible]"
// (or a decode error) while still burning a Gemini API call AND holding a
// 60-minute voice connection. /listen reported success but never transcribed.
//
// A correct fix needs to decode Opus → PCM/WAV before sending. prism-media's
// opus.Decoder can do that, but it requires a native binding
// (@discordjs/opus / opusscript / node-opus) — none of which ship by default.
// When no decoder is available we cannot transcribe at all, so we DISABLE the
// feature outright: refuse to open the connection and never make the
// per-utterance Gemini call. This is the safe option — it stops the cost leak
// and the dead connection instead of pretending to listen.
//
// Detect once at module load. If an operator installs a native Opus binding
// the decoder becomes constructible and the gate opens automatically.
let _opusDecoderAvailable = false;
let _prismOpus = null;
try {
  // prism-media is a hard dependency (used elsewhere); the *native binding* it
  // wraps may not be. Construct a throwaway decoder to prove decoding works.
  const prism = (await import("prism-media")).default;
  const probe = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  try { probe.destroy(); } catch { /* cleanup */ }
  _prismOpus = prism.opus;
  _opusDecoderAvailable = true;
} catch (err) {
  _opusDecoderAvailable = false;
  log(`[VoiceListen] Opus decoder unavailable (${err?.message || err}) — /listen is disabled (no native opus binding installed)`);
}

const STT_DISABLED_NOTICE =
  "voice listening is currently **disabled** on this instance — the server is missing a native Opus audio decoder, " +
  "so I can't transcribe what's said in voice. (Ask the host to install `@discordjs/opus` to enable it.)";

/** Whether the wake-word STT pipeline can actually transcribe audio. */
export function isSttAvailable() {
  return _opusDecoderAvailable;
}

// PCM → WAV header helper. Mirrors the one in music/player.js but WITHOUT the
// 50% attenuation that one applies (that's for TTS playback; for STT input we
// want the captured signal intact). Decoded Discord voice is signed 16-bit LE,
// 48kHz stereo by default.
function pcmToWav(pcmBuffer, sampleRate = 48000, numChannels = 2, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

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

  return Buffer.concat([header, pcmBuffer]);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start listening in a voice channel.
 * Creates a @discordjs/voice connection (separate from Shoukaku/Lavalink).
 */
export async function startListening(voiceChannel, textChannel, options = {}) {
  const guildId = voiceChannel.guild.id;

  // Hard gate: if we can't decode Opus we can't transcribe. Refuse to open the
  // connection at all rather than holding a dead 60-min session and burning a
  // Gemini call per utterance for nothing.
  if (!_opusDecoderAvailable) {
    log(`[VoiceListen] Refusing to start in ${guildId} — STT disabled (no Opus decoder)`);
    return { success: false, error: STT_DISABLED_NOTICE };
  }

  // If already listening in this guild, stop first
  if (listeners.has(guildId)) {
    stopListening(guildId);
  }

  const wakeWord = (options.wakeWord || getWakeWord(guildId)).toLowerCase();

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // Must NOT be deafened to receive audio
      selfMute: true,  // Muted — we use Lavalink/TTS for output
    });

    // Wait for connection to be ready
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

    const state = {
      connection,
      channelId: voiceChannel.id,
      textChannelId: textChannel.id,
      guildId,
      wakeWord,
      listening: new Map(), // userId → AudioState
      userCooldowns: new Map(), // userId → timestamp
      startedAt: Date.now(),
      lastAudioAt: Date.now(),
      sessionTimer: null,
      idleTimer: null,
    };

    listeners.set(guildId, state);

    // Hard ceiling — even if everything else is healthy, force-stop the
    // listener after MAX_SESSION_MS so a forgotten session can't accumulate.
    state.sessionTimer = setTimeout(() => {
      if (listeners.get(guildId) === state) {
        log(`[VoiceListen] Max session reached (${MAX_SESSION_MS}ms) — auto-stopping`);
        stopListening(guildId);
      }
    }, MAX_SESSION_MS);
    if (typeof state.sessionTimer?.unref === "function") state.sessionTimer.unref();

    // Idle watcher — recheck periodically; if no audio has arrived in
    // NO_DATA_TIMEOUT_MS, the channel is empty / the receiver is broken.
    state.idleTimer = setInterval(() => {
      if (Date.now() - state.lastAudioAt > NO_DATA_TIMEOUT_MS) {
        log(`[VoiceListen] No audio for ${NO_DATA_TIMEOUT_MS}ms — auto-stopping`);
        stopListening(guildId);
      }
    }, 60_000);
    if (typeof state.idleTimer?.unref === "function") state.idleTimer.unref();

    // Start receiving audio from the connection
    const receiver = connection.receiver;

    // Listen for users starting to speak
    receiver.speaking.on("start", (userId) => {
      state.lastAudioAt = Date.now();
      if (state.listening.has(userId)) return; // Already capturing
      startCapturingUser(state, userId, receiver);
    });

    log(`[VoiceListen] Started listening in ${voiceChannel.name} (${guildId}), wake word: "${wakeWord}"`);
    return { success: true };
  } catch (err) {
    let errMsg = err.message;
    if (errMsg === "The operation was aborted") {
      errMsg = "I cannot start listening while I am actively connected to the channel for Music/Lavalink! Please use `/stop` or stop the music player entirely before starting my Voice Conversation mode.";
    }
    log(`[VoiceListen] Failed to start: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Stop listening in a guild.
 */
export function stopListening(guildId) {
  const state = listeners.get(guildId);
  if (!state) return false;

  // Clean up all user audio states
  for (const [userId, audioState] of state.listening) {
    if (audioState.silenceTimer) clearTimeout(audioState.silenceTimer);
    if (audioState.maxTimer) clearTimeout(audioState.maxTimer);
    if (audioState.stream) { try { audioState.stream.destroy(); } catch { /* cleanup */ } }
    if (audioState.decoder) { try { audioState.decoder.destroy(); } catch { /* cleanup */ } }
  }
  state.listening.clear();

  // Clear session lifetime + idle watchers
  if (state.sessionTimer) { clearTimeout(state.sessionTimer); state.sessionTimer = null; }
  if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }

  // Destroy the voice connection
  try {
    state.connection.destroy();
  } catch { /* cleanup: connection may already be torn down */ }

  listeners.delete(guildId);
  log(`[VoiceListen] Stopped listening in guild ${guildId}`);
  return true;
}

/**
 * Check if currently listening in a guild.
 */
export function isListening(guildId) {
  return listeners.has(guildId);
}

/**
 * Get/set wake word for a guild.
 * Reads prefer the durable settingsStore (survives restart); the local
 * guildSettings Map is kept as a synchronous fallback when the store has no
 * cached value yet (e.g. before loadWakeWord has hydrated it).
 */
export function getWakeWord(guildId) {
  return settingsStore.getWakeWord(guildId)
    || guildSettings.get(guildId)?.wakeWord
    || DEFAULT_WAKE_WORD;
}

export function setWakeWord(guildId, word) {
  const lowered = word.toLowerCase();
  const settings = guildSettings.get(guildId) || {};
  settings.wakeWord = lowered;
  guildSettings.set(guildId, settings);

  // Persist durably (degrades to in-memory if Supabase/table absent)
  settingsStore.setWakeWord(guildId, lowered);

  // Update live listener if active
  const state = listeners.get(guildId);
  if (state) state.wakeWord = lowered;
}

/**
 * Hydrate a guild's durable settings (wake word) from Supabase. Best-effort —
 * callers can fire-and-forget. Safe to call before startListening so the
 * loaded wake word is picked up.
 */
export async function loadWakeWord(guildId) {
  try { await settingsStore.loadGuild(guildId); } catch { /* falls back to in-memory settings */ }
  return getWakeWord(guildId);
}

export function getListenerData() {
  const data = {};
  for (const [guildId, settings] of guildSettings) {
    data[guildId] = settings;
  }
  return data;
}

export function initListenerData(loaded) {
  guildSettings.clear();
  if (loaded && typeof loaded === "object") {
    for (const [guildId, settings] of Object.entries(loaded)) {
      guildSettings.set(guildId, settings);
    }
  }
}

// ─── Per-User Audio Capture ─────────────────────────────────────────────────

function startCapturingUser(state, userId, receiver) {
  // Check cooldown
  const now = Date.now();
  const lastResponse = state.userCooldowns.get(userId) || 0;
  if (now - lastResponse < COOLDOWN_MS) return;

  const pcmChunks = [];
  let totalBytes = 0;
  const startTime = Date.now();

  // Subscribe to this user's raw Opus stream, then decode to PCM via prism.
  // Discord voice is 48kHz stereo, 20ms frames (960 samples/channel). We MUST
  // decode before sending to Gemini — raw Opus frames are not a container any
  // STT model can read. (startListening already refused to run if the decoder
  // is unavailable, so _prismOpus is guaranteed here.)
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_THRESHOLD_MS,
    },
  });

  const decoder = new _prismOpus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const pcmStream = opusStream.pipe(decoder);

  const audioState = {
    stream: opusStream,
    decoder,
    chunks: pcmChunks,
    startTime,
    silenceTimer: null,
    maxTimer: null,
  };

  state.listening.set(userId, audioState);

  // Collect decoded PCM (signed 16-bit LE, 48kHz stereo)
  pcmStream.on("data", (chunk) => {
    pcmChunks.push(chunk);
    totalBytes += chunk.length;
    state.lastAudioAt = Date.now();
  });

  // When the stream ends (after silence threshold), process the audio
  pcmStream.on("end", async () => {
    state.listening.delete(userId);

    const duration = Date.now() - startTime;

    // Ignore very short audio
    if (duration < MIN_AUDIO_DURATION_MS || pcmChunks.length === 0) {
      return;
    }

    // Ignore if over max duration
    if (duration > MAX_AUDIO_DURATION_MS) {
      log(`[VoiceListen] Audio from ${userId} too long (${duration}ms), skipping`);
      return;
    }

    // Wrap decoded PCM in a WAV container Gemini can actually read.
    const pcmBuffer = Buffer.concat(pcmChunks);
    const wavBuffer = pcmToWav(pcmBuffer, 48000, 2, 16);
    log(`[VoiceListen] Captured ${pcmBuffer.length} PCM bytes (${duration}ms) from user ${userId}`);

    // Process with Gemini (or local whisper if LOCAL_STT=1 — frames passed for prism decode)
    try {
      await processAudio(state, userId, wavBuffer, audioChunks);
    } catch (err) {
      log(`[VoiceListen] Error processing audio from ${userId}: ${err.message}`);
    }
  });

  const onStreamError = (err) => {
    log(`[VoiceListen] Stream error for ${userId}: ${err.message}`);
    try { decoder.destroy(); } catch { /* cleanup */ }
    state.listening.delete(userId);
  };
  opusStream.on("error", onStreamError);
  pcmStream.on("error", onStreamError);

  // Safety: force-end after max duration
  audioState.maxTimer = setTimeout(() => {
    if (state.listening.has(userId)) {
      opusStream.destroy();
      try { decoder.destroy(); } catch { /* cleanup */ }
      state.listening.delete(userId);
    }
  }, MAX_AUDIO_DURATION_MS + 1000);
}

// ─── Audio Processing (Gemini multimodal, or local whisper.cpp via WHISPER_BIN) ─

// Decode raw Opus packets (Discord voice) → 16kHz mono PCM WAV via prism-media.
// Needed for local whisper because whisper expects a proper WAV/MP3/etc file.
async function _opusFramesToWav16kMono(opusFrames) {
  const prism = (await import("prism-media")).default;
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  return await new Promise((resolve, reject) => {
    const pcmChunks = [];
    decoder.on("data", (c) => pcmChunks.push(c));
    decoder.on("end", () => {
      const pcm = Buffer.concat(pcmChunks); // 48kHz stereo s16le
      const stereoSamples = pcm.length / 4;
      const monoSamples = Math.floor(stereoSamples / 3); // decimate 48 → 16
      const out = Buffer.alloc(monoSamples * 2);
      for (let i = 0, j = 0; j < monoSamples; i += 12, j++) {
        const l = pcm.readInt16LE(i);
        const r = pcm.readInt16LE(i + 2);
        out.writeInt16LE(Math.round((l + r) / 2), j * 2);
      }
      const dataSize = out.length;
      const hdr = Buffer.alloc(44);
      hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + dataSize, 4); hdr.write("WAVE", 8);
      hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
      hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
      hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
      hdr.write("data", 36); hdr.writeUInt32LE(dataSize, 40);
      resolve(Buffer.concat([hdr, out]));
    });
    decoder.on("error", reject);
    for (const frame of opusFrames) decoder.write(frame);
    decoder.end();
  });
}

async function _whisperTranscribe(opusFrames) {
  const wav = await _opusFramesToWav16kMono(opusFrames);
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const tmpPath = `/tmp/irene-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  writeFileSync(tmpPath, wav);
  return await new Promise((resolve) => {
    const proc = spawn(config.local?.whisperBin || `${process.env.HOME}/.local/whisper-cli`, [tmpPath]);
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => log(`[VoiceListen] whisper-cli: ${c.toString().trim()}`));
    proc.on("close", () => {
      try { unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    proc.on("error", (e) => {
      log(`[VoiceListen] whisper-cli spawn failed: ${e.message}`);
      try { unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
      resolve("");
    });
  });
}

async function processAudio(state, userId, wavBuffer, opusFrames) {
  const localStt = !!config.local?.stt;
  const client = localStt ? null : getSttClient();
  if (!localStt && !client) {
    log("[VoiceListen] No Gemini client available for STT");
    return;
  }

  const wakeWord = state.wakeWord;

  try {
    let transcript = "";
    if (localStt) {
      transcript = await _whisperTranscribe(opusFrames);
    } else {
      // Step 1: Send audio to Gemini for transcription + wake word check.
      // We send a real WAV container (decoded from Opus → PCM, wrapped with a
      // RIFF/WAVE header) — Gemini cannot decode raw Opus frames, which is why
      // the previous "audio/ogg" path always returned "[inaudible]".
      const transcribeResponse = await client.models.generateContent({
        model: config.geminiFastModel || "gemini-2.5-flash-preview-04-17",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: wavBuffer.toString("base64"),
                },
              },
              {
                text: `Transcribe this audio exactly as spoken. Return ONLY the transcription, nothing else. If the audio is unclear or empty, respond with "[inaudible]".`,
              },
            ],
          },
        ],
      });

      transcript = transcribeResponse.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    }

    if (!transcript || transcript === "[inaudible]" || transcript.length < 2) {
      return; // Nothing useful captured
    }

    log(`[VoiceListen] Transcript from ${userId}: "${transcript}"`);

    // Step 2: Check if the wake word is present
    if (!transcript.toLowerCase().includes(wakeWord)) {
      return; // No wake word — ignore this utterance
    }

    // Step 3: Strip the wake word from the beginning to get the actual request
    const wakeRegex = new RegExp(`^\\s*(hey\\s+)?${escapeRegex(wakeWord)}[,!.\\s]*`, "i");
    const userMessage = transcript.replace(wakeRegex, "").trim() || transcript;

    log(`[VoiceListen] Wake word detected! User request: "${userMessage}"`);

    // Step 4: Get AI response via Gemini
    const aiResponse = await client.models.generateContent({
      model: config.geminiFastModel || "gemini-2.5-flash-preview-04-17",
      contents: [
        {
          parts: [
            {
              text: `You are Irene, an AI assistant in a Discord voice channel. A user just spoke to you out loud. Respond conversationally and concisely — keep it under 2-3 sentences since this will be read aloud via TTS. Be natural and friendly.

User said: "${userMessage}"`,
            },
          ],
        },
      ],
    });

    const reply = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!reply) {
      log("[VoiceListen] Empty AI response");
      return;
    }

    log(`[VoiceListen] AI reply: "${reply.slice(0, 100)}..."`);

    // Step 5: Set cooldown and play TTS response
    state.userCooldowns.set(userId, Date.now());

    // Prune expired cooldowns to prevent unbounded Map growth
    if (state.userCooldowns.size > 20) {
      const cutoff = Date.now() - 5 * 60_000;
      for (const [uid, ts] of state.userCooldowns) {
        if (ts < cutoff) state.userCooldowns.delete(uid);
      }
    }

    const { client: discordClient } = await import("../index.js");
    let guild = discordClient.guilds.cache.get(state.guildId);
    let voiceChannel = guild?.channels.cache.get(state.channelId) || { id: state.channelId, guild: { id: state.guildId } };
    let textChannel = guild?.channels.cache.get(state.textChannelId) || { id: state.textChannelId };

    await playTTS(state.guildId, reply, voiceChannel, textChannel);

  } catch (err) {
    if (err.message?.includes("Could not decode")) {
      // We now send a real WAV container, so this should be rare. Log and bail
      // for this utterance rather than tearing down the whole session.
      log(`[VoiceListen] Gemini could not decode audio for ${userId} — skipping utterance`);
      return;
    }
    throw err;
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export function cleanupAllListeners() {
  for (const guildId of listeners.keys()) {
    stopListening(guildId);
  }
}
