import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JS module without declarations
import {
  buildTikTokFixLinks,
  buildTikTokFixReply,
  extractTikTokUrls,
  isTikTokUrl,
  resolveTikTokUrl,
  toTikTokEmbedFixUrl,
} from "../../src/ai/tiktokLinkFixer.js";

describe("tiktokLinkFixer", () => {
  it("extracts TikTok URLs and strips common Discord punctuation", () => {
    expect(extractTikTokUrls("watch this (https://www.tiktok.com/@user/video/123?x=1). and https://example.com")).toEqual([
      "https://www.tiktok.com/@user/video/123?x=1",
    ]);
    expect(extractTikTokUrls("<https://vm.tiktok.com/ZMtest/>")).toEqual([
      "https://vm.tiktok.com/ZMtest/",
    ]);
  });

  it("recognizes only TikTok hosts", () => {
    expect(isTikTokUrl("https://www.tiktok.com/@user/video/123")).toBe(true);
    expect(isTikTokUrl("https://vt.tiktok.com/ZMtest/")).toBe(true);
    expect(isTikTokUrl("https://vxtiktok.com/@user/video/123")).toBe(false);
  });

  it("converts canonical TikTok URLs to the embed mirror and drops tracking", () => {
    expect(toTikTokEmbedFixUrl("https://www.tiktok.com/@user/video/123?is_from_webapp=1")).toBe(
      "https://www.vxtiktok.com/@user/video/123",
    );
  });

  it("resolves short TikTok links before creating mirror links", async () => {
    const safeFetch = vi.fn(async () => ({
      status: 200,
      url: "https://www.tiktok.com/@creator/video/987654321?sender_device=pc",
      text: "",
      headers: new Headers(),
    }));

    await expect(resolveTikTokUrl("https://vm.tiktok.com/ZMshort/", { safeFetch })).resolves.toBe(
      "https://www.tiktok.com/@creator/video/987654321?sender_device=pc",
    );
    await expect(buildTikTokFixLinks(["https://vm.tiktok.com/ZMshort/"], { safeFetch })).resolves.toEqual([
      "https://www.vxtiktok.com/@creator/video/987654321",
    ]);
    expect(safeFetch).toHaveBeenCalledWith("https://vm.tiktok.com/ZMshort/", expect.objectContaining({ method: "HEAD" }));
  });

  it("builds a Discord-safe reply payload", async () => {
    await expect(buildTikTokFixReply("https://www.tiktok.com/@u/video/1")).resolves.toEqual({
      content: "fixed tiktok embed:\nhttps://www.vxtiktok.com/@u/video/1",
      allowedMentions: { parse: [] },
    });
  });
});
