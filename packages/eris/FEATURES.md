# Eris — Feature Progress

Tracks what's shipped, what's planned, and what's explicitly skipped.
Legend: ✅ shipped · 🚧 in progress · ⬜ planned · ⏭️ skipped (with reason)

---

## Recently shipped

### Council execution round (2026-04-23 evening)
- ✅ **Dead-code purge** — deleted `tasks/` folder (5 .ts files, orphan refactor with no callers) + `db/` folder (21 .ts files, same) + dead stock functions in `ai/stocks.js` + dead `eris_stocks` table accessors in `database.js`. Net ~2,300 LOC removed, zero behavior change.
- ✅ **Moonshot regression tests** — 82 new tests across `tests/ai/poker.test.ts`, `tests/ai/stockMarket.test.ts`, `tests/ai/lottery.test.ts`, `tests/utils/roleCategorizer.test.ts`. Target the exact bug classes we shipped: split-pot leftover, share-count overflow, weighted-draw proportionality, cosmetic-role spoof. Extracted `splitPot()` + `evalFiveCards` + `compareHands` from inside `resolveTable` so the math is unit-testable. All 82 pass.
- ✅ **Casino executor extracted** — `start_poker`/`join_poker`/`stock_market`/`stock_buy`/`stock_sell`/`buy_lottery_ticket`/`lottery_status` moved from 43KB `miscExecutor.js` into dedicated `casinoExecutor.js`. File layout now matches test layout one-to-one.
- ✅ **Refund-path logging** — `.catch(() => {})` on poker create/join refunds + lottery rollback refund now log user+amount+error so orphaned coins show up in observability instead of silently vanishing.
- ✅ **LRUCache group index** — `invalidateUserCache` is O(k) instead of O(n). Critical on economy-heavy servers doing 50-100 bets/sec.
- ✅ **Shared core extraction plan** — `EXTRACTION_PLAN.md` documents the full monorepo migration (phase 0 drift reconciliation, workspace setup, per-file move order, deploy changes, risk register). Execution deferred; plan is on the board.

### Security & correctness (2026-04-23 council audit round)
- ✅ **Dashboard API-key hardening** — removed the `config.token.substring(0, 20)` fallback that was letting a truncated Discord bot token double as a dashboard credential.
- ✅ **Dead stock code purged** — deleted the old 5-min `db.getAllStocks`/`updateStockPrice` ticker from `events/ready.js` (was running alongside the new `stepMarket` GBM loop, mutating two state stores independently). Also deleted `ai/stocksExecutor.js` — the dispatcher had already rerouted to the locked `stockMarket.js` path weeks ago; the file sat as a tempting wrong turn.
- ✅ **Twin mute respected for Irene's messages** — `events/messageCreate.js` now enforces `chat_muted_channels` on twin messages too. Previously only the `!isTwin` branch checked; Eris happily chatted with Irene in admin-designated "quiet" channels.
- ✅ **HMAC twin-punish repaired** — `api/dashboard.js` generic `body.secret` pre-check was 403'ing Irene's HMAC-signed requests before the real verifier ran. Cross-bot punish was broken in prod.
- ✅ **Stock path wired to hardened code** — `ai/executor.js` dispatcher was short-circuiting `stock_buy`/`stock_sell` to the OLD racy `stocksExecutor.js` path, shadowing the hardened `withUserLock`-protected code in `stockMarket.js`. The whole "hardened stock market" moonshot was effectively dead code until the reroute.
- ✅ **Poker split-pot** — `Math.floor(pool/winners)` leftover was leaking coins to the house on ties. Now distributes the remainder 1-per-winner in rank order.
- ✅ **Lottery ticket cap** — per-user accumulation is capped at 999k (load path rejects ≥1M, so unbounded in-memory growth silently vaporized tickets past that point).
- ✅ **Batch lootbox failure reporting** — item credit failures were silently swallowed while boxes were already consumed. Now surfaces "db lost: N× Item" in the reply.
- ✅ **`query_database` table whitelist** — defense-in-depth against owner-targeted prompt injection.
- ✅ **LRUCache group index** — `invalidateUserCache` is O(k) instead of O(n). Critical on economy-heavy servers doing 50-100 bets/sec.

