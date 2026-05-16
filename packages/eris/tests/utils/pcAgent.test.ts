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

// ─── Bypass-path coverage ───────────────────────────────────────────────────
// Each section maps directly to the audit-flagged bypass paths in
// docs/audits/AUDIT-pc-agent.md.

describe("pcAgent.looksDestructive — PowerShell aliases (audit bypass #1)", () => {
  const aliasBypasses = [
    "ri -Recurse -Force C:\\data",            // ri alias for Remove-Item
    "rd -Recurse -Force /",                    // rd alias used PS-style
    "Ri -Force -Recurse 'C:\\users\\foo'",    // case variation, flag order
    "del -Recurse -Force C:\\data",           // del alias for Remove-Item in PS
    "erase /s /q C:\\Windows",                // erase synonym for del
    "rd /s C:\\important",                    // rd shorthand for rmdir /s
  ];

  it.each(aliasBypasses)("flags PS alias bypass: %s", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).not.toBeNull();
  });
});

describe("pcAgent.looksDestructive — -EncodedCommand bypass (audit bypass #2)", () => {
  const encodedBypasses = [
    "powershell -EncodedCommand U3RvcC1Db21wdXRlcg==",
    "powershell.exe -EncodedCommand U3RvcC1Db21wdXRlcg==",
    "powershell -enc U3RvcC1Db21wdXRlcg==",   // abbreviated -enc
    "powershell -ec U3RvcC1Db21wdXRlcg==",    // abbreviated -ec
    "pwsh -EncodedCommand AAAA",              // pwsh (PS core)
    "PowerShell.exe -EncodedCommand AAAA",    // case variation
    "cmd /c shutdown",                         // cmd /c rebuild
    "cmd.exe /c set X=shutdown && %X%",       // env-substitution smuggling
  ];

  it.each(encodedBypasses)("flags encoded/cmd bypass: %s", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).not.toBeNull();
  });
});

describe("pcAgent.looksDestructive — chained operators (audit bypass #3)", () => {
  const chainedBypasses = [
    "echo hi && rm -rf /",                     // && chain
    "echo hi || rm -rf /",                     // || chain
    "echo hi ; rm -rf /",                      // ; chain
    "echo hi | rm -rf /",                      // pipe chain
    "cd /tmp && shutdown /s /t 0",            // chained shutdown
    "git status; Remove-Item -Recurse -Force C:\\",
    "ls && powershell -EncodedCommand AAAA",  // encoded after innocuous
    "cd /tmp; bash -c 'rm -fr ./'",           // nested -fr (reversed flags)
  ];

  it.each(chainedBypasses)("flags chained bypass: %s", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).not.toBeNull();
  });
});

describe("pcAgent.looksDestructive — unicode whitespace bypass (audit bypass #4)", () => {
  const unicodeBypasses = [
    "rm -rf /",                          // NBSP between rm and -rf
    "rm -rf /",                          // EM SPACE
    "rm ​-rf /",                         // ZERO WIDTH SPACE (after a real space)
    "rm　-rf /",                          // IDEOGRAPHIC SPACE
    "r‍m -rf /",                         // ZWJ inside command name
    "rm -rf /",                          // NBSP before path
    "shutdown /s /t 0",                  // NBSP after shutdown
    "Remove-Item -Recurse -Force C:\\",
  ];

  it.each(unicodeBypasses)("flags unicode-whitespace bypass: %s", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).not.toBeNull();
  });
});

describe("pcAgent.looksDestructive — safe commands still pass", () => {
  // Defense-in-depth: false positives are cheap but make sure obvious safe
  // commands aren't suddenly rejected by the broader patterns.
  const stillSafe = [
    "Get-ChildItem -Recurse C:\\Users",       // Recurse without Force is safe
    "Get-Process | Where-Object Name -like '*'",
    "echo hi && echo bye",                    // chained but innocuous
    "git rm somefile",                         // git rm is not POSIX rm
    "echo encoded base64 stuff",              // word "encoded" alone is fine
    "Get-Content readme.md",
  ];

  it.each(stillSafe)("does not flag: %s", async (cmd) => {
    const { looksDestructive } = await loadPcAgent();
    expect(looksDestructive(cmd)).toBeNull();
  });
});
