# Audit: Irene Moderation Surface

Scope: Irene's two moderation surfaces — slash commands under
`packages/irene/commands/moderation/` (mod-initiated, explicit) and the
auto-mod pipeline driven by `enforceMessage` (silent, AI-judged) plus the
LLM tool dispatcher's mod tools in
`packages/irene/ai/executors/moderationExecutor.js` (chat-driven, AI
chooses to act on a mod's behalf).

## Tools inventory

| Surface | Entry point | Destructive ops |
|---|---|---|
| Slash commands | `commands/moderation/{ban,kick,timeout,mute,warn,purge,unban,audit,warnings,rules}.js` | ban, kick, timeout (1m–28d), mute (role), purge ≤100, unban, warn (+auto-escalate), clear-warnings |
| AI tool calls | `ai/executors/moderationExecutor.js:37-43` (`HANDLED` set, 18 tools) | ban_user, tempban, kick_user, warn_user, timeout_user, untimeout_user, unban_user, unmute_user, remove_warning, clear_warnings, lockdown_server, unlock_server, purge_messages (≤500), find_message, snipe, editsnipe |
| Auto-mod | `ai/rulesEnforcer.js:127` → `rulesDetector.js:182` → `rulesEscalation.js:38` | delete, warn, timeout (10m / 1h / 6h / 24h ladder). No auto-ban / kick. |

## Gate model

Slash commands all converge on the same pattern
(`utils/permissions.js:45-65`):

1. `requireAdminOrOwner(interaction)` — owner, Administrator, ManageGuild,
   OR `trusted_users` list.
2. `requirePermission(interaction, <perm>, …)` — the specific Discord
   permission (BanMembers, KickMembers, ModerateMembers, ManageMessages).
3. `requireBotPermission(...)` — bot has the same perm.
4. `canModerate(interaction, target)` — target ≠ self, ≠ owner, ≠ bot;
   moderator's highest role > target's highest role; bot's highest role >
   target's highest role.

Steps 1 and 2 are partially redundant — admin-or-owner is a superset of
the per-action perm except in the trusted-user case, where the
trusted-user gate intentionally widens access. `trusted_users` is anti-nuke
allowlist storage (`database.js:1128-1158`) with a 5-minute
cache-staleness window for revocation; **a recently-removed trusted user
keeps admin-equivalent slash-command access for up to 5 min**.

AI tool calls go through three nominally separate gates that overlap
unevenly:

1. `dual.js:555-563` — `ADMIN_TOOLS` flag from `ai/tools.js`. If the tool
   is in `ADMIN_TOOLS` and the invoking member is not admin (per
   `memberIsAdmin` in `events/messageCreate.js:356-361`, same definition
   as slash commands), the call returns a denial string. All mod tools
   live in `ADMIN_TOOLS` (`ai/tools.js:387-540`).
2. `moderationExecutor.js:_memberHasPerm(...)` — per-tool re-check of the
   specific Discord permission (BanMembers / KickMembers /
   ModerateMembers / ManageRoles). This is a defense-in-depth re-check in
   case the upstream `isAdmin` flag is wrong. **`warn_user`,
   `remove_warning`, `clear_warnings`, `tempban` (partially), `lockdown_*`,
   `purge_messages`, `find_message`, `snipe`, `editsnipe` skip this step**
   — they rely on the ADMIN_TOOLS gate alone.
3. `checkHierarchy(...)` (`ai/executor.js:343-352`) — role-position check
   matching the slash-command's `canModerate`.

Auto-mod gate is in `rulesEnforcer.js:127-148`: skip bot authors, skip
guild owner, skip ManageGuild and ManageMessages holders, skip globally
exempt users, skip if auto-mod disabled, skip if no rules stored.

## False-positive risks

The auto-mod pipeline is explicitly bias-toward-inaction (`rulesDetector.js:114-115`,
"Most messages — even gross or weird ones — are friends joking around and
should NOT be punished"). Concrete safeguards:

- Pre-filter is a fixed regex list (`NSFW_KEYWORDS`, `HATE_KEYWORDS`,
  `THREAT_KEYWORDS`). Messages that don't trip it bypass the LLM entirely
  (`rulesDetector.js:186-188`).
- The judge returns one of `clearly_violates | joking_banter | ambiguous`,
  and only `clearly_violates` triggers action (`rulesDetector.js:205-208`).
- Cited rule must exist (`rulesDetector.js:210-215`).
- 60s per-user cooldown after an action (`rulesEnforcer.js:25-46`).
- Provider failure / unparseable JSON → silent no-op (`rulesDetector.js:194-203`).
- Escalation ladder caps at 24h timeout. No auto-ban / auto-kick — by design.

Residual FP exposure:

- The judge is a Gemini Flash call with no inter-rater reliability check;
  a single hallucinated "clearly_violates" with a valid `rule_number`
  produces a real delete + warn + DB write. There is no human-in-the-loop
  appeals path inside Irene — the DM tells the user to "contact a
  moderator" but no audit-correction tool exists.
- Pre-filter patterns are unicode-naive — homoglyph-substituted slurs
  (Cyrillic а for Latin a, etc.) bypass entirely. This is acceptable
  given the bias-to-inaction posture, but worth noting.
- Manual `warn add` auto-escalation
  (`commands/moderation/warn.js:84-111`) hits ban / kick / 24h timeout
  thresholds the moment the threshold is met. If a mod issues an Nth
  warning with `escalation.ban_at = N`, the user is banned in the same
  command call. No "are you sure" gate.

## Top 5 risks

1. **No confirmation step on destructive AI tool calls.** Every call in
   `HANDLED` executes immediately on dispatch — no two-step confirm,
   no ephemeral preview. A mis-parsed user message ("ban whoever's been
   spamming") combined with a fuzzy `findMember` match can ban the wrong
   person. The `findMember` resolver runs against displayName, username,
   and ID with substring matching.
2. **`purge_messages` allows AI-driven 500-message deletion with weak
   intent verification.** Caller perm check is the ADMIN_TOOLS gate only
   (no `_memberHasPerm(ManageMessages)` re-check inside the
   `purge_messages` branch). The `from_user` / `exclude_user` filters now
   fail loud on unresolvable names (`moderationExecutor.js:513-522`) —
   prior regressions silently purged everyone. **Still no upper bound on
   total messages purged across a single user message** (model can issue
   multiple parallel purge_messages calls per turn — see `dual.js:534`
   parallel `Promise.all`).
3. **`trusted_users` cache stale-revocation window.** Up to 5 min after a
   trusted user is revoked, slash commands and the upstream `isAdmin`
   flag still treat them as admin-equivalent
   (`database.js:1097-1138`). Async refresh is fire-and-forget, so the
   first stale read serves stale, subsequent reads after the in-flight
   refresh see fresh — but during a guild compromise this is a real
   window.
4. **`warn_user` auto-escalation runs server-configured ban/kick on AI
   call.** When auto-escalation is configured and a warning crosses the
   threshold, the AI `warn_user` tool will silently auto-ban
   (`moderationExecutor.js:155-170`) attributed to the calling mod. The
   slash-command path does the same (`warn.js:84-111`). Mods who don't
   know the escalation config can trigger a ban with a single chat
   message to Irene saying "warn alice for spam."
5. **Local audit log is best-effort and bounded.** `logAudit`
   (`database.js:1984-1996`) keeps only the last 100 entries per guild
   in JSON, called from a subset of mod tools (ban, kick, unban,
   untimeout, unmute, remove_warning, clear_warnings, purge — but not
   warn_user, timeout_user, tempban, lockdown_server, snipe). The
   primary audit trail is Discord's native audit log + `sendModLog`
   embeds, but `/audit` (`commands/moderation/audit.js`) only ever reads
   Discord's 45-day window — there is no consolidated tamper-evident
   trail for actions older than 45 days.

## Remediation

- Add `_memberHasPerm(ManageMessages)` re-check at the top of the
  `purge_messages` branch in `moderationExecutor.js:465`. Cap total
  per-turn AI purges (e.g. one purge_messages call per `runGeminiChat`
  iteration via a turn-scoped flag).
- Drop the `trusted_users` TTL to 60 s for revocation-only, OR push
  removals via Supabase Realtime so the cache invalidates immediately
  (see `supabase-realtime-designer` skill); the asymmetric-risk
  reasoning in the comment (`database.js:1086-1095`) holds, but 5 min is
  too generous.
- For AI-initiated destructive ops on >1 target or with a non-exact
  `findMember` match, gate behind a button-confirm modal — re-use
  `buildUndoRow` style components in `utils/embeds.js`. The model can
  still queue the action; the human commits it.
- Persist `logAudit` entries to Supabase with no cap, indexed by
  (guildId, timestamp), and surface in `/audit` as the long-window
  source. The current 100-entry truncation makes incident forensics
  past ~a week unreliable on busy guilds.
- Add unicode normalization (NFKC + confusables fold) at the top of
  `preFilter` in `rulesDetector.js`; pair with a Brave-light eval set of
  homoglyph-substituted strings to confirm the pattern set still trips.
- Auto-escalation should surface a "this warning crosses the
  ban_at=N threshold — confirm?" prompt for AI-initiated `warn_user`
  calls when the resulting action escalates beyond a 10-min timeout.
