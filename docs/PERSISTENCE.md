# Persistence

Both bots are designed around the same pattern: synchronous reads from an
in-memory cache, mutations that update the cache immediately, and a debounced
background flush to Supabase. The cache is the contract callers see; Supabase
is the system of record only on cold boot and across deploys.

This doc covers the schema, the flush model, the atomicity guarantees, and the
"what happens when you don't configure a database" question.

## 1. The two databases

Eris and Irene historically run against the **same** Supabase project. Tables
are namespaced by prefix (`eris_*` vs `irene_*`) and the shared `bot_data`
key/value table carries cross-bot state — most notably the server whitelist
both bots read so they stay in sync (`packages/eris/database.js` lines
624-682, `packages/irene/database.js` line 364).

Splitting into two separate Supabase projects is fully supported — point each
`.env` at a different `SUPABASE_URL` / `SUPABASE_KEY` and apply each bot's
migrations only to its own project. The shared whitelist then needs to be
mirrored manually (or you accept that each bot keeps its own).

## 2. Schema overview per bot

### Eris (`packages/eris/database.js` lines 13-29)

Eris uses **one Postgres table per domain**, all keyed by the natural id:

| Table | Key | Purpose |
|---|---|---|
| `eris_economy` | `user_id` | balance, daily/weekly/monthly streak, totals, prestige, `version` int for CAS |
| `eris_memories` | `id` | channel-scoped chat history (never cached — too large) |
| `eris_facts` | `id` | per-user facts with `sensitivity` (normal vs secret) and `importance` |
| `eris_mood` | `id = "eris"` singleton | global mood + energy, debounced to disk |
| `eris_relationships` | `user_id` | affinity score + interactions count |
| `eris_reminders` | `id` | pending reminders drained by the scheduler |
| `eris_personality` | `id = "eris"` | editable system-prompt override |
| `eris_inventory` / `eris_shop` / `eris_achievements` | various | item catalog + per-user state |
| `eris_loans` / `eris_bounties` / `eris_daily_challenges` | `id` | per-feature game state |
| `eris_boss` / `eris_pets` / `eris_territories` | `id` / `user_id` | mid-game features |
| `eris_heists` / `eris_auctions` / `eris_roast_battles` | `id` | event-based features |
| `eris_bank` / `eris_prestige` / `eris_marriages` | `user_id` | money sinks + tier state |
| `bot_data` | `id` | catch-all JSON blob — `eris_guild_settings`, `eris_server_personas`, `main` (shared whitelist) |
| `local_commands` | `id` | outbound queue for remote workers |

The `version` int on `eris_economy` (`migrations/001_add_economy_version.sql`)
powers the optimistic-concurrency retry loop in section 6. The `bot_data` KV
shape (`{ id text PRIMARY KEY, data jsonb }`) is used for slow-moving config
that's easier to upsert as one blob than as N rows.

### Irene (`packages/irene/database.js` lines 17-48)

Irene historically wrote **everything** into a single row
(`bot_data` with `id = "irene"`) — the whole `data` object serialized as
JSON. That blob is still the boot-time read path
(`packages/irene/database.js` lines 200-240). On top of that, the per-entity
migration in `packages/irene/migrations/20260427033429-per-entity-tables.sql`
introduces dedicated tables behind a feature flag:

| Table | Key | Source field |
|---|---|---|
| `irene_guild_settings` | `guild_id` | per-guild config (welcome, log, autorole, auto-mod, tickets, AFK, color roles, personas, bad words, reaction roles, trusted users) |
| `irene_custom_commands` | `guild_id` | trigger/response map |
| `irene_scrim_stats` | `guild_id` | per-game scrim wins/losses |
| `irene_starboard_entries` | `guild_id` | original-message → starboard-message map |
| `irene_saved_queue` | `guild_id` | persisted music queue |
| `irene_mood_state` | `bot_name` | mood + energy singleton |
| `irene_relationships` | `bot_name` | affinity map |
| `irene_global_state` | `bot_name` | catch-all: counters (`_nextWarningId`, `_nextReminderId`, `_nextScheduledTaskId`), `warnings[]`, `reminders[]`, `scheduled_tasks[]`, `dm_optout`, `birthdays`, `server_whitelist`, `giveaways`, `highlights`, `temp_vcs`, `conversations` |

