# Monobot Improvement Plan — June 2026 audit

Produced by a 61-agent audit sweep: 8 deep security/quality auditors + 2 measurement agents, every medium+ finding adversarially verified by 1–3 independent verifiers (all 29 significant findings survived verification; nothing below is speculative — every item was confirmed against real code), plus a completeness critic that caught three subsystems the first pass missed (agent-ui Electron app, Supabase RLS, voice/STT pipeline), and a 3-design panel + judge for the local-model tool-calling plan.

---

## 1. What held up under attack (don't churn these)

These were audited hard and came back clean — they are the load-bearing security architecture:

- **SSRF defense is genuinely closed.** Every user/LLM-controlled URL routes through `packages/shared/src/safeFetch.js`; the undici dispatcher really does pin the connection to the validated IP (empirically tested — DNS-rebinding TOCTOU is closed), redirects re-validate per hop, metadata/private/link-local/IPv4-mapped-IPv6 ranges are covered. Raw `fetch` callsites all target fixed public APIs or operator-config endpoints.
- **Economy double-spend is prevented.** The feared race (model emits two bets/transfers in one turn → `Promise.all` races the balance check) does not exist: dual.js executes at most one economy-mutating tool per turn, and every coin mutation funnels through `withEconLock` with the balance check inside the lock, backstopped by the never-negative RPC/CAS.
- **HTTP auth core is solid.** Single normalized-path dispatch (no normalize-vs-route desync), timing-safe compares everywhere, fail-closed when secrets are unset, HMAC replay cache only accepts verified entries, body caps, exact-origin CORS, rightmost-XFF on Render only.
- **Owner/admin tool gating is two-layer.** Owner tools are excluded from non-owner schemas AND re-gated at dispatch; owner check keys on immutable `message.author.id` (webhooks can't forge it); shell args are not concatenated (whitelists/psSingleQuote/parameterized queries); twin relay binds hierarchy checks to the real requester.
- **CI/deps are above baseline.** 0 npm audit vulns; all 4 lockfile overrides patch real late-2025 advisories; ~300 test files; the Eris auth tests genuinely assert side effects don't fire on rejection.

---

## 2. Security fixes — priority order

### P0 — do these first

1. **Remove the hardcoded fallback owner ID.** `packages/eris/config.js:198` (`DEFAULT_OWNER_ID = "1365814245739987078"` → `ownerId` at :212) and `packages/irene/config.js:266/:272`. Any fork/self-host that forgets `BOT_OWNER_ID` / `DISCORD_USER_ID` silently grants *your* Discord account full owner authority on *their* deployment — including host shell where the PC agent is left enabled. This is a public repo; it contradicts SECURITY.md and looks like a backdoor even though it's a convenience default. **Fix:** delete the constants; fail-fast at boot (like `DISCORD_TOKEN`) or leave owner empty (owner tools already fail closed).

2. **Enable RLS / revoke client grants on every Supabase table.** Zero `ENABLE ROW LEVEL SECURITY`, zero `CREATE POLICY` in any migration; the only protected table is `eris_stock_portfolios` (`packages/eris/migrations/012:218` proves the author knows the default posture is open). A leaked anon/publishable key = full read/write of balances, PII memory facts, whitelist, mod audit. **Fix:** one migration: `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.<t> FROM anon, authenticated;` for every `eris_*`, `irene_*`, `bot_data`, `music_settings`, `dual_write_sagas` table (service_role bypasses RLS; bots keep working).

3. **`local_commands` needs a DB backstop.** `packages/eris/migrations/004` — no CREATE TABLE, no RLS, no REVOKE INSERT on the table whose rows get `exec()`'d on your machine by the agent-ui poller. The only barrier between "can INSERT a row" and "code execution on your PC" is the app-layer HMAC. **Fix:** explicit CREATE TABLE + RLS + `REVOKE ALL ... FROM anon, authenticated, PUBLIC` so the HMAC becomes the *second* factor, not the only one.

4. **agent-ui Electron: close the IPC holes** (`packages/eris/agent-ui/`):
   - `read-file`/`write-file` IPC (main.js:493–505) give the renderer **arbitrary absolute-path filesystem access** with no containment — bypasses the entire command gate (write to Startup folder = persistence). Fix: resolve against an allowlisted root, reject absolute/traversal paths.
   - `github-clone` (main.js:616) interpolates renderer strings into an `exec()` cmd.exe string — quote breakout = arbitrary command exec. Fix: `execFile('git', ['clone', url, dest])` + URL allowlist.
   - Destructive-command gate (main.js:49–167) misses `>`/`>>` redirection, `Set-Content`/`Out-File`/`[IO.File]::Write*`, and `Remove-Item` flag-order/abbreviation variants. Fix: add patterns; better, switch auto-approve to a read-only allowlist.
   - Auto-approve executes LLM-authored shell commands with no human in the loop (renderer.js:390–407). Fix: always require per-step confirm for terminal steps, or allowlist-only auto-approve.
   - `open-external` (main.js:650): allow only http/https. Add `sandbox:true`, `will-navigate` guard, `setWindowOpenHandler(deny)`, and a CSP via `onHeadersReceived`.

### P1 — close the injection and confirmation gaps

5. **Twin relay bypasses the human-confirm gate.** `packages/irene/presence.js:942` calls `executeTool(...)` without `{ aiInitiated: true }`, so an Eris-side hallucination/injection can drive an immediate unconfirmed ban/kick/purge on Irene — the exact scenario the confirm button exists for. **Fix:** pass `{ aiInitiated: true }` from the relay (one line) so relayed destructive actions defer to the same Confirm button.

6. **Indirect prompt injection cluster** — four confirmed paths where untrusted text enters the prompt unspotlighted:
   - `[CHANNEL CONTEXT]`: other users' messages, never firewall-checked (passive messages bail before the firewall), spliced raw into the system prompt (eris contextBuild.js:405–424; irene :947–960). Wrap each line in `spotlight()` like `user_message` already is.
   - **Memory facts**: user-written `remember_fact` text replayed every future turn — Eris wraps it in a `[SYSTEM: ...]` block, the highest-authority framing (eris memory.js:81, contextBuild.js:191). Spotlight + drop the `[SYSTEM:` wrapper; optionally `checkInjection` at write time.
   - **DIRECTIVES**: framed as "override your default behavior", settable by any Manage-Server admin in any guild (contextBuild.js:291–299). Add a precedence clause (never overrides safety/identity/owner/tool gates) + spotlight.
   - **Tool results**: only web tools self-wrap; `analyze_image` OCR and other externally-sourced results re-enter the loop bare (mediaExecutor.js:291; dual.js functionResponse). Apply the web-tools untrusted-envelope pattern to all external-content tools.

7. **Voice/STT pipeline is an un-gated second AI ingress** (`packages/irene/voice/listener.js`):
   - Transcripts bypass the firewall and gauntlet entirely; raw transcript interpolated into the reply prompt (:542–544). Run `checkInjection` on transcripts; keep the path tool-free by construction.
   - **Unbounded Gemini spend**: every utterance is transcribed *before* the wake-word check, and the cooldown only populates after a successful wake-word reply (:494 vs :523, :561). Throttle transcription itself + per-guild/session call budget.
   - No recording-consent notice; audio of people who never address the bot is uploaded to Google. Post a persistent notice on session start/join; consider opt-out.

8. **Music controls don't enforce the documented DJ model.** Only `/skip` checks DJ+same-VC; `/pause /resume /volume /loop /shuffle` have **no** auth at all and `/stop` skips DJ (commands/music/*.js). The AI music tools bypass too. **Fix:** one shared `requireDj`+same-VC guard applied uniformly (the button handler already does it right — match it).

### P2 — hardening

9. **Rate-limit bucket isolation.** Unauthenticated `/api/health` (or garbage `/api/twin/*`) traffic shares the same global 2000/min bucket that gates signed twin commands on both bots (presence.js:456 before auth at :462; dashboard.js:212 before :239) — a distributed flood (~12 IPs) silently suppresses cross-bot moderation/confiscation. **Fix:** dedicated limiter bucket for twin endpoints (pattern already exists: `_twinStateLimiter`), or rate-limit after auth for authenticated routes.

10. **Eris crash handler leaks unredacted errors to the alert webhook.** `packages/eris/index.js:286` — Irene redacts the same path (irene/index.js:406/414). **Fix:** redact inside `sendAlert` itself (shared/src/alert.js) so no caller can forget.

11. **No confirm/rate-limit on `delete_channel` / `nuke_channel` / `mass_role`** (irene channelExecutor.js:90–113, roleExecutor.js:289) — extend `_maybeDeferToConfirm` + add per-tool sliding-window caps.

12. **Irene `/health` leaks the owner Discord ID**; several handlers return raw Supabase error strings. Strip both.

13. **Backlog (low, confirmed-adjacent):** safeFetch `PINNED_DISPATCHERS` never evicted (unbounded Agent growth) + no port restriction; twin-punish nonce generated but never verified server-side (replay window = 60s sig window); twin-punish unlocked-read-then-fixed-debit (make it clamp-to-zero atomic); a dormant `html:` → innerHTML branch in admin.html's `el()` helper (delete it before it becomes stored XSS — CSP allows unsafe-inline); CI actions pinned by mutable tags + no `permissions:` block in workflow; `NODE_VERSION` unpinned in render.yaml.

---

## 3. Code quality — priority order

1. **~4,100 identical lines duplicated across 12 eris/irene module pairs**, already drifting into behavior bugs (the crash-redaction asymmetry above is one). Worst: bumpReminder 94% identical (1,676 combined lines), bumpCelebrations 98%, aiBudget 98%, opinions 96%, openaiCompat.js 81%, nvidia.js 72%, longmemory 83%, humanity 82%. **Fix:** continue the existing shim+factory pattern into `packages/shared/src` (createSelfCanon/createTwinState are the template). Priority by mass + drift risk: bumpReminder → providers (port Eris's circuit breaker to both) → longmemory.
2. **Irene's `messageCreate.js` execute() is still a ~630-line god-function** (Eris's orchestrator is 204 lines and genuinely thin). Move resolveDMContext → contextBuild.js; TTS shortcut + auto-TTS + leveling + sleep-wake → a new `passiveFeatures.js`; ack-timer machinery → `ackStatus.js`.
3. **eris `interactionCreate.js` (1,194 lines) re-implements blackjack/slots/roulette/duel** already in gamblingExecutor — the blackjack dealer loop/payout math exists twice and can drift odds. Extract one game-flow engine per game consumed by both paths; route buttons by customId prefix map.
4. **Silent-null persistence catches**: 171 empty catch blocks; the dangerous cluster turns Supabase write failures into nulls indistinguishable from "row missing" (database/activities.js:138,165,204,272,340,442,567; economy.js:785,802; gambling.js:326). Policy: best-effort Discord sends may stay silent; any DB/state catch must log (rate-limited). Add eslint `no-empty`.
5. **Irene's flush JSON-round-trips the entire cache every ~2s debounce** (database/core.js:449–456) — recurring event-loop stall that grows with guild count, directly under the message handler. Serialize dirty slices only; `structuredClone` instead of parse(stringify).
6. **Add ESLint + Prettier** (none exists); enforce no-empty-catch, no-floating-promises. The tsc checkJs CI is good but doesn't catch these.
7. **Test the actual gaps:** Irene presence.js endpoint-level auth-rejection tests (Eris has them, Irene — the publicly-hosted bot — doesn't); the hand-rolled .env parser (zero tests, duplicated in both bots); `withUserLock` unit test.
8. **Docs drift:** ARCHITECTURE.md §5 says tiering is "planned — not yet wired" (it's live on both bots) and "~150 aliases" (actual: 277); docs/self-hosting.md claims a ~3k-token prompt (actual: 16–22k). Fix both — the self-hosting one actively breaks local setups (see below).

---

## 4. Running a local 14B / cheap models — measured state and plan

### Measured reality

| Metric | Eris | Irene |
|---|---|---|
| Registered tools | 175 (136 everyone + 39 owner) | 210 (70 everyone + 140 admin) |
| Tool aliases (name-drift symptom log) | 277 | 181 |
| Tier-1 schemas actually sent (casual chat) | 8 / ~4.3 KB | 16 / ~10.7 KB |
| Worst measured turn | **75 schemas / 30 KB (uncapped!)** | 32 schemas / 24.4 KB (capped) |
| Base personality prompt | 32.5 KB | 40.9 KB |
| **Total prompt per message** | **~16–21k tokens** | **~17–22k tokens** |
| Iteration cap (OpenAI-compat lane) | 40 (unconfigured default) | 40 (unconfigured default) |

Good news the docs undersell: **two-tier tool selection is already live on both bots**, and the OpenAI-compat lane is far more complete than ARCHITECTURE.md suggests — full schema translation, parallel tool calls, tool_call_id round-trip, hallucinated-call rescue parsing, circuit breaker, key rotation. **Cheap hosted models (Groq/Cerebras/OpenRouter 70B-class) work today** with env changes + the four bug fixes below. localVision already speaks native Ollama and is the plumbing template.

### The four blockers for Ollama + Qwen3-14B-class

1. **Context overflow (HIGH):** real prompt is ~17–22k tokens vs docs' claimed ~3k; stock Ollama `num_ctx` silently truncates from the head — the personality/security rules are what gets cut. Need `num_ctx≥24–32k` + `AI_PROMPT_CHAR_BUDGET≈24000`, and an `OPENAI_COMPAT_EXTRA_BODY` env merged into buildBody so `options.num_ctx`/`think:false` can be sent (the `/v1` endpoint can't express them today).
2. **Irene fast-model 404 (HIGH):** `irene/config.js:331` defaults `fastModel` to literal `"llama3.1"` instead of chaining through `OPENAI_COMPAT_MODEL` (Eris chains correctly). Since Irene routes most chat through the fast lane, setting only `OPENAI_COMPAT_MODEL=qwen3:14b` 404s on most messages and trips the circuit breaker. One-line fix.
3. **No `<think>` handling anywhere:** Qwen3 ships thinking-on; CoT either leaks raw to Discord or burns the 4096 max_tokens → canned "got cut off" replies. Need a shared `stripReasoning()` helper + the extra-body knob to disable thinking.
4. **No outer turn timeout on Eris's compat lane** (40 iterations × 60s while holding the per-channel lock = wedged channel) + `maxIterations` has no env knob. Also: quick-ack fires on Irene's compat lane with a 5s timeout and no "short ack" instruction (wasted prefill + double replies); tool-timeout key typo `toolSlow` vs `slowTool` on Eris.

### The plan (judge-selected: evolve the existing two-tier registry as backbone, graft constrained-output + scoring ideas)

A 3-design panel (minimal evolution vs intent-router vs constrained-JSON-envelope) was scored by a judge that verified each design's claims against the code. Winner: **evolution of the live tiering** (39/50) — every change closes a verifiably-existing gap; the JSON-envelope (33/50) becomes the contingency lever; the standalone intent-router (29/50) loses because Irene's score-and-cap already is a soft router with a gentler failure mode.

- **Phase 0 — baseline (half a day):** make `scripts/measure-prompt-footprint.mjs` run on a clean checkout (stub env); commit the per-profile byte table as regression baseline; add `TOOLS_SHADOW_LOG=1` logging of what a 16/20-tool cap *would have* dropped — run a week on live traffic, zero behavior change.
- **Phase 1 — config-only fixes (an hour, ship now):** Irene fastModel chain fix; define `OPENAI_COMPAT_MAX_ITERATIONS` (6 local / 12 hosted); Eris `toolSlow`→`slowTool` fix; Irene `toolsUsed` array-truthiness fix (empty array currently DM-mirrors every reply on the compat lane); add `OPENAI_COMPAT_EXTRA_BODY` merge.
- **Phase 2 — local lane viable (1–2 days):** shared `stripReasoning()` in packages/shared applied to both lanes; **port Irene's score-and-cap into Eris's uncapped `selectByMessage`** (the 75-schema blowup is the single biggest 14B killer; `TOOLS_TIER1_MAX` 16/20 local, 24/32 hosted); local preset (`AI_PROMPT_CHAR_BUDGET=24000`, iterations 6, `TIMEOUT_WORKER` 120s); port the NVIDIA lane's hand-tuned `[TOOL USE — CRITICAL]` coaching block into the compat lane (cheapest quality lever for a 14B); outer turn deadline on Eris; gate Irene's 2s ack on provider capability.
- **Phase 3 — local lane works well (2–3 days):** wire `registry.trackUsage` at dispatch (the promotion loop is currently dead outside Irene's Gemini lane); schema-echo-on-miss for `use_tool` Tier-2 calls + `{"help":true}` short-circuit; rescue parser accepts Tier-2 names; wire-time schema compactor behind `OPENAI_COMPAT_COMPACT_SCHEMAS`; strong/weak keyword-regex split in the scorer (fixes `games` matching `play|start|deal|cards?`); CI ceilings on measured tool bytes (≤8 KB Eris / ≤11.5 KB Irene worst case).
- **Phase 4 — source-of-truth diet (2–3 days, low urgency):** split the mega-schemas (`customize_welcome` 28 params→~10, `set_role_permissions` 25, `setup_ticket` 1,257-char description, `ask_irene` 17-value command multiplexer); converge the ~10 cross-bot naming flips (`set_reminder` vs `reminder_set` — Irene literally aliases Eris's name today) on verb_noun; delete dead self-aliases; rewrite stale docs with real numbers.
- **Phase 5 — contingency:** only if Phase-3 telemetry still shows >~5% malformed/hallucinated native tool_calls on the target model, add `TOOL_STRATEGY=json` (single JSON action envelope, grammar-enforced via Ollama `format`/json_schema, one tool per turn) — Phases 1–3 build 80% of its prerequisites.
- **Safety:** everything env-gated; Gemini path byte-identical with no new envs set; dev bot pair in a test guild on `AI_PROVIDER=ollama`; rollback = unset env.

**Expected outcome:** prompt drops from ~17–22k to ~6–9k tokens/message (cap + compaction + personality diet + coaching), every tool turn fits comfortably in a 32k context with prefix-cache-friendly layout, and a Qwen3-14B-class model sees ≤16–20 simple schemas per turn instead of up to 75 — the regime where mid-size models are actually reliable. Restructuring the system prompt static-first/dynamic-last (today's dynamic blocks defeat KV prefix caching) is the follow-on latency win.
