import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";

const mocks = vi.hoisted(() => ({
  getRules: vi.fn(),
  isAutoModEnabled: vi.fn(() => true),
  isUserExempt: vi.fn(() => false),
  recordViolation: vi.fn(),
  getRecentViolations: vi.fn(() => []),
  analyzeMessage: vi.fn(),
  decideAction: vi.fn(),
  sendModLog: vi.fn(async () => {}),
  log: vi.fn(),
}));

vi.mock("../../database.js", () => ({
  getRules: mocks.getRules,
  isAutoModEnabled: mocks.isAutoModEnabled,
  isUserExempt: mocks.isUserExempt,
  recordViolation: mocks.recordViolation,
  getRecentViolations: mocks.getRecentViolations,
}));
vi.mock("../../ai/rulesDetector.js", () => ({ analyzeMessage: mocks.analyzeMessage }));
vi.mock("../../ai/rulesEscalation.js", () => ({ decideAction: mocks.decideAction }));
vi.mock("../../utils/logger.js", () => ({ sendModLog: mocks.sendModLog, log: mocks.log }));

// @ts-expect-error — JS module without types
import { enforceMessage } from "../../ai/rulesEnforcer.js";

let sequence = 0;

function makeMessage() {
  const id = `user-${++sequence}`;
  const member = { moderatable: true, timeout: vi.fn(async () => {}) };
  return {
    id: `message-${sequence}`,
    guildId: "guild-1",
    channelId: "channel-1",
    content: "the detective is the murderer",
    author: {
      id,
      tag: `member-${sequence}`,
      username: `member-${sequence}`,
      bot: false,
      send: vi.fn(async () => {}),
    },
    member: null,
    client: {},
    delete: vi.fn(async () => {}),
    channel: { messages: { cache: new Collection() } },
    guild: {
      id: "guild-1",
      name: "test guild",
      ownerId: "owner",
      members: { cache: new Collection([[id, member]]) },
    },
    _testMember: member,
  };
}

describe("rules enforcer model-only review boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAutoModEnabled.mockReturnValue(true);
    mocks.isUserExempt.mockReturnValue(false);
    mocks.getRecentViolations.mockReturnValue([]);
    mocks.getRules.mockReturnValue([{ number: 7, text: "no story spoilers", severity: "high" }]);
  });

  it("logs an uncorroborated custom-rule hit without punishing or accumulating escalation", async () => {
    mocks.analyzeMessage.mockResolvedValue({
      violation: true,
      ruleNumber: 7,
      severity: "high",
      corroborated: false,
      corroboration: [],
      explanation: "possible spoiler",
    });
    const message = makeMessage();

    await expect(enforceMessage(message)).resolves.toBe(true);

    expect(mocks.decideAction).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
    expect(message._testMember.timeout).not.toHaveBeenCalled();
    expect(message.author.send).not.toHaveBeenCalled();
    expect(mocks.recordViolation).not.toHaveBeenCalled();
    expect(mocks.sendModLog).toHaveBeenCalledOnce();
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining("review only"));
  });

  it("preserves normal enforcement for a locally corroborated matching rule", async () => {
    mocks.analyzeMessage.mockResolvedValue({
      violation: true,
      ruleNumber: 7,
      severity: "high",
      corroborated: true,
      corroboration: ["threat"],
      explanation: "direct threat",
    });
    mocks.decideAction.mockReturnValue({
      kind: "delete_and_timeout",
      deleteMessage: true,
      timeoutMs: 600_000,
      reason: "rule #7",
    });
    const message = makeMessage();

    await expect(enforceMessage(message)).resolves.toBe(true);

    expect(mocks.decideAction).toHaveBeenCalledOnce();
    expect(message.delete).toHaveBeenCalledOnce();
    expect(message._testMember.timeout).toHaveBeenCalledOnce();
    expect(mocks.recordViolation).toHaveBeenCalledOnce();
  });
});
