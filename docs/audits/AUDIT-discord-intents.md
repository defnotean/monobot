# Discord Intents — Least-Privilege Audit

Scope: every `GatewayIntentBits.*` declared in each bot's `Client` constructor,
cross-referenced against the events actually wired in `events/`, the partials
declared, and any direct cache / fetch usage (`guild.members.fetch`,
`member.presence`, `guild.invites`, etc.). Sources: `packages/eris/index.js:21-32`
and `packages/irene/index.js:27-51`. Events auto-load from `events/` via the
filename-to-event-name convention in `loadEvents()` (`packages/eris/index.js:63-93`,
`packages/irene/index.js:155-170`).

## Per-bot intent inventory

**Eris** declares 7 intents (`packages/eris/index.js:22-30`):
`Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`, `DirectMessages`,
`GuildPresences`, `GuildMessageReactions`. Partials:
`Message, Channel, User, Reaction`.

**Irene** declares 14 intents (`packages/irene/index.js:28-43`):
`Guilds`, `GuildPresences`, `GuildMembers`, `GuildMessages`, `GuildVoiceStates`,
`MessageContent`, `GuildMessageReactions`, `DirectMessages`, `GuildModeration`,
`GuildInvites`, `GuildEmojisAndStickers`, `GuildScheduledEvents`,
`AutoModerationConfiguration`, `AutoModerationExecution`. Partials:
`Message, Channel, Reaction, DirectMessage`.

## Usage cross-reference

### Eris (7 intents, 6 event handlers)

| Intent | Required for | Evidence |
| --- | --- | --- |
| `Guilds` | base lifecycle, `guildCreate` | `packages/eris/events/guildCreate.js`, `ready.js` |
| `GuildMessages` | `messageCreate` in guild channels | `packages/eris/events/messageCreate.js` |
| `MessageContent` | reading `message.content` for AI pipeline | `messageCreate.js:540+`, privileged |
| `GuildMembers` | `guildMemberAdd`, member fetch in `bumpReminder.js:500` (`withPresences`), bumpCorrelation | `packages/eris/events/guildMemberAdd.js:1-21`, privileged |
| `DirectMessages` | DM branch in `messageCreate.js:648, 1385-1386` (replies to owner DMs) | `messageCreate.js:648` (`const isDM = !message.guild`) |
| `GuildPresences` | `check_presence` tool, `withPresences: true` member fetch for online-role bump targeting | `ai/executors/webExecutor.js:117-133`, `ai/bumpReminder.js:500-507`, privileged |
| `GuildMessageReactions` | `messageReactionAdd` catchphrase tracker | `packages/eris/events/messageReactionAdd.js` |

No `messageUpdate`, `messageDelete`, `voice*`, `invite*`, `emoji*`, `thread*`,
`autoModeration*`, `guildBan*`, or `presenceUpdate` handler exists in
`packages/eris/events/` — all declared intents map to an actual code path.

### Irene (14 intents, 53 event handlers)

| Intent | Required for | Evidence |
| --- | --- | --- |
| `Guilds` | `guildCreate/Delete/Update`, `channel*`, `thread*`, `role*`, `guildAvailable/Unavailable` | `events/guildCreate.js`, `channelCreate.js`, `roleCreate.js`, `threadCreate.js` |
| `GuildPresences` | `presenceUpdate` (temp-VC rename, auto-stream notify) | `events/presenceUpdate.js:13-89`, privileged |
| `GuildMembers` | `guildMemberAdd/Remove/Update`, `userUpdate` (mutual-guild filter) | `events/guildMemberAdd.js`, `userUpdate.js:29-30`, privileged |
| `GuildMessages` | `messageCreate/Update/Delete/BulkDelete`, `channelPinsUpdate` | `events/messageCreate.js`, `messageUpdate.js`, `messageDelete.js`, `messageBulkDelete.js`, `channelPinsUpdate.js` |
| `GuildVoiceStates` | `voiceStateUpdate` (temp VCs, music auto-disconnect, AFK move) | `events/voiceStateUpdate.js` |
| `MessageContent` | rules enforcer, AI pipeline, firewall, content classification | `events/messageCreate.js`, `ai/rulesEnforcer.js`, privileged |
| `GuildMessageReactions` | `messageReactionAdd/Remove/RemoveAll/RemoveEmoji` (reaction roles, paginators, polls) | `events/messageReactionAdd.js` (+3 siblings) |
| `DirectMessages` | DM confirmation flow for VC actions | `events/voiceStateUpdate.js:123-140` (`member.user.createDM` + `dmChannel.createMessageCollector`) |
| `GuildModeration` | `guildBanAdd/Remove` (mod-log embeds) | `events/guildBanAdd.js`, `guildBanRemove.js` |
| `GuildInvites` | `inviteCreate/Delete`, invite-tracker (`utils/invites.js`) | `events/inviteCreate.js`, `inviteDelete.js` |
| `GuildEmojisAndStickers` | `emoji*`, `sticker*` mod-log handlers | `events/emojiCreate.js`, `stickerCreate.js` (+ 4 siblings) |
| `GuildScheduledEvents` | `guildScheduledEventCreate/Delete/Update/UserAdd/UserRemove` | `events/guildScheduledEventCreate.js` (+ 4 siblings) |
| `AutoModerationConfiguration` | `autoModerationRuleCreate/Delete/Update` mod-log | `events/autoModerationRuleCreate.js` (+ 2 siblings) |
| `AutoModerationExecution` | `autoModerationActionExecution` mod-log | `events/autoModerationActionExecution.js` |

