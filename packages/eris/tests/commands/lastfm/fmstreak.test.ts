// Tests for /fmstreak — daily scrobble streak
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getStreakData: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmstreak.js";
import { getStreakData } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedStreak = vi.mocked(getStreakData);
const mockedGetFmUser = vi.mocked(getFmUser);

describe("/fmstreak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prompts the caller to link when they have no account", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    const me = makeUser({ id: "me" });
    const interaction = makeInteraction({ user: me });

    await execute(interaction);

    expect(mockedStreak).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/you haven't linked/i);
  });

  it("uses a different message when the target user (not caller) is unlinked", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    const interaction = makeInteraction({ user: me, options: { user: other } });

    await execute(interaction);

    // looks up the target, not the caller
    expect(mockedGetFmUser).toHaveBeenCalledWith("other");
    expect(getLastReplyContent(interaction)).toMatch(/bob hasn't linked/i);
  });

  it("surfaces last.fm API errors", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedStreak.mockRejectedValue(new Error("rate limited"));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/last\.fm error: rate limited/i);
  });

  it("renders an active streak with today's count", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedStreak.mockResolvedValue(/** @type any */({ current: 42, active: true, todayCount: 7 }));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.description).toContain("42");
    expect(embed.description).toMatch(/and counting/i);
    expect(embed.description).toMatch(/7 scrobbles today/i);
    // active uses the FM red color
    expect(embed.color).toBe(0xD51007);
  });

  it("renders a no-active-streak state with the muted color", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedStreak.mockResolvedValue(/** @type any */({ current: 0, active: false, todayCount: 0 }));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.description).toMatch(/no active streak/i);
    expect(embed.color).toBe(0x6B7280);
  });
});
