# Irene — Slash Commands

Total: 67 commands across 8 categories. Generated from packages/irene/commands/.

To register changes with Discord: `npm run deploy --workspace=@defnotean/irene`.

## AI

| Command | Description | File |
|---|---|---|
| `/chat` | Chat with Irene, the server's friendly assistant | commands/ai/chat.js |
| `/listen` | Toggle AI voice conversation in a voice channel | commands/ai/listen.js |
| `/listen start` | Start listening in your current voice channel | commands/ai/listen.js |
| `/listen stop` | Stop listening in this server | commands/ai/listen.js |
| `/listen status` | Check if the bot is currently listening | commands/ai/listen.js |
| `/listen wakeword` | Change the wake word (default: irene) | commands/ai/listen.js |
| `/memory` | Manage memories Irene has about you | commands/ai/memory.js |
| `/memory list` | (Lists stored memories; admin can target another user) | commands/ai/memory.js |
| `/memory forget` | Remove a specific memory by number | commands/ai/memory.js |
| `/memory clear` | Clear all memories about you | commands/ai/memory.js |
| `/memory search` | Search for memories by keyword | commands/ai/memory.js |
| `/persona` | Customize the bot's name and personality for this server | commands/ai/persona.js |
| `/persona set` | Set a custom persona for this server | commands/ai/persona.js |
| `/persona reset` | Reset to the default Irene personality | commands/ai/persona.js |
| `/persona view` | View the current persona for this server | commands/ai/persona.js |

## Fun

| Command | Description | File |
|---|---|---|
| `/8ball` | Ask the magic 8-ball a question | commands/fun/8ball.js |
| `/coinflip` | Flip a coin | commands/fun/coinflip.js |
| `/giveaway` | Manage giveaways | commands/fun/giveaway.js |
| `/giveaway start` | Start a new giveaway | commands/fun/giveaway.js |
| `/giveaway end` | End a giveaway early | commands/fun/giveaway.js |
| `/giveaway reroll` | Pick new winners for a giveaway | commands/fun/giveaway.js |
| `/leaderboard` | View the server's XP leaderboard | commands/fun/leaderboard.js |
| `/meme` | Get a random meme | commands/fun/meme.js |
| `/poll` | Create a poll | commands/fun/poll.js |
| `/poll create` | Create a new poll (advanced, with buttons) | commands/fun/polladvanced.js |
| `/poll close` | Close a poll early | commands/fun/polladvanced.js |
| `/rank` | Check your or someone else's XP rank | commands/fun/rank.js |
| `/roll` | Roll a dice | commands/fun/roll.js |
| `/rps` | Play Rock Paper Scissors | commands/fun/rps.js |
| `/scrim` | Organize, play, and track ELO for custom scrim matches | commands/fun/scrim.js |
| `/scrim create` | Host a new scrim lobby | commands/fun/scrim.js |
| `/scrim leaderboard` | View the ELO leaderboard for a specific game | commands/fun/scrim.js |
| `/scrim stats` | View someone's ELO and match history | commands/fun/scrim.js |
| `/trivia` | Answer a random trivia question | commands/fun/trivia.js |

> Note: both `fun/poll.js` and `fun/polladvanced.js` register the top-level name `poll`. Discord will only accept one — `polladvanced.js` (with subcommands) wins at registration time. The simple `/poll` builder is effectively dead code.

## Moderation