`guildAuditLogEntryCreate.js` rides on `Guilds` (no separate intent required —
it only fires for guilds the bot is in and Discord gates it by audit-log perms).
`entitlement*` events are also `Guilds`-scoped lifecycle.

## Over-permissioned items

None at the intent level. Every declared intent on both bots maps to at least
one wired event handler or an explicit fetch call. The three intents most often
flagged in audits — `MessageContent`, `GuildMembers`, `GuildPresences` — are
each load-bearing:

- `MessageContent` is the entire AI pipeline's input (`messageCreate.js`).
- `GuildMembers` powers the member-fetch + `userUpdate` mutual-guild filter and
  `guildMemberAdd/Remove/Update` mod-log handlers.
- `GuildPresences` is consumed by Irene's `presenceUpdate.js` (temp-VC rename,
  live-stream auto-detect) and Eris's `check_presence` tool plus
  `bumpReminder.js:500` (online-role ping targeting).

If `GuildPresences` were ever cut from Eris, the `check_presence` tool would
silently return "offline or invisible" for everyone (`webExecutor.js:125-126`)
and the `online`-mode bump pinger would degrade to never finding active roles.
Both are intentional features, not dead code.

## Under-permissioned items

None observed. Specifically checked:

- Eris does not handle `messageUpdate`, `messageDelete`, `voiceStateUpdate`,
  `inviteCreate`, `guildBanAdd`, `presenceUpdate`, `userUpdate`, `thread*`,
  `channel*`, `emoji*`, `sticker*`, `guildScheduledEvent*`, or `autoModeration*`
  — so it correctly does not declare the corresponding intents.
- Irene's `userUpdate` handler runs on cached users only; no extra intent is
  required beyond `GuildMembers` (which keeps users cached).
- Irene's `guildAuditLogEntryCreate` does not require a dedicated intent — it
  rides on `Guilds` and Discord's `VIEW_AUDIT_LOG` permission.
- Both bots' outbound DM sends (`createDM().send(...)`) do not strictly need
  `DirectMessages` — but both bots also *receive* DMs (Eris's AI DM branch,
  Irene's VC confirmation collector), so the intent is justified.

## Recommended minimal set

Both bots are already at the minimum viable set given current features.

**Eris minimum:** `Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`,
`DirectMessages`, `GuildPresences`, `GuildMessageReactions` — keep as-is.

**Irene minimum:** all 14 currently declared intents — keep as-is.

Removal would break observable behavior:

- Drop `GuildPresences` on Eris → `check_presence` and online-role bump targeting
  break.
- Drop `DirectMessages` on Eris → owner DM replies and DM AI conversations break
  (`messageCreate.js:1385`).
- Drop any of Irene's `GuildModeration` / `GuildInvites` /
  `GuildEmojisAndStickers` / `GuildScheduledEvents` / `AutoModeration*` →
  the corresponding mod-log embeds silently stop firing for that event class.

The current declarations are tight. If any of these subsystems are removed in
the future, drop the matching intent in the same change.
