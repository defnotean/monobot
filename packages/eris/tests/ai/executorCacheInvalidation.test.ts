import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getMarriage: vi.fn(),
  updateBalance: vi.fn(),
  deleteMarriage: vi.fn(),
  hasAchievement: vi.fn(),
  unlockAchievement: vi.fn(),
  getDailyChallenge: vi.fn(),
  getGameStats: vi.fn(),
  completeDailyChallenge: vi.fn(),
  getSupabase: vi.fn(),
  createTable: vi.fn(),
  buildLobbyEmbed: vi.fn(),
  resolveTable: vi.fn(),
  buildResultEmbed: vi.fn(),
  getTable: vi.fn(),
  joinTable: vi.fn(),
  buyLotteryTicket: vi.fn(),
  getLotteryState: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  default: {
    ownerId: "999999999999999999",
    botName: "eris-test",
  },
}));

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

vi.mock("../../database.js", () => ({
  getBalance: mocks.getBalance,
  getMarriage: mocks.getMarriage,
  updateBalance: mocks.updateBalance,
  deleteMarriage: mocks.deleteMarriage,
  hasAchievement: mocks.hasAchievement,
  unlockAchievement: mocks.unlockAchievement,
  getDailyChallenge: mocks.getDailyChallenge,
  getGameStats: mocks.getGameStats,
  completeDailyChallenge: mocks.completeDailyChallenge,
  getSupabase: mocks.getSupabase,
}));

vi.mock("../../ai/gameVisuals.js", () => ({
  balanceEmbed: () => ({ title: "balance" }),
  dailyChallengeEmbed: () => ({ embed: { title: "daily" }, row: null }),
}));

vi.mock("../../ai/poker.js", () => ({
  createTable: mocks.createTable,
  buildLobbyEmbed: mocks.buildLobbyEmbed,
  resolveTable: mocks.resolveTable,
  buildResultEmbed: mocks.buildResultEmbed,
  getTable: mocks.getTable,
  joinTable: mocks.joinTable,
}));

vi.mock("../../ai/lottery.js", () => ({
  buyLotteryTicket: mocks.buyLotteryTicket,
  getLotteryState: mocks.getLotteryState,
}));

// @ts-expect-error JS module without types
import { executeTool } from "../../ai/executor.js";

function makeMessage(userId = "111111111111111111") {
  return {
    author: { id: userId, displayName: `User ${userId.slice(-3)}` },
    guild: { id: "222222222222222222", members: { cache: new Map() } },
    channel: {
      id: "333333333333333333",
      send: vi.fn(async () => ({ id: "msg-1", edit: vi.fn(async () => {}) })),
    },
    content: "",
  } as any;
}

let cacheUserSeq = 1;

async function expectCallerBalanceInvalidatedBy(
  toolName: string,
  runTool: (message: any) => Promise<unknown>,
) {
  const userId = `11111111111111111${cacheUserSeq++}`;
  const message = makeMessage(userId);
  mocks.getBalance.mockResolvedValue({ balance: 100 });

  expect(await executeTool("check_balance", {}, message)).toContain("100 coins");
  expect(await executeTool("check_balance", {}, message)).toContain("100 coins");
  expect(mocks.getBalance).toHaveBeenCalledTimes(1);

  mocks.getBalance.mockResolvedValue({ balance: 250 });
  await runTool(message);

  expect(await executeTool("check_balance", {}, message)).toContain("250 coins");
  expect(mocks.getBalance).toHaveBeenCalledTimes(2);
  expect(toolName).toBeTruthy();
}

describe("Eris executor cache invalidation gaps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const fn of Object.values(mocks)) fn.mockReset();

    mocks.getSupabase.mockReturnValue(null);
    mocks.getBalance.mockResolvedValue({ balance: 100 });
    mocks.updateBalance.mockResolvedValue(100);
    mocks.hasAchievement.mockResolvedValue(false);
    mocks.unlockAchievement.mockResolvedValue(true);

    mocks.createTable.mockResolvedValue({
      ok: true,
      table: { ante: 50, pot: 50, players: new Set(["111111111111111111"]) },
    });
    mocks.buildLobbyEmbed.mockReturnValue({ embed: { setDescription: vi.fn() }, row: { type: 1 } });
    mocks.resolveTable.mockResolvedValue({ ok: false, reason: "not_enough_players" });
    mocks.buildResultEmbed.mockReturnValue(null);
    mocks.getTable.mockReturnValue(null);
    mocks.joinTable.mockResolvedValue({
      ok: true,
      table: { pot: 100, players: new Set(["111111111111111111", "444444444444444444"]) },
    });

    mocks.buyLotteryTicket.mockResolvedValue({
      ok: true,
      cost: 10,
      userTotal: 1,
      pot: 1000,
    });
    mocks.getLotteryState.mockResolvedValue({
      drawAt: Date.now() + 60_000,
      tickets: {},
      history: [],
    });

    mocks.getDailyChallenge.mockResolvedValue({
      id: "challenge-1",
      challenge_type: "coinflip_wins",
      challenge_target: 1,
      reward: 25,
      completed_by: [],
    });
    mocks.getGameStats.mockResolvedValue({ wins: 1, losses: 0 });
    mocks.completeDailyChallenge.mockResolvedValue(true);
  });

  it("buy_lottery_ticket clears the caller's cached balance", async () => {
    await expectCallerBalanceInvalidatedBy("buy_lottery_ticket", (message) =>
      executeTool("buy_lottery_ticket", { count: 1 }, message),
    );
  });

  it("start_poker clears the caller's cached balance", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as any);
    try {
      await expectCallerBalanceInvalidatedBy("start_poker", (message) =>
        executeTool("start_poker", { ante: 50 }, message),
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("join_poker clears the caller's cached balance", async () => {
    await expectCallerBalanceInvalidatedBy("join_poker", (message) =>
      executeTool("join_poker", {}, message),
    );
  });

  it("daily_challenge_complete clears the caller's cached balance", async () => {
    await expectCallerBalanceInvalidatedBy("daily_challenge_complete", (message) =>
      executeTool("daily_challenge_complete", {}, message),
    );
  });

  it("divorce clears the ex-partner's cached partner_status", async () => {
    const userId = "555555555555555555";
    const partnerId = "666666666666666666";
    const marriage = {
      user1_id: userId,
      user2_id: partnerId,
      married_at: new Date().toISOString(),
    };
    let married = true;
    mocks.getMarriage.mockImplementation(async () => (married ? marriage : null));
    mocks.getBalance.mockResolvedValue({ balance: 2000 });
    mocks.deleteMarriage.mockImplementation(async () => {
      married = false;
      return true;
    });

    const partnerMessage = makeMessage(partnerId);
    expect(await executeTool("partner_status", {}, partnerMessage)).toContain(`<@${userId}>`);
    expect(mocks.getMarriage).toHaveBeenCalledTimes(1);

    expect(await executeTool("divorce", {}, makeMessage(userId))).toContain(`divorced from <@${partnerId}>`);
    expect(mocks.getMarriage).toHaveBeenCalledTimes(2);

    expect(await executeTool("partner_status", {}, partnerMessage)).toBe("you're not married");
    expect(mocks.getMarriage).toHaveBeenCalledTimes(3);
  });
});