| Command | Description | File |
|---|---|---|
| `/audit` | Search Discord audit log for moderation actions (45-day retention) | commands/moderation/audit.js |
| `/audit user` | All mod actions performed against a specific user | commands/moderation/audit.js |
| `/audit by` | All mod actions performed BY a specific moderator | commands/moderation/audit.js |
| `/audit recent` | Mod actions in the last 24h (any actor, any target) | commands/moderation/audit.js |
| `/ban` | Ban a user from the server | commands/moderation/ban.js |
| `/kick` | Kick a user from the server | commands/moderation/kick.js |
| `/mute` | Mute a user (role-based) | commands/moderation/mute.js |
| `/purge` | Bulk delete messages | commands/moderation/purge.js |
| `/rep` | View user reputation | commands/moderation/rep.js |
| `/rep view` | View a user's reputation | commands/moderation/rep.js |
| `/rep history` | View detailed rep history | commands/moderation/rep.js |
| `/rep note` | Add a note (admin only) | commands/moderation/rep.js |
| `/rep leaderboard` | Show top 10 users by reputation score | commands/moderation/rep.js |
| `/rules` | Manage server rules Irene enforces (admin only) | commands/moderation/rules.js |
| `/rules learn` | AI-extract rules from a #rules channel and store them | commands/moderation/rules.js |
| `/rules list` | Show stored rules | commands/moderation/rules.js |
| `/rules add` | Add a single rule manually | commands/moderation/rules.js |
| `/rules remove` | Remove a rule by number | commands/moderation/rules.js |
| `/rules clear` | Wipe all stored rules | commands/moderation/rules.js |
| `/rules enable` | Turn ON proactive auto-mod | commands/moderation/rules.js |
| `/rules disable` | Turn OFF proactive auto-mod | commands/moderation/rules.js |
| `/rules status` | Show whether auto-mod is on, rule count, exemption count | commands/moderation/rules.js |
| `/rules exempt` | Whitelist a user from a rule (or all rules) | commands/moderation/rules.js |
| `/rules unexempt` | Remove a user's exemption | commands/moderation/rules.js |
| `/rules exemptions` | List active rule exemptions in this server | commands/moderation/rules.js |
| `/timeout` | Timeout a user | commands/moderation/timeout.js |
| `/unban` | Unban a user by their ID | commands/moderation/unban.js |
| `/warn` | Warn a user | commands/moderation/warn.js |
| `/warn add` | Issue a warning to a user | commands/moderation/warn.js |
| `/warn view` | View a user's warnings | commands/moderation/warn.js |
| `/warn remove` | Remove a warning by index | commands/moderation/warn.js |
| `/warnings` | View or manage warnings for a user | commands/moderation/warnings.js |

## Music

| Command | Description | File |
|---|---|---|
| `/dj` | Configure DJ role for music commands | commands/music/dj.js |
| `/dj set` | Set the DJ role | commands/music/dj.js |
| `/dj remove` | Remove DJ role requirement | commands/music/dj.js |
| `/dj status` | Show current DJ role | commands/music/dj.js |
| `/dj check` | Check if a user has DJ permissions | commands/music/dj.js |
| `/filter` | Apply audio filters to music | commands/music/filters.js |
| `/filter apply` | Apply a filter | commands/music/filters.js |
| `/filter list` | Show available filters | commands/music/filters.js |
| `/filter current` | Show currently active filters | commands/music/filters.js |
| `/filter reset` | Clear all filters | commands/music/filters.js |
| `/karaoke` | Display synced song lyrics as music plays | commands/music/karaoke.js |
| `/karaoke start` | Start lyrics for a specific song (or auto-detect from music player) | commands/music/karaoke.js |
| `/karaoke auto` | Auto-show lyrics whenever a new track plays | commands/music/karaoke.js |
| `/karaoke stop` | Stop lyrics and restore my nickname | commands/music/karaoke.js |
| `/karaoke offset` | Shift lyrics timing (positive = later, negative = earlier) | commands/music/karaoke.js |
| `/karaoke status` | Show current karaoke status | commands/music/karaoke.js |
| `/loop` | Toggle loop mode | commands/music/loop.js |
| `/nowplaying` | Show the currently playing song | commands/music/nowplaying.js |
| `/pause` | Pause the current song | commands/music/pause.js |
| `/play` | Play a song or playlist from YouTube or Spotify | commands/music/play.js |
| `/queue` | View the music queue | commands/music/queue.js |
| `/resume` | Resume the paused song | commands/music/resume.js |
| `/shuffle` | Shuffle the upcoming queue or toggle auto-shuffle | commands/music/shuffle.js |
| `/skip` | Skip the current song | commands/music/skip.js |
| `/soundboard` | Play short audio clips | commands/music/soundboard.js |
| `/soundboard add` | Add a sound to the soundboard (admin only) | commands/music/soundboard.js |
| `/soundboard play` | Play a sound in voice channel | commands/music/soundboard.js |
| `/soundboard list` | List all available sounds | commands/music/soundboard.js |
| `/soundboard remove` | Remove a sound (admin only) | commands/music/soundboard.js |
| `/stop` | Stop music and clear the queue | commands/music/stop.js |
| `/volume` | Set the music volume | commands/music/volume.js |

## Setup

