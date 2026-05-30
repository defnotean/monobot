// ─── whitelistExecutor — bot-owner-only server whitelist controls ────────────
//
// Every tool here is gated to config.ownerId. These tests pin the OWNER GATE
// (a security boundary — only the bot owner can add/remove/view) plus the
// invite/ID/name resolution branches and the "unwhitelist also leaves the
// guild" behavior. We mock the database whitelist helpers and config so no DB
// or live Discord is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  addToWhitelist: vi.fn(async () => true),
  removeFromWhitelist: vi.fn(async () => true),
  getWhitelist: vi.fn(async () => ({})),
}));

vi.mock("../../../config.js", () => ({
  default: { ownerId: "owner-123" },
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/whitelistExecutor.js";
import {
  addToWhitelist,
  removeFromWhitelist,
  getWhitelist,
  // @ts-expect-error - importing JS module without types
} from "../../../database.js";

const OWNER = "owner-123";
const NOT_OWNER = "rando-999";

function buildClient({ guilds = [] as Array<{ id: string; name: string }> } = {}) {
  const cache = new Map(guilds.map((g) => [g.id, { ...g, leave: vi.fn(async () => {}), iconURL: () => null, memberCount: 10 }]));
  return {
    guilds: { cache },
    fetchInvite: vi.fn(),
  };
}

function buildMessage(authorId: string, client: any) {
  return { author: { id: authorId }, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWhitelist).mockResolvedValue({});
});

describe("whitelistExecutor — owner gate", () => {
  it("returns undefined for an unhandled tool", async () => {
    const r = await execute("not_whitelist", {}, buildMessage(OWNER, buildClient()), {});
    expect(r).toBeUndefined();
  });

  it("blocks whitelist_server for a non-owner and never mutates", async () => {
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "discord.gg/abc123" },
      buildMessage(NOT_OWNER, buildClient()),
      {},
    );
    expect(String(r)).toMatch(/only the bot owner/i);
    expect(addToWhitelist).not.toHaveBeenCalled();
  });

  it("blocks unwhitelist_server for a non-owner", async () => {
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "111111111111111111" },
      buildMessage(NOT_OWNER, buildClient()),
      {},
    );
    expect(String(r)).toMatch(/only the bot owner/i);
    expect(removeFromWhitelist).not.toHaveBeenCalled();
  });

  it("blocks list_whitelist for a non-owner", async () => {
    const r = await execute("list_whitelist", {}, buildMessage(NOT_OWNER, buildClient()), {});
    expect(String(r)).toMatch(/only the bot owner/i);
    expect(getWhitelist).not.toHaveBeenCalled();
  });
});

describe("whitelist_server (owner)", () => {
  it("requires an invite or id argument", async () => {
    const r = await execute("whitelist_server", { invite_or_id: "  " }, buildMessage(OWNER, buildClient()), {});
    expect(String(r)).toMatch(/provide a discord invite/i);
  });

  it("resolves an invite link, whitelists the resolved guild, and reports members", async () => {
    const client = buildClient();
    client.fetchInvite = vi.fn(async () => ({
      guild: { id: "guild-A", name: "Cool Server", iconURL: () => "icon", memberCount: 50 },
      memberCount: 50,
    }));
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "https://discord.gg/abc123" },
      buildMessage(OWNER, client),
      {},
    );
    expect(addToWhitelist).toHaveBeenCalledWith("guild-A", expect.objectContaining({
      name: "Cool Server", invited_by: OWNER,
    }));
    expect(String(r)).toContain("Cool Server");
    expect(String(r)).toContain("guild-A");
  });

  it("handles an invite that resolves to no guild", async () => {
    const client = buildClient();
    client.fetchInvite = vi.fn(async () => ({ guild: null }));
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "discord.gg/xyz" },
      buildMessage(OWNER, client),
      {},
    );
    expect(String(r)).toMatch(/couldn't resolve a server/i);
    expect(addToWhitelist).not.toHaveBeenCalled();
  });

  it("surfaces a fetchInvite failure as a friendly error", async () => {
    const client = buildClient();
    client.fetchInvite = vi.fn(async () => { throw new Error("Unknown Invite"); });
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "discord.gg/dead" },
      buildMessage(OWNER, client),
      {},
    );
    expect(String(r)).toMatch(/couldn't resolve that invite/i);
    expect(String(r)).toContain("Unknown Invite");
  });

  it("whitelists a bare numeric guild ID using cached guild info when present", async () => {
    const client = buildClient({ guilds: [{ id: "222222222222222222", name: "Known Guild" }] });
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "222222222222222222" },
      buildMessage(OWNER, client),
      {},
    );
    expect(addToWhitelist).toHaveBeenCalledWith("222222222222222222", expect.objectContaining({
      name: "Known Guild",
    }));
    expect(String(r)).toContain("Known Guild");
  });

  it("whitelists an unknown numeric ID with a placeholder name", async () => {
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "333333333333333333" },
      buildMessage(OWNER, buildClient()),
      {},
    );
    expect(addToWhitelist).toHaveBeenCalledWith("333333333333333333", expect.objectContaining({
      name: "Unknown (ID-only)",
    }));
  });

  it("rejects input that is neither an invite nor a guild ID", async () => {
    const r = await execute(
      "whitelist_server",
      { invite_or_id: "just some text" },
      buildMessage(OWNER, buildClient()),
      {},
    );
    expect(String(r)).toMatch(/doesn't look like a discord invite or guild id/i);
    expect(addToWhitelist).not.toHaveBeenCalled();
  });
});

