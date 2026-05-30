import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../database.js", () => ({
  setDmWelcome: vi.fn(),
  setLeaveChannel: vi.fn(),
  setChannelPersonality: vi.fn(),
  setBadWords: vi.fn(),
  setEscalation: vi.fn(),
  setServerPersona: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  default: { botPersonality: "Irene test personality" },
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("@defnotean/shared/safeFetch", () => ({
  safeFetch: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/personalizeExecutor.js";
// @ts-expect-error - importing JS module without types
import { safeFetch } from "@defnotean/shared/safeFetch";

const mockSafeFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;

function makeGuild() {
  return {
    id: "guild-1",
    client: {
      rest: {
        patch: vi.fn(async () => ({})),
      },
    },
    members: {
      me: null,
      fetchMe: vi.fn(async () => null),
    },
  };
}

function makeContext(guild = makeGuild()) {
  return {
    guild,
    findChannel: vi.fn(),
    findMember: vi.fn(),
  } as any;
}

describe("personalizeExecutor avatar/banner downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
  });

  it("downloads server avatars through safeFetch binary mode and sends a data URI", async () => {
    const bytes = Buffer.from("fake image");
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "image/webp" }),
      bytes,
      url: "https://cdn.example/avatar.webp",
    });
    const guild = makeGuild();
    const ctx = makeContext(guild);

    const result = await execute(
      "set_server_avatar",
      { image_url: "https://cdn.example/avatar.webp" },
      {} as any,
      ctx,
    );

    expect(mockSafeFetch).toHaveBeenCalledWith("https://cdn.example/avatar.webp", {
      binary: true,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    expect(guild.client.rest.patch).toHaveBeenCalledWith("/guilds/guild-1/members/@me", {
      body: { avatar: `data:image/webp;base64,${bytes.toString("base64")}` },
    });
    expect(String(result)).toMatch(/server avatar updated successfully/i);
  });

  it("rejects non-image banner responses before patching Discord", async () => {
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      bytes: Buffer.from("<html></html>"),
      url: "https://example.com/banner.png",
    });
    const guild = makeGuild();

    const result = await execute(
      "set_server_banner",
      { image_url: "https://example.com/banner.png" },
      {} as any,
      makeContext(guild),
    );

    expect(guild.client.rest.patch).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/did not return an image/i);
  });

  it("requires an image extension when the response has no image content type", async () => {
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      bytes: Buffer.from("bytes"),
      url: "https://cdn.example/download",
    });
    const guild = makeGuild();

    const result = await execute(
      "set_server_avatar",
      { image_url: "https://cdn.example/download" },
      {} as any,
      makeContext(guild),
    );

    expect(guild.client.rest.patch).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/png, jpg, gif, or webp/i);
  });

  it("returns a friendly size error when safeFetch aborts an oversized image", async () => {
    mockSafeFetch.mockRejectedValue(new Error("response too large"));
    const guild = makeGuild();

    const result = await execute(
      "set_server_avatar",
      { image_url: "https://cdn.example/huge.png" },
      {} as any,
      makeContext(guild),
    );

    expect(guild.client.rest.patch).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/max 8 MB/i);
  });
});
