import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JS module without declarations
import {
  describeImageAttachments,
  formatImageDescriptions,
  getImageAttachments,
  isImageAttachment,
} from "../src/ai/localVision.js";

class Collection<K, V> extends Map<K, V> {
  first() {
    return this.values().next().value;
  }
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
