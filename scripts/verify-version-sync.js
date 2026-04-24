#!/usr/bin/env node
// verify-version-sync.js
//
// Pre-flight check for the monorepo: when two or more workspace packages
// declare the SAME dependency, their specified version ranges must be
// byte-identical. Otherwise npm workspace hoisting will pick one version
// arbitrarily and the packages whose range didn't match the hoist get a
// version they weren't tested against — which is exactly what broke Irene
// on 2026-04-24 during the first monorepo cutover attempt.
//
// This script fails loudly on divergence. Wire it into:
//   npm run lint:version-sync
// and run it before every deploy/migrate.
//
// Exit codes:
//   0 — all shared deps have identical ranges across workspaces
//   1 — divergence found (prints the offending deps + ranges)
//   2 — script itself broke (e.g., unreadable package.json)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[verify-version-sync] Failed to read ${path}: ${err.message}`);
    process.exit(2);
  }
}

function discoverWorkspaces() {
  const out = [];
  for (const name of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const pkgJson = join(dir, "package.json");
    try {
      statSync(pkgJson);
    } catch {
      continue;
    }
    const pkg = readJson(pkgJson);
    out.push({ name: pkg.name || name, dir, pkg });
  }
  return out;
}

function collectDeps(workspace) {
  const deps = new Map();
  for (const kind of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = workspace.pkg[kind];
    if (!section) continue;
    for (const [dep, range] of Object.entries(section)) {
      // Skip the @defnotean/* workspace-local packages — they're `*` by convention
      // and resolve via npm workspaces to the local symlink.
      if (dep.startsWith("@defnotean/")) continue;
      deps.set(dep, { range, kind });
    }
  }
  return deps;
}

function main() {
  const workspaces = discoverWorkspaces();
  if (workspaces.length < 2) {
    console.log("[verify-version-sync] Only one workspace found — nothing to compare. OK.");
    process.exit(0);
  }

  // Build { depName: [{ workspace, range, kind }, ...] }
  const byDep = new Map();
  for (const ws of workspaces) {
    for (const [dep, { range, kind }] of collectDeps(ws)) {
      if (!byDep.has(dep)) byDep.set(dep, []);
      byDep.get(dep).push({ workspace: ws.name, range, kind });
    }
  }

  const divergent = [];
  for (const [dep, uses] of byDep) {
    if (uses.length < 2) continue;
    const ranges = new Set(uses.map((u) => u.range));
    if (ranges.size > 1) {
      divergent.push({ dep, uses });
    }
  }

  if (divergent.length === 0) {
    console.log(`[verify-version-sync] ${byDep.size} unique deps across ${workspaces.length} workspaces. All shared deps have identical ranges. OK.`);
    process.exit(0);
  }

  console.error(`[verify-version-sync] FAIL: ${divergent.length} shared dep(s) have divergent version ranges across workspaces.`);
  console.error("");
  console.error("When npm workspaces hoist a shared dep, it picks ONE version for the root");
  console.error("node_modules/. Packages whose range doesn't match the hoist still accept the");
  console.error("hoisted version (as long as semver permits), but their runtime deps are then");
  console.error("different from what they were tested against. This is the same bug that silently");
  console.error("broke Irene's interaction handlers on 2026-04-24.");
  console.error("");
  console.error("Fix: pick one range (usually the newer) and apply it to every workspace. Prefer");
  console.error("exact versions (no caret) for reproducibility.");
  console.error("");
  for (const { dep, uses } of divergent) {
    console.error(`  ${dep}:`);
    for (const { workspace, range, kind } of uses) {
      console.error(`    ${workspace} [${kind}] → ${range}`);
    }
  }
  console.error("");
  process.exit(1);
}

main();
