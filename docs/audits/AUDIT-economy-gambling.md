# Gambling and Economy Audit — Double-Spends, Negative Balances, RNG, Overflow

Scope: every code path that mutates a user's coin balance, deals with shared
pots (poker / lottery / heist / auction), or relies on RNG for a money-affecting
outcome. Source tree: `packages/eris/`. No runtime, no edits — read only.

## Current status (2026-06-01)

The original `/bank deposit` and `/bank withdraw` race finding has been fixed:
the slash command now calls `bankDeposit` / `bankWithdraw`, and
`packages/eris/tests/db/bankRace.test.ts` covers parallel deposits and
withdrawals. Older rows in this file should be read with that remediation in
mind.

## Architecture summary

All balance writes funnel through `_updateBalanceUnsafe()` in
`packages/eris/database.js:781` behind a per-user in-process mutex
(`withEconLock` at `database.js:716`). Inside that helper the preferred path is
the Postgres function `eris_add_balance` (`migrations/002_atomic_balance_rpc.sql`)
which runs `SELECT … FOR UPDATE` + bounded `UPDATE` in one transaction; the
fallback when the RPC isn't deployed is a version-CAS retry loop with capped
backoff (`database.js:838-898`). Both paths refuse the update when the resulting
balance would go negative, surfacing `insufficient_balance` to the caller.

Gambling commands live in `packages/eris/commands/gambling/` (slash commands)
and `packages/eris/ai/executors/gamblingExecutor.js` (AI-tool path). Roulette
has a dedicated rules module at `packages/eris/ai/gambling/roulette.js`; shared
helpers (slots, blackjack, mood-rigging) are in `packages/eris/ai/gambling.js`.
Multi-player surfaces — poker, lottery, stocks, auctions, heists — live in
`packages/eris/ai/poker.js`, `ai/lottery.js`, `ai/stockMarket.js`, and the
auction/heist helpers in `database.js`.

## Mutations inventory

| Surface | Entry point | Mutation primitive |
|---|---|---|
| `/coinflip` slash | `commands/gambling/coinflip.js:27` | `updateBalance` (check-then-update) |
| `/dice` slash | `commands/gambling/dice.js:24` | `updateBalance` (check-then-update) |
| `/roulette` slash | `commands/gambling/roulette.js:102,134` | `tryDeductBalance` + `updateBalance` (atomic stake) |
| `/slots` slash | `commands/gambling/slots.js:27` | `updateBalance` (check-then-update) |
| AI `coinflip_bet` | `gamblingExecutor.js:76` | `updateBalance` (check-then-update) |
| AI `dice_roll_bet` | `gamblingExecutor.js:111` | `updateBalance` (check-then-update) |
| AI `slots_spin` | `gamblingExecutor.js:135` | `updateBalance` (check-then-update) |
| AI `blackjack_start/action` | `gamblingExecutor.js:161,207,220` | `updateBalance` under per-game lock |
| AI `russian_roulette` | `gamblingExecutor.js:290,296` | `updateBalance` (check-then-update) |
| AI `rps_play` | `gamblingExecutor.js:335` | `updateBalance` (check-then-update) |
| AI `rob_user` | `gamblingExecutor.js:254,267` | `transferBalance` (two-user atomic) |
| Poker ante | `ai/poker.js:287,335` | `tryDeductBalance` under per-channel table lock |
| Poker payout | `ai/poker.js` (resolveTable) | `updateBalance` per winner |
| Lottery buy | `ai/lottery.js:142` | `tryDeductBalance` under module-level lock |
| Lottery payout | `ai/lottery.js:237` | `updateBalance` |
| Stocks buy | `ai/stockMarket.js:249` | `tryDeductBalanceUnsafe` under `withUserLock` |
| Stocks sell | `ai/stockMarket.js:289` | `updateBalanceUnsafe` (decrement-first) |
| `/bank deposit` slash | `commands/economy/bank.js:32-43` | `bankDeposit` atomic helper |
| `/bank withdraw` slash | `commands/economy/bank.js:46-54` | `bankWithdraw` atomic helper |
| `bankDeposit/Withdraw` API | `database.js:1877,1897` | atomic, under `withEconLock` |
| `/daily`, `/weekly`, `/monthly` | `database.js:984,2025,2051` | under `withEconLock` |
| Bank interest | `database.js:1914` | unlocked read-modify-write on bank cache |
| Auctions bid | `database.js:1755` | per-auction lock + optimistic CAS |
| Loans | `database.js:1407-1427` | no locks, no balance side-effects (insert-only) |

## Per-mutation atomicity

