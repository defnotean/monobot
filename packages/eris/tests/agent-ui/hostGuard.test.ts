import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { createHmac } from "crypto";

// agent-ui/main.js is a CommonJS Electron module. Its `require('electron')` is
// guarded so the file still loads outside Electron, exporting the pure
// host-side guard helpers (looksDestructive, verifyLocalCommand). We load it
// here to test those points-of-effect in isolation — no Electron, no Supabase.
const require = createRequire(import.meta.url);
// @ts-expect-error - importing CJS JS module without types
const { looksDestructive, verifyLocalCommand } = require("../../agent-ui/main.js");

describe("agent-ui host looksDestructive (ported copy)", () => {
  const destructive = [
    "rm -rf /",
    "rm -rf ~/important",
    "del /s /q C:\\Users\\me",
    "format c:",
    "Stop-Computer",
    "Restart-Computer",
    "Remove-Item -Path 'C:\\' -Recurse -Force",
    "powershell -EncodedCommand U3RvcC1Db21wdXRlcg==",
    "echo hi && rm -rf /",          // chained
    "git status; Remove-Item -Recurse -Force C:\\",
    "rm　-rf /",                      // ideographic-space bypass
  ];
  const safe = [
    "ls -la",
    "git status",
    "node --version",
    "Get-ChildItem -Recurse C:\\Users", // Recurse without Force is fine
    'powershell -Command "Get-Process | ConvertTo-Json"',
  ];

  it.each(destructive)("flags %s", (cmd) => {
    expect(looksDestructive(cmd)).not.toBeNull();
  });
  it.each(safe)("does not flag %s", (cmd) => {
    expect(looksDestructive(cmd)).toBeNull();
  });
});

describe("agent-ui verifyLocalCommand (local_commands auth)", () => {
  const ownerId = "123456789012345678";
  const secret = "test-twin-secret";

  function sign(requested_by: string, command: string, ts: number) {
    return createHmac("sha256", secret)
      .update(`${requested_by}.${command}.${ts}`)
      .digest("hex");
  }

  function row(over: Record<string, unknown> = {}) {
    const ts = Date.now();
    const command = "ls -la";
    return {
      requested_by: ownerId,
      command,
      ts,
      sig: sign(ownerId, command, ts),
      ...over,
    };
  }

  it("accepts a correctly signed owner row", () => {
    expect(verifyLocalCommand(row(), { ownerId, secret }).ok).toBe(true);
  });

  it("rejects a row from a non-owner requester", () => {
    const ts = Date.now();
    const r = verifyLocalCommand(
      { requested_by: "999", command: "ls", ts, sig: sign("999", "ls", ts) },
      { ownerId, secret }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not the owner/);
  });

  it("rejects a row with a bad signature", () => {
    const r = verifyLocalCommand(row({ sig: "deadbeef" }), { ownerId, secret });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bad signature/);
  });

  it("rejects a row whose command was tampered after signing", () => {
    const r = verifyLocalCommand(row({ command: "rm -rf /" }), { ownerId, secret });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bad signature/);
  });

  it("fails closed when sig/ts columns are missing (pre-migration)", () => {
    const r = verifyLocalCommand(
      { requested_by: ownerId, command: "ls" },
      { ownerId, secret }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing sig\/ts/);
  });

  it("rejects a stale row beyond the max age window", () => {
    const ts = Date.now() - 10 * 60 * 1000; // 10 minutes old
    const r = verifyLocalCommand(
      { requested_by: ownerId, command: "ls", ts, sig: sign(ownerId, "ls", ts) },
      { ownerId, secret }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale ts/);
  });

  it("fails closed when no secret is configured on the host", () => {
    const r = verifyLocalCommand(row(), { ownerId, secret: "" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TWIN_API_SECRET/);
  });

  it("fails closed when no owner id is configured on the host", () => {
    const r = verifyLocalCommand(row(), { ownerId: "", secret });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BOT_OWNER_ID/);
  });
});
