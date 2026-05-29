import { describe, it, expect } from "vitest";
import { createRequire } from "module";

// agent-ui/renderer.js is a browser script. Its DOM/Monaco/agent bootstrap is
// guarded behind `typeof document/agent !== 'undefined'` so the file loads
// under CommonJS and exports its pure guard helpers for unit testing.
const require = createRequire(import.meta.url);
// @ts-expect-error - importing CJS JS module without types
const { looksDestructive, resolveInFolder } = require("../../agent-ui/renderer.js");

describe("renderer looksDestructive (plan-step gate)", () => {
  const destructive = [
    "rm -rf /",
    "Stop-Computer",
    "shutdown /s /t 0",
    "Remove-Item -Recurse -Force C:\\",
    "echo done && rm -rf ~/",
  ];
  const safe = ["npm install", "git pull", "node build.js", "ls"];

  it.each(destructive)("flags destructive plan step: %s", (cmd) => {
    expect(looksDestructive(cmd)).not.toBeNull();
  });
  it.each(safe)("allows safe plan step: %s", (cmd) => {
    expect(looksDestructive(cmd)).toBeNull();
  });
});

describe("renderer looksDestructive (typed-terminal confirm escalation)", () => {
  // termKey gates the manually-typed terminal through this same detector and,
  // on a match, prompts window.confirm() and forwards confirm:true so the owner
  // can still escalate a command they typed (instead of a silent host refusal).
  it("flags an owner-typed 'rm -rf ./build' so it requires confirm", () => {
    expect(looksDestructive("rm -rf ./build")).not.toBeNull();
  });
  it("flags an owner-typed 'shutdown /r' so it requires confirm", () => {
    expect(looksDestructive("shutdown /r")).not.toBeNull();
  });
  it("does not gate a routine typed command like 'npm run build'", () => {
    expect(looksDestructive("npm run build")).toBeNull();
  });
});

describe("renderer resolveInFolder (writeFile containment)", () => {
  it("resolves a relative path inside the folder (POSIX)", () => {
    expect(resolveInFolder("/home/u/proj", "src/app.js")).toBe("/home/u/proj/src/app.js");
  });

  it("resolves a nested relative path (Windows)", () => {
    expect(resolveInFolder("C:\\proj", "src\\app.js")).toBe("C:\\proj\\src\\app.js");
  });

  it("rejects parent-directory traversal", () => {
    expect(resolveInFolder("/home/u/proj", "../etc/passwd")).toBeNull();
  });

  it("rejects traversal that climbs out mid-path", () => {
    expect(resolveInFolder("/home/u/proj", "a/../../b")).toBeNull();
  });

  it("rejects an absolute POSIX path escape", () => {
    expect(resolveInFolder("/home/u/proj", "/etc/passwd")).toBeNull();
  });

  it("rejects an absolute Windows path escape", () => {
    expect(resolveInFolder("C:\\proj", "C:\\Windows\\System32\\x")).toBeNull();
  });

  it("rejects a UNC / backslash-rooted path escape", () => {
    expect(resolveInFolder("/home/u/proj", "\\\\server\\share")).toBeNull();
  });

  it("returns null when no folder is selected", () => {
    expect(resolveInFolder(null, "a.js")).toBeNull();
  });
});
