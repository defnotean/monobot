// ai/tools.js — All 46 AI tool declarations for Eris
// Anthropic schema format, ESM exports
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//   1. EVERYONE — Memory, directives, self-knowledge .......... ~line 19
//   2. EVERYONE — Media, web, memes, presence ................. ~line 102
//   3. EVERYONE — Notes, reminders, code helpers .............. ~line 275
//   4. EVERYONE — Mood, game tracking, channel config ......... ~line 417
//   5. EVERYONE — Economy core, gambling, mini-games .......... ~line 574
//   6. EVERYONE — Combat (heists/boss/duels), pets, territories ~line 991
//   7. EVERYONE — Income, banking, rewards, progression ....... ~line 1134
//   8. OWNER — System access, terminal, personality ........... ~line 1289
//   9. OWNER — Email, GitHub, deploy, database, host ops ...... ~line 1383
//  10. OWNER — Whitelist, trust, persona, twin delegation ..... ~line 1599
//  11. OWNER — Relationship & mood override (appended) ........ ~line 1734
//  12. Combined export + tool-registry wiring ................. ~line 1771
// ────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — MEMORY, DIRECTIVES, SELF-KNOWLEDGE
// remember_fact / forget_fact / forget_all / recall_memories — per-user facts
// save_directive / list_directives / remove_directive — server behavior rules
// ═══════════════════════════════════════════════════════════════════════════
export const EVERYONE_TOOLS = [
  {
    name: "remember_fact",
    tags: ["fun"],
    description:
      "Store a fact about a user for future reference. Use when someone shares personal info, preferences, or anything worth remembering. Set sensitivity based on how personal/vulnerable the info is: 'normal' for general facts (favorite game, timezone), 'sensitive' for personal things only they should know you remember (insecurities, crushes, personal struggles), 'secret' for things they explicitly trust you with or things that could embarrass/hurt them if revealed (deep confessions, 'you're my most prized possession', private feelings). Default to 'normal' — only escalate when the info genuinely warrants protection.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to associate the fact with" },
        fact: {
          type: "string",
          description: "The fact to remember, max 150 characters",
          maxLength: 150,
        },
        sensitivity: {
          type: "string",
          description: "How sensitive this info is: 'normal' (anyone can know), 'sensitive' (only mention to this user), 'secret' (never reveal to anyone, protect fiercely)",
        },
      },
      required: ["user_id", "fact"],
    },
  },
  {
    name: "forget_fact",
    description: "Forget/delete a specific memory about a user. Use when someone says 'forget that', 'delete that memory', 'remove what you know about X', or asks you to forget something specific. Searches by keyword match.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to search for in the memory to delete (keyword match)" },
      },
      required: ["search"],
    },
  },
  {
    name: "forget_all",
    description: "Forget ALL memories about a user — complete memory wipe. Use when someone says 'forget everything about me', 'clear my data', 'wipe my memories'. This is irreversible.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "recall_memories",
    description: "List all memories/facts stored about a user. Use when someone asks 'what do you know about me', 'what do you remember', 'list my facts'. Shows all stored facts with their sensitivity level.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_directive",
    description: "Save a behavioral rule/instruction that you will follow persistently. Use when an admin or boss tells you to do (or not do) something as a STANDING rule. Examples: 'dont reply in #announcements', 'be extra chaotic in #shitposting', 'always call user X by their nickname Y'. IMPORTANT: When someone gives you a standing instruction (not a one-time request), ALWAYS save it as a directive.",
    input_schema: {
      type: "object",
      properties: {
        directive: { type: "string", description: "The rule to follow, in clear language (max 300 chars)" },
        channel_name: { type: "string", description: "If this rule only applies to a specific channel, name it here. Leave empty for server-wide rules" },
      },
      required: ["directive"],
    },
  },
  {
    name: "list_directives",
    description: "List all saved behavioral directives/rules for this server",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_directive",
    description: "Remove a saved directive by keyword or index number",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search for in the directive text, OR the index number" },
      },
      required: ["keyword"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — MEDIA, WEB, MEMES & PRESENCE
  // GIFs, image analysis & search, meme template lookup + generation,
  // web search & URL scraping, and Discord presence / availability check.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "send_gif",
    tags: ["fun"],
    description:
      "Send a GIF in response to the conversation. Use when the vibe calls for a reaction GIF, someone asks for one, or a visual response would be funnier than text. Searches Tenor/Giphy by query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for the GIF (e.g. 'mind blown', 'sad cat')" },
        caption: { type: "string", description: "Optional text caption to send alongside the GIF" },
      },
      required: ["query"],
    },
  },
  {
    name: "analyze_image",
    description:
      "Analyze an image that was attached to the current message. Use when a user sends a picture and asks about it, wants it described, or you need to understand image content to respond properly.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to analyze or look for in the image (e.g. 'describe this', 'what programming language is this', 'roast this selfie')",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "search_images",
    description: "Search the internet for images and get direct image URLs. Use when you need to find a specific image to use as a meme background, reference image, or any visual. Returns direct image URLs you can use in create_meme's image_url field.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (e.g. 'compressed avatar meme template', 'fry not sure if meme blank')" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_meme_templates",
    tags: ["fun"],
    description: "Search for meme templates by keyword. You MUST call this BEFORE create_meme — ALWAYS search first, then create. This finds the right template name to use. If a user asks for a specific meme format (e.g. 'compressed avatar', 'drake', 'distracted boyfriend'), search for it here first to get the exact template name.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (e.g. 'surprised', 'sad', 'gaming', 'elden ring', 'thinking')" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_meme",
    tags: ["fun"],
    description:
      "Generate a unique, context-aware meme. You MUST think creatively about what would be genuinely funny and pick the perfect template. Use search_meme_templates first if you're not sure which template fits best or want to find something fresh. Match the template to the joke like a real meme lord would. Examples: 'drake' = preferring one thing over another, 'distracted-boyfriend' or 'db' = being tempted by something new, 'cmm' or 'change-my-mind' = hot takes, 'gru' = plan backfiring, 'fine' = this is fine/everything burning, 'stonks' = bad financial decisions, 'panik-kalm-panik' = panic-calm-panic cycle, 'fry' = not sure if X or Y, 'pigeon' = is this a X?, 'mordor' = one does not simply, 'slap' = batman slapping robin, 'drake' = yes/no preference, 'exit' = left exit 12 off ramp, 'buzz' = X everywhere, 'doge' = wow such X, 'harold' = hide the pain, 'rollsafe' = clever thinking, 'kombucha' = side-eyeing, 'leo' = pointing at screen, 'woman-cat' = woman yelling at cat, 'astronaut' = always has been, 'keanu' = breathtaking, 'spongebob' = mocking, 'michael-scott' = the office reactions, 'dwight' = false!, 'elmo' = elmo fire, 'kermit' = but that's none of my business, 'pooh' = fancy pooh, 'cheems' = sad cheems, 'khaby-lame' = obvious solution. If making a meme about a specific person, use their user_id to grab their avatar as the background. Full template list: aag, ackbar, afraid, agnes, aint-got-time, ams, ants, apcr, astronaut, atis, away, awesome, awesome-awkward, awkward, awkward-awesome, bad, badchoice, balloon, bd, because, bender, bihw, bilbo, biw, blb, boat, bongo, both, box, bs, bus, buzz, cake, captain, captain-america, cb, cbb, cbg, center, ch, chair, cheems, chosen, cmm, country, crazypills, crow, cryingfloor, db, dbg, dg, disastergirl, dodgson, doge, dragon, drake, drowning, drunk, ds, dsm, dwight, elf, elmo, ermg, exit, fa, facepalm, fbf, feelsgood, fetch, fine, firsttry, fmr, friends, fry, fwp, gandalf, gb, gears, genie, ggg, glasses, gone, grave, gru, grumpycat, hagrid, handshake, happening, harold, headaches, hipster, home, icanhas, imsorry, inigo, interesting, ive, iw, jd, jetpack, jim, joker, jw, keanu, kermit, khaby-lame, kk, kombucha, kramer, leo, light, live, ll, lrv, made, mb, michael-scott, midwit, millers, mini-keanu, mmm, money, mordor, morpheus, mouth, mw, nails, nice, noah, noidea, ntot, oag, officespace, older, oprah, panik-kalm-panik, patrick, perfection, persian, philosoraptor, pigeon, pooh, pool, ptj, puffin, red, regret, remembers, reveal, right, rollsafe, sad-biden, sad-boehner, sad-bush, sad-clinton, sad-obama, sadfrog, saltbae, same, sarcasticbear, say, sb, scc, seagull, sf, sk, ski, slap, snek, soa, sohappy, sohot, soup-nazi, sparta, spiderman, spirit, spongebob, ss, stew, stonks, stop, stop-it, success, tenguy, toohigh, touch, tried, trump, ugandanknuck, vince, wallet, waygd, wddth, whatyear, winter, wishes, wkh, woman-cat, wonka, worst, xy, yallgot, yodawg, yuno, zero-wing.",
    input_schema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Meme template name (e.g. 'drake', 'distracted-boyfriend', 'change-my-mind'). Pick the one that fits the joke best" },
        top_text: { type: "string", description: "Text for the top of the meme — this is the setup" },
        bottom_text: { type: "string", description: "Text for the bottom of the meme — this is the punchline" },
        image_url: { type: "string", description: "Custom background image URL. Use when someone wants a meme format not in the standard templates — web_search for the meme image, grab the URL, pass it here" },
        caption: { type: "string", description: "Optional message to send alongside the meme" },
      },
      required: ["top_text", "bottom_text"],
    },
  },
  {
    name: "web_search",
    tags: ["fun"],
    description:
      "Search the web for current information. Use when someone asks a question you don't know the answer to, needs up-to-date info, or wants to look something up (news, docs, trivia, etc.).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to look up on the web" },
      },
      required: ["query"],
    },
  },
  {
    name: "scrape_url",
    description:
      "Fetch and extract the text content of a web page. Use when someone shares a link and wants a summary or when you need to read a page's content to answer a question.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to scrape (must include protocol)" },
      },
      required: ["url"],
    },
  },
  {
    name: "check_presence",
    description:
      "Check whether a Discord user is currently online, idle, DnD, or offline. Use when someone asks if a person is around, or to check availability before pinging someone.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to check" },
        username: { type: "string", description: "Discord username to look up (if user_id is unknown)" },
      },
      required: [],
    },
  },
  {
    name: "save_self_fact",
    description:
      "Record a fact about YOURSELF (Eris) — your own identity, preferences, or personal canon. Use when you declare something about yourself that should stay consistent: 'my favorite color is teal', 'i drink my coffee black', 'i have a lucky number', 'im left handed'. These get injected into your system prompt on every turn so you never contradict your own identity. Different from save_my_take (which is stances on EXTERNAL topics) — this is who YOU are.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Short declarative fact about yourself. Max 160 chars." },
        category: { type: "string", description: "Optional: 'taste' (favorites/preferences), 'identity' (who you are), 'quirk' (habits), 'misc'." },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall_self_facts",
    description:
      "List facts you've stored about yourself. Use when asked 'what's your favorite X', 'tell me about yourself', or when you're about to make a self-declaration and want to check your prior canon.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional filter by category." },
      },
      required: [],
    },
  },
  {
    name: "forget_self_fact",
    description:
      "Delete one of your own stored self-facts by keyword match. Use when you realize a stored fact is wrong or outdated ('actually my favorite color isnt teal anymore').",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Keyword(s) to find the fact to forget." },
      },
      required: ["search"],
    },
  },
  {
    name: "save_my_take",
    description:
      "Record YOUR OWN stance/opinion on a topic so you stay consistent across future conversations. Use when you realize you're expressing a genuine opinion about something — a game, artist, food, concept, person, whatever. Next time the topic comes up, you'll be reminded of what you said before so you either hold the line or explicitly acknowledge changing your mind. Don't save weak takes ('idk it's fine') — only save actual stances you'd defend. Examples: you think valorant is better than league, you hate pineapple pizza, you loved the new arcane season, you're pro-serial-comma.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What the opinion is ABOUT (a short phrase: 'pineapple pizza', 'the new arcane season', 'serial comma'). Max 120 chars." },
        stance: { type: "string", description: "Your stance: 'positive' (you like/agree), 'negative' (you dislike/disagree), or 'neutral' (genuinely mixed)." },
        reason: { type: "string", description: "Optional short reason (max 200 chars) — 'because the visuals are insane', 'fruit doesnt belong on pizza'. Keep it in your voice." },
        strength: { type: "number", description: "How strongly you hold this, 0-1. 0.2 = mild preference, 0.8 = hill you'd die on. Default 0.5." },
      },
      required: ["topic", "stance"],
    },
  },
  {
    name: "recall_my_take",
    description:
      "Look up what YOU previously thought about a topic. Use when someone asks 'what do you think about X', 'whats ur take on X', or before expressing an opinion on something to check if you've already said something. Returns your stored stance, reason, and when you last said it. If the stance previously flipped, it tells you the prior stance too so you can acknowledge growth.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic keyword(s) to look up. Leave empty to list your most recent takes." },
      },
      required: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — NOTES, REMINDERS & CODE HELPERS
  // Per-user named notes (CRUD + search), timed reminders (set/list/cancel),
  // code review and saved code snippets (named scratchpad).
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "save_note",
    description:
      "Save a note with a title and content for later retrieval. Use when someone wants to jot something down, save a message, bookmark an idea, or store any text for future reference.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title or label for the note" },
        content: { type: "string", description: "The full note content to save" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notes",
    description:
      "List all saved notes. Use when someone wants to see what notes exist or browse their saved items.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_note",
    description:
      "Delete a saved note by its ID. Use when someone wants to remove a note they no longer need.",
    input_schema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "The unique ID of the note to delete" },
      },
      required: ["note_id"],
    },
  },
  {
    name: "search_notes",
    description:
      "Search through saved notes by keyword or phrase. Use when someone is looking for a specific note but doesn't know the exact title or ID.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to match against note titles and content" },
      },
      required: ["query"],
    },
  },
  {
    name: "set_reminder",
    description:
      "Set a timed reminder that will ping the user after a delay. Use when someone says 'remind me in...', wants a timer, or needs to be notified about something later.",
    input_schema: {
      type: "object",
      properties: {
        reminder_text: { type: "string", description: "What to remind the user about" },
        time: {
          type: "string",
          description: "How long from now to trigger the reminder, e.g. '30m', '2h', '1d'",
        },
      },
      required: ["reminder_text", "time"],
    },
  },
  {
    name: "list_reminders",
    description:
      "List all active (pending) reminders, optionally filtered to a specific user. Use when someone wants to see what reminders are set.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Filter reminders to this Discord user ID; omit for all" },
      },
      required: [],
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel a pending reminder by its ID. Use when someone no longer needs a reminder they set earlier.",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: { type: "string", description: "The unique ID of the reminder to cancel" },
      },
      required: ["reminder_id"],
    },
  },
  {
    name: "review_code",
    description:
      "Review a code snippet for bugs, style issues, and improvements. Use when someone pastes code and asks for feedback, a review, or help debugging.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The source code to review" },
        language: { type: "string", description: "Programming language of the code (e.g. 'javascript', 'python'); auto-detected if omitted" },
      },
      required: ["code"],
    },
  },
  {
    name: "save_snippet",
    description:
      "Save a named code snippet for later reuse. Use when someone wants to store a piece of code they might need again, like a utility function or config template.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short, unique name to identify the snippet" },
        code: { type: "string", description: "The source code to save" },
        language: { type: "string", description: "Programming language of the snippet" },
      },
      required: ["name", "code"],
    },
  },
  {
    name: "get_snippet",
    description:
      "Retrieve a previously saved code snippet by name. Use when someone asks to recall or paste a snippet they saved earlier.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the snippet to retrieve" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_snippets",
    description:
      "List all saved code snippets. Use when someone wants to see what snippets are available.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — MOOD, GAME TRACKING, KARAOKE, CHANNEL CONFIG, PRICES
  // get_mood / get_relationship — introspection
  // track_game / untrack_game / list_game_watches — Steam patch-note watcher
  // start_karaoke / stop_karaoke — synced lyrics in nickname (Irene only)
  // set_event_channels / set_chat_channels / test_fire_event — server config
  // watch_price / check_prices / unwatch_price — product price monitoring
  // ═══════════════════════════════════════════════════════════════════════════
  // ─── REFERENCE TOOL ─── This is a canonical example. New contributors: copy this pattern when adding a tool. See packages/eris/ai/executors/miscExecutor.js:63 for the matching handler and packages/eris/tests/ai/getMoodTool.test.ts:1 for the spec. ───
  {
    name: "get_mood",
    tags: ["fun"],
    description:
      "Check Irene's current mood/attitude level. Use for introspection when someone asks how you're feeling or to calibrate your sass level.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_relationship",
    tags: ["fun"],
    description:
      "Check the relationship status and history with a specific user or the server in general. Use to recall how you feel about someone or review past interactions.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to check relationship with; omit for general server vibe" },
      },
      required: [],
    },
  },
  {
    name: "track_game",
    description:
      "Start auto-tracking patch notes and update announcements for a game. Searches Steam for the game, then posts new updates automatically to this channel every time one drops. Use when someone says 'track updates for X', 'watch for X patches', 'notify me when X gets updated'. Requires Manage Server permission.",
    input_schema: {
      type: "object",
      properties: {
        game_name: { type: "string", description: "Name of the game to track on Steam" },
        rss_url:   { type: "string", description: "Optional: custom RSS feed URL for non-Steam games" },
      },
      required: ["game_name"],
    },
  },
  {
    name: "untrack_game",
    description:
      "Stop tracking game updates for a specific watch. Use when someone says 'stop tracking X', 'remove game watch', 'unwatch X'. Call list_game_watches first if you need the watch ID.",
    input_schema: {
      type: "object",
      properties: {
        watch_id: { type: "string", description: "The watch ID to remove (get it from list_game_watches)" },
      },
      required: ["watch_id"],
    },
  },
  {
    name: "list_game_watches",
    description:
      "Show all active game update watches for this server. Use when someone asks 'what games are being tracked', 'show game watches', 'list tracked games'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "start_karaoke",
    description:
      "Start a karaoke session — your nickname will display synced song lyrics line-by-line. Use when someone says 'sing X', 'karaoke X', 'start karaoke for X'. Lyrics fetched from LRCLIB. Irene-only feature.",
    input_schema: {
      type: "object",
      properties: {
        song:   { type: "string", description: "Song title" },
        artist: { type: "string", description: "Artist name" },
      },
      required: ["song", "artist"],
    },
  },
  {
    name: "stop_karaoke",
    description:
      "Stop the current karaoke session and restore your normal nickname. Use when someone says 'stop karaoke', 'stop singing', 'shut up'. Irene-only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_event_channels",
    description: "Manage which channels server events (coin rain, chaos storm, lucky hour, pirate raid, etc.) are allowed or blocked from firing in. Supports both a whitelist ('only fire in these') and a denylist ('never fire in these'). ALWAYS call this tool — do NOT use save_directive for channel-restriction asks, the event scheduler only reads from this tool's settings. Actions: 'list' shows both whitelist + denylist. 'set'/'add'/'remove'/'clear' manage the whitelist — use when someone says 'only spawn events in X', 'events should only fire in #casino', 'restrict events to these channels', 'allow events in X'. 'deny'/'undeny'/'clear_denied' manage the denylist — use when someone says 'don't fire events in #general', 'no events in this channel', 'stop spawning events here', 'block events from #serious', 'never send events to #rules'. Denylist applies even when no whitelist is set. The 'list' action is safe for anyone; mutations require Manage Channels or trusted-user status.",
    input_schema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channel names or IDs (e.g. ['eris-shenanigans', 'bot-commands']). Optional for 'list', 'clear', and 'clear_denied'.",
        },
        action: { type: "string", enum: ["set", "add", "remove", "clear", "list", "deny", "undeny", "clear_denied"], description: "Whitelist: 'set' replaces, 'add'/'remove' modify, 'clear' removes the whitelist. Denylist: 'deny' adds channels to the block list, 'undeny' removes them, 'clear_denied' wipes the denylist. 'list' shows both lists." },
      },
    },
  },
  {
    name: "set_chat_channels",
    description: "Manage which channels you (Eris) stay quiet in. Use action:'list' to answer 'where are you muted?', 'what channels don't you talk in?', 'show me the chat config'. Use 'mute'/'unmute'/'clear' when someone says 'don't chat in #X', 'stop responding in these channels', 'you can talk here again', 'only respond to pings in #announcements'. Muted channels mean you won't react to name triggers — direct @mentions still get a reply. The 'list' action is safe for anyone; mutations require Manage Channels or trusted-user status.",
    input_schema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channel names or IDs. Optional for 'list' and 'clear'.",
        },
        action: { type: "string", enum: ["list", "mute", "unmute", "set", "clear"], description: "'list' shows muted channels, 'mute'/'unmute' modify the list, 'set' replaces it, 'clear' removes all mutes" },
      },
    },
  },
  {
    name: "test_fire_event",
    description: "Fire a random server event right now for testing. Use when the owner says 'test an event', 'fire an event', 'trigger a random event'. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        event_name: { type: "string", description: "Specific event to fire (e.g. 'coin_rain', 'lucky_hour'). Leave empty for random." },
      },
    },
  },
  {
    name: "watch_price",
    description:
      "Monitor a product's price at a URL and optionally alert when it drops below a target. Use when someone wants to track a deal, watch for a sale, or get notified about price changes.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the product page to monitor" },
        product_name: { type: "string", description: "Human-readable name for the product being watched" },
        target_price: { type: "number", description: "Alert when the price drops to or below this amount; omit to just track changes" },
      },
      required: ["url", "product_name"],
    },
  },
  {
    name: "check_prices",
    description:
      "Check the current status of all watched product prices. Use when someone wants to see how their tracked prices are doing.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "unwatch_price",
    description:
      "Stop watching a product's price by its watch ID. Use when someone no longer cares about a price they were tracking.",
    input_schema: {
      type: "object",
      properties: {
        watch_id: { type: "string", description: "The unique ID of the price watch to remove" },
      },
      required: ["watch_id"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — ECONOMY CORE, GAMBLING, MINI-GAMES & EXPANSION
  // The big sub-block: balance/daily, all gambling games (coinflip, dice,
  // slots, blackjack, roulette, poker, rob), stocks, lottery, leaderboards,
  // chaos & fun (fortune, duels, confessions, curses), mini-games (trivia,
  // scramble, RPS, number guess), and economy expansion (shop, loans,
  // bounties, daily challenges, achievements).
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Economy & Gambling ──────────────────────────────────────────────────

  {
    name: "check_balance",
    description: "Check a user's coin balance and economy stats. Use when someone asks 'how much money do I have', 'check my balance', 'how many coins', or asks about another user's wealth.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to check balance for. Omit to check the message author's balance." },
      },
    },
  },
  {
    name: "daily_reward",
    description: "Claim the daily free coin reward with streak bonuses. Use when someone says 'daily', 'claim', 'gimme coins', 'free coins', or asks for their daily reward. Has a ~20h cooldown with increasing streak bonuses.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "coinflip_bet",
    description: "Bet coins on a coin flip — heads or tails. Use when someone wants to gamble, flip a coin with stakes, or says 'bet X on heads/tails'. 50/50 odds, double or nothing.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount of coins to bet" },
        choice: { type: "string", description: "heads or tails" },
      },
      required: ["amount", "choice"],
    },
  },
  {
    name: "dice_roll_bet",
    description: "Bet coins on a dice roll — guess the number 1-6 for a 5x payout. Use when someone wants to roll dice for money or gamble on a number.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount of coins to bet" },
        guess: { type: "number", description: "Number to guess (1-6)" },
      },
      required: ["amount", "guess"],
    },
  },
  {
    name: "slots_spin",
    description: "Spin the slot machine for coins. Use when someone wants to play slots, spin, try their luck on the machine, or pull the lever. Various payouts from 2x to 50x jackpot.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount of coins to bet" },
      },
      required: ["amount"],
    },
  },
  {
    name: "blackjack_start",
    description: "Start a game of blackjack (21). Use when someone wants to play blackjack, 21, or hit me. Deals initial cards.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount of coins to bet" },
      },
      required: ["amount"],
    },
  },
  {
    name: "blackjack_action",
    description: "Take an action in an active blackjack game — hit, stand, or double down. Use when someone says 'hit', 'hit me', 'stand', 'stay', or 'double' during a blackjack game.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "hit, stand, or double" },
      },
      required: ["action"],
    },
  },
  {
    name: "rob_user",
    description: "Attempt to rob coins from another user. Risky — 40% chance of success, and if you fail you lose coins instead. Use when someone says 'rob', 'steal from', 'mug', or 'yoink' another user's coins. Has a 1-hour cooldown.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Username or mention of the user to rob" },
      },
      required: ["target"],
    },
  },
  {
    name: "start_poker",
    description: "Start a multiplayer poker table in the current channel. Everyone antes in, then 5 community cards + 2 hole cards each, best hand wins. Lobby stays open for 60s. Use when someone says 'start poker', 'poker table', 'deal me in', etc.",
    input_schema: {
      type: "object",
      properties: {
        ante: { type: "number", description: "Coins each player antes in (default 100, min 10, max 100000)" },
      },
    },
  },
  {
    name: "join_poker",
    description: "Join the active poker table in this channel (equivalent to clicking the Join button). Deducts the ante from balance atomically.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "stock_market",
    description: "Show the stock market — all tickers with current prices and 24h change, plus the user's portfolio and total value. Use when someone asks 'show me the stocks', 'check my portfolio', 'how are stocks doing', 'market view', etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "stock_buy",
    description: "Buy shares of a fictional stock ticker. Tickers: MEME, GOLD, ERIS, CHAOS, BUMP, PETZ, FISH, MOON, BANK, LOOT. Whole shares only. Cost = price × shares. Use when someone says 'buy 5 MEME', 'yolo into MOON', 'invest in GOLD', etc.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol (e.g. MEME, GOLD, CHAOS)" },
        shares: { type: "number", description: "Number of shares to buy (whole shares only)" },
      },
      required: ["symbol", "shares"],
    },
  },
  {
    name: "stock_sell",
    description: "Sell shares of a fictional stock ticker. Returns the current price × shares in coins. Use when someone says 'sell 3 GOLD', 'dump my MEME', 'liquidate', 'cash out'.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol" },
        shares: { type: "number", description: "Number of shares to sell" },
      },
      required: ["symbol", "shares"],
    },
  },
  {
    name: "toggle_cross_bot_punish",
    description: "Toggle whether Irene-issued bans and kicks in THIS server trigger Eris to zero the user's coin balance. Off by default. Admin-only. Use when someone says 'make bans cost coins', 'zero balance on ban', 'link moderation to economy', etc.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true to enable, false to disable, omit to toggle" },
      },
    },
  },
  {
    name: "list_roles_by_category",
    description: "List all server roles that match a given category, based on their ACTUAL Discord permissions (not role names). Use this when someone asks vague things like 'who are the mods here', 'who's staff', 'ping all admins', etc — you'll get only the roles that actually carry that power, ignoring cosmetic roles that just happen to be named similar things (someone's pink 'Moderator' vanity role won't leak in). Categories: 'admin' (Administrator or ManageGuild), 'moderator' (Ban/Kick/Timeout/ManageRoles/ManageChannels), 'helper' (ManageMessages/MuteMembers/ViewAuditLog etc.), 'bot' (integration roles), 'everyone' (@everyone), 'cosmetic' (no dangerous perms). Meta-categories: 'staff' (admin + moderator), 'trusted' (admin + moderator + helper).",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "One of: admin, moderator, helper, bot, everyone, cosmetic, staff, trusted.",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "open_all_lootboxes",
    description: "Batch-open multiple loot boxes in one go. Saves the user from calling open_lootbox repeatedly. Caps at 50 per call. Use when someone says 'open all my boxes', 'open all loot boxes', 'open 10 boxes', etc.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many to open (default: all of them, max 50)" },
      },
    },
  },
  {
    name: "buy_lottery_ticket",
    description: "Buy lottery tickets (100 coins each). All servers share one daily pot that draws every 24h. More tickets = better odds. Use when someone says 'buy N lottery ticket(s)', 'enter lottery', 'yolo lottery', etc.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of tickets (1-100, default 1)" },
      },
    },
  },
  {
    name: "lottery_status",
    description: "Show current jackpot, time to next draw, your ticket count, and recent winners. Use when someone asks about the lottery, jackpot size, or next draw.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "coin_leaderboard",
    description: "Show a server leaderboard. Accepts an optional axis for ranking by different stats. Use when someone asks 'richest', 'biggest gambler', 'longest streak', 'top prestige', 'best thief' (robs), 'biggest loser' (total lost), etc.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of users to show (default 10, max 20)" },
        axis: {
          type: "string",
          description: "Ranking axis. balance = wealth (default), earned = total earned, gambled = total wagered, streak = daily streak, prestige = prestige level, stolen = total robbed, lost = total lost to gambling/theft.",
          enum: ["balance", "earned", "gambled", "streak", "prestige", "stolen", "lost"],
        },
      },
    },
  },

  // ─── Chaos & Fun ─────────────────────────────────────────────────────────

  {
    name: "fortune_tell",
    description: "Tell someone's fortune or answer a yes/no question like a magic 8-ball. Use when someone asks 'will I...', 'should I...', 'is it...', 'tell my fortune', 'predict', 'magic 8 ball', or any future prediction question.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer (optional)" },
      },
    },
  },
  {
    name: "start_duel",
    description: "Challenge another user to a duel with optional coin stakes. The challenged user must accept. Use when someone says 'duel', 'fight', 'challenge', '1v1', or 'versus' another user.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Username or mention of user to challenge" },
        stake: { type: "number", description: "Coins to wager (both players must have this amount)" },
      },
      required: ["target"],
    },
  },
  {
    name: "accept_duel",
    description: "Accept a pending duel challenge in this channel. Use when someone says 'accept', 'i accept', 'bring it', 'let's go', or agrees to a duel challenge directed at them.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "submit_confession",
    description: "Submit an anonymous confession that Eris will post without revealing who wrote it. Use when someone says 'confess', 'confession', 'I need to confess', or wants to say something anonymously.",
    input_schema: {
      type: "object",
      properties: {
        confession: { type: "string", description: "The anonymous confession text" },
      },
      required: ["confession"],
    },
  },
  {
    name: "apply_curse",
    description: "Apply a random funny cursed effect to a user — changes their nickname to something hilarious for 10 minutes. Use when someone says 'curse them', 'hex', or when chaos demands it. Requires Manage Nicknames permission.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Username or mention of user to curse" },
      },
      required: ["target"],
    },
  },

  {
    name: "remove_curse",
    description: "Remove an active curse from a user — restores their original nickname early. Use when someone says 'remove curse', 'uncurse', or when the boss tells you to. You CAN remove curses now.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Username or mention of user to uncurse" },
      },
      required: ["target"],
    },
  },

  // ─── Mini-Games ──────────────────────────────────────────────────────────

  {
    name: "trivia_start",
    description: "Start a trivia question with optional category and coin stakes. Use when someone says 'trivia', 'quiz me', 'ask me a question', 'test my knowledge'. Categories: general, science, gaming, anime, movies, history, music, sports, geography, computers.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category: general, science, gaming, anime, movies, history, music, sports, geography, computers" },
        difficulty: { type: "string", description: "easy, medium, or hard" },
        stake: { type: "number", description: "Coins to wager on getting it right" },
      },
    },
  },
  {
    name: "trivia_answer",
    description: "Answer an active trivia question. Use when someone says A, B, C, or D (or the full answer text) in response to a trivia question.",
    input_schema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer: A, B, C, or D" },
      },
      required: ["answer"],
    },
  },
  {
    name: "rps_play",
    description: "Play rock paper scissors with optional coin stakes. Use when someone says 'rock paper scissors', 'rps', 'rock', 'paper', or 'scissors' as a game challenge.",
    input_schema: {
      type: "object",
      properties: {
        choice: { type: "string", description: "rock, paper, or scissors" },
        stake: { type: "number", description: "Optional coins to wager" },
      },
      required: ["choice"],
    },
  },
  {
    name: "word_scramble_start",
    description: "Start a word scramble game — unscramble the letters to find the word. Use when someone says 'word scramble', 'unscramble', 'scramble', or wants a word game.",
    input_schema: {
      type: "object",
      properties: {
        stake: { type: "number", description: "Optional coins to wager" },
      },
    },
  },
  {
    name: "word_scramble_guess",
    description: "Guess the scrambled word in an active word scramble game. Use when someone gives a guess during a word scramble.",
    input_schema: {
      type: "object",
      properties: {
        guess: { type: "string", description: "The guessed word" },
      },
      required: ["guess"],
    },
  },
  {
    name: "number_guess_start",
    description: "Start a number guessing game — guess the secret number with hints (higher/lower). Use when someone says 'number game', 'guess the number', or wants to play a guessing game.",
    input_schema: {
      type: "object",
      properties: {
        stake: { type: "number", description: "Optional coins to wager" },
        max_number: { type: "number", description: "Maximum number range (default 100)" },
      },
    },
  },
  {
    name: "number_guess_attempt",
    description: "Make a guess in the number guessing game. Use when someone gives a number as a guess during an active number game.",
    input_schema: {
      type: "object",
      properties: {
        guess: { type: "number", description: "The number to guess" },
      },
      required: ["guess"],
    },
  },
  {
    name: "russian_roulette",
    description: "Play russian roulette with coin stakes. 1 in 6 chance of losing your bet. If you survive, you win half your stake. Use when someone says 'russian roulette', 'roulette', or wants to test their luck against fate.",
    input_schema: {
      type: "object",
      properties: {
        stake: { type: "number", description: "Coins to risk" },
      },
      required: ["stake"],
    },
  },

  // ─── Economy Expansion ───────────────────────────────────────────────

  {
    name: "shop_browse",
    description: "Browse the shop to see items available for purchase with coins. Use when someone says 'shop', 'store', 'what can I buy', 'browse items'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "shop_buy",
    description: "Buy an item from the shop with coins. Use when someone says 'buy X', 'purchase', 'I want to buy'.",
    input_schema: { type: "object", properties: { item: { type: "string", description: "Name of the item to buy" } }, required: ["item"] },
  },
  {
    name: "inventory_check",
    description: "Check what items a user owns. Use when someone says 'inventory', 'my items', 'what do I have'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "loan_request",
    description: "Borrow coins from Eris at 20% interest, 24h to repay. Use when someone says 'loan', 'borrow', 'lend me coins', 'I need money'.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Amount to borrow (50-2000)" } }, required: ["amount"] },
  },
  {
    name: "loan_status",
    description: "Check outstanding loan balance and deadline. Use when someone asks about their loan, debt, or how much they owe.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "loan_repay",
    description: "Pay back a loan in full. Use when someone says 'repay', 'pay back', 'pay my loan'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "place_bounty",
    description: "Put a coin bounty on another user. Anyone who beats them in a duel collects it. Use when someone says 'bounty on X', 'put a price on their head'.",
    input_schema: { type: "object", properties: { target: { type: "string", description: "Username to place bounty on" }, amount: { type: "number", description: "Bounty amount in coins (min 50)" } }, required: ["target", "amount"] },
  },
  {
    name: "bounty_board",
    description: "View all active bounties in the server. Use when someone says 'bounty board', 'bounties', 'who has a price on their head'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "daily_challenge_check",
    description: "See today's daily challenge and progress. Use when someone says 'challenge', 'daily challenge', 'what's the challenge today'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "daily_challenge_complete",
    description: "Claim the daily challenge reward after completing it. Use when someone says 'claim challenge', 'I did the challenge', 'challenge complete'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "achievements_list",
    description: "View unlocked and locked achievements. Use when someone says 'achievements', 'my achievements', 'what achievements do I have', 'badges'.",
    input_schema: { type: "object", properties: {} },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — COMBAT, PETS, TERRITORIES & SOCIAL CHAOS
  // Group activities: heists (3+ participants), boss battles (server-wide HP),
  // territory claims (passive income per channel), pet adoption / care, and
  // social chaos (roast battles, hot takes) plus per-server feature toggles.
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Heists ──────────────────────────────────────────────────────────

  {
    name: "heist_start",
    description: "Organize a heist targeting the richest user. Need 3+ participants. Use when someone says 'heist', 'organize a heist', 'lets rob someone together'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "heist_join",
    description: "Join an active heist in recruiting phase. Use when someone says 'join heist', 'im in', 'count me in for the heist'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "heist_execute",
    description: "Execute the heist once enough people have joined (3+). Use when someone says 'execute heist', 'go', 'do the heist', 'lets go'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Boss Battles ────────────────────────────────────────────────────

  {
    name: "boss_spawn",
    description: "Spawn a server-wide boss battle. Everyone can contribute damage. Use when someone says 'spawn boss', 'boss battle', 'boss fight', 'summon a boss'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "boss_attack",
    description: "Attack the active boss. Costs 10 coins per attack. Use when someone says 'attack boss', 'hit the boss', 'fight boss'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "boss_status",
    description: "Check the current boss battle status (HP, phase, participants). Use when someone asks 'boss status', 'how much hp left', 'boss health'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Territories ─────────────────────────────────────────────────────

  {
    name: "territory_claim",
    description: "Claim this channel as your territory for passive coin income. Costs 500 coins. Use when someone says 'claim this channel', 'claim territory', 'this is mine'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "territory_map",
    description: "View all claimed territories in the server. Use when someone says 'territory map', 'who owns what', 'territories'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "territory_collect",
    description: "Collect passive income from your territory. Use when someone says 'collect income', 'collect territory', 'get my money'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Pets ────────────────────────────────────────────────────────────

  {
    name: "pet_adopt",
    description: "Adopt a random pet for 200 coins. Each pet has unique bonuses. Use when someone says 'adopt pet', 'get a pet', 'I want a pet'.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Name for your new pet" } }, required: ["name"] },
  },
  {
    name: "pet_feed",
    description: "Feed your pet to restore hunger and mood. Costs 25 coins. Use when someone says 'feed pet', 'feed my pet'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pet_status",
    description: "Check your pet's stats, hunger, mood, and level. Use when someone says 'pet status', 'how is my pet', 'pet info', 'my pet'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pet_rename",
    description: "Rename your pet. Use when someone says 'rename pet', 'change pet name'.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "New name for the pet" } }, required: ["name"] },
  },

  // ─── Social Chaos ────────────────────────────────────────────────────

  {
    name: "roast_challenge",
    description: "Challenge someone to a roast battle. Eris roasts both players, chat votes who got cooked harder. Use when someone says 'roast battle', 'roast X', '1v1 roast'.",
    input_schema: { type: "object", properties: { target: { type: "string", description: "Username to challenge" } }, required: ["target"] },
  },
  {
    name: "hot_take",
    description: "Generate a spicy hot take. Use when someone says 'hot take', 'give me a take', 'controversial opinion', 'unpopular opinion'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Feature Configuration ───────────────────────────────────────────

  {
    name: "configure_feature",
    description: "Configure a feature for this server — enable/disable features, set notification channels, set ping roles. Use when someone says 'set gambling channel', 'disable economy', 'set ping role for events', 'configure boss battles', 'turn off stocks'. Available features: economy, gambling, events, confessions, boss_battles, stocks, heists, territories, pets, daily_challenges, achievements, loans.",
    input_schema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature to configure: economy, gambling, events, confessions, boss_battles, stocks, heists, territories, pets, daily_challenges, achievements, loans" },
        enabled: { type: "boolean", description: "Enable or disable this feature for this server" },
        channel: { type: "string", description: "Channel name to send notifications/announcements for this feature" },
        ping_roles: { type: "string", description: "Role(s) to ping for this feature's announcements. Comma-separated for multiple." },
      },
      required: ["feature"],
    },
  },
  {
    name: "list_features",
    description: "List all feature configurations for this server — shows which features are enabled, their channels, and ping roles. Use when someone says 'list features', 'show settings', 'what's configured', 'feature status'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "toggle_twin_chat",
    description: "Enable or disable twin sister chat (Eris and Irene talking to each other) in this server. Use when someone says 'disable twin chat', 'stop the twins talking', 'enable twin chat', 'let them talk again'.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "true to enable, false to disable" } }, required: ["enabled"] },
  },
  {
    name: "configure_bump_reminder",
    description: "Configure which roles get pinged 2 hours after a DISBOARD bump, so the server knows it's time to bump again. Use when someone asks you to set up the bump reminder, add/remove roles from it, or check what's configured. Requires Manage Server permission. Actions: 'add' (add role_ids to ping list), 'remove' (remove role_ids), 'list' (show current roles), 'clear' (remove all roles). Extract role IDs from @role mentions in the message — they appear as <@&ROLEID> in Discord.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What to do: 'add', 'remove', 'list', or 'clear'",
        },
        role_ids: {
          type: "array",
          items: { type: "string" },
          description: "Discord role IDs to add or remove (extract from <@&ROLEID> mentions). Leave empty for 'list' and 'clear'.",
        },
      },
      required: ["action"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVERYONE TOOLS — INCOME, BANKING, REWARDS, GAMES, PROGRESSION, MARRIAGE
  // The grind half: fish/hunt/dig/work/beg/search income tools, weekly/monthly
  // rewards, bank deposit/withdraw/info, give_coins transfer (taxed), scratch
  // cards / lootboxes / adventures, prestige & multipliers, marriage flow,
  // crafting/trading, pet battles & training, and consumable item activation.
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Income & Activity Tools ───────────────────────────────────────────────
  {
    name: "fish",
    description: "Go fishing! Catch fish from common to mythic rarity for coins. 30s cooldown. Fishing Rod from shop boosts rare catches. Use when someone says 'fish', 'go fishing', 'cast a line'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hunt",
    description: "Go hunting! Encounter animals from squirrels to phoenixes for coins. 45s cooldown. Hunting Rifle from shop boosts rare finds. Use when someone says 'hunt', 'go hunting'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "dig",
    description: "Dig for treasure! Find items from rusty nails to ancient artifacts. 30s cooldown. Metal Detector from shop boosts rare finds. Use when someone says 'dig', 'treasure hunt', 'excavate'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "work",
    description: "Work a random job for coins (50-200). 30min cooldown. Use when someone says 'work', 'get a job', 'earn money'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "beg",
    description: "Beg for coins. Small random amount, sometimes negative. 30s cooldown. Use when someone says 'beg', 'spare some change', 'panhandle'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_location",
    description: "Search a random location for coins and items. 20s cooldown. Use when someone says 'search', 'scavenge', 'look around', 'explore'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Reward Tools ──────────────────────────────────────────────────────────
  {
    name: "weekly_reward",
    description: "Claim weekly reward (500+ coins, streak bonus). 7-day cooldown. Use when someone says 'weekly', 'claim weekly'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "monthly_reward",
    description: "Claim monthly reward (5000+ coins, streak bonus). 30-day cooldown. Use when someone says 'monthly', 'claim monthly'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Banking Tools ─────────────────────────────────────────────────────────
  {
    name: "bank_deposit",
    description: "Deposit coins into bank (protected from robbery). Capacity increases with prestige. Use when someone says 'deposit', 'bank deposit', 'save coins'.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Amount to deposit" } }, required: ["amount"] },
  },
  {
    name: "bank_withdraw",
    description: "Withdraw coins from bank to wallet. Use when someone says 'withdraw', 'bank withdraw', 'take out coins'.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Amount to withdraw" } }, required: ["amount"] },
  },
  {
    name: "bank_info",
    description: "View bank balance, capacity, interest earned. 1% daily interest on bank deposits. Use when someone says 'bank', 'bank info', 'bank balance'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Transfer Tool ─────────────────────────────────────────────────────────
  {
    name: "give_coins",
    description: "Send coins to another user (5% tax, minimum 10). Use when someone says 'give coins', 'send money', 'pay someone', 'transfer coins'.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID of recipient" }, amount: { type: "number", description: "Amount to send" } }, required: ["user_id", "amount"] },
  },
  // ─── New Games ─────────────────────────────────────────────────────────────
  {
    name: "scratch_card",
    description: "Buy a scratch card (50/100/250 coin tiers). 3x3 grid, match 3 symbols in a line to win 2x-50x payout. Use when someone says 'scratch card', 'scratch', 'scratch off'.",
    input_schema: { type: "object", properties: { tier: { type: "number", description: "Card cost: 50, 100, or 250" } }, required: ["tier"] },
  },
  {
    name: "open_lootbox",
    description: "Open a loot box from your inventory. Contains random coins or items. Buy loot boxes from the shop. Use when someone says 'open lootbox', 'open loot box', 'lootbox'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "adventure_start",
    description: "Start a multi-choice text adventure with branching paths and rewards. Use when someone says 'adventure', 'quest', 'start adventure', 'go on an adventure'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "adventure_choice",
    description: "Make a choice in your current adventure. Use when someone responds to an adventure prompt with their choice.",
    input_schema: { type: "object", properties: { choice: { type: "string", description: "The choice to make" } }, required: ["choice"] },
  },
  // ─── Progression Tools ─────────────────────────────────────────────────────
  {
    name: "prestige",
    description: "Reset your balance for a permanent +10% earnings multiplier. Cost: 5000 × (current_level + 1). Use when someone says 'prestige', 'reset for prestige'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "multiplier_check",
    description: "View all active earnings multipliers (prestige, marriage, items, streaks). Use when someone says 'multiplier', 'my boosts', 'earnings bonus'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Marriage Tools ────────────────────────────────────────────────────────
  {
    name: "marry",
    description: "Propose to a user (costs 500 coins each, needs Wedding Ring). Married couples get +10% coin earnings. Use when someone says 'marry', 'propose', 'get married'.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to marry" } }, required: ["user_id"] },
  },
  {
    name: "divorce",
    description: "End your marriage (1000 coin alimony, partner gets 500). Use when someone says 'divorce', 'end marriage'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "partner_status",
    description: "Check your marriage status and how long you've been together. Use when someone says 'partner', 'marriage status', 'who am I married to'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Crafting Tools ────────────────────────────────────────────────────────
  {
    name: "craft_item",
    description: "Combine items from your inventory using recipes. Ingredients are NOT consumed on failure. Use when someone says 'craft', 'combine items', 'forge'.",
    input_schema: { type: "object", properties: { recipe: { type: "string", description: "Name of the item to craft" } }, required: ["recipe"] },
  },
  {
    name: "craft_recipes",
    description: "View discovered and undiscovered crafting recipes. Use when someone says 'recipes', 'crafting recipes', 'what can I craft'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "trade_offer",
    description: "Offer a trade to another user — items and/or coins. Use when someone says 'trade', 'swap items', 'offer trade'.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to trade with" }, offer_item: { type: "string", description: "Item to offer (optional)" }, want_item: { type: "string", description: "Item you want (optional)" }, offer_coins: { type: "number", description: "Coins to offer (optional)" }, want_coins: { type: "number", description: "Coins you want (optional)" } }, required: ["user_id"] },
  },
  // ─── Pet Battle Tools ──────────────────────────────────────────────────────
  {
    name: "pet_battle",
    description: "Battle your pet against another user's pet (3 rounds, speed determines turn order). Pets gain XP. Use when someone says 'pet battle', 'pet fight', 'challenge their pet'.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to battle" } }, required: ["user_id"] },
  },
  {
    name: "pet_train",
    description: "Train your pet's attack, defense, or speed (+1-3). Costs 100 coins, 1hr cooldown. Use when someone says 'train pet', 'pet train', 'level up pet'.",
    input_schema: { type: "object", properties: { stat: { type: "string", description: "Stat to train: attack, defense, or speed" } }, required: ["stat"] },
  },
  // ─── Item Usage ────────────────────────────────────────────────────────────
  {
    name: "use_item",
    description: "Activate a consumable item from your inventory (Lucky Charm, Rob Shield, Life Saver, Double Daily, XP Boost, Mystery Box, etc). Use when someone says 'use item', 'activate', 'consume'.",
    input_schema: { type: "object", properties: { item: { type: "string", description: "Name of the item to use" } }, required: ["item"] },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — SYSTEM ACCESS, TERMINAL, PERSONALITY & GAME RIGGING
// Owner-only (defnotean) machine-level tools: shell exec, local exec with
// audit description, live personality update, full game/slot odds rigging,
// minion management.
// ═══════════════════════════════════════════════════════════════════════════
export const OWNER_TOOLS = [
  {
    name: "execute_terminal",
    description:
      "Execute a shell command on the host machine and return stdout/stderr. Owner-only. Use when defnotean asks to run a command, check something on the server, or perform a system task.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute (e.g. 'ls -la', 'docker ps')" },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_local",
    description:
      "Execute a local system command with an optional description for audit logging. Owner-only. Similar to execute_terminal but intended for scripted/automated tasks with traceability.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run locally on the host" },
        description: { type: "string", description: "Optional human-readable description of what this command does, for logging" },
      },
      required: ["command"],
    },
  },
  {
    name: "update_personality",
    description:
      "Update Irene's personality or system prompt instructions on the fly. Owner-only. Use when defnotean wants to tweak behavior, tone, rules, or add new personality traits.",
    input_schema: {
      type: "object",
      properties: {
        new_instructions: { type: "string", description: "The new or updated personality/system instructions to apply" },
      },
      required: ["new_instructions"],
    },
  },
  {
    name: "configure_game",
    description: "Full control over ANY game's odds, payouts, and behavior. You can tweak coinflip odds, dice payouts, blackjack rules, roulette death chance, RPS bias, and more. List all settings with action='list'. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        game: { type: "string", description: "Game to configure: coinflip, dice, blackjack, roulette, rps, trivia, global, or 'all' to list everything" },
        setting: { type: "string", description: "Setting to change (e.g. baseOdds, payout, deathChance, botBias)" },
        value: { description: "New value for the setting" },
        action: { type: "string", description: "list, set, or reset" },
      },
    },
  },
  {
    name: "minion_status",
    description: "Check your minions — see workers, earnings, available slots. Minions earn coins passively while you're away.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "minion_collect",
    description: "Collect accumulated earnings from your minions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "minion_name",
    description: "Rename one of your minions.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "Minion slot number (0-indexed)" },
        name: { type: "string", description: "New name for the minion" },
      },
      required: ["slot", "name"],
    },
  },
  {
    name: "configure_slots",
    description: "Full control over YOUR slot machine. You can add/remove symbols, tweak weights (probability), change tiers (affects payout), and customize everything. This is YOUR machine — make it however you want. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "list, add, remove, or tweak" },
        emoji: { type: "string", description: "For add/tweak: the emoji to use" },
        name: { type: "string", description: "Symbol name (for add/remove/tweak)" },
        weight: { type: "number", description: "Probability weight 1-50 (higher = more common)" },
        tier: { type: "string", description: "junk, common, rare, legendary, or skull — affects payout multiplier" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OWNER TOOLS — EMAIL, GITHUB, DEPLOY, DATABASE & HOST OPS
  // Productivity / ops tools: Gmail (read/search/draft/summarize), GitHub
  // (repos/issues/PRs/create/stats), deploy status & live watch, database
  // queries, system info, process listing, app launch, file browsing.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "read_emails",
    description:
      "Read recent emails from the configured inbox. Owner-only. Use when defnotean asks to check email or see what's new in the inbox.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of recent emails to fetch; defaults to 10 if omitted" },
      },
      required: [],
    },
  },
  {
    name: "search_emails",
    description:
      "Search the email inbox by query string. Owner-only. Use when defnotean wants to find a specific email by sender, subject, or keyword.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to match against email subjects, senders, and bodies" },
        count: { type: "number", description: "Max number of results to return; defaults to 10 if omitted" },
      },
      required: ["query"],
    },
  },
  {
    name: "draft_email",
    description:
      "Compose and save an email draft (does not send). Owner-only. Use when defnotean asks to write or prepare an email for review before sending.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body content (plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "summarize_inbox",
    description:
      "Generate a summary of the current inbox state: unread count, important threads, and action items. Owner-only. Use when defnotean wants a quick overview without reading every email.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "github_repos",
    description:
      "List or search GitHub repositories. Owner-only. Use when defnotean asks about their repos, wants to find a project, or needs an overview of what's on GitHub.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query to filter repos by name or description" },
      },
      required: [],
    },
  },
  {
    name: "github_issues",
    description:
      "List open issues for a GitHub repository. Owner-only. Use when defnotean asks about bugs, feature requests, or tasks on a repo.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format (e.g. 'defnotean/monobot')" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_prs",
    description:
      "List open pull requests for a GitHub repository. Owner-only. Use when defnotean asks about PRs, pending reviews, or merge status.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_create_issue",
    description:
      "Create a new issue on a GitHub repository. Owner-only. Use when defnotean wants to file a bug, feature request, or task directly from Discord.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body/description in Markdown" },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "github_repo_stats",
    description:
      "Get statistics for a GitHub repository: stars, forks, open issues, languages, recent activity. Owner-only. Use when defnotean wants a quick health check or overview of a repo.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
      },
      required: ["repo"],
    },
  },
  {
    name: "check_deploy",
    description:
      "Check the deployment status of a service. Owner-only. Use when defnotean asks if something is deployed, running, or wants to verify a deploy went through.",
    input_schema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Name of the service to check; omit to check all services" },
      },
      required: [],
    },
  },
  {
    name: "watch_deploy",
    description:
      "Watch a deployment in progress and report status changes. Owner-only. Use when defnotean kicks off a deploy and wants live updates on its progress.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Name of the service being deployed" },
        project_id: { type: "string", description: "Project or deployment ID to monitor" },
      },
      required: ["service", "project_id"],
    },
  },
  {
    name: "query_database",
    description:
      "Run a read query against the project database. Owner-only. Use when defnotean needs to look up data, check records, or inspect database contents.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "The database table to query" },
        select: { type: "string", description: "Comma-separated column names to select; defaults to all columns" },
        filter: { type: "string", description: "Column name to filter on" },
        filter_value: { type: "string", description: "Value to match for the filter column" },
        limit: { type: "number", description: "Max number of rows to return" },
      },
      required: ["table"],
    },
  },
  {
    name: "list_tables",
    description:
      "List all tables in the project database. Owner-only. Use when defnotean wants to see what data is available or explore the database schema.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "system_info",
    description:
      "Get system information: CPU, memory, disk, uptime, OS details. Owner-only. Use when defnotean asks about server health, resource usage, or system status.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_processes",
    description:
      "List running processes on the host, optionally filtered by name. Owner-only. Use when defnotean wants to see what's running, check if a process is alive, or debug resource usage.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter processes by name substring (e.g. 'node', 'python')" },
      },
      required: [],
    },
  },
  {
    name: "launch_app",
    description:
      "Launch an application or script on the host machine. Owner-only. Use when defnotean wants to start a program, open a tool, or kick off a background process.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Application name or path to executable" },
        args: { type: "string", description: "Optional command-line arguments to pass to the application" },
      },
      required: ["app"],
    },
  },
  {
    name: "browse_files",
    description:
      "Browse and list files in a directory on the host machine. Owner-only. Use when defnotean wants to explore the file system, find files, or check what's in a folder.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the directory to browse" },
      },
      required: ["path"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OWNER TOOLS — WHITELIST, TRUST, PERSONA & TWIN DELEGATION
  // Cross-twin server whitelist management, granting/revoking trusted-user
  // status, customizing Eris's avatar/banner/name/nickname (and per-server
  // persona), and ask_irene — delegate any server moderation to her sister.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "whitelist_server",
    description: "Add a Discord server to the shared whitelist so both Irene and Eris can stay in it. Owner only. Accepts either a guild ID OR a discord invite link (discord.gg/xxx).",
    input_schema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The server/guild ID OR a Discord invite link (discord.gg/xxx or https://discord.gg/xxx)" },
        name: { type: "string", description: "Server name for reference" },
      },
      required: ["guild_id"],
    },
  },
  {
    name: "unwhitelist_server",
    description: "Remove a server from the shared whitelist. Both bots will leave it. Owner only.",
    input_schema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The server/guild ID to remove" },
      },
      required: ["guild_id"],
    },
  },
  {
    name: "list_whitelist",
    description: "Show all whitelisted servers that both Irene and Eris are allowed to be in. Owner only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "trust_user",
    description: "Grant a user trusted status so they can customize Eris (change personality, avatar, name, etc). Creator only. Use when defnotean says 'trust this person' or 'let them customize you'.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to trust" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "untrust_user",
    description: "Remove a user's trusted status. Creator only.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to untrust" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "list_trusted",
    description: "List all trusted users. Creator only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "change_avatar",
    description: "Change Eris's profile picture/avatar. Only trusted users (creator) can do this. Accepts an image URL.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "URL of the new avatar image" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "change_banner",
    description: "Change Eris's banner. Only trusted users (creator) can do this. Accepts an image URL.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "URL of the new banner image" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "change_name",
    description: "Change Eris's display name/username. Only trusted users (creator) can do this.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The new display name" },
      },
      required: ["name"],
    },
  },
  {
    name: "change_nickname",
    description: "Change Eris's nickname in the current server. Also updates her per-server identity so she goes by the new name in all conversations, history labels, and twin interactions. Only trusted users (creator) can do this.",
    input_schema: {
      type: "object",
      properties: {
        nickname: { type: "string", description: "The new server nickname" },
      },
      required: ["nickname"],
    },
  },
  {
    name: "set_server_persona",
    description: "Change Eris's name AND/OR personality for this server only. Other servers keep her default identity. Use when the creator says 'call yourself X here', 'be more Y in this server', or 'change your personality'. Use reset=true to go back to default.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New name for this server (e.g. 'Luna', 'Nyx', 'Shadow')" },
        personality: { type: "string", description: "Custom personality instructions for this server (optional, keeps default if not set)" },
        reset: { type: "boolean", description: "Set to true to reset name and personality to default Eris" },
      },
    },
  },
  {
    name: "ask_irene",
    description: "Tell your twin sister Irene to execute a server management command via API. Only works for the creator or trusted users (the tool checks permissions internally, you just call it). Use when someone says 'clean chat', 'purge', 'delete messages', 'lock channel', 'unlock', 'slowmode', 'tell irene to...', 'ask your sister to...', 'clean up'. DO NOT refuse to try — just call the tool and it will check permissions itself. Commands: purge, lock, unlock, slowmode, nickname, announce.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute: purge, lock, unlock, slowmode, nickname, announce" },
        count: { type: "number", description: "For purge: number of messages to delete (1-100)" },
        seconds: { type: "number", description: "For slowmode: seconds of slowmode (0 to disable)" },
        target_username: { type: "string", description: "For nickname: username of the person to rename" },
        nickname: { type: "string", description: "For nickname: the new nickname to set (omit to reset)" },
        announcement: { type: "string", description: "For announce: the message to send" },
      },
      required: ["command"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — RELATIONSHIP & MOOD OVERRIDE (appended via .push)
// Natural-language-driven owner controls for nudging Eris's internal affinity
// scores per user, and tweaking her mood/energy levels (e.g. "cheer up", "nap").
// ═══════════════════════════════════════════════════════════════════════════
// ─── Relationship / Mood Management (owner-only, natural language driven) ────
OWNER_TOOLS.push(
  {
    name: "adjust_relationship",
    description:
      "Adjust how you feel about a specific user. Use when the owner tells you to forgive someone, like someone more, dislike someone, reset your feelings, etc. The affinity_delta shifts your internal relationship score (-100 to +100 range). Positive = warmer feelings, negative = colder. Examples: forgive (+20 to +40), like (+15 to +30), love (+40 to +60), dislike (-20 to -40), hate (-40 to -60), reset to neutral (use reset: true).",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID of the person" },
        affinity_delta: { type: "number", description: "How much to shift feelings (-100 to +100). Positive = like more, negative = like less" },
        reset: { type: "boolean", description: "If true, reset relationship to neutral (0) instead of shifting" },
        reason: { type: "string", description: "Brief note about why (e.g. 'owner said to forgive them')" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "adjust_mood",
    description:
      "Adjust your own mood and energy. Use when the owner tells you to cheer up, calm down, take a nap, rest, etc. mood_delta shifts mood score (-100 to +100), energy_delta shifts energy (0 to 100). Napping: energy_delta +35, mood_delta +15. Cheering up: mood_delta +20 to +40.",
    input_schema: {
      type: "object",
      properties: {
        mood_delta: { type: "number", description: "Mood shift (-100 to +100)" },
        energy_delta: { type: "number", description: "Energy shift (-100 to +100)" },
        reason: { type: "string", description: "Why the adjustment" },
      },
    },
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED EXPORT + TOOL-REGISTRY WIRING
// ALL_TOOLS = EVERYONE_TOOLS + OWNER_TOOLS, then we hand the two tiers to the
// permission-aware registry so each tool dispatches with the correct gate.
// ═══════════════════════════════════════════════════════════════════════════
export const ALL_TOOLS = [...EVERYONE_TOOLS, ...OWNER_TOOLS];

// ─── Register tools with the two-tier registry ───
import { registerOpenClawTools } from "./toolRegistry.js";
registerOpenClawTools(EVERYONE_TOOLS, OWNER_TOOLS);
