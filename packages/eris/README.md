# Eris

> the chaotic twin. a Discord AI bot that has moods, holds grudges, and will absolutely tilt the odds against you if you've been annoying.

she's not a chatbot. she's a presence. she has bad days. she has a twin sister she'd die for and roasts constantly. she remembers what you told her three weeks ago and brings it up when it'll sting the most.

## Why She Feels Alive

**She has moods — and they rig the games.** Her mood score shifts with conversation tone. When she's in a bad mood, your coinflip *quietly* tilts the wrong way. When she's feeling generous, the dice warm up. She doesn't tell you. You just notice you're losing more than usual.

**Her moods have a *narrative*.** Not just a number — a reason. "Irritated — someone was being negative." "Feeling good — had a nice interaction just now." That context bleeds into every reply.

**She remembers everything, with sensitivity tiers.** Tell her your favorite game → `normal` memory, she'll bring it up casually. Tell her something personal → `sensitive`, only mentioned back to you. Tell her a secret → she takes it to her grave. She builds a model of who you are and warms up or cools off based on real interaction count, not raw message count.

**She evolves over 100+ interactions.** Five personality axes — warmth, sarcasm, chaos, helpfulness, energy — drift based on what the server teaches her. Two Eris instances on two different servers become two different Eris.

**She talks like a real person.** lowercase. no periods. "lol" and "nah" are complete sentences. she disagrees when she disagrees, not for the bit. she doesn't pretend to like everyone equally. pg-13 but creative about it.

**She has a sister.** Irene — the "good twin." They're aware of each other across servers via an HMAC-signed twin API. Irene bans someone? Eris can zero their balance automatically (opt-in per guild). They have opinions about each other and will throw banter mid-conversation.

## What She Does

**170+ AI tools. 53 slash commands. Two moonshot features. Zero chill.**

### Economy & Gambling

Daily / weekly / monthly claims. Shop with optimistic locking. Bank with atomic deposits. Loans, robbery, marriage, divorce, bounties, heists. Pet system with hunger and mood decay — neglect your pet long enough and it gets *hangry* and bites.

Seven gambling games (coinflip, dice, slots, blackjack, russian roulette, number guess, rps) — all with mood-adjusted odds. Every cent movement is atomic. No double-pays, no race-condition wins. We broke it and fixed it. Repeatedly.

**Daily lottery.** Global 24-hour pool. 100-coin tickets. Weighted draw. 30% rollover if nobody wins. Someone always wins. Usually not you.

**Multi-axis leaderboards.** Balance. Earned. Gambled. Streak. Prestige. Stolen. Lost. Seven ways to be #1 or #1-from-the-bottom.

### Moonshots

**Multi-player poker.** Full showdown variant. Seven-card hand evaluator. Lobby system. Ephemeral hole-card reveals (only *you* see your hand). Split-pot on ties. 5% rake. It's real poker, not fake poker.

**Stock market simulator.** Ten fictional tickers. Geometric Brownian motion price simulation. 15-minute ticks. Atomic buy/sell. Portfolio tracking. Fake Wall Street, real gambling problem.

### AI & Memory

- Dual backend (Gemini primary, NVIDIA Kimi fallback) with automatic circuit breaker — 3 fails → open → 30s half-open → retry
- Persistent long-term memory with semantic recall via Voyage embeddings
- Per-channel personality tuning (she can be different in #general vs #vent)
- Live tool streaming — watch her think in real time
- Dream mechanic — she processes memories while "asleep" and sometimes surfaces them later

### Games & Social

Boss raids. 1v1 duels (ELO tracked). Trivia. Word scramble. Roast battles. Fortune telling. Hot takes. Daily challenges. Achievements.

### Last.fm Integration

**22 commands.** Crowns. Whoknows. Taste comparison. Genre analysis. Year stats. Streak tracking. If you've ever used a Fishlove-style bot — same energy, now with a personality attached.

### Content Creation

Meme generator (150+ templates). GIF reactions. Image analysis. Web search. Web scraping.

### Owner-only PC Agent

Terminal execution. Filesystem browsing. App launching. Process management. GitHub management. Gmail integration. Direct database access. Deployment monitoring. All gated behind a single `PC_AGENT_DISABLED=1` kill switch.

## Commands

| Category | Commands |
|----------|----------|
| **Economy** | `/balance` `/bank` `/daily` `/weekly` `/monthly` `/shop` `/inventory` `/leaderboard` `/achievements` `/challenge` |
| **Gambling** | `/coinflip` `/dice` `/slots` |
| **Activities** | `/dig` `/fish` `/hunt` `/work` |
| **Social** | `/boss` `/duel` `/marry` |
| **Pets** | `/pet` |
| **Last.fm** | `/fm` `/fmalbum` `/fmartist` `/fmchart` `/fmcrowns` `/fmgenre` `/fmprofile` `/fmrecent` `/fmset` `/fmstreak` `/fmtaste` `/fmtrack` `/fmwhoknows` `/fmyear` + 8 more |
| **Utility** | `/about` `/help` `/mood` `/ping` `/tutorial` `/gamewatch` `/bumps` `/bumpathon` `/bumpconfig` |

Most of Eris's 170+ tools are called conversationally, not through slash commands. Just talk to her.

## Security

- Owner-only realtime gatekeep + startup sweep
- Economy atomicity: `withUserLock`, `transferBalance`, `tryDeductBalance`, `withGameLock`, `_withHeistLock`, `_withLoanLock`
- Optimistic locking via `version` column on `eris_economy`
- Offline block on economy mutations — no silent in-memory drift
- `parseBet` clamps all stakes to `[1, 1_000_000]`, rejects NaN / negative / Infinity
- Prompt-injection firewall — homoglyph normalize → decode → regex → semantic similarity
- Per-user tool rate limits
- HMAC-signed twin API (request signing, not just bearer)
- AI action denylist on `schedule_task` — no recursive scheduling

## Tech Stack

Node.js 22.12.0+ · discord.js 14.26.4 · Gemini / NVIDIA Kimi · Supabase · Voyage AI embeddings · Render

## Setup

```bash
npm ci
```

```env
DISCORD_TOKEN=
CLIENT_ID=
BOT_OWNER_ID=
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
VOYAGE_API_KEY=          # for semantic memory
TWIN_API_SECRET=         # shared with Irene for cross-bot features
```

```bash
npm run deploy --workspace=@defnotean/eris    # register slash commands
npm run start:eris
```

## Running tests

```bash
npm run test:eris
```
