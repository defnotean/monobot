import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordJoinMock, logMock } = vi.hoisted(() => ({
  recordJoinMock: vi.fn(async () => {}),
  logMock: vi.fn(),
}));

vi.mock("../../ai/bumpCorrelation.js", () => ({
  recordJoinForCorrelation: recordJoinMock,
}));

vi.mock("../../utils/logger.js", () => ({ log: logMock }));

// @ts-expect-error - importing JS module without types
import guildMemberAdd from "../../events/guildMemberAdd.js";

function makeMember(overrides: any = {}) {
  return {
    id: "member-1",
    guild: { id: "guild-1" },
    user: { bot: false },
    joinedTimestamp: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  recordJoinMock.mockReset();
  recordJoinMock.mockResolvedValue(undefined);
  logMock.mockReset();
});

describe("guildMemberAdd", () => {
  it("records a join correlation for a real human member", async () => {
    await guildMemberAdd(makeMember());
    expect(recordJoinMock).toHaveBeenCalledTimes(1);
    expect(recordJoinMock).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "member-1",
      joinedAtMs: 1_700_000_000_000,
      botName: "eris",
    });
  });

  it("falls back to Date.now() when joinedTimestamp is missing", async () => {
    const before = Date.now();
    await guildMemberAdd(makeMember({ joinedTimestamp: undefined }));
    const arg = recordJoinMock.mock.calls[0][0];
    expect(arg.joinedAtMs).toBeGreaterThanOrEqual(before);
  });

  it("ignores bot joins (no correlation recorded)", async () => {
    await guildMemberAdd(makeMember({ user: { bot: true } }));
    expect(recordJoinMock).not.toHaveBeenCalled();
  });

  it("ignores members with no guild id", async () => {
    await guildMemberAdd(makeMember({ guild: {} }));
    expect(recordJoinMock).not.toHaveBeenCalled();
  });

  it("ignores members with no member id", async () => {
    await guildMemberAdd(makeMember({ id: undefined }));
    expect(recordJoinMock).not.toHaveBeenCalled();
  });

  it("ignores a null/undefined member without throwing", async () => {
    await expect(guildMemberAdd(undefined)).resolves.toBeUndefined();
    expect(recordJoinMock).not.toHaveBeenCalled();
  });

  it("swallows errors from the correlation recorder and logs them", async () => {
    recordJoinMock.mockRejectedValueOnce(new Error("db down"));
    await expect(guildMemberAdd(makeMember())).resolves.toBeUndefined();
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(String(logMock.mock.calls[0][0])).toMatch(/correlation record failed.*db down/i);
  });
});
