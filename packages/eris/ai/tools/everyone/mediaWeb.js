// @ts-check
// ─── packages/eris/ai/tools/everyone/mediaWeb.js ─────────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — MEDIA, WEB, MEMES & PRESENCE
// GIFs, image analysis & search, meme template lookup + generation,
// web search & URL scraping, and Discord presence / availability check.
// (Also includes self-knowledge: save/recall/forget_self_fact, save/recall_my_take.)
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const MEDIA_WEB_TOOLS = [
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
    name: "show_image",
    tags: ["fun"],
    description:
      "Find a REAL photo of something and POST it directly into the chat with your own caption. Use this whenever someone asks what something looks like, wants to see something, or a real picture answers better than words (e.g. 'what does a quokka look like', 'show me the eiffel tower', 'whats a capybara'). It posts the actual image (not a URL) as an embed. ALWAYS pass a `caption` written in your own voice/personality — your reaction or one-line explanation to send alongside it. (send_gif = reaction GIFs, create_meme = memes, this = real reference photos.)",
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
    tags: ["fun"],
    description:
      "Post the full content as a downloadable FILE attachment. ALWAYS use this instead of pasting long code/scripts/text inline — inline replies are capped and get cut off mid-line. The right pattern: a SHORT normal message in your voice (1-2 sentences) PLUS the file attached. e.g. asked for a python script → caption 'made u a lil snake game, run it with python 🐍' and attach snake.py with the code. The file holds the long stuff so it's never truncated.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name WITH extension (e.g. 'snake.py', 'notes.md', 'data.json')" },
        content: { type: "string", description: "The FULL file contents (code/text). Goes in the file, not the chat — length is fine here, write the whole thing." },
        caption: { type: "string", description: "Short message to post alongside the file, in your own voice (1-2 sentences)" },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "generate_image",
    tags: ["fun"],
    description:
      "Generate a brand-new AI image from a text description and post it. Use when someone asks you to draw/make/create/imagine a picture of something. (show_image = find a real photo; edit_image = alter a photo the user sent; this = make new art.)",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate" },
        caption: { type: "string", description: "Optional short message to post with it, in your voice" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    tags: ["fun"],
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
      "Generate a context-aware meme. Pick the template that fits the joke. Common picks: 'drake' = preferring X over Y, 'db' = distracted boyfriend tempted by something new, 'change-my-mind' / 'cmm' = hot takes, 'gru' = plan backfiring, 'fine' = everything burning, 'stonks' = bad financial decisions, 'panik-kalm-panik' = panic cycle, 'fry' = not sure if X or Y, 'mordor' = one does not simply, 'slap' = batman slap, 'harold' = hide the pain, 'spongebob' = mocking, 'astronaut' = always has been, 'pooh' = fancy pooh. If you don't know the right template, call search_meme_templates first. To make a meme about a specific person, pass their user_id to grab their avatar as the background. To use a custom format not in the catalog, pass image_url instead of template.",
    input_schema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Meme template name (e.g. 'drake', 'db', 'change-my-mind'). Pick the one that fits the joke best" },
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
      "Search the web for current information. Use when someone asks a question you don't know the answer to, needs up-to-date info, or wants to look something up (news, docs, trivia, etc.). One precise query is usually enough; don't run near-duplicate searches unless the first result clearly failed or the user asked for deeper cross-checking.",
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
];
