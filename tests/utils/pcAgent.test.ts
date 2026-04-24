import { describe, it, expect, beforeEach, vi } from "vitest";

// Force PC agent enabled and isolate config state per test.
beforeEach(() => {
  vi.resetModules();
  process.env.PC_AGENT_DISABLED = "0";
  process.env.DISCORD_TOKEN ||= "test-token";
});

async function loadPcAgent() {
  // @ts-expect-error - importing JS module without types
  return await import("../../utils/pcAgent.js");
}

describe("pcAgent.looksDestructive", () => {
  const destructive = [
    "rm -rf /",
    "rm -rf ~/important",
    "rm -rf .",
    "del /s /q C:\\Users\\me",
    "rmdir /s c:\\data",
    "format c:",
    "diskpart",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown /s /t 0",
    "reg delete HKLM\\Software\\Microsoft /f",
    "Remove-Item -Path 'C:\\' -Recurse -Force",
    "Stop-Computer",
    "mkfs.ext4 /dev/sda1",
  ];

  const safe = [
    "ls -la",
    "git status",
    "node --version",
    "Get-ChildItem C:\\Users",
    "echo hello",
    "npm test",
    "dir",
    "type README.md",
  ];

  it.each(destructive)("flags %s as destructive", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).not.toBeNull();
  });

  it.each(safe)("does not flag %s as destructive", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).toBeNull();
  });
});

describe("pcAgent.gateShellCommand", () => {
  it("allows a safe command through", async () => {
    const { gateShellCommand } = await loadPcAgent();
    expect(gateShellCommand("ls -la", {}).ok).toBe(true);
  });

  it("blocks a destructive command without confirm", async () => {
    const { gateShellCommand } = await loadPcAgent();
    const r = gateShellCommand("rm -rf /", {});
    expect(r.ok).toBe(false);
  });

  it("allows a destructive command when confirm: true", async () => {
    const { gateShellCommand } = await loadPcAgent();
    expect(gateShellCommand("rm -rf /tmp", { confirm: true }).ok).toBe(true);
  });

  it("blocks everything when PC_AGENT_DISABLED=1", async () => {
    process.env.PC_AGENT_DISABLED = "1";
    vi.resetModules();
    const { gateShellCommand, isPcAgentEnabled } = await loadPcAgent();
    expect(isPcAgentEnabled()).toBe(false);
    const r = gateShellCommand("ls", {});
    expect(r.ok).toBe(false);
  });
});
