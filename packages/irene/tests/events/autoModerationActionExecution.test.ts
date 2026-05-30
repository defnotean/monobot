import { describe, it, expect, beforeEach, vi } from "vitest";

// autoModerationActionExecution logs an auto-mod hit to the mod-log. We mock the
// mod-log sender and logEvent (pass-through so we can read the structured payload
// the handler built) and exercise: action/trigger label resolution (known +
// unknown codes), user resolution success/failure, timeout-duration + matched
// keyword/content branches, and the content -> "Full Content" field branch.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));

// logEvent is the embed factory; replace with identity so the test sees exactly
// what the handler passed (title/description/meta/fields/color/footerNote).
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/autoModerationActionExecution.js";

function makeExecution(overrides: any = {}) {
  const usersFetch = vi.fn(async () => ({ tag: "rule-breaker#0001", id: "u-1" }));
  return {
    userId: "u-1",
    channelId: "c-1",
    ruleId: "r-1",
    ruleName: "No slurs",
    ruleTriggerType: 1,
    matchedKeyword: null,
    matchedContent: null,
    content: null,
    action: { type: 1, metadata: {} },
    guild: { client: { users: { fetch: (...a: any[]) => usersFetch(...a) } } },
    _usersFetch: usersFetch,
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("autoModerationActionExecution", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("autoModerationActionExecution");
  });

  it("sends one mod-log with the resolved action + trigger labels and user tag", async () => {
    const ex = makeExecution({ action: { type: 3, metadata: { durationSeconds: 600 } }, ruleTriggerType: 5 });
    await execute(ex);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(sendModLog.mock.calls[0][0]).toBe(ex.guild);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Auto-Mod · Timeout");
    expect(payload.meta["Trigger Type"]).toBe("Mention Spam");
    expect(payload.meta["Action Taken"]).toBe("Timeout");
    // timeout-duration branch active because action.type === 3 + durationSeconds
    expect(payload.meta["Timeout Duration"]).toBe("600s");
    // user resolved -> tag shows in the User meta line
    expect(payload.meta["User"]).toContain("rule-breaker#0001");
  });

  it("falls back to numeric labels for unknown action/trigger codes", async () => {
    const ex = makeExecution({ action: { type: 99, metadata: {} }, ruleTriggerType: 42 });
    await execute(ex);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Auto-Mod · Action 99");
    expect(payload.meta["Trigger Type"]).toBe("Trigger 42");
  });

  it("omits the user tag when the user fetch resolves to null", async () => {
    const ex = makeExecution();
    ex._usersFetch.mockResolvedValueOnce(null);
    await execute(ex);
    const payload = logEvent.mock.calls[0][0];
    // no tag segment, just the mention + raw id
    expect(payload.meta["User"]).toBe("<@u-1> · `u-1`");
  });

  it("adds a Full Content field only when execution.content is present", async () => {
    const withContent = makeExecution({ content: "bad words here" });
    await execute(withContent);
    expect(logEvent.mock.calls[0][0].fields[0]).toMatchObject({ name: "Full Content", value: "bad words here" });

    logEvent.mockClear();
    sendModLog.mockClear();
    const withoutContent = makeExecution({ content: null });
    await execute(withoutContent);
    expect(logEvent.mock.calls[0][0].fields).toBeUndefined();
  });

  it("renders matched keyword/content meta only when supplied; omits timeout duration for non-timeout actions", async () => {
    const ex = makeExecution({
      action: { type: 1, metadata: {} }, // Block Message — not a timeout
      matchedKeyword: "slur",
      matchedContent: "a long matched bit of content",
    });
    await execute(ex);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.meta["Matched Keyword"]).toBe("`slur`");
    expect(payload.meta["Matched Content"]).toContain("a long matched bit of content");
    expect(payload.meta["Timeout Duration"]).toBeNull();
  });
});