| Command | Description | File |
|---|---|---|
| `/autorole` | Auto-assign a role to new members | commands/setup/autorole.js |
| `/logging` | Set the moderation log channel | commands/setup/logging.js |
| `/setup` | Interactive setup wizard — configure Irene's features in one place | commands/setup/setup-wizard.js |
| `/setup-server` | Auto-create a standard server structure (categories, channels, roles) | commands/setup/setup-server.js |
| `/ticket` | Manage the ticket system | commands/setup/ticket.js |
| `/ticket create` | Open a new support ticket | commands/setup/ticket.js |
| `/ticket close` | Close and delete this ticket channel | commands/setup/ticket.js |
| `/ticket setup` | Initial ticket-system bootstrap (Admin) | commands/setup/ticket.js |
| `/ticket config` | Show current ticket config (Admin) | commands/setup/ticket.js |
| `/ticket category` | Change the category new tickets are created under (Admin) | commands/setup/ticket.js |
| `/ticket view-role` | Grant a role view+send access on every new ticket (Admin) | commands/setup/ticket.js |
| `/ticket ping-role` | Ping a role in the welcome message of each new ticket (Admin) | commands/setup/ticket.js |
| `/ticket mods` | Shortcut: set one role for BOTH view access AND ping (Admin) | commands/setup/ticket.js |
| `/ticket welcome` | Customize the welcome embed on new tickets (Admin) | commands/setup/ticket.js |
| `/ticket auto-mods` | Auto-populate view/ping roles from any role with mod/admin permissions (Admin) | commands/setup/ticket.js |
| `/welcome` | Configure the welcome message channel | commands/setup/welcome.js |

## Utility