All per-entity rows share the same shape: `<key> + version int + data jsonb +
updated_at timestamptz`. The `version` column powers optimistic concurrency in
`packages/irene/database/perEntity.js` lines 61-98 — writes do
`.eq("version", lastSeen)` and bump `version + 1` on success.

## 3. In-memory fallback

If Supabase is unconfigured (or all init retries fail), both bots still boot
and run **purely** from memory. Eris (`packages/eris/database.js` lines
146-165) logs `[DB] Supabase not configured — in-memory only`; most economy
mutations explicitly refuse to run (`updateBalance` throws
`economy_unavailable: database offline`, lines 901-906) rather than letting
the cache drift from a non-existent source of truth. Irene
(`packages/irene/database.js` lines 180-188) logs a loud multi-line warning
naming exactly what will reset on every restart and points operators at
`REQUIRE_PERSISTENCE=1`.

What's lost on restart in in-memory mode is, in short, **everything**: facts,
mood, relationships, reminders, guild settings, server personas, in-progress
economy/game state, music queues, warnings, custom commands. Either bot can
be run this way for casual testing or a single-server homelab; neither should
ship to production without persistence.

## 4. `REQUIRE_PERSISTENCE` env var

Parsed in both configs as `config.requirePersistence`
(`packages/eris/config.js` line 284, `packages/irene/config.js` line 269;
defaults to `0`).

The intent — documented inline in the database modules
(`packages/irene/database.js` lines 50-54) — is **fail-fast on missing DB**
so a silent in-memory fallback never reaches production. Production deploys
should set this on both services so a misconfigured Supabase secret kills boot
rather than silently burning user state on every redeploy.

Even with the flag off, Eris's economy already refuses to mutate without a DB
(`packages/eris/database.js` lines 901-906) — that's the load-bearing guard
against silent coin loss regardless of how the flag is set.

## 5. Debounced flush model

Both bots use the same shape — cache mutates synchronously, a single timer
schedules a flush — but the window and the granularity differ.

**Eris (`packages/eris/database.js` lines 211-249)** — `_DEBOUNCE_MS = 200`.
Mutating helpers call `save(bucket)` which adds the bucket name (`"mood"`,
`"relationships"`, `"guild_settings"`) to a `_dirty` set and schedules a
single 200ms timer. The window is intentionally tight: a hard crash between
mutation and flush drops at most 200ms of writes per bucket. The
`beforeExit` hook (lines 255-267) and the SIGTERM/SIGINT handlers in
`packages/eris/index.js` lines 134-147 call `flushAll()` which:

1. Clears the pending timer.
2. Re-marks every persistable bucket dirty (so a directive added in the last
   200ms doesn't get skipped — see lines 2298-2318).
3. Drains synchronously with a 4-second cap so a hung Supabase request can't
   block exit forever.

**Irene (`packages/irene/database.js` lines 254-392)** — 2-second debounce.
A coarser window because Irene's flush serializes the **entire** cache into
the single `bot_data.id = "irene"` row. Retry logic: 3 immediate attempts
with 1s/2s backoff, then a 30-second reschedule, capped at 10 retries before
a 5-minute cooldown. On shutdown (`packages/irene/index.js` lines 336-344)
`flushNow()` clears the timer and runs `_flushSave()` once synchronously,
plus drains the per-entity coalesce queue, with an 8-second hard cap on the
whole shutdown.

The per-entity layer adds its own 500ms coalescing window
(`packages/irene/database/perEntity.js` lines 38, 138-164) — rapid writes to
the same (table, key) collapse into one Supabase call carrying the latest
data; different keys never block each other.

## 6. Atomic mutations

Eris's economy is the most contention-prone surface (transfers, daily claims,
gambling, loan repayments, pet training). Two independent mechanisms
guarantee correctness depending on what's deployed:

