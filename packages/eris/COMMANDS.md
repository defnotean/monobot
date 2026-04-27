# Eris — Slash Commands

Total: 54 commands across 8 categories. Generated from packages/eris/commands/.

To register changes with Discord: `npm run deploy --workspace=@defnotean/eris`.

## Activities

| Command | Description | File |
|---|---|---|
| `/dig` | Dig for treasure | commands/activities/dig.js |
| `/fish` | Cast your line and catch some fish for coins | commands/activities/fish.js |
| `/hunt` | Go hunting for coins | commands/activities/hunt.js |
| `/work` | Work a job for coins (30min cooldown) | commands/activities/work.js |

## Economy

| Command | Description | File |
|---|---|---|
| `/achievements` | View your unlocked achievements | commands/economy/achievements.js |
| `/balance` | Check your coin balance | commands/economy/balance.js |
| `/bank` | Manage your bank account | commands/economy/bank.js |
| &nbsp;&nbsp;`/bank info` | Check your bank balance | commands/economy/bank.js |
| &nbsp;&nbsp;`/bank deposit` | Deposit coins into your bank | commands/economy/bank.js |
| &nbsp;&nbsp;`/bank withdraw` | Withdraw coins from your bank | commands/economy/bank.js |
| `/challenge` | View today's daily challenge | commands/economy/challenge.js |
| `/daily` | Claim your daily coin reward | commands/economy/daily.js |
| `/inventory` | Check your inventory | commands/economy/inventory.js |
| `/leaderboard` | See the richest users | commands/economy/leaderboard.js |
| `/monthly` | Claim your monthly coin reward (30-day cooldown) | commands/economy/monthly.js |
| `/shop` | Browse & buy from Eris's shop | commands/economy/shop.js |
| `/weekly` | Claim your weekly coin reward (7-day cooldown) | commands/economy/weekly.js |

## Gambling

| Command | Description | File |
|---|---|---|
| `/coinflip` | Flip a coin — double or nothing | commands/gambling/coinflip.js |
| `/dice` | Roll a die — guess the number for big wins | commands/gambling/dice.js |
| `/roulette` | Spin the roulette wheel — European, single zero | commands/gambling/roulette.js |
| `/slots` | Spin the slot machine | commands/gambling/slots.js |

## Games

| Command | Description | File |
|---|---|---|
| `/connect4` | Play connect-4 with another user | commands/games/connect4.js |
| `/hangman` | Play hangman — guess the word before you run out of misses | commands/games/hangman.js |
| `/tictactoe` | Play tic-tac-toe with another user | commands/games/tictactoe.js |

## Last.fm

| Command | Description | File |
|---|---|---|
| `/fm` | Show your now playing or last scrobbled track | commands/lastfm/fm.js |
| `/fmalbum` | Get info about an album (defaults to your currently playing) | commands/lastfm/fmalbum.js |
| `/fmalbums` | Show your top albums | commands/lastfm/fmalbums.js |
| `/fmartist` | Get info about an artist | commands/lastfm/fmartist.js |
| `/fmartists` | Show your top artists | commands/lastfm/fmartists.js |
| `/fmchart` | Generate a grid chart of your top album/artist art | commands/lastfm/fmchart.js |
| `/fmcrowns` | View Last.fm crowns — who holds the most-plays crown per artist | commands/lastfm/fmcrowns.js |
| &nbsp;&nbsp;`/fmcrowns user` | View a user's crowns | commands/lastfm/fmcrowns.js |
| &nbsp;&nbsp;`/fmcrowns server` | Crown leaderboard for this server | commands/lastfm/fmcrowns.js |
| `/fmgenre` | Browse top artists or albums for a genre/tag | commands/lastfm/fmgenre.js |
| `/fmprofile` | View a Last.fm profile overview | commands/lastfm/fmprofile.js |
| `/fmrecent` | Show your recent Last.fm scrobbles | commands/lastfm/fmrecent.js |
| `/fmserveralbums` | Top albums across all linked members in this server | commands/lastfm/fmserveralbums.js |
| `/fmserverartists` | Top artists across all linked members in this server | commands/lastfm/fmserverartists.js |
| `/fmservertracks` | Top tracks across all linked members in this server | commands/lastfm/fmservertracks.js |
| `/fmset` | Link your Last.fm account | commands/lastfm/fmset.js |
| &nbsp;&nbsp;`/fmset username` | Set your Last.fm username | commands/lastfm/fmset.js |
| &nbsp;&nbsp;`/fmset remove` | Unlink your Last.fm account | commands/lastfm/fmset.js |
| `/fmstreak` | Show your current daily scrobble streak | commands/lastfm/fmstreak.js |
| `/fmtaste` | Compare music taste between you and another user | commands/lastfm/fmtaste.js |
| `/fmtrack` | Get info about a track (defaults to your now playing) | commands/lastfm/fmtrack.js |
| `/fmtracks` | Show your top tracks | commands/lastfm/fmtracks.js |
| `/fmwhoknows` | Who in this server listens to an artist? | commands/lastfm/fmwhoknows.js |
| `/fmwhoknowsalbum` | Who in this server has listened to an album? | commands/lastfm/fmwhoknowsalbum.js |
| `/fmwhoknowstrack` | Who in this server has listened to a track? | commands/lastfm/fmwhoknowstrack.js |
| `/fmyear` | Year in review — top artists, albums, tracks, and monthly breakdown | commands/lastfm/fmyear.js |

