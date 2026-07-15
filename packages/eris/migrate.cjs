/* eslint-disable no-console */
// Ordered, checksum-tracked PostgreSQL migration runner for Eris.
// Usage: DATABASE_URL=postgres://... npm run migrate --workspace=@defnotean/eris

const { createHash } = require("node:crypto");
const { readdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { Client } = require("pg");
require("dotenv").config({
  path: [join(__dirname, ".env"), join(__dirname, "..", "..", ".env")],
  quiet: true,
});

const MIGRATIONS_DIR = join(__dirname, "migrations");
const LOCK_ID = 735137201; // Stable project-specific PostgreSQL advisory lock.

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required (use the direct PostgreSQL connection string, not SUPABASE_URL)");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.monobot_schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.monobot_schema_migrations ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.monobot_schema_migrations FROM PUBLIC;
      DO $migration_roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON TABLE public.monobot_schema_migrations FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON TABLE public.monobot_schema_migrations FROM authenticated;
        END IF;
      END
      $migration_roles$;
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort((a, b) => a.localeCompare(b, "en"));

    for (const filename of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      const digest = checksum(sql);
      const prior = await client.query(
        "SELECT checksum FROM public.monobot_schema_migrations WHERE filename = $1",
        [filename],
      );
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== digest) {
          throw new Error(`migration ${filename} changed after it was applied; add a new migration instead`);
        }
        console.log(`skip  ${filename}`);
        continue;
      }

      console.log(`apply ${filename}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.monobot_schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, digest],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log(`complete: ${files.length} migration file(s) accounted for`);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]); } catch {}
    await client.end();
  }
}

main().catch((error) => {
  console.error(`migration failed: ${error.message}`);
  process.exitCode = 1;
});
