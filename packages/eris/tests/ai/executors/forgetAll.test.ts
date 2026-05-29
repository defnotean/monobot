// Right-to-be-forgotten regression — forget_all must clear BOTH the facts table
// AND the searchable episodic/semantic store. Clearing only facts previously
// left every emotional disclosure recoverable in the vector store forever. This
// suite proves:
//   - forget_all deletes facts AND calls the episodic delete-by-user
//   - the episodic delete is scoped to (botId, userId)
//   - partial-failure reporting: if EITHER leg fails, we report a partial wipe
//     instead of falsely claiming a clean slate

import { describe, it, expect, beforeEach, vi } from "vitest";

const clearAllFacts = vi.fn();
const deleteEpisodicMemoriesForUser = vi.fn();

vi.mock("../../../database.js", () => ({
  // memoryExecutor imports the whole namespace; only forget_all's deps matter here.
  clearAllFacts: (...args: unknown[]) => clearAllFacts(...args),
  getFacts: vi.fn(async () => []),
  saveFact: vi.fn(async () => true),
  deleteFactByText: vi.fn(),
  getUserPreferences: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock("../../../ai/semantic.js", () => ({
  deleteEpisodicMemoriesForUser: (...args: unknown[]) => deleteEpisodicMemoriesForUser(...args),
}));

vi.mock("../../../config.js", () => ({
  default: { botName: "test-eris" },
}));

// memory.js is imported by the executor (addMemory) — stub so the module graph
// resolves without touching real db.
vi.mock("../../../ai/memory.js", () => ({
  addMemory: vi.fn(async () => ({ success: true, message: "ok" })),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/memoryExecutor.js";

const message = { author: { id: "u-forget" } } as any;

beforeEach(() => {
  clearAllFacts.mockReset();
  deleteEpisodicMemoriesForUser.mockReset();
});

describe("forget_all clears both facts and episodic memories", () => {
  it("deletes facts AND the episodic store, scoped to (botId, userId)", async () => {
    clearAllFacts.mockResolvedValue(true);
    deleteEpisodicMemoriesForUser.mockResolvedValue({ ok: true, deleted: 7 });

    const out = await execute("forget_all", {}, message, {});

    expect(clearAllFacts).toHaveBeenCalledWith("u-forget");
    // The episodic purge MUST be invoked — this is the gap the task closes.
    expect(deleteEpisodicMemoriesForUser).toHaveBeenCalledTimes(1);
    expect(deleteEpisodicMemoriesForUser).toHaveBeenCalledWith("test-eris", "u-forget");
    // Full success → clean-slate message
    expect(out).toMatch(/clean slate/i);
  });

  it("reports PARTIAL when the episodic delete fails (facts ok)", async () => {
    clearAllFacts.mockResolvedValue(true);
    deleteEpisodicMemoriesForUser.mockResolvedValue({ ok: false, deleted: 0, error: "boom" });

    const out = await execute("forget_all", {}, message, {});

    // Never claim a clean slate when half the data survived.
    expect(out).not.toMatch(/clean slate/i);
    expect(out).toMatch(/partly done/i);
    expect(out).toMatch(/conversation memories/i);
  });

  it("reports PARTIAL when the facts delete fails (episodic ok)", async () => {
    clearAllFacts.mockResolvedValue(false);
    deleteEpisodicMemoriesForUser.mockResolvedValue({ ok: true, deleted: 3 });

    const out = await execute("forget_all", {}, message, {});

    expect(out).not.toMatch(/clean slate/i);
    expect(out).toMatch(/partly done/i);
    expect(out).toMatch(/saved facts/i);
  });

  it("reports total failure when BOTH legs fail", async () => {
    clearAllFacts.mockResolvedValue(false);
    deleteEpisodicMemoriesForUser.mockResolvedValue({ ok: false, deleted: 0, error: "boom" });

    const out = await execute("forget_all", {}, message, {});
    expect(out).toBe("couldn't clear memories");
  });
});
