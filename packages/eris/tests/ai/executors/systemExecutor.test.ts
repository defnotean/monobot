import { describe, it, expect, vi, beforeEach } from "vitest";

// This test exercises the destructive-command GATE, which only runs when the
// PC agent is enabled. A deployed .env may set PC_AGENT_DISABLED=1 (a stronger,
// separate kill switch); config caches that at load and process.env wins over
// .env, so we force the switch OFF here BEFORE config.js is imported. Without
// this the executor short-circuits with the kill-switch message and the gate
// is never reached.
vi.hoisted(() => { process.env.PC_AGENT_DISABLED = "0"; });

// The fixed-shape PC-agent tools (launch_app / browse_files / system_info /
// list_processes) now route their constructed command strings through the same
// looksDestructive gate as execute_terminal. We mock the owner check and the
// queue so we can assert: a malicious launch_app is blocked and never queued,
// while benign tools queue normally.

vi.mock("../../../utils/permissions.js", () => ({
  isOwner: vi.fn(() => true),
  denyMessage: vi.fn(() => "denied"),
}));

vi.mock("../../../database.js", () => ({
  queueLocalCommand: vi.fn(async () => true),
}));

// auditLog hits Supabase/disk; stub it so tests stay offline. Keep the real
// gate/kill-switch logic (gateShellCommand, isPcAgentEnabled). The kill switch
// is forced enabled via the PC_AGENT_DISABLED=0 hoisted set above.
vi.mock("../../../utils/pcAgent.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, auditLog: vi.fn(async () => {}) };
});

import { execute } from "../../../ai/executors/systemExecutor.js";
import * as db from "../../../database.js";

const mockQueue = db.queueLocalCommand as unknown as ReturnType<typeof vi.fn>;

const message = {
  author: { id: "123456789012345678" },
  guild: { id: "g" },
  channel: { id: "c" },
};

describe("systemExecutor fixed-shape tool gating", () => {
  beforeEach(() => {
    process.env.PC_AGENT_DISABLED = "0";
    vi.clearAllMocks();
  });

  it("blocks launch_app that smuggles Stop-Computer and never queues it", async () => {
    const result = await execute(
      "launch_app",
      { app: "powershell", args: "-Command Stop-Computer" },
      message,
      {}
    );
    expect(String(result)).toMatch(/destructive/i);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("blocks launch_app that smuggles shutdown", async () => {
    const result = await execute(
      "launch_app",
      { app: "shutdown", args: "/s /t 0" },
      message,
      {}
    );
    expect(String(result)).toMatch(/destructive/i);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("allows a benign launch_app and queues it", async () => {
    const result = await execute("launch_app", { app: "notepad" }, message, {});
    expect(String(result)).toMatch(/queued/i);
    expect(mockQueue).toHaveBeenCalledTimes(1);
  });

  it("blocks browse_files when the path smuggles a destructive command", async () => {
    const result = await execute(
      "browse_files",
      { path: "C:\\; Stop-Computer" },
      message,
      {}
    );
    expect(String(result)).toMatch(/destructive/i);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("allows a benign browse_files and queues it", async () => {
    const result = await execute("browse_files", { path: "~" }, message, {});
    expect(String(result)).toMatch(/queued/i);
    expect(mockQueue).toHaveBeenCalledTimes(1);
  });

  it("does not false-flag system_info (plain -Command is allowed)", async () => {
    const result = await execute("system_info", {}, message, {});
    expect(String(result)).toMatch(/queued/i);
    expect(mockQueue).toHaveBeenCalledTimes(1);
  });

  it("does not false-flag list_processes", async () => {
    const result = await execute("list_processes", { filter: "node" }, message, {});
    expect(String(result)).toMatch(/queued/i);
    expect(mockQueue).toHaveBeenCalledTimes(1);
  });
});
