import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../../../ai/executors/mediaExecutor.js";

// Mock the global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("mediaExecutor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("create_meme", () => {
    it("normalizes 'distracted-boyfriend' to 'db'", async () => {
      // Setup fetch mock to return a valid fake image
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => new ArrayBuffer(2048), // valid size
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

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0];
      // It should use "db" instead of "distracted-boyfriend"
      expect(calledUrl).toContain("/images/db/");
      expect(calledUrl).not.toContain("distracted-boyfriend");
      
      expect(message.channel.send).toHaveBeenCalledTimes(1);
      // Ensure the attachment was created properly
      const sendArgs = message.channel.send.mock.calls[0][0];
      expect(sendArgs.files).toBeDefined();
      expect(sendArgs.files.length).toBe(1);
      expect(result).toBe("meme sent");
    });

    it("refuses to send bad/empty image responses", async () => {
      // Mock Memegen returning a tiny 404 HTML/JSON instead of an image
      mockFetch.mockResolvedValueOnce({
        ok: true, // Memegen might return 200 OK
        headers: new Headers({ "content-type": "application/json" }),
        arrayBuffer: async () => new ArrayBuffer(500), // < 1000 bytes
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
