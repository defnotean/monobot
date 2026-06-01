// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config.js", () => ({
  default: { ownerId: "OWNER_ID", twinBotId: "ERIS_ID" },
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
// channelTypeLabel is used by resolveDiscordReferences for the [type, id] suffix.
vi.mock("../../../utils/channelTypes.js", () => ({
  channelTypeLabel: vi.fn(() => "text channel"),
}));
// spotlight wraps the user text; make it identity so assertions are exact.
vi.mock("../../../ai/firewall.js", () => ({
  spotlight: vi.fn((text) => text),
}));
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@defnotean/shared/safeFetch", () => ({ safeFetch }));

import {
  collectImages,
  safeIdentityName,
  resolveDiscordReferences,
  buildUserTurn,
  stripMention,
  scrubTwinHistoryForRecall,
  shouldBuildOpinionContextForMessage,
  shouldBuildTwinStateContextForMessage,
} from "../../../events/messageCreate/contextBuild.js";
// @ts-expect-error JS helper, no types
import { makeMessage, makeUser, makeMember, makeGuild, makeChannel, makeClient, makeRole, Collection } from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("contextBuild / tail context gates", () => {
  it("skips expensive optional builders for ordinary chat", () => {
    expect(shouldBuildOpinionContextForMessage("hey whats up")).toBe(false);
    expect(shouldBuildTwinStateContextForMessage("hey whats up")).toBe(false);
  });

  it("keeps opinion context enabled for opinion-bearing triggers", () => {
    expect(shouldBuildOpinionContextForMessage("what's your take on pineapple pizza?")).toBe(true);
    expect(shouldBuildOpinionContextForMessage("i love pineapple pizza")).toBe(true);
    expect(shouldBuildOpinionContextForMessage("do you hate valorant ranked")).toBe(true);
  });

  it("keeps twin state enabled for sister and bot-name triggers", () => {
    expect(shouldBuildTwinStateContextForMessage("is eris around?")).toBe(true);
    expect(shouldBuildTwinStateContextForMessage("what is your twin doing")).toBe(true);
    expect(shouldBuildTwinStateContextForMessage("ask your sister about that")).toBe(true);
    expect(shouldBuildTwinStateContextForMessage("can <@ERIS_ID> see this")).toBe(true);
  });
});

describe("contextBuild / safeIdentityName", () => {
  it("prefers the member displayName", () => {
    const msg = { member: { displayName: "Nickname" }, author: { username: "rawname" } };
    expect(safeIdentityName(msg)).toBe("Nickname");
  });

  it("falls back to the author username when no member displayName", () => {
    const msg = { member: null, author: { username: "rawname" } };
    expect(safeIdentityName(msg)).toBe("rawname");
  });

  it("strips angle-bracket mention payloads from a malicious nickname", () => {
    const msg = { member: { displayName: "<@123456789>" }, author: { username: "u" } };
    // The <@...> payload is stripped; what remains here is empty → falls to "user".
    expect(safeIdentityName(msg)).toBe("user");
  });

  it("strips bracket/newline/backtick injection characters", () => {
    const msg = { member: { displayName: "Bob[SYSTEM]\n`x`" }, author: { username: "u" } };
    expect(safeIdentityName(msg)).toBe("BobSYSTEMx");
  });

  it("falls back to the literal 'user' when nothing is available", () => {
    expect(safeIdentityName({})).toBe("user");
  });
});

describe("contextBuild / resolveDiscordReferences", () => {
  let g;
  beforeEach(() => {
    g = makeGuild({ id: "g1" });
    g.members.cache = new Collection();
    g.channels.cache = new Collection();
    g.roles.cache = new Collection();
    const member = makeMember({ user: makeUser({ id: "111", username: "alice" }) });
    g.members.cache.set("111", member);
    g.channels.cache.set("222", makeChannel({ id: "222", name: "general" }));
    g.roles.cache.set("333", makeRole({ id: "333", name: "Mods" }));
  });

  it("returns content unchanged when content or guild is missing", () => {
    expect(resolveDiscordReferences("", g)).toBe("");
    expect(resolveDiscordReferences("hi", null)).toBe("hi");
  });

  it("resolves a plain <@id> user mention to @username with the id kept", () => {
    expect(resolveDiscordReferences("hey <@111>", g)).toBe("hey @alice (<@111>)");
  });

  it("resolves the nickname-form <@!id> user mention too", () => {
    expect(resolveDiscordReferences("hey <@!111>", g)).toBe("hey @alice (<@111>)");
  });

  it("resolves a channel mention to #name with a type/id suffix", () => {
    expect(resolveDiscordReferences("go to <#222>", g)).toBe("go to #general [text channel, id:222]");
  });

  it("resolves a role mention to @rolename with the id kept", () => {
    expect(resolveDiscordReferences("ping <@&333>", g)).toBe("ping @Mods (<@&333>)");
  });

  it("leaves an unknown user id as the raw mention token", () => {
    expect(resolveDiscordReferences("who is <@999>", g)).toBe("who is <@999>");
  });

  it("resolves several mixed references in one string", () => {
    expect(resolveDiscordReferences("<@111> joined <#222> as <@&333>", g))
      .toBe("@alice (<@111>) joined #general [text channel, id:222] as @Mods (<@&333>)");
  });
});