## Pets

| Command | Description | File |
|---|---|---|
| `/pet` | Manage your pet | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet adopt` | Adopt a new pet | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet feed` | Feed your pet | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet status` | Check your pet's stats | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet rename` | Rename your pet | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet train` | Train your pet (100 coins) | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet battle` | Battle your pet against another user's pet | commands/pets/pet.js |
| &nbsp;&nbsp;`/pet evolve` | Evolve your pet if it meets the level requirement | commands/pets/pet.js |

## Social

| Command | Description | File |
|---|---|---|
| `/boss` | Cooperative boss battles | commands/social/boss.js |
| &nbsp;&nbsp;`/boss spawn` | Spawn a boss (costs 500 coins) | commands/social/boss.js |
| &nbsp;&nbsp;`/boss attack` | Attack the active boss (costs 10 coins) | commands/social/boss.js |
| &nbsp;&nbsp;`/boss status` | View the current boss | commands/social/boss.js |
| `/duel` | Challenge someone to a coin duel | commands/social/duel.js |
| `/marry` | Propose to someone (costs 500 coins + wedding ring) | commands/social/marry.js |

## Utility

| Command | Description | File |
|---|---|---|
| `/about` | About Eris | commands/utility/about.js |
| `/bumpathon` | Run a timed bump goal event for the server | commands/utility/bumpathon.js |
| &nbsp;&nbsp;`/bumpathon start` | Start a bump-a-thon | commands/utility/bumpathon.js |
| &nbsp;&nbsp;`/bumpathon status` | Current bump-a-thon progress | commands/utility/bumpathon.js |
| &nbsp;&nbsp;`/bumpathon cancel` | Cancel the active bump-a-thon | commands/utility/bumpathon.js |
| `/bumpconfig` | Configure the bump reminder | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig role add` | Add a role to the ping list | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig role remove` | Remove a role from the ping list | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig role clear` | Clear all ping roles | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig role rotation` | How to ping when multiple roles are configured | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig service enable` | Enable a bump service on this server | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig service disable` | Disable a bump service on this server | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig channel` | Send reminders to a different channel than the bump channel | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig quiet` | Set quiet hours when pings are suppressed | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig unquiet` | Disable quiet hours | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig template` | Custom reminder message. Vars: {service} {command} {guildName}. Empty = AI voice | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig no_show_toggle` | Toggle the 15-minute no-show escalation nudge | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig applause` | Toggle the post-bump applause shoutout (default: on) | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig personal_ping` | Allow users to opt into personal DM bump pings on this server (default: off) | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig mvp` | Toggle the weekly MVP thank-you DM sent to the server's top bumper (default: on) | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig celebration_template` | Customize milestone/goal-hit/fell-short/streak-lost messages. Empty text clears the override. | commands/utility/bumpconfig.js |
| &nbsp;&nbsp;`/bumpconfig show` | Show current configuration | commands/utility/bumpconfig.js |
| `/bumps` | See who's been bumping the server | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps leaderboard` | Top bumpers in this server | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps me` | See your personal bump stats | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps trend` | Daily bump activity over the last 14 days | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps dm` | Opt into or out of personal DM pings when a server is bumpable | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps mvp` | Opt into or out of the weekly MVP thank-you DM | commands/utility/bumps.js |
| &nbsp;&nbsp;`/bumps correlation` | How many new members join this server shortly after a bump | commands/utility/bumps.js |
| `/gamewatch` | Track patch notes and updates for games | commands/utility/gamewatch.js |
| &nbsp;&nbsp;`/gamewatch add` | Start tracking updates for a game | commands/utility/gamewatch.js |
| &nbsp;&nbsp;`/gamewatch remove` | Stop tracking a game | commands/utility/gamewatch.js |
| &nbsp;&nbsp;`/gamewatch list` | Show all active game watches for this server | commands/utility/gamewatch.js |
| `/help` | See what Eris can do | commands/utility/help.js |
| `/karaoke` | Make Irene's nickname display synced lyrics as a song plays | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke start` | Start a karaoke session for a song (manually triggered) | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke auto` | Auto-start karaoke whenever a Last.fm user starts a new track | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke stop` | Stop karaoke and restore my nickname | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke pause` | Pause the current karaoke | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke resume` | Resume the paused karaoke | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke offset` | Adjust timing if lyrics are ahead/behind (positive = lyrics later, negative = lyrics earlier) | commands/utility/karaoke.js |
| &nbsp;&nbsp;`/karaoke status` | Show what's currently playing | commands/utility/karaoke.js |
| `/mood` | See Eris's current mood and how it's affecting gambling odds | commands/utility/mood.js |
| `/ping` | Check if Eris is alive | commands/utility/ping.js |
| `/tutorial` | Learn what Eris can do — interactive walkthrough | commands/utility/tutorial.js |

## Adding a new command

See [CONTRIBUTING.md](../../CONTRIBUTING.md#your-first-contribution) for the walkthrough.