describe("unwhitelist_server (owner)", () => {
  it("requires a guild id or name", async () => {
    const r = await execute("unwhitelist_server", { guild_id: "" }, buildMessage(OWNER, buildClient()), {});
    expect(String(r)).toMatch(/provide a guild id or server name/i);
  });

  it("removes a whitelisted ID and leaves the guild if the bot is in it", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({ "444444444444444444": { name: "Doomed" } });
    const client = buildClient({ guilds: [{ id: "444444444444444444", name: "Doomed" }] });
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "444444444444444444" },
      buildMessage(OWNER, client),
      {},
    );
    expect(removeFromWhitelist).toHaveBeenCalledWith("444444444444444444");
    expect(client.guilds.cache.get("444444444444444444").leave).toHaveBeenCalled();
    expect(String(r)).toMatch(/removed from whitelist and left/i);
  });

  it("leaves a non-whitelisted guild the bot still sits in (kick the bot out)", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({});
    const client = buildClient({ guilds: [{ id: "555555555555555555", name: "Sneaked In" }] });
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "555555555555555555" },
      buildMessage(OWNER, client),
      {},
    );
    expect(removeFromWhitelist).not.toHaveBeenCalled();
    expect(client.guilds.cache.get("555555555555555555").leave).toHaveBeenCalled();
    expect(String(r)).toMatch(/wasn't on the whitelist/i);
  });

  it("resolves a target by partial NAME match from the whitelist", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({ "666666666666666666": { name: "My Cool Lounge" } });
    const client = buildClient({ guilds: [{ id: "666666666666666666", name: "My Cool Lounge" }] });
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "cool lounge" },
      buildMessage(OWNER, client),
      {},
    );
    expect(removeFromWhitelist).toHaveBeenCalledWith("666666666666666666");
    expect(String(r)).toContain("My Cool Lounge");
  });

  it("reports no match when nothing resolves", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({});
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "nonexistent server" },
      buildMessage(OWNER, buildClient()),
      {},
    );
    expect(String(r)).toMatch(/no whitelisted server matching/i);
    expect(removeFromWhitelist).not.toHaveBeenCalled();
  });

  it("removes from whitelist without a leave when the bot isn't in the guild", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({ "777777777777777777": { name: "Remote" } });
    const r = await execute(
      "unwhitelist_server",
      { guild_id: "777777777777777777" },
      buildMessage(OWNER, buildClient()),
      {},
    );
    expect(removeFromWhitelist).toHaveBeenCalledWith("777777777777777777");
    expect(String(r)).toMatch(/removed from whitelist\./i);
  });
});

describe("list_whitelist (owner)", () => {
  it("reports an empty whitelist", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({});
    const r = await execute("list_whitelist", {}, buildMessage(OWNER, buildClient()), {});
    expect(String(r)).toMatch(/whitelist is empty/i);
  });

  it("lists entries with joined / not-joined status", async () => {
    vi.mocked(getWhitelist).mockResolvedValue({
      "888888888888888888": { name: "Joined Server", members: 100 },
      "999999999999999990": { name: "Pending Server" },
    });
    const client = buildClient({ guilds: [{ id: "888888888888888888", name: "Joined Server" }] });
    const r = await execute("list_whitelist", {}, buildMessage(OWNER, client), {});
    expect(String(r)).toContain("Joined Server");
    expect(String(r)).toMatch(/joined/i);
    expect(String(r)).toContain("Pending Server");
    expect(String(r)).toMatch(/not joined yet/i);
    expect(String(r)).toContain("~100 members");
  });
});
