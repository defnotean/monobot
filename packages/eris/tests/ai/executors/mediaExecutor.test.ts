import { describe, it, expect, vi, beforeEach } from "vitest";

// mediaExecutor now routes every URL fetch through `@defnotean/shared/safeFetch`
// (SSRF blocklist + size cap), so the mock target shifted from `global.fetch`
// to the safeFetch module. safeFetch's return shape is
// `{ status, headers, bytes (for binary), text }` rather than the global
// fetch's `{ ok, arrayBuffer(), json() }`.
vi.mock("@defnotean/shared/safeFetch", () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from "@defnotean/shared/safeFetch";
import { execute } from "../../../ai/executors/mediaExecutor.js";

const mockSafeFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;

describe("mediaExecutor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("create_meme", () => {
    it("normalizes 'distracted-boyfriend' to 'db'", async () => {
      // safeFetch mock returning a valid fake image
      mockSafeFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        bytes: Buffer.alloc(2048), // > 1000 byte placeholder threshold
      });

      const message = {
        channel: {
          send: vi.fn().mockResolvedValue({}),
        },
      };

      const input = {
        template: "distracted-boyfriend",
        top_text: "me trying to bake scones",
        bottom_text: "my brain scr",
      };

      const result = await execute("create_meme", input, message, {});

      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockSafeFetch.mock.calls[0][0];
      // It should use "db" instead of "distracted-boyfriend"
      expect(calledUrl).toContain("/images/db/");
      expect(calledUrl).not.toContain("distracted-boyfriend");

      expect(message.channel.send).toHaveBeenCalledTimes(1);
      // Ensure the attachment was created properly
      const sendArgs = (message.channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.files).toBeDefined();
      expect(sendArgs.files.length).toBe(1);
      expect(result).toBe("meme sent");
    });

    it("refuses to send bad/empty image responses", async () => {
      // Memegen returning a non-image content-type (JSON 404 body) with a
      // 200 status. safeFetch hands the bytes to the handler, the
      // content-type sniff catches it, and the code returns the
      // "non-image" error string instead of posting to the channel.
      mockSafeFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        bytes: Buffer.alloc(500), // < 1000 byte placeholder threshold
      });

      const message = {
        channel: {
          send: vi.fn().mockResolvedValue({}),
        },
      };

      const input = {
        template: "fake-template-id",
        top_text: "hello",
        bottom_text: "world",
      };

      const result = await execute("create_meme", input, message, {});

      // execution fails and returns an error string
      expect(result).toMatch(/meme creation failed/i);
      expect(result).toMatch(/Memegen returned non-image/i);

      // Ensure it never sent the message to the channel
      expect(message.channel.send).not.toHaveBeenCalled();
    });
  });
});
