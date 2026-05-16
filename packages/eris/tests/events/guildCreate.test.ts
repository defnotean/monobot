import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Module mocks ────────────────────────────────────────────────────────
// guildCreate imports the logger, config, and database. We mock all three so
// the test stays pure-in-memory and we can assert on log lines + whitelist
// side effects. vi.mock is hoisted to the top of the file, so any state the
// mock factories close over has to live inside vi.hoisted() to be visible
// when the factory runs.
const { logCalls, whitelist, isWhitelistedMock, addToWhitelistMock, OWNER_ID } = vi.hoisted(() => {
  const ownerId = "123456789012345678";
  const calls: string[] = [];
  const wl = new Set<string>();
  return {
    OWNER_ID: ownerId,
    logCalls: calls,
    whitelist: wl,
    isWhitelistedMock: vi.fn(async (id: string) => wl.has(id)),
    addToWhitelistMock: vi.fn(async (id: string, _info: any) => { wl.add(id); return true; }),
  };
});

vi.mock("../../utils/logger.js", () => ({
  log: (msg: string) => { logCalls.push(msg); },
}));

vi.mock("../../config.js", () => ({
  default: { ownerId: OWNER_ID },
}));

vi.mock("../../database.js", () => ({
  isWhitelisted: (id: string) => isWhitelistedMock(id),
  addToWhitelist: (id: string, info: any) => addToWhitelistMock(id, info),
}));

// @ts-expect-error - importing JS module without types
import guildCreate from "../../events/guildCreate.js";

// ─── Fixture builders ────────────────────────────────────────────────────
function makeGuild(overrides: Partial<{
  id: string;
  name: string;
  ownerId: string;
  memberCount: number;
  ownerInMembers: boolean;
  iconURL: ((opts?: any) => string | null) | null;
}> = {}) {
  const id = overrides.id ?? "guild-1";
  const name = overrides.name ?? "Test Guild";
  const ownerId = overrides.ownerId ?? "other-owner";
  const memberCount = overrides.memberCount ?? 42;
  const ownerCached = overrides.ownerInMembers ? { id: OWNER_ID } : undefined;

  const leave = vi.fn(async () => {});
  const fetchAuditLogs = vi.fn(async () => ({ entries: { first: () => null } }));
  const usersFetch = vi.fn(async () => ({ username: "the-owner" }));

  return {
    id,
    name,
    ownerId,
    memberCount,
    iconURL: overrides.iconURL === null ? undefined : (overrides.iconURL ?? (() => "https://cdn/icon.png")),
    members: {
      cache: new Map(ownerCached ? [[OWNER_ID, ownerCached]] : []),
      fetch: vi.fn(async () => { throw new Error("not found"); }),
    },
    fetchAuditLogs,
    leave,
    client: { users: { fetch: usersFetch } },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────
describe("events/guildCreate", () => {
  beforeEach(() => {
    logCalls.length = 0;
    whitelist.clear();
    isWhitelistedMock.mockClear();
    addToWhitelistMock.mockClear();
  });

  it("logs the new-guild join with name, member count, and ID", async () => {
    const guild = makeGuild({ id: "g-log", name: "Cool Server", memberCount: 99, ownerId: OWNER_ID });
    await guildCreate(guild as any);
    const joinLog = logCalls.find((l) => l.startsWith("[BOT] Joined new server"));
    expect(joinLog).toBeDefined();
    expect(joinLog).toContain("Cool Server");
    expect(joinLog).toContain("g-log");
    expect(joinLog).toContain("99 members");
  });

  it("auto-tracks an allowed guild into the whitelist (owner is guild owner)", async () => {
    const guild = makeGuild({ id: "g-allowed", name: "Owner's Server", ownerId: OWNER_ID });
    await guildCreate(guild as any);
    expect(addToWhitelistMock).toHaveBeenCalledTimes(1);
    expect(addToWhitelistMock).toHaveBeenCalledWith("g-allowed", expect.objectContaining({
      name: "Owner's Server",
      invited_by: "auto-tracked-on-join",
    }));
    expect(whitelist.has("g-allowed")).toBe(true);
    expect(guild.leave).not.toHaveBeenCalled();
  });

  it("does not re-add a guild that is already whitelisted", async () => {
    whitelist.add("g-existing");
    const guild = makeGuild({ id: "g-existing", ownerId: "stranger" });
    await guildCreate(guild as any);
    // Already-whitelisted path passes isGuildAllowed via the whitelist check
    // and must NOT call addToWhitelist a second time.
    expect(addToWhitelistMock).not.toHaveBeenCalled();
    expect(guild.leave).not.toHaveBeenCalled();
  });

  it("does not crash when iconURL is missing on the guild object", async () => {
    const guild = makeGuild({ id: "g-no-icon", ownerId: OWNER_ID, iconURL: null });
    await expect(guildCreate(guild as any)).resolves.not.toThrow();
    expect(addToWhitelistMock).toHaveBeenCalledWith("g-no-icon", expect.objectContaining({
      icon_url: null,
    }));
  });

  it("leaves and logs gatekeep when guild is not on the allow list (no owner, no whitelist)", async () => {
    const guild = makeGuild({ id: "g-bad", name: "Sketchy Server", ownerId: "stranger" });
    await guildCreate(guild as any);
    expect(guild.leave).toHaveBeenCalledTimes(1);
    expect(addToWhitelistMock).not.toHaveBeenCalled();
    const gatekeepLog = logCalls.find((l) => l.startsWith("[GATEKEEP] Unauthorized server"));
    expect(gatekeepLog).toBeDefined();
    expect(gatekeepLog).toContain("Sketchy Server");
    expect(gatekeepLog).toContain("g-bad");
  });

  it("treats a guild as allowed when the owner is a cached member (invited it themselves)", async () => {
    const guild = makeGuild({ id: "g-invited", ownerId: "someone-else", ownerInMembers: true });
    await guildCreate(guild as any);
    // Owner is a member → allowed → tracked, not left.
    expect(guild.leave).not.toHaveBeenCalled();
    expect(addToWhitelistMock).toHaveBeenCalledTimes(1);
    expect(whitelist.has("g-invited")).toBe(true);
  });
});
