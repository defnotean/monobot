// ─── mediaExecutor — GIF / image / file posting guard branches ───────────────
//
// Focus on the deterministic guard/validation paths that don't require a live
// network call: missing API key, missing inputs, oversized file, the GIF-style
// toggle, and the send_file happy path (which only touches message.channel.send
// + AttachmentBuilder). The network-heavy show_image / edit_image / send_gif
// success paths are intentionally left to integration coverage.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../database.js", () => ({
  getGuildSettings: vi.fn(() => ({})),
  setGifEmbed: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  default: { colors: { gif: 0x2b2d31 }, geminiKeys: [] },
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

vi.mock("@defnotean/shared/gifCadence", () => ({
  isExplicitGifRequest: vi.fn(() => true),
  recordNaturalGif: vi.fn(),
  shouldAllowNaturalGif: vi.fn(() => ({ allowed: true })),
}));

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@defnotean/shared/safeFetch", () => ({ safeFetch }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/mediaExecutor.js";
// @ts-expect-error - importing JS module without types
import { setGifEmbed } from "../../../database.js";

const guild = { id: "guild-1", members: { cache: { find: () => null } } };

function buildMessage() {
  const send = vi.fn(async () => ({}));
  return {
    msg: {
      author: { id: "u1" },
      channel: { send },
      attachments: { first: () => undefined },
      guild,
    },
    send,
  };
}

const ctx = { guild } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.KLIPY_API_KEY;
  vi.unstubAllGlobals();
});

describe("mediaExecutor — routing", () => {
  it("returns undefined for an unhandled tool", async () => {
    const { msg } = buildMessage();
    const r = await execute("not_media", {}, msg, ctx);
    expect(r).toBeUndefined();
  });
});

describe("send_gif", () => {
  it("explains the feature is unconfigured when KLIPY_API_KEY is missing", async () => {
    delete process.env.KLIPY_API_KEY;
    const { msg } = buildMessage();
    const r = await execute("send_gif", { query: "cat" }, msg, ctx);
    expect(String(r)).toMatch(/GIF feature not set up/i);
  });

  it("allows only resolved user mentions in GIF captions", async () => {
    process.env.KLIPY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { data: [{ file: { sm: { gif: { url: "https://cdn.test/cat.gif" } } } }] },
      }),
    })));
    const member = { id: "alice-id", user: { username: "alice" }, displayName: "Alice" };
    const localGuild = {
      id: "guild-1",
      members: { cache: { find: (fn: (member: any) => boolean) => fn(member) ? member : null } },
    };
    const send = vi.fn(async () => ({}));
    const msg = {
      author: { id: "u1" },
      content: "send a gif",
      channel: { id: "c1", send },
      attachments: { first: () => undefined },
      guild: localGuild,
    };

    await execute(
      "send_gif",
      { query: "cat", caption: "hi @Alice @everyone <@999> <@&123>" },
      msg,
      { guild: localGuild } as any,
    );

    const payload = send.mock.calls[0][0] as any;
    expect(payload.content).toContain("<@alice-id>");
    expect(payload.content).toContain("everyone");
    expect(payload.content).toContain("<@999>");
    expect(payload.allowedMentions).toEqual({ parse: [], users: ["alice-id"] });
  });

  it("keeps the same mention restrictions on GIF URL fallback", async () => {
    process.env.KLIPY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { data: [{ file: { sm: { gif: { url: "https://cdn.test/cat.gif" } } } }] },
      }),
    })));
    const member = { id: "alice-id", user: { username: "alice" }, displayName: "Alice" };
    const localGuild = {
      id: "guild-1",
      members: { cache: { find: (fn: (member: any) => boolean) => fn(member) ? member : null } },
    };
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("embed blocked"))
      .mockResolvedValueOnce({});
    const msg = {
      author: { id: "u1" },
      content: "send a gif",
      channel: { id: "c1", send },
      attachments: { first: () => undefined },
      guild: localGuild,
    };

    await execute("send_gif", { query: "cat", caption: "hi @Alice @everyone" }, msg, { guild: localGuild } as any);

    const fallbackPayload = send.mock.calls[1][0] as any;
    expect(fallbackPayload.content).toContain("https://cdn.test/cat.gif");
    expect(fallbackPayload.allowedMentions).toEqual({ parse: [], users: ["alice-id"] });
  });
});

describe("set_gif_style", () => {
  it("sets raw style (no embed border)", async () => {
    const { msg } = buildMessage();
    const r = await execute("set_gif_style", { style: "raw" }, msg, ctx);
    expect(setGifEmbed).toHaveBeenCalledWith("guild-1", false);
    expect(String(r)).toMatch(/raw/i);
  });

  it("accepts the 'plain' alias for raw", async () => {
    const { msg } = buildMessage();
    await execute("set_gif_style", { style: "plain" }, msg, ctx);
    expect(setGifEmbed).toHaveBeenCalledWith("guild-1", false);
  });

  it("sets embed style (colored border)", async () => {
    const { msg } = buildMessage();
    const r = await execute("set_gif_style", { style: "fancy" }, msg, ctx);
    expect(setGifEmbed).toHaveBeenCalledWith("guild-1", true);
    expect(String(r)).toMatch(/embed/i);
  });

  it("rejects an unknown style without mutating settings", async () => {
    const { msg } = buildMessage();
    const r = await execute("set_gif_style", { style: "sparkly" }, msg, ctx);
    expect(setGifEmbed).not.toHaveBeenCalled();
    expect(String(r)).toMatch(/use "raw".*"embed"/i);
  });
});

