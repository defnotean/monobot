import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error JS module without declarations
import {
  elevenLabsSoundEffect,
  elevenLabsSpeechToText,
  elevenLabsTextToSpeech,
} from "../../src/ai/elevenLabs.js";

describe("elevenLabs adapter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates speech with the configured voice, model, and output format", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String(_url)).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=mp3_44100_128");
      expect((init as RequestInit).headers).toMatchObject({
        "xi-api-key": "key",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        text: "hello",
        model_id: "eleven_multilingual_v2",
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as any;

    await expect(elevenLabsTextToSpeech({
      apiKey: "key",
      text: "hello",
      voiceId: "voice-1",
    })).resolves.toMatchObject({
      buffer: Buffer.from([1, 2, 3]),
      contentType: "audio/mpeg",
      filename: "audio.mp3",
    });
  });

  it("creates sound effects through sound-generation", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String(_url)).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        text: "sparkle hit",
        duration_seconds: 3,
      });
      return new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as any;

    const result = await elevenLabsSoundEffect({
      apiKey: "key",
      text: "sparkle hit",
      durationSeconds: 3,
    });
    expect(result.buffer).toEqual(Buffer.from([4, 5]));
  });

  it("transcribes source URLs with Scribe options", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String(_url)).toBe("https://api.elevenlabs.io/v1/speech-to-text");
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
      const form = (init as RequestInit).body as FormData;
      expect(form.get("model_id")).toBe("scribe_v2");
      expect(form.get("source_url")).toBe("https://cdn.example/audio.mp4");
      expect(form.get("diarize")).toBe("true");
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    await expect(elevenLabsSpeechToText({
      apiKey: "key",
      sourceUrl: "https://cdn.example/audio.mp4",
      diarize: true,
    })).resolves.toMatchObject({ text: "hello world" });
  });
});
