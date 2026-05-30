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