describe("show_image", () => {
  it("requires a query", async () => {
    const { msg } = buildMessage();
    const r = await execute("show_image", {}, msg, ctx);
    expect(String(r)).toMatch(/no image query provided/i);
  });

  it("keeps mention restrictions on image URL fallback", async () => {
    safeFetch
      .mockResolvedValueOnce({
        text: JSON.stringify({ query: { search: [{ title: "Cat" }] } }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ query: { pages: { "1": { original: { source: "https://cdn.test/cat.png" } } } } }),
      });
    const member = { id: "alice-id", user: { username: "alice" }, displayName: "Alice" };
    const localGuild = {
      id: "guild-1",
      members: {
        cache: {
          filter: (fn: (member: any) => boolean) => {
            const matches = [member].filter(fn);
            return { size: matches.length, first: () => matches[0] };
          },
        },
      },
    };
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("embed blocked"))
      .mockResolvedValueOnce({});
    const msg = {
      author: { id: "u1" },
      channel: { id: "c1", send },
      attachments: { first: () => undefined },
      guild: localGuild,
    };

    const r = await execute(
      "show_image",
      { query: "cat", caption: "hi @Alice @everyone <@999>" },
      msg,
      { guild: localGuild } as any,
    );

    expect(String(r)).toMatch(/posted image URL/i);
    const fallbackPayload = send.mock.calls[1][0] as any;
    expect(fallbackPayload.content).toContain("<@alice-id>");
    expect(fallbackPayload.content).toContain("everyone");
    expect(fallbackPayload.content).toContain("<@999>");
    expect(fallbackPayload.content).toContain("https://cdn.test/cat.png");
    expect(fallbackPayload.allowedMentions).toEqual({ parse: [], users: ["alice-id"] });
  });
});

describe("send_file", () => {
  it("requires content", async () => {
    const { msg } = buildMessage();
    const r = await execute("send_file", {}, msg, ctx);
    expect(String(r)).toMatch(/no file content provided/i);
  });

  it("rejects content larger than 7MB", async () => {
    const { msg, send } = buildMessage();
    const big = "x".repeat(7_000_001);
    const r = await execute("send_file", { content: big, filename: "huge.txt" }, msg, ctx);
    expect(String(r)).toMatch(/too large to attach/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("posts content as a file attachment with a sanitized filename", async () => {
    const { msg, send } = buildMessage();
    const r = await execute(
      "send_file",
      { content: "console.log('hi')", filename: "my script!.js", caption: "here you go" },
      msg,
      ctx,
    );
    expect(send).toHaveBeenCalledTimes(1);
    const opts = send.mock.calls[0][0] as any;
    expect(opts.content).toBe("here you go");
    expect(opts.files).toHaveLength(1);
    // The sanitizer keeps word chars, dots, dashes AND spaces; only the "!" is
    // replaced with "_", so "my script!.js" → "my script_.js".
    expect(opts.files[0].name).toBe("my script_.js");
    expect(String(r)).toMatch(/posted "my script_\.js" as a file/);
  });

  it("restricts file captions to resolved user mentions only", async () => {
    const member = { id: "alice-id", user: { username: "alice" }, displayName: "Alice" };
    const localGuild = {
      id: "guild-1",
      members: {
        cache: {
          filter: (fn: (member: any) => boolean) => {
            const matches = [member].filter(fn);
            return { size: matches.length, first: () => matches[0] };
          },
        },
      },
    };
    const send = vi.fn(async () => ({}));
    const msg = {
      author: { id: "u1" },
      channel: { send },
      attachments: { first: () => undefined },
      guild: localGuild,
    };

    await execute(
      "send_file",
      { content: "hello", filename: "note.txt", caption: "hi @Alice @everyone <@999>" },
      msg,
      { guild: localGuild } as any,
    );

    const opts = send.mock.calls[0][0] as any;
    expect(opts.content).toContain("<@alice-id>");
    expect(opts.content).toContain("everyone");
    expect(opts.content).toContain("<@999>");
    expect(opts.allowedMentions).toEqual({ parse: [], users: ["alice-id"] });
  });
});

describe("edit_image", () => {
  it("requires an instruction", async () => {
    const { msg } = buildMessage();
    const r = await execute("edit_image", {}, msg, ctx);
    expect(String(r)).toMatch(/tell me what to change/i);
  });

  it("requires an attached or referenced image", async () => {
    const { msg } = buildMessage();
    const r = await execute("edit_image", { instruction: "make it blue" }, msg, ctx);
    expect(String(r)).toMatch(/no image attached/i);
  });

  it("reports when no Gemini key is configured", async () => {
    const { msg } = buildMessage();
    const r = await execute(
      "edit_image",
      { instruction: "make it blue", url: "https://example.com/pic.png" },
      msg,
      ctx,
    );
    expect(String(r)).toMatch(/image editing isn't set up/i);
  });
});
