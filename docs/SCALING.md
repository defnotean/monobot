# Scaling MonoBot

Honest answer to "can I run this big?": yes, up to a point, and then no — not
without surgery.

This doc is the per-component truth about what gets bigger when you do, what
falls over, and what you'd have to rewrite if you actually wanted to run more
than one replica per bot. It is **not** an aspirational architecture doc.
The code lives in `packages/eris/` and `packages/irene/` today; everything
below is what's actually there.

## 1. The intended scale

MonoBot is designed for **a single process per bot, on one box**. One Eris
process, one Irene process. That fits:

- Up to a few hundred guilds per bot (Discord's "small bot" tier, no gateway
  sharding required — discord.js shards automatically past ~2500 guilds,
  but you'll feel the pain in other places first).
- Steady traffic in the low tens of messages per second.
- A handful of concurrent voice connections (Irene only; one Lavalink node
  handles ~50 audio streams comfortably).
- Supabase free tier or a small managed Postgres.
- A single OS process per bot, restarted by PM2 / systemd / Render.

That's the box. The code is full of comments that say things like *"use this
for the twin-bot use case: a handful of long-lived keys"* or *"200ms debounce
intentionally tight"* — those are deliberate single-process choices, not bugs
to be fixed.

## 2. What scales horizontally for free

Two things scale without any work from us.

**Discord gateway sharding.** discord.js v14 transparently shards the gateway
WebSocket past the 2500-guild line. If you grow past that on a single process
you'll need `ShardingManager`, but the per-shard code is unchanged — Discord
itself handles message routing to the right shard.

**Stateless HTTP reads.** Irene's `/presence` Lanyard-replacement endpoint and
the `/api/dashboard/*` routes are read-only over `cachedPresence` / `data` in
memory. Multiple replicas would each serve the same shape; only the cached
contents would diverge.

That's it. Everything else below is per-process and breaks if you naively run
two copies.

## 3. What's per-process and breaks under multi-replica

If you spin up two Eris replicas behind a load balancer, the following
silently corrupt or duplicate.

**Rate limiter** — `packages/shared/src/rateLimit.js` is a sliding window over
a `Map<key, number[]>`. It is explicitly scoped to in-process use:

> *"For high-cardinality keys or multi-process correctness reach for something
> with shared state."*

Two replicas = 2x the effective limit for every key, because each one has its
own window. Used by `/api/twin/state`, expensive AI tools (`web_search`,
`analyze_image`, `scrape_url` — see `packages/eris/utils/toolRateLimit.js`),
and any new endpoint that calls `createRateLimiter`.

**LRU caches** — `packages/shared/src/lruCache.js` is in-process. Every
replica has its own copy of:

- The tool-result cache (`_toolCache`, 200 entries, 15s TTL,
  `packages/eris/ai/executor.js`).
- The economy / bank caches (`_economyCache` 10s TTL, `_bankCache` LRU(1000)
  + 5min TTL, both in `packages/eris/database.js`).
- TTS audio cache (`ttsAudioCache` in `packages/irene/presence.js`) — a TTS
  URL minted by replica A is a 404 on replica B.
- Per-guild member-name index (`_memberIndexes` in
  `packages/irene/ai/executor.js`).

A cache miss in any replica means an extra Supabase round trip; a cache *hit*
on stale data because replica B mutated underneath you is the real failure
mode. The economy cache invalidation in `executor.js` calls
`invalidateUserCache(userId)` after every write — only invalidating the local
LRU. Replica B sees stale balances for up to 10 seconds.

**Lazy-load promises** — `packages/eris/ai/lottery.js`,
`packages/eris/ai/stockMarket.js`, and `packages/irene/ai/personality.js` all
have a `let _loadPromise = null` memoization pattern. Each replica will do
its own one-time load on first access — fine for read-mostly config, but the
**stock market GBM simulation tick** writes back; two replicas would each
run a tick and both would upsert prices, doubling the drift per minute.

**Debounced flush queue** — both `packages/eris/database.js` and
`packages/irene/database.js` use a `_dirty Set` + `_saveTimer` setTimeout.
Eris flushes every ~200ms, Irene every ~2s. Each replica holds its own dirty
set, so two replicas mutating the same row will both upsert it —
last-writer-wins on Supabase. The version-CAS path on the economy table
catches *balance* races; **nothing else has that protection**. Mood,
relationships, guild_settings, custom_commands — all clobber-prone.

**Trusted-user cache TTL refresh** — `packages/irene/database.js` around
lines 1010-1062: `getTrustedUsers` is a synchronous read backed by a
5-minute TTL that triggers a fire-and-forget background refetch. The cache
exists because the call site can't be made async without rewriting every
permission check.

- Granting trust on replica A means up to 5 minutes before replica B sees it.
- **Revoking trust is the asymmetric risk** — a removed user keeps elevated
  permissions on the other replica until its TTL expires.

**In-flight Sets and per-target locks** — single-process race guards that do
nothing across replicas:

- `_inflightGameKeys` (blackjack double-click guard,
  `packages/eris/events/interactionCreate.js`).
- `_economyLocks`, `_heistLocks`, `_auctionLocks`,
  `withUserLock`/`withEconLock` in `packages/eris/database.js`.
- `processing` and `_repliedMessages` dedupe sets,
  `packages/irene/events/messageCreate.js`.
- `_inflight` mutex on dream generation, `packages/irene/ai/dreams.js`.

These all live in a single `Map` per process. They prevent races *within* a
process; they do nothing across processes. The auction code has a defensive
optimistic-concurrency `.eq("current_bid", lastSeen)` retry exactly because
of this — it expects multi-instance to be theoretically possible even though
we don't run it today.

## 4. Database scaling

The DB is Supabase (managed Postgres + PostgREST).

**Connection pooling.** PostgREST sits between us and Postgres and handles
its own pool. The `@supabase/supabase-js` client makes HTTP calls, so the
bot doesn't manage Postgres connections directly. Free-tier Supabase caps
you at the project's pooler size; if you see `remaining connection slots
are reserved` you're on the wrong tier, not on bad code.

**Atomic RPC vs version-CAS fallback.** Economy mutations prefer a Postgres
function (`eris_add_balance`, see `migrations/002_atomic_balance_rpc.sql`)
that does `SELECT … FOR UPDATE` server-side. If that function isn't deployed
(RPC returns `PGRST202` = function-not-found), Eris falls back to an
optimistic concurrency loop with a `version` column.

Both paths are correct under contention; the RPC path is one round-trip
instead of N. Critically:

- The version-CAS loop relies on `withEconLock` to serialize within a
  process.
- The RPC path serializes server-side at the Postgres row level.
- **The RPC path is the only thing that serializes correctly across multiple
  bot processes** — apply migration 002 if you ever run multi-replica.

**Free tier limits.** Supabase free tier is 500 MB database, 2 GB egress per
month, and the project pauses after 7 days of no API activity. For a small
bot fleet this is plenty; the chat history (`eris_memories`) is the only
table that grows linearly with traffic. Add a TTL cleanup job if you see the
table cross ~100 MB.

**Read patterns.** `_loadFromSupabase()` runs all initial queries in parallel
via `Promise.allSettled`. Hot reads (`getBalance`, `getBankBalance`) are
cache-first with 10s / 5min TTLs. Cold reads (chat history, leaderboards)
hit Postgres directly. No N+1 fanouts in the current code; if you add a tool
that loops `getBalance(uid)` for each member of a guild, that's where you'd
first feel it.

## 5. AI provider rate limits

Both bots use `ai/dual.js` to fan out across Gemini and NVIDIA backends
(plus Brave Search). Limits are **per-key, per-provider**, and entirely
outside our cache.

- **Gemini free tier** — generous on RPM, much tighter on TPM (tokens per
  minute) for the larger models. A single noisy channel can saturate
  `gemini-2.5-pro` TPM during long tool-chain turns. Router falls back to
  NVIDIA on 429.
- **NVIDIA Build** — currently free with generous limits, but reseller terms
  change frequently. Treat as best-effort fallback, not primary.
- **Brave Search Pro** — paid per query. Per-turn dedup in
  `packages/eris/ai/executors/webExecutor.js` and the irene equivalent
  reuses results within a single turn, so a tool chain doesn't pay 5x for
  the same query.

The per-user tool rate limiter (`packages/eris/utils/toolRateLimit.js`) caps
`web_search` to 10/min/user and `scrape_url`/`analyze_image` to 5/min/user.
That is a **per-process** limit, multiplied per replica.

If you add a third backend, the router in `ai/dual.js` is the place. Keys
are env-var pools (`GEMINI_API_KEYS` comma-separated), so adding a key gets
you more headroom without code changes.

## 6. When you'd actually need to scale

For most self-hosters: **never**. Concrete watermarks where the
single-process design starts hurting:

- **~500 guilds** — Discord gateway is fine, but the in-memory cache
  footprint starts mattering. Watch RSS via `pm2 ls`; if you're past 1 GB,
  prune `data.conversations` (per-channel) and `data.relationships`
  (per-user) with `last_interaction < 30 days`.
- **~20 msg/sec sustained to a single bot** — the AI pipeline
  (`messageCreate` gauntlet → `ai/dual.js` → executor) handles bursts fine,
  but at sustained 20/s you'll hit Gemini TPM walls on long-context
  messages. Add an LLM-side queue, or split prompts.
- **~2500 guilds** — discord.js auto-sharding kicks in. Single process can
  keep up; verify that `getOrFetch` patterns across guilds (member fetches
  in executors) don't blow the per-shard ratelimit.
- **Voice on >10 simultaneous guilds** — one Lavalink node is the
  bottleneck. Spin up a second Lavalink and shard by guild ID — Irene's
  music layer assumes a single node today, so this is a real change.
- **Supabase egress > 2 GB/month** — graduate off free tier or self-host
  Postgres (see `docs/self-hosting.md`).

## 7. If you must run multi-replica

If you really want HA or load distribution, here's what you'd actually have
to change. **None of this is shippable today**; treat it as a punch-list,
not a recipe.

1. **Move the rate limiter to Redis.** Replace `createRateLimiter` with a
   Redis `INCR` + `EXPIRE` script (or `@upstash/ratelimit`). The current
   interface (`allow(key)`) is the only contract; one swap covers
   `/api/twin/state` and the per-user tool limiter.
2. **Apply migration 002 unconditionally.** The `eris_add_balance` RPC is
   the only economy path that serializes across processes. Same review for
   any future tool that writes to a shared row — wrap it in a Postgres
   function that does `SELECT … FOR UPDATE` or use `INSERT … ON CONFLICT
   … DO UPDATE` with a constraint.
3. **Move the debounced flush to a leader-elected worker.** Easiest path:
   pick one replica as "the writer" via a Redis lock with TTL renewal
   heartbeat; non-writers either send dirty buckets over the wire or skip
   the cache entirely and write straight through, paying the Supabase
   round-trip on every mutation.
4. **Sticky sessions for the twin protocol.** `/api/twin/state` and
   `/api/twin/command` (the HMAC-signed REST surface in
   `packages/irene/presence.js`) assume one Irene. If you fan out, the
   caller either sticks to one replica per conversation (consistent-hash
   on `userId`) or every replica subscribes to a shared event bus to learn
   about cross-replica mood updates. Sticky is the smaller change.
5. **In-flight Sets become Redis SETNX with TTL.** `_inflightGameKeys`,
   `_economyLocks`, `_heistLocks`, `_auctionLocks` all turn into "acquire
   Redis lock with 30s TTL, or 409 immediately". Set the TTL high enough
   that no in-process handler can outrun it; release in `finally`.
6. **Trusted-user cache becomes Supabase Realtime.** Subscribe to
   `bot_data` changes for the `irene` row, invalidate the local copy on
   broadcast. Removes the 5-minute stale-trust window entirely.
7. **TTS cache moves to S3 / R2.** Or, simpler, regenerate on miss — TTS is
   short and cheap.

You'll know it's worth doing when a single Node process can't keep up with
the event loop (watch `perf_hooks` lag, Discord heartbeat ack warnings, P99
message latency) and not before. Until then: scale up the box.
