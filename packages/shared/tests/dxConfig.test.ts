import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression coverage for the CI / DX surface owned by the ci-dx stream:
//   - the dev loop must use `node --watch index.js` (the file that ships),
//     not the old `tsx --watch index.ts` (index.ts never existed → broke on
//     every clean checkout);
//   - the render blueprint must build with `npm ci` so deploys honour the
//     committed lockfile;
//   - the CI workflow the README badge points at must exist and only
//     reference npm scripts that actually exist.

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/shared/tests -> repo root
const ROOT = resolve(__dirname, "..", "..", "..");

function readJson(relPath: string): any {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
}

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("dev loop scripts", () => {
  for (const pkg of ["packages/eris", "packages/irene"]) {
    it(`${pkg} dev script uses node --watch index.js`, () => {
      const pj = readJson(`${pkg}/package.json`);
      expect(pj.scripts.dev).toBe("node --watch index.js");
      // The old broken command pointed at a TS entrypoint that never shipped.
      expect(pj.scripts.dev).not.toContain("tsx");
      expect(pj.scripts.dev).not.toContain("index.ts");
    });

    it(`${pkg} dev entrypoint (index.js) exists`, () => {
      expect(existsSync(join(ROOT, pkg, "index.js"))).toBe(true);
    });
  }
});

describe("render blueprints", () => {
  for (const blueprint of ["render.yaml"]) {
    it(`${blueprint} builds with npm ci, never npm install`, () => {
      const text = readText(blueprint);
      const buildLines = text
        .split("\n")
        .filter((l) => l.includes("buildCommand:"));
      expect(buildLines.length).toBeGreaterThan(0);
      for (const line of buildLines) {
        expect(line).toContain("npm ci");
        expect(line).not.toContain("npm install");
      }
    });
  }
});

describe("CI workflow", () => {
  const WORKFLOW = ".github/workflows/test.yml";

  it("exists (the README CI badge points at it)", () => {
    expect(existsSync(join(ROOT, WORKFLOW))).toBe(true);
  });

  it("references a supported Node matrix and the expected steps", () => {
    const wf = readText(WORKFLOW);
    // Node 20 is intentionally excluded because current Electron and Discord
    // voice packages require Node >=22.12. Production runs Node 24.
    expect(wf).toContain("node-version: [22, 24]");
    expect(wf).toContain("npm ci");
    expect(wf).toContain("npm run lint:version-sync");
    expect(wf).toContain("npm test --workspaces --if-present");
    expect(wf).toContain("npm run build --workspaces --if-present");
  });

  it("only references npm scripts that actually exist", () => {
    const root = readJson("package.json");
    expect(root.scripts["lint:version-sync"]).toBeTruthy();
    // test + build run per-workspace via --workspaces --if-present.
    for (const pkg of ["packages/shared", "packages/eris", "packages/irene"]) {
      const pj = readJson(`${pkg}/package.json`);
      expect(pj.scripts.test).toBeTruthy();
      expect(pj.scripts.build).toBeTruthy();
    }
  });

  it("has consistent two-space YAML indentation (no tabs)", () => {
    const wf = readText(WORKFLOW);
    expect(wf).not.toContain("\t");
    for (const line of wf.split("\n")) {
      const indent = line.length - line.trimStart().length;
      expect(indent % 2).toBe(0);
    }
  });
});