describe("contextBuild / buildUserTurn", () => {
  it("labels twin messages with [Eris said] and wraps the resolved text", () => {
    const message = makeMessage({ channel: makeChannel({ name: "chat" }) });
    const { userText, userContent, resolvedContent } = buildUserTurn({
      message, content: "hi sis", images: [], allImageAttachments: [],
      isTwinMsg: true, guild: message.guild, safeSpeakerName: "ignored-for-twin",
    });
    expect(userText.startsWith("[Eris said]\n")).toBe(true);
    expect(userText).toContain("hi sis");
    expect(resolvedContent).toBe("hi sis");
    // No images → userContent is the string itself.
    expect(userContent).toBe(userText);
  });

  it("labels a normal message with the sanitized speaker name", () => {
    const message = makeMessage({});
    const { userText } = buildUserTurn({
      message, content: "hello", images: [], allImageAttachments: [],
      isTwinMsg: false, guild: null, safeSpeakerName: "Alice",
    });
    expect(userText.startsWith("[Alice said]\n")).toBe(true);
    expect(userText).toContain("hello");
  });

  it("appends attachment URLs when allImageAttachments is non-empty", () => {
    const message = makeMessage({});
    const { userText } = buildUserTurn({
      message, content: "look", images: [], isTwinMsg: false, guild: null,
      safeSpeakerName: "Alice",
      allImageAttachments: [{ url: "https://cdn/x.png" }],
    });
    expect(userText).toContain("[Attached image URL(s): https://cdn/x.png]");
  });

  it("uses a placeholder when content is empty but an image is present", () => {
    const message = makeMessage({});
    const { resolvedContent, userText } = buildUserTurn({
      message, content: "", images: [{ type: "text" }], allImageAttachments: [],
      isTwinMsg: false, guild: null, safeSpeakerName: "Alice",
    });
    expect(resolvedContent).toBe(""); // resolveDiscordReferences("") → ""
    expect(userText).toContain("(sent an image)");
  });

  it("returns a content array (text part + image parts) when images are present", () => {
    const message = makeMessage({});
    const imgPart = { type: "image", inlineData: { mimeType: "image/png", data: "B64" } };
    const { userContent } = buildUserTurn({
      message, content: "look", images: [imgPart], allImageAttachments: [],
      isTwinMsg: false, guild: null, safeSpeakerName: "Alice",
    });
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0].type).toBe("text");
    expect(userContent[1]).toBe(imgPart);
  });
});

describe("contextBuild / collectImages", () => {
  it("prefetches image attachments through capped safeFetch before caching bytes", async () => {
    safeFetch.mockResolvedValueOnce({
      status: 200,
      bytes: Buffer.from("image-bytes"),
      headers: { get: () => "image/png" },
    });
    const attachment = { contentType: "image/png", name: "pic.png", url: "https://cdn.test/pic.png" };
    const message = { attachments: new Collection([["a1", attachment]]) };

    const result = await collectImages(message);

    expect(safeFetch).toHaveBeenCalledWith("https://cdn.test/pic.png", {
      binary: true,
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
    });
    expect(result.allImageAttachments).toEqual([attachment]);
    expect(result.images[0]._cachedBase64).toBe(Buffer.from("image-bytes").toString("base64"));
    expect(result.images[0]._cachedMime).toBe("image/png");
  });

  it("leaves the URL image block uncached when safeFetch rejects an oversized body", async () => {
    safeFetch.mockRejectedValueOnce(new Error("response too large"));
    const attachment = { contentType: "image/png", name: "pic.png", url: "https://cdn.test/huge.png" };
    const message = { attachments: new Collection([["a1", attachment]]) };

    const result = await collectImages(message);

    expect(result.images[0]).toEqual({ type: "image", source: { type: "url", url: "https://cdn.test/huge.png" } });
  });
});

describe("contextBuild / stripMention", () => {
  it("removes the bot's own mention and trims", () => {
    const client = makeClient({ user: makeUser({ id: "BOT" }) });
    const msg = makeMessage({ content: "<@BOT> hello there", client });
    expect(stripMention(msg)).toBe("hello there");
  });

  it("removes the nickname-form mention too", () => {
    const client = makeClient({ user: makeUser({ id: "BOT" }) });
    const msg = makeMessage({ content: "<@!BOT>   hey", client });
    expect(stripMention(msg)).toBe("hey");
  });

  it("leaves content untouched when it does not mention the bot", () => {
    const client = makeClient({ user: makeUser({ id: "BOT" }) });
    const msg = makeMessage({ content: "just chatting", client });
    expect(stripMention(msg)).toBe("just chatting");
  });
});

describe("contextBuild / scrubTwinHistoryForRecall", () => {
  // NOTE: the source mutates the array in place and returns undefined; it only
  // transforms entries whose `.content` is an ARRAY of tool blocks.
  it("converts a tool_use block array to a readable summary string", () => {
    const history = [
      { role: "assistant", content: [{ type: "tool_use", name: "ban_user" }] },
    ];
    const ret = scrubTwinHistoryForRecall(history);
    expect(ret).toBeUndefined(); // mutates in place
    expect(history[0].content).toBe("[twin/bot used ban_user]");
  });

  it("summarizes a tool_result block (truncated) and keeps text blocks", () => {
    const history = [
      { role: "user", content: [
        { type: "text", text: "hey" },
        { type: "tool_result", content: "operation completed successfully" },
      ] },
    ];
    scrubTwinHistoryForRecall(history);
    expect(history[0].content).toContain("hey");
    expect(history[0].content).toContain("[result: operation completed successfully]");
  });

  it("falls back to [previous action] when the array yields no text", () => {
    const history = [{ role: "assistant", content: [{ type: "unknown" }] }];
    scrubTwinHistoryForRecall(history);
    expect(history[0].content).toBe("[previous action]");
  });

  it("leaves string-content entries unchanged", () => {
    const history = [{ role: "user", content: "plain string stays" }];
    scrubTwinHistoryForRecall(history);
    expect(history[0].content).toBe("plain string stays");
  });
});
