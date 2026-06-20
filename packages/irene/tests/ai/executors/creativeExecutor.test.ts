import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: {
    elevenLabs: {
      apiKey: "test-key",
      baseUrl: "https://api.elevenlabs.io/v1",
      voiceId: "default-voice",
      voiceMap: { Irene: "irene-voice", eris: "eris-voice" },
      dialogueModel: "eleven_v3",
      outputFormat: "mp3_44100_128",
      timeoutMs: 60_000,
    },
    higgsfield: {
      command: "/tmp/fake-higgsfield",
      outputDir: "/tmp/monobot-higgsfield",
      timeoutMs: 600_000,
    },
  },
  soundEffect: vi.fn(),
  dialogue: vi.fn(),
  runHiggsfield: vi.fn(),
  buildPayload: vi.fn((action: string, input: any) => ({ action, ...input })),
  log: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ default: h.config }));
vi.mock("../../../utils/logger.js", () => ({ log: h.log }));
vi.mock("@defnotean/shared/safeFetch", () => ({ safeFetch: vi.fn() }));
vi.mock("@defnotean/shared/elevenLabs", () => ({
  elevenLabsAudioIsolation: vi.fn(),
  elevenLabsSpeechToText: vi.fn(),
  elevenLabsSoundEffect: h.soundEffect,
  elevenLabsTextToDialogue: h.dialogue,
}));
vi.mock("@defnotean/shared/higgsfieldBridge", () => ({
  buildHiggsfieldPayload: h.buildPayload,
  runHiggsfieldCommand: h.runHiggsfield,
}));

// @ts-expect-error JS module without declarations
import { execute } from "../../../ai/executors/creativeExecutor.js";

function message() {
  const send = vi.fn(async () => ({}));
  return { msg: { channel: { send }, attachments: { values: () => [][Symbol.iterator]() } }, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.soundEffect.mockResolvedValue({
    buffer: Buffer.from([1, 2, 3]),
    contentType: "audio/mpeg",
  });
  h.dialogue.mockResolvedValue({
    buffer: Buffer.from([4, 5, 6]),
    contentType: "audio/mpeg",
  });
  h.runHiggsfield.mockResolvedValue({
    message: "done",
    url: "https://cdn.example/out.mp4",
  });
});

describe("creativeExecutor", () => {
  it("generates and posts an ElevenLabs sound effect", async () => {
    const { msg, send } = message();
    const result = await execute("generate_sound_effect", { prompt: "sparkly transition", name: "sparkle" }, msg);

    expect(h.soundEffect).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "test-key",
      text: "sparkly transition",
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("sent sparkle.mp3");
  });

  it("maps dialogue speaker names to configured ElevenLabs voices", async () => {
    const { msg, send } = message();
    await execute("generate_dialogue_audio", {
      lines: [
        { speaker: "Irene", text: "hello" },
        { voice: "eris", text: "yo" },
      ],
    }, msg);

    expect(h.dialogue).toHaveBeenCalledWith(expect.objectContaining({
      inputs: [
        { text: "hello", voice_id: "irene-voice" },
        { text: "yo", voice_id: "eris-voice" },
      ],
    }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("forwards Higgsfield jobs to the configured local wrapper", async () => {
    const { msg, send } = message();
    const result = await execute("higgsfield_generate_video", {
      prompt: "cinematic product shot",
      aspect_ratio: "9:16",
    }, msg);

    expect(h.buildPayload).toHaveBeenCalledWith("generate_video", expect.objectContaining({
      prompt: "cinematic product shot",
    }));
    expect(h.runHiggsfield).toHaveBeenCalledWith(expect.objectContaining({
      command: "/tmp/fake-higgsfield",
      payload: expect.objectContaining({ action: "generate_video" }),
    }));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("https://cdn.example/out.mp4"));
    expect(String(result)).toContain("sent Higgsfield result");
  });
});
