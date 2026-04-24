# Irene — Feature Progress

Tracks what's shipped, what's planned, and what's explicitly skipped.
Legend: ✅ shipped · 🚧 in progress · ⬜ planned · ⏭️ skipped (with reason)

---

## Recently shipped

### Monorepo migration + feature sprint (2026-04-24)
- ✅ **Monorepo migrated** — both bots now run from `defnotean/bots-monorepo`. Shared core utilities (`roleCategorizer`, `twinSign`, `LRUCache`) live in `@defnotean/shared`. Migration had a bump: first cutover attempt silently broke Irene's interaction handlers due to npm workspace dep-version hoisting (she was on `discord.js@14.26` when she was tested on 14.14). Rolled back in ~2 min, re-attempted with unified exact-pinned deps across all workspaces. See `DEPLOY_MIGRATION.md` post-mortem for the bug story and the pre-flight (`npm run lint:version-sync`) that now prevents this class of bug.
- ✅ **Evidence preservation on ban/kick** — when a mod (or Irene's AI mod tools) bans or kicks a user, the mod-log embed now includes a "Recent messages before ban/kick" field with the user's last ~10 messages before action. Rolling in-memory buffer (`utils/messageEvidence.js`), 24h TTL, bounded at 1000 user-buckets across all guilds. Intentionally ephemeral — never persisted to DB (GDPR-friendly).
- ✅ **Message context-menu commands** — right-click any message → Apps → 3 new actions:
  - **Remember this** — saves the message to Irene's per-guild memory store (dedupes against existing memories).
  - **Remind me** — opens a duration modal, then schedules a reminder via the existing reminder system. Duration parser accepts `s/m/h/d/w` with decimals, case-insensitive, 10s–365d bounds.
  - **Translate** — ephemeral Gemini-translated English (or most-likely other lang if already English).
- ✅ **Command loader observability** — `[Commands] Failed to load: <msg>` now includes the `<dir>/<filename>` so load failures are diagnosable in seconds, not minutes. Would have made the 2026-04-24 migration incident ~instantly traceable.
- ✅ **`twinPunish.js` stale import fixed** — bare relative import `./twinSign.js` that the original sed pass missed. Contributed to Irene silently losing 1 command on migration.
- ✅ **`bumpconfig.js` 106-char subcommand description fixed** — pre-existing bug: one subcommand description exceeded discord.js's 100-char limit, causing `RangeError: Invalid string length` at command-load time. Silently dropped 1 command from the registry on every Irene startup (both on standalone and monorepo). Fixed.
- ✅ **`fetchReply` deprecation fixed** — 5 call sites migrated from `{ fetchReply: true }` option form (deprecated in discord.js 14.17+) to `.fetchReply()` method form. Preemptive for post-migration running on hoisted 14.26.

### Council execution round (2026-04-23 evening)
- ✅ **LRUCache synced with Eris** — ported Eris's new group-key indexing so `deleteGroup(userId)` is O(k). Both bots' `utils/LRUCache.js` are now byte-identical, reducing drift ahead of the planned extraction.
- ✅ **Shared core extraction plan** — `EXTRACTION_PLAN.md` drafted (mirrored from Eris). Documents the full monorepo migration: phase 0 drift reconciliation, workspace setup, per-file move order, deploy changes, risk register. Executed 2026-04-24.

### Security & correctness (2026-04-23 council audit round)
- ✅ **Anti-nuke owner/admin exemption** — `utils/antinuke.js` was synchronous, accepted `guild` as a 4th arg it ignored, and its only exemption path was an explicit allowlist. Server owner could get anti-nuke'd and their roles stripped (really happened). Now async, with four-tier exemption: guild owner (always), bot owner (always), explicit allowlist, admins (default exempt, togglable via `track_admins`). Defense-in-depth re-check in the response path refuses to strip/ban protected users even if something else bypassed tracking.
- ✅ **Firewall owner-bypass field unified** — Irene's firewall checked `config.userId`; Eris checked `config.ownerId`. Copy-paste between bots would silently fail the owner exemption. Added `ownerId` alias to Irene's config; both bots now use `config.ownerId` in firewall, legacy `userId` callers still work.
- ✅ **Scheduler durability** — `utils/scheduler.js` `safeRemove()` relied on `save()`'s 2s debounce; bot crashes in that window caused tasks to re-fire on restart (duplicate bans, double untimeouts). Now `await`s `flushNow()` so task deletion is durable before returning. Same fix applied to the too-far-future cleanup path in `armScheduledTask`.
- ✅ **Giveaway timer re-entry guard** — `commands/fun/giveaway.js` 30s `setInterval` could re-enter on slow ticks (multi-giveaway finalize + network latency), causing duplicate winner announcements. Added `_finalizingGiveaways` flag + per-giveaway set.

### Moderation
- ✅ **One-click mod-action undo buttons** — admin button on every ban/timeout/warn mod-log embed; reverses the action + strikes through the original.
- ✅ **Moderation reversal AI tools** — `untimeout_user`, `unban_user`, `unmute_user`, `remove_warning`, `clear_warnings`.
- ✅ **Scheduled task primitive** — `schedule_task` lets Irene chain tool calls over time ("timeout 5m then untimeout after 10s"). Recursion denylist + admin re-check at fire time.
- ✅ **Voice disconnect cause detection** — distinguishes self / mod / bot / kicked-from-server / banned / network drop.
- ✅ **Full "who did what" attribution** across 20+ event types in mod-log embeds.
- ✅ **Mod-tools pre-dispatch admin gate** — `messageCreate.js:844` filters `ADMIN_TOOLS` out of the tool schemas sent to Gemini for non-admins. Plus a second gate in `dual.js:498` and a third `_memberHasPerm` check per-executor (three layers, council verified).

### Tickets (major overhaul)
- ✅ **Interactive `/ticket setup` wizard** — single-page hub, channel/role selects, welcome + panel embed modals.
- ✅ **Ticket types** — multiple panel buttons routing to different categories (Support → #support-tickets, Reports → #reports, Appeals → #appeals).
- ✅ **Fully customizable panel + welcome embeds** — title, description, color, button label, button emoji. Panel is posted idempotently — edits the existing message instead of spamming duplicates.
- ✅ **Configurable panel channel** — admin picks any channel, not just auto-created `#open-ticket`.
- ✅ **Dynamic role resolution** — `ticket_view_auto_category` saves a category keyword (`staff`, `moderator`, etc.) and resolves to live roles every ticket. New mod roles get picked up automatically.
- ✅ **Split view/ping roles** — view role (granted channel access) is independent from ping role (mentioned on open). Legacy `ticket_mod_role_ids` auto-migrates.
- ✅ **Rescue for inert `send_message` buttons** — Irene's AI-posted custom panels (with throwaway customIds) get routed to the ticket handler if label or surrounding embed content indicates intent.
- ✅ **No default mod ping / mod view** — admin must opt in explicitly. Staff access via category permissions instead.

### Role categorizer
- ✅ **Permission-based role classifier** — `utils/roleCategorizer.js`, shared byte-identical with Eris. Categories: `admin` / `moderator` / `helper` / `bot` / `cosmetic` / `everyone`. Meta: `staff` / `trusted`.
- ✅ **Classifier is name-blind** — a cosmetic "🎭 Moderator" vanity role with zero perms gets bucketed as `cosmetic`; a real mod role called anything gets bucketed as `moderator`.
- ✅ **`list_roles_by_category` AI tool** — Irene can answer "who are the mods on this server?" by actual permissions.
- ✅ **`/ticket auto-mods`** — populates view/ping from categorized staff, re-evaluates every ticket open (dynamic, not snapshot).
- ✅ **Role-change visibility** — `roleCreate` logs the new role's category; `roleUpdate` flags category shifts (e.g., `cosmetic` → `moderator` when BanMembers is added).

### Performance & reliability
- ✅ Bounded LRU caches (geminiToolsCache, userHistory, botExchanges, searchCache).
- ✅ `findMember` per-guild name index (O(n) → O(1)).
- ✅ `mass_role` paginates ALL members (was silently capped at 100).
- ✅ Kicked-mid-queue guards.
- ✅ Gemini 429 fallback.
- ✅ Centralized `config.timeouts`.

### Logging & UX
- ✅ Colored aligned console logger.
- ✅ `logEvent` embed builder with author bar, image support, meta blocks.
- ✅ Image-forward embeds for emoji/sticker/avatar/guild-update events.
- ✅ Aggressively detailed mod-log embeds (account age, roles, time in server, etc).

### AI / agent
- ✅ **Memory dreams** — `ai/dreams.js`, fires on sleep/nap, stays in prompt 30min post-wake.
- ✅ **Weekly server health digest** — `ai/weeklyDigest.js`, Sunday noon per-guild.
- ✅ **Cross-bot mod→economy consequences** — `utils/twinPunish.js`, fires after ban/kick; Eris applies if opted-in.

---

## Planned by category

### Moderation & safety
- ⬜ Time-limited punishments with auto-reversal (UX layer on schedule_task)
- ✅ Evidence preservation on ban/kick — shipped 2026-04-24 (last ~10 messages, 24h ring buffer, ephemeral)
- ⬜ Appeals system (banned users DM the bot, mods see structured form)
- ⬜ Shadow-ban mode
- ⬜ Word-filter severity tiers + learning mode
- ⬜ Slowmode auto-tuning
- ⏭️ Cross-server federated ban list — governance/liability nightmare

### Logging & insights
- ⬜ Searchable audit log (`/audit who banned @X`)
- ⬜ Per-category log channels (split mod/member/voice/message)
- ⬜ Member deletion forensics (full history in ban embed)
- ⬜ Mod performance dashboard
- ⬜ Channel activity heatmap

### AI / personality
- ⬜ Per-channel personas
- ⬜ Mood-driven moderation (tone scaling)
- ⬜ Voice personality variants (TTS by mood)
- ⬜ Contextual auto-reactions
- ⬜ AI-drafted welcome messages
- ⬜ Opt-in roleplay mode per user
- ⬜ Inside jokes callback system (running_bit episode type already exists)
- ⬜ Emotional check-ins (opt-out)
- ⬜ Multilingual (large)

### Voice & music
- ⬜ Full-call transcription (opt-in)
- ⬜ DJ mode
- ⬜ Skip vote threshold
- ⬜ Soundboard
- ⬜ VC AFK auto-move
- ⬜ Voice-activity triggered TTS

### Setup & configuration
- ⬜ Server templates
- ⬜ Config backup & restore
- ⬜ Clone settings from another server
- ⬜ Feature toggle dashboard
- ⬜ Preview mode

### Utility / QoL
- ⬜ Ranked polls
- ⬜ Anonymous polls
- ⬜ Polls with role requirements
- ⬜ Anti-alt giveaways (account age / tenure)
- ⬜ Threaded reminders
- ⬜ Recurring events
- ⬜ Live countdown timers
- ✅ Context-menu commands (right-click message → remember / remind / translate) — shipped 2026-04-24
- ⬜ Anniversary messages
- ⬜ Bookmark-to-DM
- ⬜ Message translation
- ⬜ Pomodoro study session timer

### Integrations
- ⬜ Spotify presence board
- ⬜ Steam now-playing
- ⬜ RSS feed subscriptions
- ⬜ Bluesky / Mastodon cross-post
- ⬜ Webhook receiver

---

## Cross-bot (Irene + Eris)
- ✅ Cross-bot mod→economy consequences (ban/kick → zero balance, HMAC-signed)
- ✅ Role categorizer shared (byte-identical across both bots)
- ⬜ Shared schedule calendar
- ⬜ Organic cross-bot conversations (beyond banter)
- ⬜ Shared achievement system
- ⬜ Unified `/status` dashboard
- ⬜ Eris exploit detection → Irene investigation signal
- ⬜ Cross-bot handoffs with context

---

## Known debt (flagged, with status)
- Duplicated personality / firewall / humanity / longmemory / semantic modules across Irene + Eris — **plan drafted** in `EXTRACTION_PLAN.md`; execution deferred until the four drifted files (firewall, twinSign, personality, longmemory) are reconciled.
- `setupExecutor.js` is 60KB — split candidate. Eris's sibling `miscExecutor.js` got the first domain extraction (casino) on 2026-04-23; Irene's setupExecutor is a similar shape but lower priority since Irene's AI-tool hot path goes through `moderationExecutor` and `advancedExecutor`, not setup.
- Mixed error-handling styles: `try/catch`, `.catch(() => null)`, `.catch(() => {})` across 500+ sites. Hot-path cases in Eris were swept on 2026-04-23 (poker/lottery refund paths). Irene's equivalent hot paths are clean today (scheduler `flushNow` + antinuke exemption shipped earlier).
- Stale comments referencing variables that were renamed (found during audit).

---

## Security inventory
- Owner-only gatekeep (realtime + startup sweep)
- Prompt-injection firewall (homoglyph normalize → decode → regex → semantic similarity), worker-threaded with 100ms ReDoS timeout
- Permission hierarchy (Owner > Trusted > Admin > Member)
- Anti-raid + anti-nuke (with owner/admin exemption)
- Anti-spam rate limiting
- Per-user tool rate limits + NVIDIA circuit breaker + Gemini 429 fallback
- Economy atomicity (withUserLock, transferBalance, tryDeductBalance)
- Input validation everywhere (Number.isFinite, MAX_BET, hex regex)
- Moderation hierarchy checks (bot + user position vs target)
- AI tool denylist (`NON_SCHEDULABLE` prevents `schedule_task` recursion)
- Three-layer mod-tool gating: pre-dispatch schema filter + dispatcher check + per-tool permission verify
- Full audit logging + attribution on every mod action
- HMAC-signed twin API (timing-safe compare, ±60s skew, replay cache)
- Scheduler durability (`flushNow` after task removal prevents post-crash re-fire)

---

*Last updated: 2026-04-23 (council audit round)*
