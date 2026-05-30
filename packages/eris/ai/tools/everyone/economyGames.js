// @ts-check
// ─── packages/eris/ai/tools/everyone/economyGames.js ─────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — ECONOMY CORE, GAMBLING, MINI-GAMES & EXPANSION
// The big sub-block: balance/daily, all gambling games (coinflip, dice,
// slots, blackjack, roulette, poker, rob), stocks, lottery, leaderboards,
// chaos & fun (fortune, duels, confessions, curses), mini-games (trivia,
// scramble, RPS, number guess), and economy expansion (shop, loans,
// bounties, daily challenges, achievements).
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const ECONOMY_GAME_TOOLS = [
  // ─── Economy & Gambling ──────────────────────────────────────────────────

  {
    name: "check_balance",
    description: "Check a user's coin balance and economy stats. Use ONLY when the user EXPLICITLY asks about coins/balance/wealth — examples: 'how much money do I have', 'check my balance', 'how many coins', 'what's my wallet', 'how rich is X'. Do NOT call this tool for game/activity requests (adventure, scratch_card, blackjack, slots, dig, fish, hunt, work, etc.) — each of those tools handles its own balance check. Do NOT call this tool just because the recent channel chat had wallet info in it. If the current message doesn't literally ask about balance/coins/wallet, skip this tool.",
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
        choice: { type: "string", enum: ["heads", "tails"], description: "Either 'heads' or 'tails' (lowercase)" },
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
        action: { type: "string", enum: ["hit", "stand", "double"], description: "Exactly one of 'hit', 'stand', or 'double' (lowercase)" },
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
    description: "List all server roles grouped by power category, based on their ACTUAL Discord permissions (not role names). Use when someone asks 'who are the mods', 'who's staff', 'ping all admins', or just 'list roles by category'. If no category is given, returns ALL categories (default: 'all'). Specific categories: 'admin' (Administrator or ManageGuild), 'moderator' (Ban/Kick/Timeout/ManageRoles/ManageChannels), 'helper' (ManageMessages/MuteMembers/ViewAuditLog), 'bot' (integration roles), 'everyone' (@everyone), 'cosmetic' (no dangerous perms). Meta: 'staff' (admin + moderator), 'trusted' (admin + moderator + helper).",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "admin", "moderator", "helper", "bot", "everyone", "cosmetic", "staff", "trusted"],
          description: "Which category to list (default: 'all' — returns every category)",
        },
      },
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
    description: "Apply a random funny cursed effect to a user — changes their nickname to something hilarious for 10 minutes. Use when someone says 'curse them', 'hex', or when chaos demands it. Requires Manage Nicknames permission. Inverse: remove_curse to lift it early.",
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
    description: "Remove an active curse from a user — restores their original nickname early. Reverses apply_curse. Use when someone says 'remove curse', 'uncurse', or when the boss tells you to. You CAN remove curses now.",
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
    description: "Start a trivia question with optional category and coin stakes. Use when someone says 'trivia', 'quiz me', 'ask me a question', 'test my knowledge'.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["general", "science", "gaming", "anime", "movies", "history", "music", "sports", "geography", "computers"], description: "Question category (lowercase)" },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"], description: "Question difficulty (lowercase)" },
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
        choice: { type: "string", enum: ["rock", "paper", "scissors"], description: "Exactly one of 'rock', 'paper', or 'scissors' (lowercase)" },
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
    description: "Buy a SPECIFIC named item from the shop with coins. Call this DIRECTLY whenever the user names an item to buy — 'buy a Lucky Charm', 'buy Wedding Ring', 'purchase Fishing Rod', 'I want a Loot Box'. Do NOT call shop_browse first if the user already named the item — go straight to shop_buy. shop_browse is only for 'what can i buy' / 'show me the shop' (browsing without a named item).",
    input_schema: { type: "object", properties: { item: { type: "string", description: "Name of the item to buy (e.g. 'Lucky Charm', 'Wedding Ring')" } }, required: ["item"] },
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
];
