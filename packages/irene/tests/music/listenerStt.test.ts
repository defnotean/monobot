// Regression — the wake-word listener sent raw Opus frames to Gemini as
// "audio/ogg", which Gemini cannot decode. /listen reported success but never
// transcribed, while burning a Gemini call per utterance and holding a 60-min
// voice connection. The fix gates the feature on a working Opus decoder: when
// none is installed, startListening refuses up-front (no connection, no Gemini
// call). In CI there is no native Opus binding, so the disabled path is what
// runs here.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { joinVoiceChannel } = vi.hoisted(() => ({ joinVoiceChannel: vi.fn() }));
vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel,
  VoiceConnectionStatus: { Ready: "ready" },
  entersState: vi.fn(),
  EndBehaviorType: { AfterSilence: 1 },
  getVoiceConnection: vi.fn(),
}));
vi.mock("../../music/player.js", () => ({ playTTS: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

import { startListening, isSttAvailable } from "../../voice/listener.js";

// The whisper conversion helper is module-internal (not part of the public
// export surface). voice/listener.js exposes it on globalThis ONLY when
// IRENE_TEST_HOOKS=1 (set in tests/setup.ts), so the behavioral test below
// exercises the REAL production _pcmToWav16kMono — not a spec-mirror copy.
const _pcmToWav16kMono = (globalThis as any).__irenePcmToWav16kMono as
  | ((pcmChunks: Buffer[]) => Buffer)
  | undefined;

describe("voice listener — STT gating when Opus decoder is unavailable", () => {
  it("reports STT unavailable in an environment with no native Opus binding", () => {
    // CI has no @discordjs/opus / opusscript / node-opus installed.
    expect(isSttAvailable()).toBe(false);
  });

  it("refuses to start (no connection opened) and returns a clear disabled notice", async () => {
    const voiceChannel = { id: "vc1", name: "VC", guild: { id: "g1" } };
    const textChannel = { id: "tc1" };

    const result = await startListening(voiceChannel as any, textChannel as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(result.error).toMatch(/opus/i);
    // Critically: it never opened a voice connection (no 60-min hold, no
    // per-utterance Gemini call path reached).
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });
});

describe("voice listener — capture callback passes the in-scope PCM frames", () => {
  // Regression: the pcmStream "end" handler called
  //   processAudio(state, userId, wavBuffer, audioChunks)
  // but `audioChunks` was never declared (the captured frames live in
  // `pcmChunks`). On any environment with a native Opus binding the callback
  // throws `ReferenceError: audioChunks is not defined`, breaking the LOCAL_STT
  // (whisper) transcription path. This path cannot run in CI (no Opus binding),
  // so we assert against the source to lock the fix in.
  const src = readFileSync(
    fileURLToPath(new URL("../../voice/listener.js", import.meta.url)),
    "utf8",
  );

  it("does not reference an undefined `audioChunks` identifier", () => {
    expect(src).not.toMatch(/\baudioChunks\b/);
  });

  it("passes the captured `pcmChunks` buffer into processAudio", () => {
    expect(src).toMatch(/processAudio\(state, userId, wavBuffer, pcmChunks\)/);
  });
});

describe("voice listener — whisper (LOCAL_STT) path builds 16k mono WAV from PCM, not Opus", () => {
  // Regression: the LOCAL_STT/whisper path used to take the already-DECODED
  // 48kHz stereo PCM frames and re-feed each one into a FRESH prism Opus
  // decoder via `decoder.write(frame)` as if they were raw Opus packets — so
  // whisper received garbage / decode errors. The fix builds the 16kHz mono
  // 16-bit WAV directly FROM the PCM (downmix L/R + decimate 48k→16k) with no
  // Opus re-decode.
  //
  // The conversion helper (_pcmToWav16kMono) is module-internal and the runtime
  // whisper path is unreachable in CI (no native Opus binding), so we (a) lock
  // the source-level invariants and (b) exercise the REAL helper (exposed on
  // globalThis under IRENE_TEST_HOOKS) against synthetic 48kHz stereo PCM to
  // prove the produced WAV is a valid 16kHz mono 16-bit container with the
  // expected downsampled length.
  const src = readFileSync(
    fileURLToPath(new URL("../../voice/listener.js", import.meta.url)),
    "utf8",
  );

  it("renamed the helper to reflect it takes PCM (no Opus-frames name)", () => {
    expect(src).not.toMatch(/_opusFramesToWav16kMono/);
    expect(src).toMatch(/function _pcmToWav16kMono\(pcmChunks\)/);
  });

  it("whisper transcribe calls the PCM→WAV helper with pcmChunks", () => {
    expect(src).toMatch(/async function _whisperTranscribe\(pcmChunks\)/);
    expect(src).toMatch(/_pcmToWav16kMono\(pcmChunks\)/);
  });

  it("does NOT re-decode via an Opus decoder on the whisper path", () => {
    // No decoder.write anywhere (the old re-decode), and the PCM→WAV helper
    // body must not construct a prism Opus decoder.
    expect(src).not.toMatch(/decoder\.write\s*\(/);
    const helper = src.slice(
      src.indexOf("function _pcmToWav16kMono"),
      src.indexOf("async function _whisperTranscribe"),
    );
    expect(helper.length).toBeGreaterThan(0);
    expect(helper).not.toMatch(/opus\.Decoder/i);
    expect(helper).not.toMatch(/import\(["']prism-media["']\)/);
    // Conversion fundamentals present: averaged L/R downmix + 16k/mono/16-bit.
    expect(helper).toMatch(/\(l \+ r\) \/ 2/);
    expect(helper).toMatch(/writeUInt32LE\(16000, 24\)/); // 16kHz sample rate
    expect(helper).toMatch(/writeUInt16LE\(1, 22\)/);      // mono (1 channel)
    expect(helper).toMatch(/writeUInt16LE\(16, 34\)/);     // 16 bits/sample
  });

  it("converts synthetic 48kHz stereo PCM → a valid 16kHz mono 16-bit WAV with the expected sample count", () => {
    // Exercise the REAL production helper (exposed on globalThis under
    // IRENE_TEST_HOOKS). If the hook is missing the test fails loudly rather
    // than silently passing on a copy. Synthesize 9000 stereo frames of 48kHz
    // s16le PCM; expect floor(9000/3) = 3000 mono samples at 16kHz.
    expect(
      _pcmToWav16kMono,
      "production _pcmToWav16kMono hook not exposed — set IRENE_TEST_HOOKS=1",
    ).toBeTypeOf("function");

    const STEREO_FRAMES = 9000;
    const pcm = Buffer.alloc(STEREO_FRAMES * 4); // 4 bytes/stereo frame (L+R, s16)
    for (let f = 0; f < STEREO_FRAMES; f++) {
      // Distinct L/R so the downmix (average) is observable.
      const l = ((f * 7) % 20000) - 10000;
      const r = ((f * 11) % 20000) - 10000;
      pcm.writeInt16LE(l, f * 4);
      pcm.writeInt16LE(r, f * 4 + 2);
    }

    const wav = _pcmToWav16kMono!([pcm]);

    // ── Valid RIFF/WAVE header ──
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);     // PCM format
    // ── 16kHz mono 16-bit ──
    expect(wav.readUInt16LE(22)).toBe(1);     // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // 16kHz
    expect(wav.readUInt16LE(34)).toBe(16);    // 16-bit
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");

    // ── Expected downsampled sample count: floor(9000/3) = 3000 mono samples ──
    const expectedMonoSamples = Math.floor(STEREO_FRAMES / 3);
    const dataSize = wav.readUInt32LE(40);
    expect(dataSize).toBe(expectedMonoSamples * 2); // 2 bytes per mono sample
    expect(wav.length).toBe(44 + expectedMonoSamples * 2);

    // ── First output sample is the averaged L/R of frame 0 ──
    const l0 = pcm.readInt16LE(0);
    const r0 = pcm.readInt16LE(2);
    expect(wav.readInt16LE(44)).toBe(Math.round((l0 + r0) / 2));
  });
});