**Atomic balance RPC** (`packages/eris/migrations/002_atomic_balance_rpc.sql`)
— `eris_add_balance` does the read-modify-write inside one transaction with
`SELECT … FOR UPDATE`. This is the only path that serializes correctly across
**multiple bot processes**. When deployed it's the fast path
(`packages/eris/database.js` lines 788-835): one round-trip, server-side
atomic, returns the new balance + tallies.

**Version-CAS fallback**
(`packages/eris/migrations/001_add_economy_version.sql`) —
`eris_economy.version` increments on every write. The fallback loop (lines
837-898) reads the row, computes new state, does
`UPDATE … WHERE version = lastSeen`, and retries up to 5 times with
exponential backoff. Correct for a **single-process** bot held together by
`withEconLock`; two processes hitting the same row can still race. The first
time the RPC errors with PGRST202 ("function not found"), the module flips
`_rpcAddBalanceAvailable = false` and never retries (lines 800-802) — every
subsequent call drops into the CAS loop.

The in-process lock layer is `withEconLock(userId, fn)` (lines 716-725) and
its public alias `withUserLock` (lines 733-735). `transferBalance` acquires
**both** locks in sorted ID order (lines 955-957) to avoid deadlock; rollback
on credit failure is best-effort with a manual-reconciliation log line (lines
974-976). The contract is exercised by
`packages/eris/tests/db/loanRepayRace.test.ts` — two parallel `loan_repay`
calls only deduct once.

## 7. Migration philosophy

Migrations are **numbered SQL files** committed to the repo, applied manually
against whatever Postgres your bot points at. Not Knex, not Prisma, not
Supabase CLI migrations — just plain `.sql` you can pipe into `psql`.

- `packages/eris/migrations/001_add_economy_version.sql`
- `packages/eris/migrations/002_atomic_balance_rpc.sql`
- `packages/irene/migrations/20260427033429-per-entity-tables.sql`

The file headers tell you how to apply them
(`packages/eris/migrations/002_atomic_balance_rpc.sql` lines 16-18):

```bash
psql $DATABASE_URL -f packages/eris/migrations/002_atomic_balance_rpc.sql
```

Or paste into the Supabase SQL editor. The codebase assumes migrations are
**additive and idempotent** — every CREATE uses `IF NOT EXISTS`, every ALTER
uses `IF NOT EXISTS`, the RPC uses `CREATE OR REPLACE`. Rolling out is a
strict superset: apply the migration first, then deploy the code that uses
it. The Eris atomic-balance path proves this — code without migration 002
falls through to the CAS loop and logs the gap; code with migration 002 just
uses it.

Local Supabase / Docker Supabase / plain Postgres: same files, same
ordering, same `psql -f`.

## 8. Trusted-user cache TTL (Irene)

Irene's privileged-user list (`getTrustedUsers`,
`packages/irene/database.js` lines 1086-1158) is read on every interaction —
synchronously, because we can't await network round-trips inside a 3-second
slash-command ack. To bound the stale-trust window without making the read
async, the module uses a **5-minute background TTL** keyed per guild
(`TRUSTED_TTL_MS` line 1097).

The flow: a stale cache returns the current value immediately AND kicks off
a fire-and-forget refresh that updates `data.guild_settings` in place. The
next call after the round-trip sees the fresh list. `_trustedFetchedAt` is
marked optimistically (line 1132) so back-to-back stale reads only spawn one
refresh; `_trustedRefreshInFlight` dedupes concurrent refreshes (line 1099).
Local writes (`addTrustedUser`, `removeTrustedUser`) are authoritative and
defer the next TTL refresh (lines 1147, 1156) so the bot doesn't race itself
before its own `save()` flush completes.

Net effect: revoking trust takes at most 5 minutes to propagate across the
cluster without requiring a restart, and the read path stays sync.

## 9. Per-entity storage pattern (Irene)

The per-entity layer (`packages/irene/database/perEntity.js`) is the
designated escape hatch from Irene's one-giant-blob persistence model. Each
helper writes ONE row to ONE table keyed by a natural identifier.

How a write lands (`packages/irene/database/perEntity.js`):