### New features
- ✅ **Multi-player poker** `[MOONSHOT]` — showdown variant, 7-card hand eval, lobby + ephemeral hole cards, split-pot with fair leftover distribution, 5% rake.
- ✅ **Stock market** `[MOONSHOT]` — 10 tickers, GBM price sim, 15-min ticks, atomic buy/sell, portfolios, now actually reachable.
- ✅ **Daily lottery** — global 24h pool, 100-coin tickets, weighted draw, 30% rollover.
- ✅ **Pet hunger/mood decay** — lazy on-read, hangry mechanic.
- ✅ **Batch loot-box opening** — `open_all_lootboxes`, up to 50 at once, per-item failure reporting.
- ✅ **Multi-axis leaderboards** — balance / earned / gambled / streak / prestige / stolen / lost.
- ✅ **Cross-bot punish** — `/api/twin/punish` endpoint + `toggle_cross_bot_punish` admin tool, HMAC-signed.
- ✅ **Permission-based role categorizer** — `list_roles_by_category` AI tool. Answers "who are the mods on this server?" by actual Discord permissions (not role names), so cosmetic vanity roles can't be miscategorized.
- ✅ **Event channel denylist** — `set_event_channels` has both allow + deny lists.

### Reliability
- ✅ Atomic economy primitives (`withUserLock`, `transferBalance`, `tryDeductBalance`, optimistic `version` column).
- ✅ NVIDIA circuit breaker (3-fail → open, 30s half-open) with auto-fallback to Gemini.
- ✅ Gemini 429 fallback + conv/work pool split (even keys for conversation, odd for work).
- ✅ Per-user tool rate limits + escalating anti-spam cooldowns.
- ✅ Prompt-injection firewall — homoglyph normalize → decode → regex → semantic (90+ patterns, worker-threaded with ReDoS timeout).
- ✅ Bounded LRU caches (tool results, user history, conversations) with TTL.
- ✅ Colored aligned console logger.

---

## Planned by category

### Economy
- ⬜ Investment portfolios (post-hardened stock market)
- ⬜ Auction house expansion (schema exists)
- ⬜ Commodity trading (wheat / gold / timber)
- ⬜ Player-to-player loans
- ⬜ Credit score system
- ⬜ Tax events (random server-wide 1%)
- ⬜ Coin-burning deflation events
- ⬜ Compound bank interest above threshold
- ⬜ Passive business empire (factories / farms nested income)
- ⬜ Real estate (channels as properties)
- ⬜ Subscription / boost perks

### Gambling
- ⬜ Roulette (European + American)
- ⬜ Horse racing
- ⬜ Prediction markets
- ⬜ Progressive slots jackpot
- ⬜ Blackjack tournaments
- ⬜ Casino VIP tiers
- ⏭️ Sports betting — regulatory risk
- ⏭️ Dating profiles — moderation burden

### Pets & crafting
- ⬜ Pet breeding
- ⬜ Pet evolution at level milestones
- ⬜ Pet accessories (cosmetic + stat)
- ⬜ Rare pet drops from activities
- ⬜ Crafting trees (tiers)
- ⬜ Recipe discovery via experimentation
- ⬜ Tool durability
- ⬜ Enchanting
- ⬜ Workshop display

### Social
- ⬜ Friendship system
- ⬜ Rivalry declaration
- ⬜ Family / adoption
- ⬜ Anonymous gifts
- ⬜ Social actions library (`/hug`, `/kiss`, `/high-five` with GIFs)
- ⬜ Marriage expansions (shared vault, anniversary, honeymoon)
- ⬜ Matchmaker Eris
- ⏭️ Dating profiles — moderation burden

