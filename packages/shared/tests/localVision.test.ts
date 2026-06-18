import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JS module without declarations
import {
  computeImageTileRegions,
  describeImageBuffer,
  describeImageAttachments,
  formatImageDescriptions,
  getImageAttachments,
  isImageAttachment,
  readImageDimensions,
  shouldCreateImageTiles,
} from "../src/ai/localVision.js";

class Collection<K, V> extends Map<K, V> {
  first() {
    return this.values().next().value;
  }
}

function pngHeader(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0x89;
  buffer.write("PNG", 1, "ascii");
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("localVision", () => {
  it("detects typed and extension-based image attachments", () => {
    expect(isImageAttachment({ url: "https://cdn.test/a", contentType: "image/png" })).toBe(true);
    expect(isImageAttachment({ url: "https://cdn.test/a", contentType: "application/octet-stream", name: "photo.webp" })).toBe(true);
    expect(isImageAttachment({ url: "https://cdn.test/a", contentType: "text/plain", name: "note.txt" })).toBe(false);
    expect(isImageAttachment({ contentType: "image/png", name: "missing-url.png" })).toBe(false);
  });

  it("collects multiple images and skips non-images", () => {
    const message = {
      attachments: new Collection([
        ["1", { url: "https://cdn.test/1.png", contentType: "image/png", name: "1.png" }],
        ["2", { url: "https://cdn.test/2.txt", contentType: "text/plain", name: "2.txt" }],
        ["3", { url: "https://cdn.test/3.jpg", contentType: "application/octet-stream", name: "3.jpg" }],
      ]),
    };

    expect(getImageAttachments(message).map((a: any) => a.name)).toEqual(["1.png", "3.jpg"]);
  });

  it("collects embed and sticker images when Discord does not expose a normal attachment", () => {
    const message = {
      attachments: new Collection([]),
      embeds: [
        { image: { url: "https://cdn.test/full-dress.webp?ex=1" } },
        { thumbnail: { url: "https://cdn.test/thumb.jpg" } },
      ],
      stickers: new Collection([
        ["s1", { url: "https://cdn.test/sticker.png", name: "sparkle sticker" }],
      ]),
    };

    expect(getImageAttachments(message).map((a: any) => a.url)).toEqual([
      "https://cdn.test/full-dress.webp?ex=1",
      "https://cdn.test/thumb.jpg",
      "https://cdn.test/sticker.png",
    ]);
  });

  it("detects tall screenshots as candidates for high-resolution crop passes", () => {
    const dimensions = readImageDimensions(pngHeader(1170, 2532));

    expect(dimensions).toEqual({ type: "png", width: 1170, height: 2532 });
    expect(shouldCreateImageTiles(dimensions, {
      maxTiles: 4,
      tileMinLongEdge: 1600,
      tileMinAspect: 1.45,
    })).toBe(true);
    expect(computeImageTileRegions(dimensions!, { maxTiles: 4 })).toMatchObject([
      { x: 0, y: 0, width: 1170, label: "top" },
      { x: 0, width: 1170 },
      { x: 0, width: 1170 },
    ]);
  });

  it("adds crop-pass descriptions for high-resolution screenshot evidence", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "Visible: full phone screenshot\nText: small text unclear\nUnclear: tiny UI text" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "Visible: top notification shade\nText: Wi-Fi, 9:41 AM\nUnclear: none visible" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "Visible: bottom chat input\nText: Send, Message\nUnclear: none visible" } }) });
    const makeImageTiles = vi.fn().mockResolvedValue([
      { buffer: Buffer.from("top-tile"), label: "top", width: 390, height: 720, sourceWidth: 390, sourceHeight: 1560 },
      { buffer: Buffer.from("bottom-tile"), label: "bottom", width: 390, height: 720, sourceWidth: 390, sourceHeight: 1560 },
    ]);

    const description = await describeImageBuffer(Buffer.from("full-image"), {
      visionUrl: "http://127.0.0.1:11434",
      model: "qwen2.5vl:3b",
      fetchImpl,
      makeImageTiles,
      maxTiles: 2,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(makeImageTiles).toHaveBeenCalledWith(Buffer.from("full-image"), expect.objectContaining({ maxTiles: 2 }));
    const cropRequestBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(cropRequestBody.messages[0].content).toContain("high-resolution crop 1/2 (top)");
    expect(cropRequestBody.messages[0].content).toContain("Prioritize small UI text");
    expect(description).toContain("Full image:");
    expect(description).toContain("High-resolution crop pass:");
    expect(description).toContain("Wi-Fi, 9:41 AM");
    expect(description).toContain("Send, Message");
  });

  it("describes several images through local Ollama without exposing raw bytes in the formatted block", async () => {
    const safeFetch = vi.fn()
      .mockResolvedValueOnce({ status: 200, bytes: Buffer.from("image-one"), headers: new Headers({ "content-type": "image/png" }) })
      .mockResolvedValueOnce({ status: 200, bytes: Buffer.from("image-two"), headers: new Headers({ "content-type": "image/jpeg" }) });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "a cat on a chair" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "an owl in a tree" } }) });
    const message = {
      attachments: new Collection([
        ["1", { url: "https://cdn.test/1.png", contentType: "image/png", name: "cat.png" }],
        ["2", { url: "https://cdn.test/2.jpg", contentType: "image/jpeg", name: "owl.jpg" }],
      ]),
    };

    const result = await describeImageAttachments(message, {
      visionUrl: "http://127.0.0.1:11434",
      model: "qwen2.5vl:3b",
      safeFetch,
      fetchImpl,
    });

    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(requestBody.model).toBe("qwen2.5vl:3b");
    expect(requestBody.messages[0].content).toContain("strict visual evidence extractor");
    expect(requestBody.messages[0].content).toContain("do not invent");
    expect(requestBody.keep_alive).toBe("30m");
    expect(requestBody.options.temperature).toBe(0);
    expect(result.imageDescriptions.map((d: any) => d.description)).toEqual([
      "a cat on a chair",
      "an owl in a tree",
    ]);
    expect(result.imageDescriptionBlock).toContain("1 (cat.png): a cat on a chair");
    expect(result.imageDescriptionBlock).toContain("2 (owl.jpg): an owl in a tree");
    expect(result.imageDescriptionBlock).not.toContain(Buffer.from("image-one").toString("base64"));
  });

  it("records omitted images when the limit is lower than the attachment count", async () => {
    const safeFetch = vi.fn().mockResolvedValue({ status: 200, bytes: Buffer.from("image"), headers: new Headers({ "content-type": "image/png" }) });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: "visible image" } }) });
    const message = {
      attachments: new Collection([
        ["1", { url: "https://cdn.test/1.png", contentType: "image/png", name: "1.png" }],
        ["2", { url: "https://cdn.test/2.png", contentType: "image/png", name: "2.png" }],
      ]),
    };

    const result = await describeImageAttachments(message, {
      visionUrl: "http://127.0.0.1:11434",
      maxImages: 1,
      safeFetch,
      fetchImpl,
    });

    expect(result.imageDescriptions).toHaveLength(1);
    expect(result.omittedCount).toBe(1);
    expect(result.imageDescriptionBlock).toContain("+1 more image(s) omitted");
  });

  it("formats an empty description list as an empty block", () => {
    expect(formatImageDescriptions([])).toBe("");
  });
});
