# Irene

> the good twin. an all-in-one Discord bot that feels like a person actually running your server — not a bot executing commands.

she doesn't just moderate. she reads the room. she remembers what matters to you. she has talkative days and quiet days. she has a twin sister she loves and will absolutely roast for being too edgy.

## Why She Feels Alive

**She has moods.** Not a gimmick — her mood shifts with conversation tone and shapes how she replies. Good mood → warmer, chattier. Annoyed → shorter, still does what you ask, just with less enthusiasm. Like a real moderator who's had a day.

**She remembers you.** Persistent memory with 90-day decay if unreinforced — real memory fade, not a flat database. Tell her you have a test tomorrow. Next week she might ask how it went. She also knows who to ask about what.

**She has relationships.** Per-user affinity scores built from actual interaction history. People she vibes with get warmth. Exhausting users get "ok." She holds small grudges and forgives genuine apologies. Emerges from the tracking system — no scripts.

**She talks like a person.** lowercase, no periods. she helps because she wants to, not from obligation. she lets boring conversations die instead of forcing engagement. deep meme and internet-culture literacy — reference a meme and she pulls the GIF. no "how fascinating!" no enthusiastic validation. just presence.

**She listens in voice chat.** Say "hey irene" in a VC and she wakes up — transcribes, processes, responds with a natural TTS voice. Custom wake words per server. Per-user cooldowns so nobody spams her. She joins the call like another person on the line.

**She has a sister.** Eris — the chaotic twin who runs the economy. They're separate bots that genuinely know about each other through an HMAC-signed twin API. Irene bans a user? Eris can zero their balance automatically (opt-in per guild). They talk about each other. They tease each other.

## What She Does

**200+ AI tools. 65+ slash commands. 53 event handlers logging everything that moves.**

### Moderation (with *attribution*)

Warn → auto-mute → auto-kick → auto-ban escalation (configurable thresholds). Reputation scoring. Raid protection (join thresholds + account-age filtering). Anti-nuke detection for mass-destructive actions. Message edit/delete logging with ghost-ping detection.

**One-click undo.** Every ban, timeout, and warn ships with an admin button on the mod-log embed. Click → reverses the action, marks the original with strike-through. No sleuthing. No "wait what was that command again."

**Compound scheduled actions.** "timeout them 5 minutes then untimeout after 10 seconds" *works* — `schedule_task` lets Irene chain AI tool calls over time. Reversal recursion is blocked (no infinite `schedule_task` → `schedule_task`).

**Full "who did what"** across 20+ mod-log event types. Account age. Roles at time of ban. Time in server. Join method. Aggressively detailed — because "who timed them out?" should never be a question.

### Music (via Lavalink)

YouTube, Spotify, SoundCloud. Queue, shuffle, loop, now-playing with progress bar. **Seven audio filters** (bassboost, nightcore, vaporwave, 8D, karaoke, tremolo, vibrato). DJ role system. Per-server custom soundboard with 30 slots. TTS in VC.

### Leveling & XP

Per-message XP with cooldowns. Role rewards at milestone levels. Configurable multipliers (global, role-based, weekend). Visual rank cards with progress bars. Leaderboards.

### Server Management

AFK system. Keyword highlight DMs. Tags/FAQ. Suggestion workflow with votes. Custom embed builder. Scheduled messages. Server stats. Birthdays. Reminders. Smart voice channels (auto-rename from games/music, ownership, lock/rename). Custom commands. Reaction roles. Starboard.

### Interactive Setup Wizard

Seven categories. Native Discord pickers. Live preview. Don't edit a config file. Don't read docs. Run `/setup-wizard` and click through.

### Notification Feeds

YouTube RSS (5 channels/server). GitHub commits (5 repos, branch filters). Twitch live alerts. Game patch notes (Valorant, League, Fortnite, Minecraft, Apex, Overwatch).

### AI Agent

Dual backend (Gemini primary, NVIDIA Kimi fallback). Persistent memory with sensitivity tiers. Per-channel personas. Image generation (Imagen 3). Channel summarization — "what did I miss?" actually works. DM-based server management. **Memory dreams** — she processes what happened while "asleep" and sometimes surfaces them 30 minutes after waking.

### Scrim Engine

1v1 through 10v10 matchmaking. ELO-balanced team formation. Auto voice-channel deployment. Consensus-based match reporting. Persistent leaderboards.

### Weekly Digest

Every Sunday at noon, a per-server health digest: messages sent, active members, mod actions, trending topics, memorable moments. Auto-drafted by Irene. Set a `digest_channel_id` and forget it.

### Presence API

REST endpoint at `/presence` — drop-in Lanyard replacement. Real-time Discord status, activities, Spotify with album art. Built for personal website integration.

## Commands

| Category | Commands |
|----------|----------|
| **AI** | `/chat` `/listen` `/memory` `/persona` |
| **Music** | `/play` `/queue` `/nowplaying` `/filters` `/loop` `/shuffle` `/skip` `/pause` `/resume` `/stop` `/volume` `/dj` `/soundboard` `/karaoke` |
| **Mod** | `/warn` `/warnings` `/ban` `/unban` `/kick` `/timeout` `/mute` `/purge` `/rep` |
| **Fun** | `/rank` `/leaderboard` `/giveaway` `/poll` `/polladvanced` `/trivia` `/8ball` `/coinflip` `/roll` `/rps` `/meme` `/scrim` |
| **Utility** | `/afk` `/highlight` `/tag` `/suggest` `/embed` `/stats` `/serverinfo` `/birthday` `/remind` `/avatar` `/userinfo` `/digest` `/bumps` `/bumpathon` `/bumpconfig` `/schedulemsg` |
| **Voice** | `/vc` |
| **Setup** | `/setup-server` `/setup-wizard` `/welcome` `/logging` `/ticket` `/autorole` |

## Security

- Owner-only gatekeep (realtime + startup sweep)
- Prompt-injection firewall — homoglyph normalize → decode → regex → semantic similarity
- Permission hierarchy (Owner > Trusted > Admin > Member)
- Anti-raid + anti-nuke + anti-spam
- Per-user tool rate limits + NVIDIA circuit breaker + Gemini 429 fallback
- Moderation hierarchy checks (bot + user position vs target)
- AI tool denylist (`NON_SCHEDULABLE` prevents `schedule_task` recursion)
- Full audit logging + attribution on every mod action
- HMAC-signed twin API with Bearer-gated state endpoint

See **[FEATURES.md](FEATURES.md)** for the full security inventory.

## Tech Stack

Node.js 18+ · discord.js v14 · Shoukaku (Lavalink) · Gemini / NVIDIA Kimi · Supabase · Voyage AI embeddings · Render

## Setup

```bash
npm install
```

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_USER_ID=
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
LAVALINK_HOST=
LAVALINK_PORT=
LAVALINK_PASSWORD=
TWIN_API_SECRET=         # shared with Eris for cross-bot features
```

```bash
npm run deploy    # register slash commands
npm start
```

## Running tests

```bash
npm test
```

---

**Roadmap:** see **[FEATURES.md](FEATURES.md)** — what's shipped, what's planned, what's explicitly skipped (and why).
