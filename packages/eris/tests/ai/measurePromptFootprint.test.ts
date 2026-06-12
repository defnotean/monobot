import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const scriptPath = resolve(repoRoot, "scripts/measure-prompt-footprint.mjs");
const CEILING_BYTES = 26_000;

describe("measure:prompt footprint", () => {
  it("runs on a clean env and keeps worst-case tier-1 schema bytes under ceiling", () => {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        DISCORD_TOKEN: "",
        CLIENT_ID: "",
        DISCORD_BOT_TOKEN: "",
        DISCORD_CLIENT_ID: "",
        GEMINI_API_KEY: "",
      },
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("MEASURE_PROMPT_FOOTPRINT_JSON="));
    expect(line).toBeTruthy();
    const summary = JSON.parse(line!.slice("MEASURE_PROMPT_FOOTPRINT_JSON=".length));
    const rows = Object.values(summary) as Array<{ profile: string, tier1SchemaJsonChars: number }>;
    const erisWorst = Math.max(...rows.filter((row) => row.profile.startsWith("eris ")).map((row) => row.tier1SchemaJsonChars));
    const ireneWorst = Math.max(...rows.filter((row) => row.profile.startsWith("irene ")).map((row) => row.tier1SchemaJsonChars));

    expect(erisWorst).toBeLessThanOrEqual(CEILING_BYTES);
    expect(ireneWorst).toBeLessThanOrEqual(CEILING_BYTES);
  });
});
