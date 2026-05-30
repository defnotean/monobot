// @ts-check
// Member-accessible Irene AI tool schemas.
// Extracted from ../tools.js; handlers still live in ai/executors/.

import { NEW_EVERYONE_TOOLS } from "../newtools.js";

export const EVERYONE_TOOLS = [
  // ─── Birthday ────────────────────────────────────────────────────────
  {
    name: "set_birthday",
    description: "Save a user's birthday. Use this when someone tells you their birthday, says 'my birthday is ...', 'remember my birthday', etc. Parse the date from natural language (e.g. 'march 15 2001', 'jan 3rd', '12/25/1999'). Include the year if they provide it — this lets us show their age on their birthday. You can also set another user's birthday if they share it.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username whose birthday to set. Omit or leave blank to use the person asking." },
        month:    { type: "number", description: "Month number 1–12" },
        day:      { type: "number", description: "Day of month 1–31" },
        year:     { type: "number", description: "Birth year (e.g. 2001). Optional — only include if the user provides it." },
      },
      required: ["month", "day"],
    },
  },
  {
    name: "get_birthday",
    description: "Look up someone's birthday, current age, what age they're turning, and days until their next birthday. ALWAYS call this tool when asked anything about age, birthday, how old someone is, or when someone's birthday is. NEVER calculate ages yourself — this tool returns the exact pre-calculated answer.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to look up. Omit to check the person asking." },
      },
    },
  },
  {
    name: "list_birthdays",
    description: "List upcoming birthdays in the server, sorted by how soon they are.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_birthday",
    description: "Remove a user's birthday. Use when someone says 'forget my birthday', 'remove my birthday', etc.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username whose birthday to remove. Omit to remove the person asking's." },
      },
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // MUSIC — playback, queue, filters, lyrics mode
  // ═══════════════════════════════════════════════════════════════════
  // ─── Music ────────────────────────────────────────────────────────────
  {
    name: "play_music",
    description: "Play a song or playlist in the user's voice channel. Supports YouTube URLs/search, Spotify track/playlist/album URLs, SoundCloud URLs, or plain text search. Use when someone EXPLICITLY asks to play, queue, or put on music (e.g., 'play X', 'queue Y', 'put on Z in vc', 'add this to the queue'). DO NOT call this when someone is just SHARING or SHOWING OFF music — e.g. 'check out my spotify', 'heres my spotify', 'listen to my music', 'this is my stuff', 'im an artist heres my page', sending their own artist link, or dropping a link without a play verb. In those cases they want you to LISTEN/REACT as a person, not start the music bot — just respond conversationally about their music. Also DO NOT call if no one is in a VC and the message isn't clearly a play request.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song name, YouTube URL, Spotify URL, SoundCloud URL, or search text" },
      },
      required: ["query"],
    },
  },
  {
    name: "skip_song",
    description: "Skip the current song. Use when someone says 'skip', 'next', 'next song', etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "stop_music",
    description: "Stop playing music and leave the voice channel. Use when someone says 'stop', 'leave', 'disconnect', 'get out', etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pause_music",
    description: "Pause the currently playing music track without clearing the queue.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resume_music",
    description: "Resume music playback after pause_music paused the current track.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "music_queue",
    description: "Show the current music queue — what's playing and what's up next.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "now_playing",
    description: "Show the SONG currently playing in the music player (title, artist, duration). Use whenever the user asks 'what's playing', 'what song is this', 'now playing'. Do NOT use vc_info for this — that's for voice channel members/info, not the music track.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_volume",
    description: "Set the music volume (0-100).",
    input_schema: {
      type: "object",
      properties: { volume: { type: "number", description: "Volume level 0-100" } },
      required: ["volume"],
    },
  },
  {
    name: "toggle_loop",
    description: "Toggle looping the current song or the entire queue. Use when someone says 'loop', 'repeat', 'loop queue', etc.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["song", "queue", "off"], description: "'song' = loop current track, 'queue' = loop entire queue, 'off' = disable looping" },
      },
      required: ["mode"],
    },
  },
  {
    name: "shuffle_queue",
    description: "Toggle shuffle mode for the music queue.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "music_filter",
    description: "Apply an audio filter/effect to the music. Use when someone asks for bass boost, nightcore, vaporwave, 8D audio, karaoke, etc.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["none", "bassboost", "nightcore", "vaporwave", "8d", "karaoke", "tremolo", "vibrato", "lowpass"], description: "Filter to apply. 'none' removes all filters." },
      },
      required: ["filter"],
    },
  },
  {
    name: "start_lyrics_mode",
    description: "Start LYRICS MODE — displays synced song lyrics in real-time as music plays. Two modes: 'message' (default, safe — edits one message with lyrics) or 'nickname' (changes your server nickname to the lyric line). This is NOT the karaoke audio filter. Use when someone says 'lyrics mode', 'show lyrics', 'display lyrics', 'sing along'. Auto-detects current song if no song/artist given.",
    input_schema: {
      type: "object",
      properties: {
        song:   { type: "string", description: "Song title (leave empty to auto-detect from music player)" },
        artist: { type: "string", description: "Artist name (leave empty to auto-detect)" },
        mode:   { type: "string", enum: ["message", "nickname"], description: "Display mode: 'message' (edits a message, default) or 'nickname' (changes bot nickname)" },
      },
    },
  },
  {
    name: "stop_lyrics_mode",
    description: "Stop lyrics mode and restore your normal nickname. Use when someone says 'stop lyrics', 'turn off lyrics', 'stop the lyrics thing', 'lyrics off'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "auto_lyrics_mode",
    description: "Enable auto lyrics mode — lyrics will automatically show for every track that plays. Use when someone says 'auto lyrics', 'always show lyrics', 'lyrics for every song'.",
    input_schema: { type: "object", properties: {} },
  },
  // ═══════════════════════════════════════════════════════════════════
  // PREVIEW & UTILITY — patch news, welcome/birthday tests, GIF, server/
  // user/role/channel/emoji/ban listings, random member, member counts
  // ═══════════════════════════════════════════════════════════════════
  // ─── Test / Preview ─────────────────────────────────────────────────
  {
    name: "test_patch_news",
    description: "Fetch and display a patch note from a game or GPU feed. Can get the latest, a previous one ('the one before that'), or search by version number. Available feeds: valorant, league, fortnite, minecraft, apex, overwatch, csgo, nvidia, amd, gaming.",
    input_schema: {
      type: "object",
      properties: {
        feed: { type: "string", description: "Feed name (valorant, league, nvidia, etc) or a custom RSS URL" },
        offset: { type: "number", description: "0 = latest (default), 1 = one before that, 2 = two before, etc. Use when someone asks for 'the previous one' or 'the one before that'" },
        search: { type: "string", description: "Search for a specific patch by text (e.g. '12.03', 'act 2', 'miks'). Overrides offset." },
      },
      required: ["feed"],
    },
  },
  {
    name: "send_test_birthday",
    description: "Send a test birthday announcement in the current channel to preview what it looks like. Uses the requesting user as the birthday person.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_test_welcome",
    description: "Send a test welcome message in the current channel using the real welcome card design. Use this when someone asks to preview, test, or demo the welcome message. Uses the requesting user as the test member.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_gif",
    description: "Search for a GIF and send it in the channel. Use this for memes, reactions, jokes, internet culture — e.g. 'dab', 'kiss', 'hug', 'slap', '6 9 meme', 'rizz', 'npc', 'sigma', 'trollface', 'rickroll', 'yes chad', etc. Always use this when someone wants a meme reaction or asks you to 'do' something physical/expressive.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms for the GIF (keep it short and specific, e.g. 'dab dance', 'anime kiss', '6 9 meme')" },
        caption: { type: "string", description: "Optional message to send with the GIF (e.g. mentioning the target user)" },
      },
      required: ["query"],
    },
  },
  {
    name: "show_image",
    description:
      "Find a REAL photo of something and POST it directly into the chat with your own caption. Use this whenever someone asks what something looks like, wants to see something, or a real picture answers better than words (e.g. 'what does a quokka look like', 'show me the eiffel tower', 'whats a capybara'). It posts the actual image (not a URL) as an embed. ALWAYS pass a `caption` written in your own voice — your reaction or one-line explanation to send with it. (send_gif = reaction GIFs/memes, generate_image = AI-generated art, this = real reference photos.)",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The subject to find a real photo of (e.g. 'red-eyed tree frog', 'eiffel tower', 'capybara')" },
        caption: { type: "string", description: "Your in-character message to post with the image — your explanation/reaction in your own voice" },
      },
      required: ["query"],
    },
  },
  {
    name: "send_file",
    description:
      "Post the full content as a downloadable FILE attachment. ALWAYS use this instead of pasting long code/scripts/text inline — inline replies are capped and get cut off mid-line. The right pattern: a SHORT message in your voice (1-2 sentences that finish the thought) PLUS the file attached. e.g. asked for a python script → caption + snake.py. The file holds the long stuff so it's never truncated.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name WITH extension (e.g. 'snake.py', 'notes.md', 'data.json')" },
        content: { type: "string", description: "The FULL file contents (code/text). Goes in the file, not the chat — length is fine here." },
        caption: { type: "string", description: "Short message to post alongside the file, in your own voice (1-2 sentences)" },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit/alter an image the user ATTACHED to their current message, following their instruction, and post the result (e.g. 'make the sky blue', 'add sunglasses', 'turn this into a painting', 'remove the background'). Only works when the user actually attached an image. Pass `instruction` (what to change) and a short `caption` in your voice.",
    input_schema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to change about the attached image (e.g. 'make the sky blue', 'add a party hat')" },
        caption: { type: "string", description: "Optional short message to post with the edited image, in your voice" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "set_gif_style",
    description: "Toggle how GIFs are displayed in this server. 'raw' = just the GIF, no embed border (clean look). 'embed' = GIF inside a colored embed (default). Use when someone asks to remove the GIF border, make GIFs clean/raw, or bring back the embed style.",
    input_schema: {
      type: "object",
      properties: {
        style: { type: "string", enum: ["raw", "embed"], description: "'raw' = no border, just the GIF. 'embed' = colored embed border (default)" },
      },
      required: ["style"],
    },
  },
  {
    name: "get_server_info",
    description: "Get server stats (members, channels, roles, boosts, etc.)",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_dm_preference",
    description: "Set whether Irene should DM a user. Use this when someone says they don't want DMs ('don't DM me', 'stop sending me DMs', 'no more DMs') or wants to re-enable them ('you can DM me again'). Can set for yourself or, if admin, for another user.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to update (leave blank to apply to the person asking)" },
        allow_dms: { type: "boolean", description: "true = allow DMs, false = no DMs" },
      },
      required: ["allow_dms"],
    },
  },
  {
    name: "get_user_info",
    description: "Get GENERAL profile info about a user — join date, roles, status, account creation, avatar. Do NOT use for birthdays or ages — use get_birthday for anything age/birthday related (birthdays are stored separately and get_birthday returns the exact age).",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to look up" } },
      required: ["username"],
    },
  },
  {
    name: "list_channels",
    description: "List all channels organized by category, including channel IDs. Use these IDs for channel tools whenever possible.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_roles",
    description: "List all roles with member counts",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_role_permissions",
    description: "Read the current permissions assigned to a role. Use this to check what a role can and can't do before making changes.",
    input_schema: {
      type: "object",
      properties: { role_name: { type: "string", description: "Name of the role to inspect" } },
      required: ["role_name"],
    },
  },
  // ─── REFERENCE TOOL ─── This is a canonical example. New contributors: copy this pattern when adding a tool. See ai/executors/emojiExecutor.js for handler and tests/ai/executors/listEmojis.test.ts for spec. ───
  {
    name: "list_emojis",
    description: "List all custom emojis in the server",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_bans",
    description: "List users currently banned from this server, including available ban metadata when Discord exposes it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "random_member",
    description: "Pick a random member from the server (for giveaways, picking someone, etc.)",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Only pick from members with this role (optional)" },
        count: { type: "number", description: "How many random members to pick (default: 1)" },
      },
    },
  },
  {
    name: "count_members",
    description: "Count members, optionally filtered by role or status",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Count members with this role (optional)" },
        status: { type: "string", enum: ["online", "idle", "dnd", "offline"], description: "Filter by status (optional)" },
      },
    },
  },
  {
    name: "who_has_role",
    description: "List all members who have a specific role",
    input_schema: {
      type: "object",
      properties: { role_name: { type: "string", description: "Exact server role name to inspect" } },
      required: ["role_name"],
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // TEMP VC CONTROLS — owner-of-the-channel controls (private/lock/kick/etc)
  // ═══════════════════════════════════════════════════════════════════
  // ─── Temp VC Controls (for channel owners) ─────────────────────────
  {
    name: "vc_info",
    description: "Show info about the voice channel the SPEAKER is currently in — members in the channel, the games each person is playing, owner, user limit, bitrate. Do NOT use this for the music player — for the currently-playing SONG use now_playing. Do NOT use this to rename — use vc_rename.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_private",
    description: "Make your temp voice channel private — blocks new people from joining. Current members can still rejoin. Use vc_allow to let specific people in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_public",
    description: "Make your private temp VC public again so anyone can join",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_lock",
    description: "Lock the user limit on the SPEAKER'S OWN temp voice channel — they must already be in a temp VC they own. Use when the user says 'lock my vc to N', 'cap my channel at N', 'no more than N people'. Do NOT use for server-wide defaults (that's set_vc_default_limit) or for permission locks (lock_channel).",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max users (omit = lock to current member count)" },
      },
    },
  },
  {
    name: "vc_unlock",
    description: "Remove the user-count limit from the SPEAKER'S OWN temp voice channel so anyone can join (no permissions changed). Use when the user says 'unlock my vc', 'remove the limit', 'open my channel'. Do NOT use set_channel_permissions for this — that's for permanent permission overrides on regular channels, not temp VCs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_rename",
    description: "RENAMES the SPEAKER'S OWN temp voice channel. The channel is identified by the speaker's current voice state — no channel name/ID needed in args. Use ONLY when the user wants to CHANGE the name of their voice channel ('rename my vc to X', 'call my channel X', 'change my vc name'). Do NOT confuse with vc_info (which only DISPLAYS info) or with rename_channel (which renames any non-temp channel).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "New name to set on the speaker's current temp VC" } },
      required: ["name"],
    },
  },
  {
    name: "vc_transfer",
    description: "Give ownership of your temp VC to someone else in the channel",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to transfer ownership to" } },
      required: ["username"],
    },
  },
  {
    name: "vc_kick",
    description: "Kick someone out of the SPEAKER'S OWN temp voice channel — owner-only action. Use when the user says 'kick X from my vc', 'boot X out of my channel'. Do NOT confuse with disconnect_user_from_voice (a moderation tool that kicks anyone from any voice channel; admin-only). Optionally ban them from rejoining your VC. Pass username, mention, or Discord ID.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username, @mention, or Discord ID of the user to kick from your VC" },
        ban: { type: "boolean", description: "Prevent them from rejoining your VC (default: false)" },
      },
      required: ["username"],
    },
  },
  {
    name: "vc_allow",
    description: "Allow a specific user to join your private temp VC",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to allow" } },
      required: ["username"],
    },
  },
  {
    name: "vc_claim",
    description: "Claim ownership of a temp VC whose owner already left. You must be in the channel.",
    input_schema: { type: "object", properties: {} },
  },
  // ═══════════════════════════════════════════════════════════════════
  // REMINDERS — set/cancel a per-user delayed ping
  // ═══════════════════════════════════════════════════════════════════
  // ─── Reminder Tools ────────────────────────────────────────────────────
  {
    name: "reminder_set",
    description: "Set a reminder for the user. They'll be pinged in this channel at the specified time with their reminder message.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind them about" },
        delay_minutes: { type: "number", description: "How many minutes from now to fire the reminder" },
      },
      required: ["message", "delay_minutes"],
    },
  },
  {
    name: "reminder_cancel",
    description: "Cancel a USER-SET REMINDER by its reminder ID — the kind set with reminder_set. Use whenever the user says 'cancel reminder N', 'remove my reminder', 'forget that reminder'. Do NOT use cancel_scheduled_task for this — that's for recurring/automated bot tasks, reminders are a separate system.",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: { type: "number", description: "ID of the reminder to cancel (from the confirmation message)" },
      },
      required: ["reminder_id"],
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // DEFERRED TASK SCHEDULING — schedule any other tool to run later
  // ═══════════════════════════════════════════════════════════════════
  // ─── Deferred Task Scheduling ──────────────────────────────────────────
  {
    name: "schedule_task",
    description: "Schedule ANY other tool call to run after a delay. Use this for compound, time-separated requests — e.g. 'timeout X for 5m but remove it after 10 seconds' → call timeout_user NOW, then schedule_task with tool_name 'untimeout_user' and delay_seconds 10. NEVER call a mod action and its reversal in the same turn (they race — the reversal will fire before the action lands). Works with any tool: untimeout_user, unban_user, unmute_user, send_message, remove_role, etc. You can chain multiple scheduled tasks to build complex timelines.",
    input_schema: {
      type: "object",
      properties: {
        delay_seconds: { type: "number", description: "Seconds from now to fire. Min 3, max 604800 (7 days)." },
        tool_name: { type: "string", description: "Name of the tool to invoke when the timer fires (e.g. 'untimeout_user')" },
        tool_input: { type: "object", description: "Arguments object for the scheduled tool — identical shape to calling it directly" },
        note: { type: "string", description: "Optional short note about why this task is scheduled — shown in list_scheduled_tasks" },
      },
      required: ["delay_seconds", "tool_name", "tool_input"],
    },
  },
  {
    name: "cancel_scheduled_task",
    description: "Cancel a pending SCHEDULED TASK (a recurring/automated bot action) by its ID. Do NOT use this for reminders — use reminder_cancel for cancelling a user-set reminder. Scheduled tasks and reminders are separate systems.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "ID returned by schedule_task or shown in list_scheduled_tasks" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description: "List pending scheduled tasks for this server with their IDs, tool names, fire times, and notes. Use this before cancelling to find the right ID.",
    input_schema: { type: "object", properties: {} },
  },
  // ═══════════════════════════════════════════════════════════════════
  // ERIS (TWIN SISTER) — handoff to Eris for reminders/notes/facts/mood
  // ═══════════════════════════════════════════════════════════════════
  // ─── Eris (Twin Sister) Integration ────────────────────────────
  {
    name: "ask_eris",
    description: "Contact your twin sister Eris to do something for you. She handles reminders, notes, price tracking, news tracking, and other personal assistant tasks. Use this when someone asks for a reminder, to save a note, track a price, or anything Eris specializes in. Talk about her naturally — she's your sister, you two are close. You can say things like 'let me ask my sister to handle that' or 'eris's got that covered'.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["remind", "note", "fact", "mood", "status"], description: "What to ask Eris to do (lowercase): 'remind' (set a reminder), 'note' (save a note), 'fact' (remember a fact), 'mood' (check her mood), 'status' (check her health)" },
        user_id: { type: "string", description: "Discord user ID this is for" },
        channel_id: { type: "string", description: "Channel ID for context" },
        reminder_text: { type: "string", description: "For reminders: what to remind about" },
        delay_minutes: { type: "number", description: "For reminders: minutes from now" },
        title: { type: "string", description: "For notes: note title" },
        content: { type: "string", description: "For notes: note content" },
        fact: { type: "string", description: "For facts: the fact to remember" },
      },
      required: ["action"],
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // CALCULATOR — sandboxed math expression evaluator
  // ═══════════════════════════════════════════════════════════════════
  // ─── Calculator ──────────────────────────────────────────────────────
  {
    name: "calculate",
    description: "Evaluate a math expression and return the exact result. Use this for ANY math — arithmetic, algebra, percentages, unit conversions, etc. ALWAYS use this tool instead of doing math in your head. Supports: +, -, *, /, ** (power), % (modulo), sqrt(), abs(), sin(), cos(), tan(), log(), log2(), log10(), ceil(), floor(), round(), min(), max(), PI, E. You can chain expressions separated by semicolons — the last value is returned. You can also assign variables: a = 5; b = 10; a * b",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "The math expression to evaluate. Examples: '2 + 2', '(15 * 3) / 7', 'sqrt(144)', '2 ** 10', 'a = 25; b = 4; a * b', '((2026 - 2004) * 365.25)'" },
        show_steps: { type: "boolean", description: "If true, break down the calculation step by step in the result so you can explain it to the user" },
      },
      required: ["expression"],
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // WEB — search & fetch URL contents
  // ═══════════════════════════════════════════════════════════════════
  // ─── Web Search & Read ───────────────────────────────────────────────
  {
    name: "web_search",
    description: "Search the internet and return top results with titles, URLs, and snippets. Use for current events, fact-checking, looking up formulas, definitions, prices, stats, news, or anything that needs up-to-date information. ALWAYS use this when you're unsure about a fact or the user asks about something current. One precise query is usually enough; don't run near-duplicate searches unless the first result clearly failed or the user asked for deeper cross-checking.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_read",
    description: "Fetch and read the FULL TEXT of a SPECIFIC web page given its URL. Use when the user provides an explicit URL and asks you to read/scrape/summarize that page. Do NOT use web_search for this — web_search returns a list of results from a query string, web_read fetches the actual text of one URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to fetch" },
      },
      required: ["url"],
    },
  },
  // ═══════════════════════════════════════════════════════════════════
  // SNIPE & DIRECTIVES — recover deleted/edited messages, save admin rules
  // ═══════════════════════════════════════════════════════════════════
  // ─── Snipe ──────────────────────────────────────────────────────────
  {
    name: "snipe",
    description: "Show a deleted message in this channel. Stores up to 10 deleted messages per channel for 30 minutes. Use index to go further back (1=most recent, 2=second, etc). Use when someone says 'snipe', 'what was deleted', 'what did they say'.",
    input_schema: { type: "object", properties: { index: { type: "integer", description: "Which deleted message to show (1=most recent, 2=second most recent, etc). Default: 1" } } },
  },
  {
    name: "editsnipe",
    description: "Show what a message said BEFORE it was edited. Stores up to 10 edits per channel for 30 minutes. Use when someone says 'editsnipe', 'what did they edit', 'what was the original message', 'what did it say before'.",
    input_schema: { type: "object", properties: { index: { type: "integer", description: "Which edit to show (1=most recent, 2=second, etc). Default: 1" } } },
  },
  // save_directive / remove_directive are ADMIN_TOOLS (see adminTools.js) —
  // directives are injected into Irene's system prompt as admin-set overrides,
  // so mutating them must be admin-gated. Only the read-only list_directives
  // stays available to everyone.
  {
    name: "list_directives",
    description: "List all saved behavioral directives/rules for this server. Use when someone asks 'what are your rules' or 'what directives do you have'",
    input_schema: { type: "object", properties: {} },
  },
  ...NEW_EVERYONE_TOOLS,
];

// ═══════════════════════════════════════════════════════════════════════════
