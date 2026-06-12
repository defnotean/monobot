import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION = "014_enable_rls_all_tables.sql";

function readMigration(name: string) {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), "utf8");
}

function stripSqlComments(sql: string) {
  return sql.replace(/--.*$/gm, "");
}

const sqlRaw = readMigration(MIGRATION);
const sql = stripSqlComments(sqlRaw);

// Table names listed in the migration's FOREACH lockdown array.
function lockdownTables(): Set<string> {
  const arrayMatch = sql.match(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP/i);
  expect(arrayMatch, "FOREACH lockdown array not found in migration").toBeTruthy();
  const names = new Set<string>();
  for (const m of arrayMatch![1].matchAll(/'([A-Za-z0-9_]+)'/g)) names.add(m[1]);
  return names;
}

// Every string-literal Supabase .from("<table>") in all three packages.
// The receiver is matched SEPARATELY by looking back at the preceding
// non-whitespace token, so newline-chained builder style
// (`supabase\n  .from("x")` — ~50 call sites) is covered too. Receivers
// starting with an uppercase letter (Buffer.from, EmbedBuilder.from,
// Array.from) are not PostgREST query builders and are excluded.
function tablesReferencedInSource(): Set<string> {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const roots = ["packages/eris", "packages/irene", "packages/shared"].map(p => join(repoRoot, p));
  const skipDirs = new Set(["node_modules", "tests", "test", "dist", "coverage", ".git"]);
  const tables = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
      const text = readFileSync(join(dir, entry.name), "utf8");
      for (const m of text.matchAll(/\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
        // Look back for the receiver token (identifier or call/index result)
        // immediately preceding the `.from`, across any whitespace/newlines.
        const before = text.slice(0, m.index).match(/([A-Za-z0-9_$)\]]+)\s*$/);
        if (before && /^[A-Z]/.test(before[1])) continue; // Buffer/Array/EmbedBuilder.from
        tables.add(m[1]);
      }
    }
  };
  for (const root of roots) visit(root);
  return tables;
}

describe("014 RLS lockdown migration", () => {
  it("creates local_commands explicitly with every column the code touches", () => {
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.local_commands/i);
    const createBlock = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.local_commands\s*\(([\s\S]*?)\);/i);
    expect(createBlock).toBeTruthy();
    for (const col of ["id", "command", "status", "result", "channel_id", "requested_by", "confirm", "sig", "ts", "created_at"]) {
      expect(createBlock![1]).toMatch(new RegExp(`(^|\\n)\\s*${col}\\s`, "i"));
    }
  });

  it("enables RLS and revokes client/public table grants in the lockdown loop", () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.%I\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.%I\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.%I\s+FROM\s+anon/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.%I\s+FROM\s+authenticated/i);
    expect(sql).toMatch(/GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+TABLE\s+public\.%I\s+TO\s+service_role/i);
    // Deny-by-default: no policies are created on purpose.
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    // Never grant table DML back to client roles.
    expect(sql).not.toMatch(/GRANT\s+[^;]*\bTO\s+[^;]*(anon|authenticated)/i);
  });

  it("locks down every table literal-referenced via .from() in eris, irene and shared", () => {
    const locked = lockdownTables();
    const missing = [...tablesReferencedInSource()].filter(t => !locked.has(t)).sort();
    expect(missing, `tables used in code but missing from ${MIGRATION} lockdown array — add them (the array is existence-guarded, extra entries are safe)`).toEqual([]);
  });

  it("source scan sees newline-chained .from() call sites (regex self-test)", () => {
    // These tables are referenced ONLY in `supabase\n  .from("...")` chained
    // style — if the scan regex regresses to requiring an adjacent receiver,
    // this canary fails before the lockdown guarantee silently erodes.
    const seen = tablesReferencedInSource();
    for (const t of ["eris_stock_portfolios", "fm_user_albums", "dual_write_sagas"]) {
      expect(seen.has(t), `scan no longer finds chained-style table ${t}`).toBe(true);
    }
  });

  it("locks down the dynamically-named and migration-created tables too", () => {
    const locked = lockdownTables();
    const known = [
      // dynamic names built in code (tableFor/bumpsTableFor/constants)
      "eris_bump_joins", "irene_bump_joins",
      "eris_bump_user_prefs", "irene_bump_user_prefs",
      "irene_mod_audit", "music_settings",
      // irene per-entity migration tables (perEntity.js write targets)
      "irene_guild_settings", "irene_custom_commands", "irene_scrim_stats",
      "irene_starboard_entries", "irene_saved_queue", "irene_mood_state",
      "irene_relationships", "irene_global_state",
      // other migration-touched tables
      "dual_write_sagas", "irene_economy", "eris_stock_portfolios",
    ];
    const missing = known.filter(t => !locked.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("revokes execution of BOTH out-of-repo RPCs (search_memories, match_injection_patterns)", () => {
    expect(sql).toMatch(/proname\s+IN\s*\(\s*'search_memories'\s*,\s*'match_injection_patterns'\s*\)/i);
    expect(sql).toMatch(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.%I\(%s\)\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.%I\(%s\)\s+TO\s+service_role/i);
  });

  it("has balanced dollar-quoted DO blocks", () => {
    const dollarPairs = (sql.match(/\$\$/g) || []).length;
    expect(dollarPairs % 2).toBe(0);
    const doBlocks = (sql.match(/DO\s+\$\$/gi) || []).length;
    const endBlocks = (sql.match(/END\s+\$\$;/gi) || []).length;
    expect(doBlocks).toBe(endBlocks);
  });
});
