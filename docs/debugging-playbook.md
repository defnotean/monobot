# Debugging playbook

Symptom → file location. The reverse direction of [where-do-i-edit.md](./where-do-i-edit.md). Use this when something's broken and you need to know where to look.

## Recent fixes — symptom → file quick lookup

If the symptom matches one of these, jump straight to the file. Each row links to a recipe further down for the full why/how.

| Symptom | File | Recipe |
|---|---|---|
| `429` from `/api/twin/state` | `packages/shared/src/rateLimit.js` + `packages/eris/api/dashboard.js:13,428` | [Twin state endpoint 429s](#twin-state-endpoint-429s) |
| `[DB] eris_add_balance RPC not deployed` log line | `packages/eris/database.js` `_updateBalanceUnsafe` (~690) + `packages/eris/migrations/002_atomic_balance_rpc.sql` | [Atomic balance RPC fell back to CAS](#atomic-balance-rpc-fell-back-to-cas) |
| `still processing your last move, hang on` on blackjack buttons | `packages/eris/events/interactionCreate.js:113-120` | [Blackjack button ephemeral rejection](#blackjack-button-ephemeral-rejection) |
| Trust changes don't take effect for ~5 min after `/trust` | `packages/irene/database.js:1020-1061` | [Trusted-user cache staleness](#trusted-user-cache-staleness) |
| Karaoke session ended on its own after 10 min | `packages/irene/ai/karaoke.js:32,402-413` | [Karaoke session auto-ended](#karaoke-session-auto-ended) |
| `/voice listen` stopped without `/voice stop` | `packages/irene/voice/listener.js:48,51,102-118` | [Voice listener auto-stopped](#voice-listener-auto-stopped) |
| Humanity/sentiment reads stale in a busy channel | `packages/irene/ai/humanity.js:34-78` | [humanity.js 30s judge cooldown](#humanityjs-30s-judge-cooldown) |
| Semantic search cache hit-rate dropped after upgrade | `packages/eris/ai/semantic.js:29-36` | [Semantic cache misses after hash widening](#semantic-cache-misses-after-hash-widening) |
| Bot connects, sees no messages | `packages/<bot>/index.js` intents + Discord Developer Portal | [Bot connects but doesn't respond](#bot-connects-but-doesnt-respond) |
| `/foo` isn't there in the picker | `packages/<bot>/deploy-commands.js` + `npm run deploy` | [Slash commands missing](#slash-commands-missing) |
| Tests pass locally, fail on CI (or vice versa) | `packages/<bot>/tests/**/*.test.ts` | [Tests flake on timers / RNG](#tests-flake-on-timers--rng) |

## Bot doesn't respond at all

Walk the gating gauntlet in `packages/<bot>/events/messageCreate.js` top-to-bottom. Each gate can silently drop a message.

| Gate | Eris file:line approx. | Irene file:line approx. | Common cause |
|---|---|---|---|
| Self-skip + dedup | ~257-262 | ~333 | normal — duplicates are filtered |
| Bump-service short-circuit | ~267-284 | — | DISBOARD/Discadia/Disforge confirmation passing through |
| Auto-mod | — | ~348 | Irene only — message got actioned, return without reply |
| Sleep mode | ~287-298 | ~360 | bot is in sleep mode; only owner wake-trigger works |
| Bot allowlist | ~301-323 | ~389 | message from another bot that didn't @mention us |
| Exploit pattern | ~40-64 | ~417 | message matched paradox/recursion/twin-loop regex |
| Repeat escalation | ~354-372 | ~468 | user has been spam-detected; in 3+ repeats → Discord timeout |
| Twin throttle | ~402-428 | — | Eris↔Irene exchange cap hit |
| Hard directive | ~437-454 | — | admin set "don't talk here" rule active |
| Mention/name gate | ~464-501 | ~749 | message doesn't @mention, name-match, or sit in a 90s reply window |
| Mute list | ~507-511 | — | channel is muted via `chat_muted_channels` |
| AI cooldown | ~516-543 | ~577 | per-user cooldown active |
| Length cap | ~545-548 | ~605 | message > 1500 chars from non-owner — silently dropped |
| Injection firewall | ~549-564 | ~613 | message matched semantic similarity to known injection |
| Age gate | — | ~567 | Irene only — message > 30s old (shard-resume replay) |

**Fastest diagnostic**: add a `console.log` after each gate temporarily, restart, send the test message, see which gate ate it.

## Bot replies but it's truncated mid-sentence

Four possible truncators, in order of likelihood:

1. **`maxOutputTokens` vs `thinkingBudget` mismatch** — `packages/<bot>/ai/dual.js`. Thinking tokens count toward `maxOutputTokens`. If `thinkingBudget=4096` and `maxOutputTokens=2048`, the model thinks for the whole budget and you see nothing. **Always set `maxOutputTokens > thinkingBudget`.** Check Gemini logs for `finishReason=MAX_TOKENS`.

2. **`[LENGTH BUDGET]` directive** — system prompt block in `messageCreate.js` (Eris ~1018-1034, Irene ~1156). Vent: 400, research: 250, casual: 150 chars. Increase if your reply class is consistently truncated.

3. **`_charBudget` post-hoc trimmer** — `messageCreate.js` (Eris ~1106-1121, Irene ~1723). Trims to the last sentence boundary with 1.2× grace. If your reply has no sentence boundaries (e.g. a code block), it might trim hard.

4. **2000-char Discord cap** — Eris ~1123, Irene ~1747. The hard ceiling. If you're hitting this you probably want `splitMessage` to multi-segment (Irene already does).

## Wrong tool gets called

1. **Keyword regex doesn't fire** → `packages/<bot>/ai/toolRegistry.js` lines 147-256 (Eris) / 145-311 (Irene). The category whose regex matches the message gets included in Tier 1. Fix the regex or add a category.

2. **Model uses wrong name** → `TOOL_ALIASES` map in `packages/<bot>/ai/executor.js`. Add an alias for the wrong name.

3. **Tool isn't in the active profile** (Eris) → check which profile (`twin`/`chat`/`chatOwner`/`full`/`fullOwner`) the message hit, then check the profile filter in `messageCreate.js`. Tools missing the right `tags` or filter criteria don't show up.

## Tool times out

1. **Per-call timeout** — `packages/<bot>/ai/dual.js` `SLOW_TOOLS` allowlist (web/scrape/image/email/github get 25s; everything else 10s). Add your tool to `SLOW_TOOLS` if it legitimately needs more time.

2. **Per-user/per-tool rate limit** — `packages/<bot>/utils/toolRateLimit.js`. Escalating backoff (5s → 30s → 5m). Check the `_userBans` map for the user.

3. **Outer loop timeout** — `dual.js` `Promise.race` against 90s worker / 45s fast (Eris) or 60s/35s (Irene). If a single tool blocks forever it can drag the whole loop past the cap.

## Bot loops with its twin

`messageCreate.js`:
- **`MAX_TWIN_EXCHANGES` and Jaccard guard** (Eris ~178, ~393-398) cap repetitive twin chat.
- **Bot-to-bot counter** (Eris ~314-322) counts mentions in a 5-min window.

If both fail and they're still looping, check `TWIN_BOT_ID` env vars on both sides — if they don't recognize each other as the twin, normal "bot allowlist" rules don't apply and the throttle never fires.

## 429 / "brain overheating"

`packages/<bot>/ai/keyPool.js`. The pool tracks per-key 429 status. When all keys in the pool are throttled:
- Eris: surfaces "brain overheating" to user.
- Irene: tries `geminiFallbackModel` first; if that also 429s, surfaces.

**Mitigations**:
- Add more `GEMINI_API_KEY*` env vars (Irene supports up to 12; Eris supports 4).
- Tune `geminiFallbackModel` to a less-loaded tier.
- Reduce `MAX_ITERATIONS` if you're burning the budget on multi-turn tool calling.

## Empty / "hmm something went quiet" reply

1. **Empty-response retry** — `dual.js` `:259-289` (Eris) / `:343` (Irene). When Gemini returns no parts, retry against `geminiFallbackModel`, first with tools then text-only.

2. **Thinking-only output** — `dual.js` `:422-435` (Eris) / `:429` (Irene). Model emitted only `thought:` parts and no visible text. Fallback retry. Usually a Flash thinking-budget edge case.

If both retries fail, the user sees a fallback message ("hmm something went quiet" or "brain overheating").

## Stale balance / inventory / mood

1. **Tool result cache** — `packages/<bot>/ai/executor.js` `_toolCache` (LRU 200, 15s TTL). Reads cached for 15s.

2. **Write tool not invalidating** — `CACHE_INVALIDATING_TOOLS` set is missing your write tool. Add it.

3. **Cross-user write not invalidating target** — `TWO_USER_TOOLS` set is missing your tool. Add it.

4. **Read-modify-write race** — wrap in `withUserLock(userId, async () => {...})` from `database.js`.

## Bot answers from wrong topic / addresses wrong user

- **`[CHANNEL CONTEXT]` block** — `messageCreate.js` (Eris ~850-887, Irene ~1487-1518). The model sees recent channel messages as passive awareness; sometimes it tries to reply to them.
- **`[ADDRESSING — STRICT]` framing** — `messageCreate.js` (Eris ~786-788). This is the rule that says "address THIS user, not the others you can see." If it's missing or the personality prompt overrides it, addressing breaks.
- **Personality prompt section "READING THE CURRENT CONVERSATION"** in `prompts/<bot>-personality.md` — if you tweaked the personality file, you may have weakened the addressing discipline.

## Auto-mod doing nothing / over-acting (Irene only)

- **Skip checks** — `packages/irene/ai/rulesEnforcer.js:128`. DM/bot/owner/ManageGuild/exempt/60s cooldown. Verify your test user isn't tripping any of these.
- **LLM judge** — `packages/irene/ai/rulesDetector.js`. If the pre-filter doesn't fire, the judge isn't called. Loosen the pre-filter regex or add a regex pattern for your test case.
- **Escalation** — `packages/irene/ai/rulesEscalation.js`. The pure punishment ladder. If you expect "ban" but get "warn", check the recent-violations count and severity calculation.
- **Auto-mod disabled for guild** — `database.js` `isAutoModEnabled(guildId)`. The `/rules toggle` command flips this.

## Twin call to other bot fails

- **Network timeout** — `ask_irene`, `twinPunish`, and `ask_eris` use 5s timeouts; `twinState` uses 4s. Check `IRENE_API_URL`/`ERIS_API_URL` env points to the right host.
- **Signature mismatch** — Both bots must have **identical** `TWIN_API_SECRET`. Check both Render env vars.
- **Body byte mismatch** — Stringify JSON once and reuse for both signing and POST. If a framework re-stringifies (re-orders keys, etc.) the signature breaks.
- **Replay** — same signature seen twice in 60s window → 403. Caller probably double-fired.
- **Clock skew** — `|now - ts| > 60s` → 403. Check NTP on both servers.
- **Body too large** — `>10 KB` → 413, connection destroyed. Reduce payload.

## Music doesn't play (Irene)

- **Lavalink down** — Shoukaku reconnects automatically. Check Lavalink server logs.
- **Voice perms** — bot needs `Connect` + `Speak` in the target VC.
- **Track failed to load** — Lavalink returns `loadFailed`. Check the URL/search query. Some YouTube videos are region-blocked.
- **Queue lost on restart** — `restoreQueues(client)` runs on `clientReady`. If Lavalink isn't connected at that moment, restore silently fails. Check the order in `index.js`.

## Voice listener doesn't hear (Irene)

- **`@discordjs/opus` didn't build** — check the explicit Irene workspace install logs. Without it, opus → PCM decode fails silently. Music playback (which uses Lavalink) is unaffected.
- **Wake word not matching** — wake word detection is a substring match on the transcribed text. The model sometimes transcribes "irene" as "iron"/"ireland." Use a less ambiguous wake word.
- **Per-user 3s cooldown** — same user rapid-firing voice utterances → only first counts.

## Conversation history corruption / "she forgot what we were talking about"

- **`compressHistory` over-compressing** — `packages/<bot>/ai/contextCompressor.js`. Tier C (oldest) gets ultra-compressed. If your conversation is hitting Tier C too aggressively, raise `historyCharBudget`.
- **Per-channel `withLock` deadlock** — `messageCreate.js` (Eris ~575, Irene ~1432). If a previous handler crashed mid-flight without releasing, subsequent messages serialize behind it forever. Restart the bot.
- **Wrong key** — history is per-channel for guilds, per-user for DMs. If you're testing in a DM and expecting per-channel history, that's why.

## Slash commands don't appear

- **Global registration takes ~1h** — for instant updates use guild-scoped registration. Edit `deploy-commands.js` to use `Routes.applicationGuildCommands(...)` and don't commit.
- **Hash didn't change** — `utils/autoDeploy.js` skips PUT if the SHA256 of the sorted command set matches the stored hash. To force re-deploy, delete the row in `bot_data` keyed `eris_commands_hash:{clientId}` (or run `npm run deploy` manually).
- **Permission scope wrong** — bot's invite URL didn't include `applications.commands`. Re-invite.

## Bot leaves the guild on join (Eris)

`packages/eris/events/guildCreate.js`. Eris is gatekept — leaves if the guild isn't whitelisted, the owner isn't a member, AND the owner doesn't own the guild. Whitelist via `addToWhitelist(guildId, info)` in `database.js` before inviting.

## Database reads return null / undefined

- **Cache not loaded** — `initDatabase()` fell back to in-memory mode. Check startup logs. With `REQUIRE_PERSISTENCE=1`, missing or unreachable Supabase is fatal instead; without it, every read returns only what has been written this session.
- **Wrong key shape** — facts are keyed `${guildId}:${userId}`, not just `userId`. Check the cache shape definition at the top of `database.js`.
- **Write didn't flush yet** — there's a 2s debounce. If you read from Supabase directly within 2s of a write, you'll see the old value. Read from the cache (the exported `get*` methods) instead.

## SIGTERM took longer than 8s on Render

Render sends SIGTERM, waits 8s, then SIGKILL. If the shutdown drain doesn't finish in that window, pending writes can be lost.

- **Big `cache.conversations`** — main flush culprit. Trim conversation history to a max age in `database.js`.
- **Network hang on Supabase** — confirm the shutdown path is still bounded before increasing any flush workload.
- **Multiple sub-systems flushing serially** — both bot entrypoints drain database, personality, longmemory, and related subsystems in parallel; if this regresses, restore the `Promise.all` shutdown shape.

## Boot fails with `Cannot find module '@defnotean/shared/...'`

Workspace symlink resolution broken. The #1 cause:

- On Render: **Root Directory** is set to `packages/eris` or `packages/irene` instead of being **blank**. Set it blank — npm workspaces requires installing from the repo root.

Also check:
- `npm ci` from the repository root — if it refuses to link workspaces, fix and commit the lockfile drift rather than papering over it with a local install.
- `package.json` workspaces array at root includes `"packages/*"` and `"packages/eris/agent-ui"`; verify with `npm pkg get workspaces`.

## Tests pass but production breaks (the 2026-04-24 class)

The 2026-04-24 incident: tests passed because they ran against the same hoisted `discord.js` version as prod, so both were "broken" in the same matching way.

- **Run `npm run lint:version-sync`** — catches divergent non-local dependency ranges across workspaces.
- **Smoke-test in dev guild before merging** — `/ping` + an embed-sending command + a moderation command.
- **Compare `[Bot] N commands loaded` count to last known good** — if it dropped, a command file failed to load silently. (This is what missed Irene on 2026-04-24.)

## Twin state endpoint 429s

Polling `GET /api/twin/state` past 10 hits/minute per source IP returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
{"error":"twin state rate limit (10/min)"}
```

- **Limiter** — `packages/shared/src/rateLimit.js` `createRateLimiter` (sliding-window, in-memory, bounded by `maxKeys=1000`).
- **Wired in** — `packages/eris/api/dashboard.js:13` creates the limiter; `:428` consults it on every `/api/twin/state` GET keyed on `req.socket.remoteAddress`.
- **Why it exists** — the endpoint is Bearer-gated, so "identity" reduces to the IP of whoever holds `TWIN_API_SECRET`. Without the gate, a valid token could be replayed in a tight loop to scrape mood/preoccupation snapshots.

Knobs:
- Legit twin awareness polling cadence is ≥60s, well under 10/min — if you're tripping the limit you're probably accidentally polling in a loop or running the poller in two processes against the same IP.
- To raise the ceiling for self-hosting, edit `_twinStateLimiter = createRateLimiter({ limit, windowMs })` directly. There is no env knob for this on purpose.
- The limiter is per-process; if you run multiple Eris replicas behind a load balancer, each replica has its own 10/min/IP allowance.

## Atomic balance RPC fell back to CAS

If you see `[DB] eris_add_balance RPC not deployed — falling back to version-CAS path. Apply migrations/002_atomic_balance_rpc.sql to enable atomic updates.` once at startup, then the version-CAS path runs forever after.

- **Cause** — the `eris_add_balance` Postgres function isn't in your Supabase. The first call probes; on `PGRST202` we flip `_rpcAddBalanceAvailable = false` and never retry. See `packages/eris/database.js:690` `_updateBalanceUnsafe`.
- **Behavior** — both paths produce identical caller-observable semantics (including the `insufficient_balance` contract). The CAS loop is correct, just costs more round-trips and burns retries on contention.
- **Fix** — apply `packages/eris/migrations/002_atomic_balance_rpc.sql` to your Supabase project, then restart the bot. The probe re-runs on first balance update post-restart.
- **Symptoms of falling back unintentionally** — `bot.log` shows repeated `eris_add_balance RPC error: …` (transient errors don't disable the path, only `PGRST202`), or balance updates feel noticeably slower under load.

The CAS retry log lines are not a bug — they're expected under concurrent writers. The RPC removes them by serializing the read-modify-write inside Postgres in a single round-trip.

## Blackjack button ephemeral rejection

User sees `still processing your last move, hang on` (ephemeral) when they spam-click `hit` / `stand` / `double`.

- **Source** — `packages/eris/events/interactionCreate.js:113-120`. The `_inflightGameKeys` Set tracks `bj:<channelId>:<userId>` while the previous click is mid-handler.
- **Why** — pre-fix, a fast double-click on `double` could pass the balance check twice before the first deduct landed, producing a double-spend. The two-layer defense is:
  1. `_inflightGameKeys.has(gameKey)` rejects the second click immediately so a duplicate handler invocation never starts.
  2. `db.withUserLock(userId, …)` still serializes inside, so AI text path / `/gamble` concurrent mutations don't race the bj logic.

If the rejection is sticky after a single click and not clearing:
- The `finally` block at `:185` clears `_inflightGameKeys.delete(gameKey)`. If a synchronous throw skipped the finally, the entry sticks until restart. Wrap any new logic added inside the `try` so its errors flow through.
- A bot restart clears the Set (it's in-memory).

## Trusted-user cache staleness

After running `/trust add @user` or `/trust remove @user`, the access decision for that user reflects the old list for up to 5 minutes.

- **Source** — `packages/irene/database.js:1020` `const TRUSTED_TTL_MS = 5 * 60 * 1000`.
- **How it works** — `getTrustedUsers(guildId)` is a sync function (every call site is sync; rewriting them all to async was deliberately avoided). It does a sync read from `data.guild_settings`, and if the last refresh was >5 min ago, kicks off a fire-and-forget `_refreshTrustedUsers` background fetch. The first stale read returns the stale list; the next read after the background fetch returns the fresh list.
- **`_trustedRefreshInFlight` dedupes concurrent refreshes** so a flurry of stale reads only fires one Supabase round-trip.

If you need an immediate update (e.g. revoking trust mid-incident), restart Irene — local writes via `addTrustedUser` / `removeTrustedUser` take effect immediately for the same process, but only the Supabase round-trip propagates the change to a different replica.

## Karaoke session auto-ended

Session ended without `/karaoke stop` and you see `[KARAOKE] Max session timeout (600000ms) — auto-stopping` in the log.

- **Source** — `packages/irene/ai/karaoke.js:32` `const MAX_SESSION_MS = 10 * 60 * 1000` + `:402-413` `armSessionTimeout`.
- **Why** — the auto-stop hooks (music-stopped, song-ended, `/karaoke stop`) can fail to fire if Lavalink reports a stuck position or the session is forgotten. Pre-fix the poll loop would spin indefinitely. 10 min is comfortably longer than any normal song in a typical queue.
- The timer is `setTimeout`-based and `.unref()`'d, so a shutdown mid-karaoke exits promptly.

If 10 min is too short for your use case (long-form acoustic sets), the constant is the one knob. Raising it past ~30 min defeats the purpose of the cap; consider why a "karaoke session" needs to be that long instead.

## Voice listener auto-stopped

`/voice listen` ended on its own and `bot.log` shows either `Max session reached (3600000ms)` or `No audio for 600000ms — auto-stopping`.

- **Source** — `packages/irene/voice/listener.js:48` `MAX_SESSION_MS = 60 * 60 * 1000` and `:51` `NO_DATA_TIMEOUT_MS = 10 * 60 * 1000`.
- **Two independent watchers** — `sessionTimer` (hard 60-min cap) and `idleTimer` (10-min no-audio watcher). Both call `stopListening(guildId)`. Both are cleared in `stopListening` so a normal end doesn't leave dangling timers.
- **Why** — a forgotten `/voice listen` (or a Discord voice-gateway hiccup that leaves the listener half-connected) can keep the bot occupied indefinitely. 60-min cap + 10-min no-data covers both the human-forgetfulness case and the silent-disconnect case.

If the bot drops out of voice mid-conversation, check whether the no-data watcher fired during a long pause. The no-data timer only resets on actual decoded audio frames — if `@discordjs/opus` failed to build (see `Voice listener doesn't hear` above) you'll get the no-data timeout instead of a transcription failure.

## humanity.js 30s judge cooldown

Humanity / sentiment context for a busy channel feels stale — same vibe for several messages in a row even though the conversation shifted.

- **Source** — `packages/irene/ai/humanity.js:34` `HUMANITY_JUDGE_COOLDOWN_MS = 30_000`, gate function `shouldRunHumanityJudge(channelId)`.
- **How** — callers call `shouldRunHumanityJudge`, get back `{ allow, cachedResult }`. If `allow === false`, they MUST skip the LLM-as-judge call and use `cachedResult` (or degrade gracefully if it's null). On completion, the caller writes back via `recordHumanityJudgeResult(channelId, result)` so the next cooldown-blocked caller reuses it.
- **Why 30s** — long enough that a back-and-forth burst collapses into one judgment (typical beat is 5-15s), short enough that a channel that goes quiet for a minute gets a fresh read when it lights up again.

If you're adding a new LLM-as-judge call: route it through this gate, otherwise you'll fire judgments per-message and blow cost / per-minute rate limits. Both maps are pruned at 1024 channel entries (drops the oldest 25%) so a long-lived bot in many channels won't leak memory.

## Semantic cache misses after hash widening

`_searchCache` in `packages/eris/ai/semantic.js` started missing more after the 2026-05-16 hash change.

- **Source** — `packages/eris/ai/semantic.js:36` `msgHash` is now SHA-256 truncated to 16 hex chars (64-bit), hashing the full lowercased message text. Previously: 32-bit DJB2-style int over the first 100 chars.
- **Why the change** — 32-bit space hits the birthday collision wall around ~65k distinct messages, well within reach for any long-running channel. The first-100-chars truncation also produced collisions for messages sharing a 100-char prefix but diverging later.
- **Expected miss-rate impact** — keys now reflect the full message, so any prior cache hits that were actually collisions become misses. This is correct behavior; the prior "hit" was returning the wrong cached result.

If you actually want a higher hit rate, the right move is to normalize input before hashing (lowercase, collapse whitespace, strip punctuation) — don't shrink the key back down.

## Bot connects but doesn't respond

Bot shows online in the member list, slash commands work, but messages get no reply. Walk this list before diving into the gating gauntlet above.

1. **`MessageContent` intent not approved** — in the Discord Developer Portal under "Bot → Privileged Gateway Intents", `MESSAGE CONTENT INTENT` must be ON. Without it, `message.content` is empty for non-mention messages, so the bot can't see what was said and silently drops the message at the length / mention gates. `packages/<bot>/index.js:22-30` already requests the intent — the failure is portal-side approval.
2. **`GuildMembers` and `GuildPresences` intents** — both privileged, both required. Without `GuildMembers`, member-mention parsing breaks; without `GuildPresences`, the bot can't see who's in voice / who's online for presence-aware replies.
3. **`BOT_OWNER_ID` not set or wrong** — `packages/eris/config.js:201` / equivalent in Irene. The owner ID gates wake-from-sleep, owner-only tools, and the relationship section in the personality prompt. If it's blank, the personality renders `{{OWNER_ID}}` literally and the bot treats nobody as the owner.
4. **Bot has Send Messages perm in the channel** — Discord permission overwrites can deny the bot at the channel level even if it has the guild-level role. Right-click the channel → Edit Channel → Permissions → check for a red ✗ on the bot role.
5. **The bot is in sleep mode** — see the gating gauntlet table at the top. Only the owner wake-trigger works in sleep mode.

If all of the above pass, walk the gating gauntlet.

## Slash commands missing

`/foo` doesn't appear in the autocomplete picker.

1. **You never deployed** — run `npm run deploy` from the package directory (e.g. `packages/eris`). This runs `deploy-commands.js` against the configured `CLIENT_ID` and either pushes guild-scoped (instant) or global (~1h propagation) commands.
2. **Hash short-circuit** — `utils/autoDeploy.js` skips PUT if the SHA256 of the sorted command set matches `bot_data` row `<bot>_commands_hash:<clientId>`. To force a re-PUT, delete that row, or edit a command's description by one character to bump the hash.
3. **Wrong scope** — guild commands appear instantly but only in that guild. Global commands appear everywhere but take up to an hour. Check which `Routes.applicationGuildCommands` vs `Routes.applicationCommands` your `deploy-commands.js` is calling.
4. **Command file failed to load** — startup log shows `[Bot] N commands loaded`. Compare N to last known good. If it dropped, a `commands/**/*.js` file has a syntax error or threw on import. Tail the log for `[ERROR] failed to load command file …`.
5. **Bot was invited without `applications.commands` scope** — re-generate the invite URL in the Discord Developer Portal with `bot + applications.commands` both checked, then re-invite.

## Tests flake on timers / RNG

Test passes locally, fails on CI (or vice versa), or fails intermittently on the same machine.

1. **Wall-clock timers** — `setTimeout` / `Date.now()` based assertions race CI scheduling. Use `vi.useFakeTimers()` + `vi.advanceTimersByTime(ms)`. Pattern from `packages/eris/tests/utils/lruCache.test.ts` — wrap the time-sensitive block, advance the clock past the threshold, assert.
2. **Frozen system time for dedupe windows** — when the code under test reads `Date.now()` multiple times and the assertion depends on them landing on the same tick, use `vi.setSystemTime(<fixed date>)`. Pattern from `packages/eris/tests/ai/bumpCelebrations.test.ts` (and the Irene mirror in `packages/irene/tests/ai/bumpCelebrations.test.ts`).
3. **Statistical bands with real `Math.random`** — coinflip / dice / slots tests use ranges like "win rate between 48% and 52% over 10k trials". CI variance can land outside the band. Seed with a deterministic PRNG (mulberry32 is already factored in `packages/eris/tests/ai/gambling.test.ts`) and `vi.spyOn(Math, "random").mockImplementation(rand)` in `beforeEach`, restore in `afterEach`.
4. **Test order dependence** — tests share module-level state (caches, in-memory maps) and pass only when run in a specific order. Add a `beforeEach` that resets the relevant module state, or use `vi.resetModules()` before each test.
5. **Workspace dep skew** — see `Tests pass but production breaks` above. If a test passes locally on a hoisted module and fails on CI because CI installed differently, run `npm run lint:version-sync` and align shared third-party dependency ranges.

## When all else fails

1. **Search for a UX string** — error message text, embed title, command name. `git grep "the message you saw"` will find the call site.
2. **Read recent `git log`** — `git log --all --oneline -50` to see what changed recently. The bug might be in a recent commit.
3. **Use `git bisect`** if you can reproduce reliably and the bug appeared after a known-good commit.
4. **Check `bot.log`** — there's a 5MB-rotating log per package with `[ERROR]` / `[WARN]` lines.
5. **Roll back first, debug second.** If the bug is in production and a deploy made it worse, flip the Render repo back to the previous commit. Don't try to hot-fix on `main`.
