import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orchestratorSource = readFileSync(new URL("../../../events/messageCreate.js", import.meta.url), "utf8");
const aiTurnSource = readFileSync(new URL("../../../events/messageCreate/aiTurn.js", import.meta.url), "utf8");

function indexOfOrThrow(source: string, needle: string) {
  const index = source.indexOf(needle);
  expect(index, `missing orchestration marker: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

function expectInOrder(source: string, markers: string[]) {
  let previous = -1;
  for (const marker of markers) {
    const index = indexOfOrThrow(source, marker);
    expect(index, `marker out of order: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("messageCreate orchestrator order", () => {
  it("keeps passive features before DM/context build", () => {
    expectInOrder(orchestratorSource, [
      "if (await handleSleepWake(message)) return;",
      "await maybeAutoTts(message);",
      "await runPassiveSideEffects({ message, isDM });",
      "const ctx = await resolveDMContext(message);",
      "if (await handleTtsToggleShortcut({ message, content, isDM, isAdmin })) return;",
      "const { guild, msgCtx } = await buildMessageContext(message, { isDM, dmGuild });",
      "const ctxResult = await buildSystemPrompt(message, {",
      "await runLockedAiTurn({",
    ]);
  });

  it("keeps ack/status lifecycle around AI execution and render cleanup", () => {
    expectInOrder(aiTurnSource, [
      "const ackStatus = createAckStatusState();",
      "startAckTimer(ackStatus,",
      "onToolStatus: createToolStatusHandler(ackStatus,",
      "cancelAckTimer(ackStatus);",
      "await cleanupAckStatus(ackStatus, toolsUsed);",
      "await sendReplyChunks(message, chunks);",
      "await deleteStatusOnError(ackStatus);",
    ]);
  });
});