### Multiplayer games
- ⬜ Chess
- ⬜ Connect-4 / Tic-tac-toe / Hangman
- ⬜ Daily Wordle-style puzzle
- ⬜ Daily crossword
- ⬜ Sudoku
- ⬜ 2-player card games
- ⬜ Trivia tournament brackets
- ⬜ Team raid bosses
- ⬜ PvP deathmatch

### Guilds / factions
- ⬜ Create guilds (groups of users)
- ⬜ Guild wars
- ⬜ Guild quests
- ⬜ Guild rankings

### Adventures / quests
- ⬜ Procedurally generated daily quests
- ⬜ Multi-day quest chains
- ⬜ Branching story mode (expansion of adventure system)
- ⬜ Exploration unlocks
- ⬜ Boss fights (server-wide raid)
- ⬜ Dungeon crawls

### Events & seasons
- ⬜ Seasonal events (Halloween / Christmas / Lunar New Year)
- ⬜ Weekly tournaments
- ⬜ Flash shop sales
- ⬜ Double-XP hours
- ⬜ Scavenger hunts
- ⬜ Server-wide fundraisers

### Leaderboards & competition
- ⬜ Historical rankings ("you were #1 last month")
- ⬜ Seasonal leaderboard resets with rewards
- ⏭️ Cross-server leaderboards — privacy complexity

### QoL
- ⬜ Collect all minions in one call
- ⬜ Mobile-friendly embed layouts
- ⬜ Account backup
- ⬜ Compact mode

### Integrations
- ⬜ Last.fm music compatibility scores
- ⬜ Steam library sync
- ⬜ Spotify co-listening detection

---

## Cross-bot (Eris + Irene)
- ✅ Cross-bot punish (Irene bans → Eris zeros balance, opt-in per guild, HMAC-signed)
- ✅ Role categorizer shared (same file, same categories across both bots)
- ✅ Twin mute respects admin's chat-channel rules
- ⬜ Shared schedule calendar
- ⬜ Organic cross-bot conversations (beyond banter)
- ⬜ Shared achievement system
- ⬜ Unified `/status` dashboard
- ⬜ Eris exploit signals → Irene investigation
- ⬜ Cross-bot handoffs with context

---

## Known debt (flagged, with status)
- ~~`db/` folder~~ — **cleared** 2026-04-23 council step 1.
- ~~`tasks/` folder~~ — **cleared** 2026-04-23 council step 1.
- Duplicated personality / firewall / humanity / longmemory / semantic modules across Eris + Irene — **plan drafted** in `EXTRACTION_PLAN.md`; execution deferred until the four drifted files are reconciled.
- `miscExecutor.js` still 35KB after casino extraction — remaining domains (mood, pets, territory, etc.) are candidates for further splits if file size ever becomes a real maintenance pain point. Council Correctness flagged file-size splits as cosmetic; doing them incrementally as each domain gets tested.
- `ai/stocks.js` is misleadingly named — holds live pet + boss exports despite the filename. Rename + import update across many callers is a one-time cost; deferred.

---

## Security inventory
- Owner-only gatekeep + realtime + startup sweep
- Economy atomicity (withUserLock, transferBalance, tryDeductBalance, withGameLock, heist/loan locks, marriage pipeline)
- Optimistic locking via `version` column on `eris_economy`
- Offline block on economy mutations — no silent in-memory drift
- `parseBet` clamps `[1, 1_000_000]`, rejects NaN / negative / Infinity
- NVIDIA circuit breaker + Gemini fallback
- Per-user tool rate limits
- HMAC-signed twin API (timing-safe compare, ±60s skew, replay cache)
- AI action denylist on `schedule_task` (no recursive scheduling)
- Firewall: homoglyph → decode → regex → semantic (Voyage embeddings)
- `query_database` table whitelist
- Dashboard API auth: explicit `DASHBOARD_API_KEY` or `TWIN_API_SECRET` only (no truncated-token fallback)

---

*Last updated: 2026-04-23 (council audit round)*
