import { describe, expect, it } from "vitest";
// @ts-expect-error JS module without declarations
import { buildHiggsfieldPayload } from "../../src/ai/higgsfieldBridge.js";

describe("higgsfieldBridge", () => {
  it("normalizes creative job payloads for a local wrapper", () => {
    expect(buildHiggsfieldPayload("animate_image", {
      prompt: "slow 360 camera move",
      image_url: "https://cdn.example/input.png",
      aspect_ratio: "16:9",
      duration_seconds: 6,
    })).toEqual({
      action: "animate_image",
      prompt: "slow 360 camera move",
      image_url: "https://cdn.example/input.png",
      video_url: null,
      product_url: null,
      youtube_url: null,
      character_name: null,
      reference_urls: [],
      aspect_ratio: "16:9",
      duration_seconds: 6,
      style: null,
      count: null,
      extra: {},
    });
  });
});