| Command | Description | File |
|---|---|---|
| `/about` | Learn about Irene | commands/utility/about.js |
| `/afk` | Set your AFK status with an optional reason | commands/utility/afk.js |
| `/avatar` | Get a user's avatar | commands/utility/avatar.js |
| `/birthday` | Birthday system — set yours, view others, check upcoming | commands/utility/birthday.js |
| `/birthday set` | Set your birthday | commands/utility/birthday.js |
| `/birthday view` | View a member's birthday | commands/utility/birthday.js |
| `/birthday list` | See all upcoming birthdays in this server | commands/utility/birthday.js |
| `/birthday remove` | Remove your birthday from this server | commands/utility/birthday.js |
| `/birthday setup` | Configure birthday announcements (admin only) | commands/utility/birthday.js |
| `/birthday config` | View current birthday configuration | commands/utility/birthday.js |
| `/bumpathon` | Run a timed bump goal event for the server | commands/utility/bumpathon.js |
| `/bumpathon start` | Start a bump-a-thon | commands/utility/bumpathon.js |
| `/bumpathon status` | Current bump-a-thon progress | commands/utility/bumpathon.js |
| `/bumpathon cancel` | Cancel the active bump-a-thon | commands/utility/bumpathon.js |
| `/bumpconfig` | Configure the bump reminder | commands/utility/bumpconfig.js |
| `/bumpconfig role add` | Add a role to the ping list | commands/utility/bumpconfig.js |
| `/bumpconfig role remove` | Remove a role from the ping list | commands/utility/bumpconfig.js |
| `/bumpconfig role clear` | Clear all ping roles | commands/utility/bumpconfig.js |
| `/bumpconfig role rotation` | How to ping when multiple roles are configured | commands/utility/bumpconfig.js |
| `/bumpconfig service enable` | Enable a bump service on this server | commands/utility/bumpconfig.js |
| `/bumpconfig service disable` | Disable a bump service on this server | commands/utility/bumpconfig.js |
| `/bumpconfig channel` | Send reminders to a different channel than the bump channel | commands/utility/bumpconfig.js |
| `/bumpconfig quiet` | Set quiet hours when pings are suppressed | commands/utility/bumpconfig.js |
| `/bumpconfig unquiet` | Disable quiet hours | commands/utility/bumpconfig.js |
| `/bumpconfig template` | Custom reminder message (tokens: {service} {command} {guildName}) | commands/utility/bumpconfig.js |
| `/bumpconfig no_show_toggle` | Toggle the 15-minute no-show escalation nudge | commands/utility/bumpconfig.js |
| `/bumpconfig applause` | Toggle the post-bump applause shoutout | commands/utility/bumpconfig.js |
| `/bumpconfig personal_ping` | Allow users to opt into personal DM bump pings | commands/utility/bumpconfig.js |
| `/bumpconfig mvp` | Toggle the weekly MVP thank-you DM | commands/utility/bumpconfig.js |
| `/bumpconfig celebration_template` | Customize milestone/goal-hit/fell-short/streak-lost messages | commands/utility/bumpconfig.js |
| `/bumpconfig show` | Show current configuration | commands/utility/bumpconfig.js |
| `/bumps` | Bump leaderboard, personal stats, and DM opt-ins | commands/utility/bumps.js |
| `/bumps leaderboard` | Top bumpers in this server | commands/utility/bumps.js |
| `/bumps me` | See your personal bump stats | commands/utility/bumps.js |
| `/bumps trend` | Daily bump activity over the last 14 days | commands/utility/bumps.js |
| `/bumps dm` | Opt into or out of personal DM pings when a server is bumpable | commands/utility/bumps.js |
| `/bumps mvp` | Opt into or out of the weekly MVP thank-you DM | commands/utility/bumps.js |
| `/bumps correlation` | How many new members join shortly after a bump | commands/utility/bumps.js |
| `/dev_stats` | Show internal bot statistics and uptime (Owner only) | commands/utility/dev_stats.js |
| `/digest` | Weekly server digest — bump ROI + growth | commands/utility/digest.js |
| `/digest now` | Generate and preview the digest right now | commands/utility/digest.js |
| `/digest channel` | Set the channel where weekly digests auto-post | commands/utility/digest.js |
| `/digest post` | Post the digest to the configured channel now | commands/utility/digest.js |
| `/digest disable` | Stop auto-posting weekly digests | commands/utility/digest.js |
| `/embed` | Build and send a custom embed | commands/utility/embed.js |
| `/help` | List all commands or get info on a specific command | commands/utility/help.js |
| `/highlight` | Manage words you want to be notified about | commands/utility/highlight.js |
| `/highlight add` | Add a word to highlight | commands/utility/highlight.js |
| `/highlight remove` | Remove a highlighted word | commands/utility/highlight.js |
| `/highlight list` | List all your highlighted words | commands/utility/highlight.js |
| `/highlight clear` | Clear all highlighted words | commands/utility/highlight.js |
| `/ping` | Check bot latency | commands/utility/ping.js |
| `/schedulemsg` | Schedule a message to be sent | commands/utility/schedulemsg.js |
| `/schedulemsg send` | Schedule a message | commands/utility/schedulemsg.js |
| `/schedulemsg list` | Show all scheduled messages | commands/utility/schedulemsg.js |
| `/schedulemsg cancel` | Cancel a scheduled message | commands/utility/schedulemsg.js |
| `/serverinfo` | Get information about this server | commands/utility/serverinfo.js |
| `/stats` | Show server activity dashboard | commands/utility/stats.js |
| `/suggest` | Manage suggestions | commands/utility/suggest.js |
| `/suggest idea` | Submit a suggestion | commands/utility/suggest.js |
| `/suggest setup` | Set the suggestion channel (admin only) | commands/utility/suggest.js |
| `/suggest approve` | Approve a suggestion (admin only) | commands/utility/suggest.js |
| `/suggest deny` | Deny a suggestion (admin only) | commands/utility/suggest.js |
| `/tag` | Manage quick-access text snippets | commands/utility/tag.js |
| `/tag create` | Create a new tag | commands/utility/tag.js |
| `/tag edit` | Edit an existing tag | commands/utility/tag.js |
| `/tag delete` | Delete a tag | commands/utility/tag.js |
| `/tag list` | List all tags in this server | commands/utility/tag.js |
| `/tag info` | Get information about a tag | commands/utility/tag.js |
| `/tag get` | Retrieve a tag | commands/utility/tag.js |
| `/userinfo` | Get information about a user | commands/utility/userinfo.js |

## Voice

| Command | Description | File |
|---|---|---|
| `/vc` | Control your temp voice channel | commands/voice/vc.js |
| `/vc private` | Make your VC private | commands/voice/vc.js |
| `/vc public` | Make your VC public | commands/voice/vc.js |
| `/vc lock` | Lock your VC to current member count | commands/voice/vc.js |
| `/vc unlock` | Remove user limit from your VC | commands/voice/vc.js |
| `/vc rename` | Rename your VC | commands/voice/vc.js |
| `/vc kick` | Kick someone from your VC | commands/voice/vc.js |
| `/vc transfer` | Transfer VC ownership | commands/voice/vc.js |

## Context-menu commands

These appear when right-clicking a message in Discord (Apps submenu) — they do not show up in slash autocomplete. Discord's context-menu API does not support a description field, so the names alone are the entire surface.

| Command | Target type | File |
|---|---|---|
| `Remember This` | Message | commands/context/remember.js |
| `Remind Me` | Message | commands/context/remindme.js |
| `Translate` | Message | commands/context/translate.js |

## Adding a new command

See [CONTRIBUTING.md](../../CONTRIBUTING.md#your-first-contribution) for the walkthrough.
