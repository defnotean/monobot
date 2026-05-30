// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the (hoisted) vi.mock factories can reference these mocks.
const leveling = vi.hoisted(() => ({
  getLeaderboard: vi.fn(),
  getXpData: vi.fn(),
}));
vi.mock("../../../utils/leveling.js", () => leveling);

const pagination = vi.hoisted(() => ({ paginate: vi.fn(async () => {}) }));
vi.mock("../../../utils/pagination.js", () => pagination);

// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/leaderboard.js";

beforeEach(() => {
  leveling.getLeaderboard.mockReset();
  leveling.getXpData.mockReset();
  pagination.paginate.mockReset();
  leveling.getXpData.mockReturnValue({ xp: 0, level: 1, totalXp: 50 });
});

function makeEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i}`,
    level: n - i,
    totalXp: (n - i) * 100,
  }));
}

describe("fun/leaderboard", () => {
  it("replies with an empty-state message when there are no entries", async () => {
    leveling.getLeaderboard.mockReturnValue([]);
    const interaction = makeInteraction({});
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(pagination.paginate).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toContain("nothing to show");
    expect(lastReply(interaction).flags).toBe(64);
  });

  it("replies directly (no pagination) for 10 or fewer entries, with medals on top 3", async () => {
    leveling.getLeaderboard.mockReturnValue(makeEntries(3));
    const interaction = makeInteraction({ user: makeUser({ id: "u0" }) });
    await cmd.execute(interaction);

    expect(pagination.paginate).not.toHaveBeenCalled();
    const text = repliedText(interaction);
    expect(text).toContain("🥇");
    expect(text).toContain("🥈");
    expect(text).toContain("🥉");
    expect(text).toContain("Level 3");
  });

  it("shows the caller's rank in the footer when they are on the board", async () => {
    leveling.getLeaderboard.mockReturnValue(makeEntries(2));
    leveling.getXpData.mockReturnValue({ xp: 0, level: 7, totalXp: 777 });
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }) }); // index 1 -> rank #2
    await cmd.execute(interaction);
    const footer = lastReply(interaction).embeds[0].data.footer.text;
    expect(footer).toContain("Your rank: #2");
    expect(footer).toContain("777");
  });

  it("delegates to paginate when there are more than 10 entries", async () => {
    const entries = makeEntries(25);
    leveling.getLeaderboard.mockReturnValue(entries);
    const interaction = makeInteraction({ user: makeUser({ id: "u0" }) });
    await cmd.execute(interaction);

    expect(pagination.paginate).toHaveBeenCalledTimes(1);
    const [, opts] = pagination.paginate.mock.calls[0];
    expect(opts.itemsPerPage).toBe(10);
    expect(opts.items).toBe(entries);
    expect(typeof opts.formatPage).toBe("function");
    // Direct reply must NOT have happened on the paginated path.
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