1. **Coalesce** (lines 138-164): the first call to
   `writeGuildSettings(guildId, data)` schedules a 500ms timer keyed on
   `${table}:${guildId}`. Further calls to the same key inside the window
   replace `latestData` but do NOT reset the timer — a sustained write loop
   can't starve the flush forever.
2. **Read current version** (lines 62-70): when the timer fires, `.select`
   the row's current `version`.
3. **Update with version check** (lines 86-97):
   `.update({ version: v + 1, data, updated_at: now() }).eq("version", v)`.
   Empty result = somebody else won the race, retry.
4. **Insert on first write** (lines 72-81): if no row exists,
   `.insert(...)` with `version = 1`. A `23505` unique-violation means a
   concurrent insert beat us → treat as version conflict, retry.
5. **Retry budget**: up to 3 attempts with 200ms × attempt backoff on hard
   errors (lines 109-125). Soft version conflicts retry without backoff.

`flushPerEntityNow()` (lines 206-223) drains the coalesce timers on
shutdown — called from `flushNow()` in `database.js` lines 274-283.

The contract is exercised by `packages/irene/tests/database/perEntity.test.ts`
(420 lines) — version conflicts, coalescing, unique-violation fall-through,
shutdown drain, and the per-table shape are all asserted there.

The layer is gated by `config.dualWritePersistence`
(`packages/irene/config.js` line 297, env var `DUAL_WRITE_PERSISTENCE`).
When on, every flush writes to **both** the legacy blob AND the per-entity
tables (`packages/irene/database.js` lines 290-334, 371-374). The flag is
off by default and meant to be flipped in production once the per-entity
schema is applied — it's a safe rollout, never a destructive cutover.

## 10. Self-host options

The bots talk to whatever speaks the PostgREST surface
`@supabase/supabase-js` expects. That gives four real choices (full detail
in `docs/self-hosting.md` lines 189-224):

| Path | What to set | When |
|---|---|---|
| **Cloud Supabase** | `SUPABASE_URL=https://<ref>.supabase.co`, `SUPABASE_KEY=<service-role-or-anon>` | Default. Free tier handles a few hundred guilds. |
| **Self-hosted Supabase via Docker** | `SUPABASE_URL=http://localhost:54321`, key from the docker env file | When you want full ownership of data. Apply migrations with `psql` against the bundled Postgres. |
| **Plain Postgres + PostgREST** | `SUPABASE_URL=<postgrest-url>` | When you already run Postgres. Install `pgvector`, apply `packages/<bot>/migrations/*.sql`, also define a `search_memories(query_embedding vector, ...)` RPC or semantic memory degrades silently to keyword-only. |
| **No DB** | Leave `SUPABASE_URL` / `SUPABASE_KEY` unset | Casual testing only. Set `REQUIRE_PERSISTENCE=1` to make the missing DB a fatal startup error instead of a silent degrade. |

All four take the **same** migration files — there's no Supabase-specific
SQL outside what Postgres itself provides. The `pgvector` extension is the
one non-base requirement (used by the firewall pattern store and semantic
memory).

## 11. Backup & restore

The repo ships **no** custom backup tooling. Use what your Postgres provides:
Point-in-Time Recovery on paid Supabase tiers + free-tier daily snapshots, or
`pg_dump $DATABASE_URL > backup.sql` on a cron for self-hosted setups.

Two restore-correctness details:

- **Eris's economy `version` column** — restoring from a snapshot is safe
  because every row carries its own version and the CAS / RPC loops always
  read the current value before writing. No in-process version cache to
  invalidate.
- **Irene's monotonic counters** (`_nextWarningId`, `_nextReminderId`,
  `_nextScheduledTaskId`) live inside the persisted blob
  (`packages/irene/database.js` lines 217-219, and the `irene_global_state`
  per-entity row). Restoring rolls them back; if the bot has issued IDs since
  the snapshot, new IDs collide. Restore at a quiet moment or bump the
  counters manually post-restore.

For a minimal cold export, `pg_dump --table='eris_*' --table='irene_*'
--table='bot_data'` covers all user-facing data. The `local_commands` queue
is operational, not durable — exclude from backups.
