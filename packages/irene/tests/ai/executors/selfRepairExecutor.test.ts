import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config.js", () => ({
  default: {
    ownerId: "OWNER_ID",
    local: {
      selfRepairEnabled: false,
      selfRepairAllowRestart: false,
    },
  },
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error JS module without declarations
import { execute, _test } from "../../../ai/executors/selfRepairExecutor.js";

describe("selfRepairExecutor guardrails", () => {
  it("accepts source/test/docs patch paths and rejects secret paths", () => {
    expect(_test.validateSelfRepairPatch("diff --git a/packages/irene/foo.js b/packages/irene/foo.js\n").ok).toBe(true);
    expect(_test.validateSelfRepairPatch("diff --git a/docs/self-repair.md b/docs/self-repair.md\n").ok).toBe(true);
    expect(_test.validateSelfRepairPatch("diff --git a/packages/irene/.env b/packages/irene/.env\n")).toMatchObject({
      ok: false,
    });
    expect(_test.validateSelfRepairPatch("diff --git a/.gcloud-config/logs/x b/.gcloud-config/logs/x\n")).toMatchObject({
      ok: false,
    });
  });

  it("only allows test/build/lint style commands", () => {
    expect(_test.isAllowedSelfRepairCommand("npm run lint")).toBe(true);
    expect(_test.isAllowedSelfRepairCommand("npm test --workspace=@defnotean/irene -- tests/ai/executors/selfRepairExecutor.test.ts")).toBe(true);
    expect(_test.isAllowedSelfRepairCommand("git diff --check")).toBe(true);
    expect(_test.isAllowedSelfRepairCommand("bash -lc whoami")).toBe(false);
    expect(_test.isAllowedSelfRepairCommand("rm -rf packages/irene")).toBe(false);
  });

  it("chooses default checks based on touched package paths", () => {
    const commands = _test.defaultTestCommandsForPaths([
      "packages/shared/src/ai/localVision.js",
      "packages/eris/config.js",
    ]);

    expect(commands).toContain("npm run lint");
    expect(commands).toContain("npm run build --workspace=@defnotean/shared");
    expect(commands).toContain("npm test --workspace=@defnotean/shared");
    expect(commands).toContain("npm run build --workspace=@defnotean/eris");
  });

  it("does not apply patches unless explicitly enabled", async () => {
    const result = await execute("self_repair", {
      mode: "apply",
      patch: "diff --git a/packages/irene/foo.js b/packages/irene/foo.js\n",
    }, {
      author: { id: "OWNER_ID" },
    });

    expect(String(result)).toContain("SELF_REPAIR_ENABLED=1");
  });
});
