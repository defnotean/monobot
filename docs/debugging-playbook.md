# Debugging playbook

Symptom → file location. The reverse direction of [where-do-i-edit.md](./where-do-i-edit.md). Use this when something's broken and you need to know where to look.

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

- **Network timeout** — Default `fetch` timeout for `ask_irene`. `twinState` uses 4s, `twinPunish` uses 5s. Check `IRENE_API_URL`/`ERIS_API_URL` env points to the right host.
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

- **`@discordjs/opus` didn't build** — check `npm install` warnings. Without it, opus → PCM decode fails silently. Music playback (which uses Lavalink) is unaffected.
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

- **Cache not loaded** — `initDatabase()` failed silently. Check startup logs. If Supabase was unreachable on boot, the bot runs in-memory-only — every read returns whatever's been written this session.
- **Wrong key shape** — facts are keyed `${guildId}:${userId}`, not just `userId`. Check the cache shape definition at the top of `database.js`.
- **Write didn't flush yet** — there's a 2s debounce. If you read from Supabase directly within 2s of a write, you'll see the old value. Read from the cache (the exported `get*` methods) instead.

## SIGTERM took longer than 8s on Render

Render sends SIGTERM, waits 8s, then SIGKILL. If `flushAll()` doesn't finish in that window, you lose the pending writes.

- **Big `cache.conversations`** — main flush culprit. Trim conversation history to a max age in `database.js`.
- **Network hang on Supabase** — wrap `flushAll()` in a `Promise.race` against an 8s timeout to at least exit cleanly.
- **Multiple sub-systems flushing serially** — `index.js` flushes `database`, `personality`, `longmemory`. Run them in parallel via `Promise.all` if not already.

## Boot fails with `Cannot find module '@defnotean/shared/...'`

Workspace symlink resolution broken. The #1 cause:

- On Render: **Root Directory** is set to `packages/eris` or `packages/irene` instead of being **blank**. Set it blank — npm workspaces requires installing from the repo root.

Also check:
- `npm install` (not `npm ci`) — the latter can refuse to link workspaces if the lockfile is even slightly off.
- `package.json` workspaces array at root includes `"packages/*"`.

## Tests pass but production breaks (the 2026-04-24 class)

The 2026-04-24 incident: tests passed because they ran against the same hoisted `discord.js` version as prod, so both were "broken" in the same matching way.

- **Run `npm run lint:version-sync`** — catches divergent dep ranges across workspaces.
- **Smoke-test in dev guild before merging** — `/ping` + an embed-sending command + a moderation command. See [DEPLOY_MIGRATION.md](../DEPLOY_MIGRATION.md) for the full checklist.
- **Compare `[Bot] N commands loaded` count to last known good** — if it dropped, a command file failed to load silently. (This is what missed Irene on 2026-04-24.)

## When all else fails

1. **Search for a UX string** — error message text, embed title, command name. `git grep "the message you saw"` will find the call site.
2. **Read recent `git log`** — `git log --all --oneline -50` to see what changed recently. The bug might be in a recent commit.
3. **Use `git bisect`** if you can reproduce reliably and the bug appeared after a known-good commit.
4. **Check `bot.log`** — there's a 5MB-rotating log per package with `[ERROR]` / `[WARN]` lines.
5. **Roll back first, debug second.** If the bug is in production and a deploy made it worse, flip the Render repo back to the previous commit. Don't try to hot-fix on `main`.