| Mutation | Stake validated | Stake bounds | Lock model | Atomic deduct | Negative-balance guard | Verdict |
|---|---|---|---|---|---|---|
| `/roulette` | yes (`validateBet`) | min 10 / max 1,000,000 | `withEconLock` via RPC | yes (`tryDeductBalance`) | yes (RPC refuses) | safe |
| `/coinflip` slash | only `setMinValue(10)` | min 10 / no max | `withEconLock` | no — read-then-write | yes (RPC refuses) | TOCTOU window before refund credit |
| `/dice` slash | min 10 / no max | none | `withEconLock` | no — read-then-write | yes | same TOCTOU shape; 4× win never overflows int |
| `/slots` slash | min 10 / no max | none | `withEconLock` | no — read-then-write | yes | same TOCTOU; 100× supernova jackpot uncapped |
| AI gambling tools | `parseBet`, 1 ≤ n ≤ 1,000,000 | enforced | `withEconLock` (game lock for BJ) | no — read-then-write | yes | shape OK; uncapped 100× slots multiplier survives |
| `blackjack_action` | parsed at start | inherits | per-game `withGameLock` | yes via lock | yes | safe; double risks reading stale balance under heavy load |
| `rob_user` | n/a | n/a | atomic `transferBalance` (two-lock sorted) | yes | yes | safe |
| Poker ante / payout | `Math.max(10, Math.min(100k, ante))` | min 10 / max 100k | per-channel `_withTableLock` + per-user lock | yes (`tryDeductBalance`) | yes | safe; refund-on-throw logged |
| Lottery buy | clamped 1–100/call, max 999k/user | enforced | module-level `_withLotteryLock` | yes (`tryDeductBalance`) | yes | safe |
| Stocks buy | `_parseShareCount` clamps ≤ 1M | enforced | `withUserLock` + `MAX_POSITION_VALUE=1e12` | yes (`*Unsafe`) | yes | safe |
| Stocks sell | parsed | clamped | `withUserLock` + decrement-first w/ rollback | yes | n/a (credit) | safe; rollback path could log refund failures |
| `/bank deposit/withdraw` slash | min 1 / no max | none | none — two awaits in series | no | wallet yes / bank floored at 0 | **double-spend race** (see Risk #1) |
| Bank interest | n/a | n/a | none | n/a | implicit | overpay possible if called twice concurrently |
| Daily / weekly / monthly | n/a | n/a | `withEconLock` | n/a (credit only) | n/a | safe |

## RNG analysis

Every monetary outcome uses `Math.random()` — V8's xorshift128+ variant.
That is **not cryptographically random and is in principle predictable** given
enough observed outputs, but for this product (chat-bot coin economy with no
external cash-out, mood-rigged odds, and a hard 2.7%–7%+ house edge baked in)
the practical exploit cost is far higher than the upside. Coercing one extra
slot pull is worth at most a few thousand coins.

Notable RNG sites:

- Roulette spin — `ai/gambling/roulette.js:51-53` — accepts an injected `rng`
  for tests; production uses `Math.random`. Spin is independent per call, no
  observable seed material leaked.
- Slot reels + rigging — `ai/gambling.js:170-232` — weighted pick, then a
  mood/affinity rig with 10% trigger probability. The rig only ever forces a
  pair-of-decent (win nudge) or three-different-non-skull (loss nudge), so
  worst-case mood impact is "lose the stake", not "lose double". `mood_score`
  and `affinity_score` are persisted, so a user who knows their own affinity
  could predict whether the next spin enters the win-rig branch — but cannot
  predict the symbol chosen inside it.
- Lottery draw — `ai/lottery.js:211` — `Math.floor(Math.random() * totalTickets) + 1`.
  Single roll per draw, no observable history that would expose internal RNG state.
- Poker shuffle — `ai/poker.js:128-137` — Fisher-Yates with `Math.random`. Two
  hands in the same process share PRNG state; that is a theoretical seeding
  attack only if a player can co-locate observed outputs with the next deal.
  Not exploitable from Discord.
- Blackjack deck — `ai/gambling.js:90-103` — Fisher-Yates with `Math.random`.
  Same as poker.
- Stock GBM step — `ai/stockMarket.js:122-141` — Box-Muller off `Math.random`,
  ±20% clamp, mean-reverting toward base. Price is bounded `[1, 1_000_000]`.
- Rob outcome (`gamblingExecutor.js:249`, 40% success), russian roulette
  (`gamblingExecutor.js:282`, 1/6 dead) — single-draw, no leakage.

Verdict: not crypto-grade, but adequate for a play-money economy. Treat any
"predicted next roll" report as a server-config problem, not a math problem.

## Top 5 risks (ranked)

1. **Fixed: `/bank deposit` and `/bank withdraw` double-spend race.** The slash
   command now calls `bankDeposit` / `bankWithdraw`, which run under the economy
   lock. `packages/eris/tests/db/bankRace.test.ts` covers parallel deposits and
   withdrawals so this finding should not regress silently.

2. **`/coinflip`, `/dice`, `/slots`, `russian_roulette`, `rps_play`,
   `coinflip_bet`, `dice_roll_bet`, `slots_spin` all use check-then-update
   instead of atomic deduct** — pattern: `getBalance` → `if balance < amount`
   → `updateBalance(payout)`. The negative guard in `_updateBalanceUnsafe`
   prevents the user from actually going negative on the eventual write, BUT
   the win-branch can credit a payout the user had no funds to wager: rapid
   parallel calls both pass the balance check while only one stake-equivalent
   amount of risk was on the table. Worst case is a "free roll" where both
   calls win and only one stake was at risk. The version-CAS loop reduces
   the window but doesn't close it. Roulette and poker fixed this with
   `tryDeductBalance`; the rest haven't. Severity: **medium–high**.

3. **Slots 100× supernova jackpot is uncapped vs the 1M bet ceiling** —
   `ai/gambling.js:250` returns `multiplier: 100` for triple supernova. The AI
   executor caps bets at 1M; the slash command has no max. A 1M bet × 100 =
   100M coin single-shot payout. That's well inside `BIGINT` and JS safe-int
   bounds, but it's a balance-blowout event that bypasses any per-day earn
   cap. Combined with risk #2, parallel high-stake spins could compound this.
   Severity: **medium**.

4. **`applyBankInterest` is unlocked read-modify-write** —
   `database.js:1914-1933` reads `getBankBalance` → computes `interest` from
   stale `last_interest` → `updateBankBalance(+interest)` → updates
   `last_interest`. Two concurrent calls (slash + AI tool, or two button
   clicks) both read the same `last_interest`, both compute the same
   `interest`, and the second one credits a duplicate. The cap-shrink at line
   1924 won't catch this if the user is below cap. Severity: **medium**
   (low frequency, hard to weaponize at scale).

5. **`/slots` slash command bet has no max** —
   `commands/gambling/slots.js:9` only sets `setMinValue(10)`. Discord's
   integer cap (`MAX_SAFE_INTEGER` ≈ 9e15) is the only ceiling. A user with
   1e12 coins could bet their full balance and lose 2× on a double-skull
   (`multiplier: -2` at `ai/gambling.js:243`) — but `payout` is computed as
   `-amount * 2` in the slash command, then `_updateBalanceUnsafe` checks
   non-negative and refuses, so the user is **stuck unable to spin** rather
   than actually losing 2×. Still a bad UX and a foot-gun. Coinflip and dice
   slash commands have the same no-max issue. Severity: **low–medium**.

## Remediation

- **Risk #1**: Replace the manual two-step in `commands/economy/bank.js` with
  the existing atomic helpers `bankDeposit(userId, amount)` and
  `bankWithdraw(userId, amount)` from `database.js`. Both already hold
  `withEconLock` across the full read-check-debit-credit window. Zero new
  code, just route the slash through the safe helper.
- **Risk #2**: Convert the check-then-update gambling paths to
  `tryDeductBalance(userId, amount, …)` for the stake, then credit the win
  via a separate `updateBalance(+payout)`. Mirror the roulette pattern
  (`commands/gambling/roulette.js:102`). Six commands + four AI tools — all
  one-line swaps.
- **Risk #3**: Add a per-game max bet (e.g., `min(1M, balance)`) on slots
  before the spin resolves. The 100× multiplier is fine in isolation;
  combining it with arbitrary stake is the issue.
- **Risk #4**: Wrap `applyBankInterest` in `withEconLock(userId, …)` (or a
  dedicated bank lock) and re-check `last_interest` inside the critical
  section. Equivalent fix: do the interest credit inside the same RPC as the
  `last_interest` timestamp update.
- **Risk #5**: Mirror roulette's `setMaxValue(1_000_000)` on the
  `/coinflip`, `/dice`, and `/slots` slash command builders. Aligns the
  slash surface with the AI surface's `MAX_BET`.

## Things this audit did NOT find

- No path bypasses `_updateBalanceUnsafe`'s `if (wouldBe < 0) throw`. The
  invariant "balance is never negative" holds across all surveyed surfaces.
- No `Math.random()`-derived monetary value is exposed in a way that allows
  recovering V8's internal PRNG state. (The risk would be a long stream of
  raw doubles being logged or echoed; the bot only emits derived integers.)
- No accumulator (poker pot, lottery pot, bank balance, total\_earned) can
  reach `MAX_SAFE_INTEGER` from realistic gameplay — every multiplicative
  path has a cap (`MAX_BET`, `MAX_POSITION_VALUE`, `MAX_PER_USER` lottery
  tickets, `MAX_PRESTIGE_MULTIPLIER_LEVEL`).
- Loans (`database.js:1407-1427`) don't touch the balance — they insert
  rows only. The actual coin grant / repayment goes through `updateBalance`
  elsewhere, so it inherits the same locking guarantees.
