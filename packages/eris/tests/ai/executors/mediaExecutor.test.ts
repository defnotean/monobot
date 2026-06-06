import { describe, it, expect, vi, beforeEach } from "vitest";

// mediaExecutor now routes every URL fetch through `@defnotean/shared/safeFetch`
// (SSRF blocklist + size cap), so the mock target shifted from `global.fetch`
// to the safeFetch module. safeFetch's return shape is
// `{ status, headers, bytes (for binary), text }` rather than the global
// fetch's `{ ok, arrayBuffer(), json() }`.
vi.mock("@defnotean/shared/safeFetch", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("@defnotean/shared/localVision", () => ({
  describeImageAttachment: vi.fn(),
  describeImageAttachments: vi.fn(),
  formatImageDescriptions: vi.fn((descriptions: any[], { omittedCount = 0 } = {}) => [
    "[LOCAL IMAGE EVIDENCE",
    ...descriptions.map((d, i) => `${i + 1} (${d.name}): ${d.description}`),
    omittedCount ? `+${omittedCount} more image(s) omitted` : "",
    "-- end local image evidence --]",
  ].filter(Boolean).join("\n")),
}));

vi.mock("../../../config.js", () => ({
  default: {
    klipyApiKey: "test-klipy-key",
    colors: { gif: 0x2b2d31 },
    local: {
      ollamaVisionUrl: "http://127.0.0.1:11434",
      ollamaVisionModel: "qwen2.5vl:3b",
      visionMaxImages: 4,
      visionImageMaxBytes: 1234,
    },
  },
}));

import { safeFetch } from "@defnotean/shared/safeFetch";
import { describeImageAttachment, describeImageAttachments } from "@defnotean/shared/localVision";
import { execute } from "../../../ai/executors/mediaExecutor.js";

const mockSafeFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;
const mockDescribeImageAttachment = describeImageAttachment as unknown as ReturnType<typeof vi.fn>;
const mockDescribeImageAttachments = describeImageAttachments as unknown as ReturnType<typeof vi.fn>;

function makeMemberCache(members: Array<{ id: string; username: string; displayName: string; globalName?: string }>) {
  return {
    filter(predicate: (member: any) => boolean) {
      const matches = members
        .map((member) => ({
          id: member.id,
          displayName: member.displayName,
          user: {
            username: member.username,
            globalName: member.globalName,
          },
        }))
        .filter(predicate);

      return {
        size: matches.length,
        first: () => matches[0],
      };
    },
  };
}

describe("mediaExecutor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("analyze_image", () => {
    it("describes multiple attached images through local vision", async () => {
      const message = {
        attachments: new Map([
          ["1", { url: "https://cdn.example.test/one.png", contentType: "image/png", name: "one.png" }],
          ["2", { url: "https://cdn.example.test/two.jpg", contentType: "image/jpeg", name: "two.jpg" }],
        ]),
      };
      mockDescribeImageAttachments.mockResolvedValueOnce({
        allImageAttachments: [...message.attachments.values()],
        imageDescriptions: [
          { ok: true, name: "one.png", description: "a cat" },
          { ok: true, name: "two.jpg", description: "an owl" },
        ],
        omittedCount: 0,
      });

      const result = await execute("analyze_image", { prompt: "describe these" }, message, {});

      expect(mockDescribeImageAttachments).toHaveBeenCalledWith(message, {
        prompt: "describe these",
        visionUrl: "http://127.0.0.1:11434",
        model: "qwen2.5vl:3b",
        maxImages: 4,
        maxBytes: 1234,
      });
      expect(String(result)).toContain("1 (one.png): a cat");
      expect(String(result)).toContain("2 (two.jpg): an owl");
    });

    it("uses local vision for a provided image URL without falling back to Gemini", async () => {
      mockDescribeImageAttachment.mockResolvedValueOnce({
        ok: true,
        name: "provided-url",
        description: "a screenshot of settings",
      });

      const result = await execute("analyze_image", {
        image_url: "https://cdn.example.test/settings.png",
        prompt: "what is this",
      }, { attachments: new Map() }, {});

      expect(mockDescribeImageAttachment).toHaveBeenCalledWith(
        { url: "https://cdn.example.test/settings.png", name: "provided-url" },
        {
          prompt: "what is this",
          visionUrl: "http://127.0.0.1:11434",
          model: "qwen2.5vl:3b",
          maxImages: 4,
          maxBytes: 1234,
        },
      );
      expect(result).toBe("a screenshot of settings");
    });
  });

  describe("send_gif", () => {
    it("allows only intentionally resolved user mentions in GIF captions", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        status: 200,
        text: JSON.stringify({
          data: {
            data: [{
              file: {
                hd: { gif: { url: "https://cdn.example.test/reaction.gif" } },
              },
            }],
          },
        }),
      });

      const message = {
        content: "send gif",
        author: { id: "author-1" },
        guild: {
          id: "guild-1",
          members: {
            cache: makeMemberCache([
              {
                id: "111111111111111111",
                username: "alice",
                displayName: "Alice",
                globalName: "Alice",
              },
            ]),
          },
        },
        channel: {
          id: "channel-1",
          send: vi.fn().mockResolvedValue({}),
        },
      };

      const input = {
        query: "celebrate",
        caption: "hi @alice <@999999999999999999> <@&888888888888888888> @everyone @here",
      };

      const result = await execute("send_gif", input, message, {});

      expect(result).toBe("sent gif for celebrate");
      expect(message.channel.send).toHaveBeenCalledTimes(1);

      const sendArgs = (message.channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.content).toContain("<@111111111111111111>");
      expect(sendArgs.content).toContain("<@999999999999999999>");
      expect(sendArgs.content).toContain("<@&888888888888888888>");
      expect(sendArgs.content).toContain("everyone");
      expect(sendArgs.content).toContain("here");
      expect(sendArgs.allowedMentions).toEqual({
        parse: [],
        users: ["111111111111111111"],
      });
    });

    it("disables mention parsing for raw GIF captions with no resolved users", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        status: 200,
        text: JSON.stringify({
          data: {
            data: [{
              file: {
                hd: { gif: { url: "https://cdn.example.test/reaction.gif" } },
              },
            }],
          },
        }),
      });

      const message = {
        content: "send gif",
        author: { id: "author-1" },
        channel: {
          id: "channel-1",
          send: vi.fn().mockResolvedValue({}),
        },
      };

      const input = {
        query: "warning",
        caption: "<@999999999999999999> <@&888888888888888888> @everyone @here",
      };

      const result = await execute("send_gif", input, message, {});

      expect(result).toBe("sent gif for warning");
      const sendArgs = (message.channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.allowedMentions).toEqual({ parse: [] });
    });
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

  describe("caption mention policy", () => {
    it("restricts non-GIF media captions to resolved users only", async () => {
      const message = {
        content: "send file",
        author: { id: "author-1" },
        guild: {
          id: "guild-1",
          members: {
            cache: makeMemberCache([
              {
                id: "111111111111111111",
                username: "alice",
                displayName: "Alice",
                globalName: "Alice",
              },
            ]),
          },
        },
        channel: {
          id: "channel-1",
          send: vi.fn().mockResolvedValue({}),
        },
      };

      const result = await execute("send_file", {
        filename: "note.txt",
        content: "hello",
        caption: "hi @alice <@999999999999999999> @everyone @here",
      }, message, {});

      expect(result).toMatch(/posted "note\.txt"/);
      const sendArgs = (message.channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.content).toContain("<@111111111111111111>");
      expect(sendArgs.content).toContain("<@999999999999999999>");
      expect(sendArgs.content).toContain("everyone");
      expect(sendArgs.allowedMentions).toEqual({
        parse: [],
        users: ["111111111111111111"],
      });
    });
  });
});
