import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: { geminiKeys: ["key-one", "key-two"] },
  generateImages: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  default: h.config,
}));

vi.mock("../../../database.js", () => ({
  getTtsChannels: vi.fn(() => []),
  setTtsChannels: vi.fn(),
  setTtsVoice: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  log: h.log,
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(({ apiKey }) => ({
    models: {
      generateImages: (args: unknown) => h.generateImages(apiKey, args),
    },
  })),
}));

const guild = {
  id: "guild-1",
  channels: { cache: { find: vi.fn() } },
  members: { fetch: vi.fn() },
};

const ctx = { guild } as any;

function imageResponse(bytes = "fake-image") {
  return {
    generatedImages: [
      { image: { imageBytes: Buffer.from(bytes).toString("base64") } },
    ],
  };
}

function buildMessage() {
  const send = vi.fn(async () => ({}));
  return {
    msg: {
      author: { id: "user-1" },
      channel: { send },
      guild,
    },
    send,
  };
}

async function loadExecute(keys = ["key-one", "key-two"]) {
  vi.resetModules();
  h.config.geminiKeys = keys;
  // @ts-expect-error - importing JS module without types
  const mod = await import("../../../ai/executors/audioExecutor.js");
  return mod.execute as (toolName: string, input: any, message: any, ctx: any) => Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.geminiKeys = ["key-one", "key-two"];
});

describe("audioExecutor — generate_image", () => {
  it("tries another configured key after a transient upstream image failure", async () => {
    h.generateImages
      .mockRejectedValueOnce(new Error('{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}'))
      .mockResolvedValueOnce(imageResponse());

    const execute = await loadExecute();
    const { msg, send } = buildMessage();
    const result = await execute("generate_image", { prompt: "cat and owl hybrid", style: "fantasy" }, msg, ctx);

    expect(h.generateImages).toHaveBeenCalledTimes(2);
    expect(h.generateImages.mock.calls[0][0]).toBe("key-one");
    expect(h.generateImages.mock.calls[0][1]).toMatchObject({
      model: "imagen-4.0-fast-generate-001",
      prompt: "fantasy style: cat and owl hybrid",
      config: { numberOfImages: 1 },
    });
    expect(h.generateImages.mock.calls[1][0]).toBe("key-two");
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("generated and sent an image");
  });

  it("falls back to the next image model when the fast model is unavailable", async () => {
    h.generateImages
      .mockRejectedValueOnce(new Error("404 model is not found"))
      .mockResolvedValueOnce(imageResponse());

    const execute = await loadExecute();
    const { msg, send } = buildMessage();
    const result = await execute("generate_image", { prompt: "neon skyline" }, msg, ctx);

    expect(h.generateImages).toHaveBeenCalledTimes(2);
    expect(h.generateImages.mock.calls[0][1]).toMatchObject({ model: "imagen-4.0-fast-generate-001" });
    expect(h.generateImages.mock.calls[1][1]).toMatchObject({ model: "imagen-4.0-generate-001" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("generated and sent an image");
  });

  it("returns a non-retry instruction after every key/model hits transient errors", async () => {
    h.generateImages.mockRejectedValue(new Error("503 UNAVAILABLE"));

    const execute = await loadExecute();
    const { msg, send } = buildMessage();
    const result = await execute("generate_image", { prompt: "glowing castle" }, msg, ctx);

    expect(h.generateImages).toHaveBeenCalledTimes(6);
    expect(send).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/temporarily unavailable/i);
    expect(String(result)).toMatch(/do not call generate_image again/i);
  });
});
