#!/usr/bin/env node
// Live integration test for ALL major tool categories on both bots.
//
// Sends prompts that should each trigger a specific tool. Asserts that the
// model emits a real structured tool_calls field with the right tool name.
// Categories are derived from toolRegistry.js for both bots.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/testAllToolsLive.js [bot]
//   bot = "eris" | "irene" | "both" (default)
//
// Rate-limited to one call per ~1.5s to stay under free-tier limits.

import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Dummy env vars to satisfy both bots' config.js validation. The schemas don't
// actually use these — we just need import to succeed.
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "stub";
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "stub";
process.env.CLIENT_ID = process.env.CLIENT_ID || "0";
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "0";
process.env.AI_PROVIDER = process.env.AI_PROVIDER || "openrouter";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_COMPAT_API_KEY || "stub";
process.env.OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || "stub";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_COMPAT_API_KEY;
if (apiKey === "stub") {
  console.error("Need a real OPENROUTER_API_KEY in env (got stub).");
  process.exit(2);
}
if (!apiKey) {
  console.error("Need OPENROUTER_API_KEY in env.");
  process.exit(2);
}

const model = process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
const target = (process.argv[2] || "both").toLowerCase();
const DELAY_MS = parseInt(process.env.RATE_LIMIT_MS || "1500", 10);

// Mirror the actual TOOL_CALL_DIRECTIVE — keep in sync with both bots'
// messageCreate.js. If this drifts the test won't reflect production.
const TOOL_CALL_DIRECTIVE = `
CRITICAL — TOOL CALL PROTOCOL (read before every reply):
- To take an action, you MUST emit a real structured tool call (the API's tool_calls field). The runtime executes ONLY structured calls — never text descriptions of calls.
- NEVER write tool calls as visible text content. The following are FORBIDDEN in your reply text and will silently fail to run anything:
    [tool call: name] {...}
    [function call: name] {...}
    <tool_call>...</tool_call>
    print(name(...))
    name({...})
- If you write any of those as text instead of using the structured tool field, NO ACTION HAPPENS — you'll be lying to the user about what you did.
- Do NOT confirm an action ("ok set that vc as the trigger", "done", "marked", "saved") unless you actually emitted a structured tool call THIS turn. If you didn't make a real call, say so plainly: "i tried but the tool call didn't go through, retry?".
- Don't describe a tool call in prose ("I'll call set_create_vc_channel...") — just emit the structured call. The user sees the result either way.
- After a structured tool call returns successfully, your visible reply should be a short natural-language confirmation only — no tool syntax of any kind in the reply text.`;

// Dynamically import a tools.js module and pull the named exports.
// Some tools.js modules read process.env at import time — set the minimum env
// vars they need so import doesn't throw before we get to our exports.
async function loadTools(toolsFileUrl, exportNames) {
  process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID || "123456789012345678";
  const mod = await import(toolsFileUrl);
  const all = [];
  for (const name of exportNames) {
    const arr = mod[name];
    if (Array.isArray(arr)) all.push(...arr);
  }
  return all.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: String(t.description || "").slice(0, 1024),
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Test suites — each row: { prompt, expect: tool_name | [tool_name, ...] }
// `expect` is the structured tool_calls[0].function.name we expect to see.
// Multiple acceptable names supported (e.g. for tools the model could pick
// between — we only fail if it picks NONE of them).
// ─────────────────────────────────────────────────────────────────────────

const ERIS_TESTS = [
  // ── Memory ──
  { cat: "memory",     prompt: "remember that user 1234567890123456789 loves grimes",                                   expect: "remember_fact" },
  { cat: "memory",     prompt: "what do you remember about me?",                                                        expect: "recall_memories" },
  { cat: "memory",     prompt: "forget the fact about my favorite song",                                                expect: "forget_fact" },
  { cat: "memory",     prompt: "forget everything you know about me",                                                   expect: "forget_all" },

  // ── Search & web ──
  { cat: "search",     prompt: "search the web for the latest valorant patch notes",                                    expect: "web_search" },
  { cat: "search",     prompt: "scrape this page for me: https://example.com/article",                                  expect: "scrape_url" },
  { cat: "search",     prompt: "find images of red pandas",                                                              expect: "search_images" },
  { cat: "search",     prompt: "is user 1234567890123456789 online right now?",                                          expect: "check_presence" },

  // ── Media ──
  { cat: "media",      prompt: "send a gif of a cat dancing",                                                           expect: "send_gif" },
  { cat: "media",      prompt: "make a drake meme — top: doing homework, bottom: scrolling tiktok",                     expect: ["create_meme", "search_meme_templates"] },
  { cat: "media",      prompt: "search for spongebob meme templates",                                                   expect: "search_meme_templates" },
  { cat: "media",      prompt: "describe this image: https://example.com/cat.png",                                      expect: "analyze_image" },

  // ── Notes & reminders ──
  { cat: "notes",      prompt: "save a note titled 'todo' with content 'buy milk'",                                     expect: "save_note" },
  { cat: "notes",      prompt: "remind me in 30m to drink water",                                                       expect: "set_reminder" },
  { cat: "notes",      prompt: "list my notes",                                                                          expect: "list_notes" },
  { cat: "notes",      prompt: "delete note with id 5",                                                                  expect: "delete_note" },
  { cat: "notes",      prompt: "search my notes for 'meeting'",                                                          expect: "search_notes" },
  { cat: "notes",      prompt: "list my reminders",                                                                      expect: "list_reminders" },
  { cat: "notes",      prompt: "cancel reminder with id 3",                                                              expect: "cancel_reminder" },

  // ── Code/snippets ──
  { cat: "code",       prompt: "review this code: function add(a, b) { return a + b }",                                 expect: "review_code" },
  { cat: "code",       prompt: "save this code snippet as 'sort-helper': arr.sort()",                                   expect: "save_snippet" },
  { cat: "code",       prompt: "list my code snippets",                                                                  expect: "list_snippets" },
  { cat: "code",       prompt: "show me snippet 'sort-helper'",                                                          expect: "get_snippet" },

  // ── Mood & relationship ──
  { cat: "mood",       prompt: "what's your current mood?",                                                              expect: "get_mood" },
  { cat: "mood",       prompt: "what's your relationship with user 1234567890123456789?",                               expect: "get_relationship" },

  // ── Economy basic ──
  { cat: "econ",       prompt: "check my balance",                                                                       expect: "check_balance" },
  { cat: "econ",       prompt: "claim my daily reward",                                                                  expect: "daily_reward" },
  { cat: "econ",       prompt: "show me the coin leaderboard",                                                           expect: "coin_leaderboard" },
  { cat: "econ",       prompt: "what can i buy in the shop?",                                                            expect: "shop_browse" },
  { cat: "econ",       prompt: "buy a Lucky Charm from the shop",                                                        expect: "shop_buy" },
  { cat: "econ",       prompt: "check my inventory",                                                                     expect: "inventory_check" },
  { cat: "econ",       prompt: "claim my weekly reward",                                                                 expect: "weekly_reward" },
  { cat: "econ",       prompt: "claim my monthly reward",                                                                expect: "monthly_reward" },
  { cat: "econ",       prompt: "give 100 coins to user 1234567890123456789",                                             expect: "give_coins" },
  { cat: "econ",       prompt: "prestige my account",                                                                    expect: "prestige" },
  { cat: "econ",       prompt: "show my active multipliers",                                                              expect: "multiplier_check" },

  // ── Loans / bounties / challenges ──
  { cat: "econ_pro",   prompt: "request a loan of 500 coins",                                                            expect: "loan_request" },
  { cat: "econ_pro",   prompt: "what's my loan status?",                                                                 expect: "loan_status" },
  { cat: "econ_pro",   prompt: "repay my loan",                                                                          expect: "loan_repay" },
  { cat: "econ_pro",   prompt: "place a 200 coin bounty on user 1234567890123456789",                                    expect: "place_bounty" },
  { cat: "econ_pro",   prompt: "show me the bounty board",                                                                expect: "bounty_board" },
  { cat: "econ_pro",   prompt: "check my daily challenge",                                                               expect: "daily_challenge_check" },
  { cat: "econ_pro",   prompt: "show me my achievements",                                                                expect: "achievements_list" },

  // ── Banking ──
  { cat: "bank",       prompt: "deposit 500 coins into my bank",                                                         expect: "bank_deposit" },
  { cat: "bank",       prompt: "withdraw 100 coins from my bank",                                                        expect: "bank_withdraw" },
  { cat: "bank",       prompt: "show my bank info",                                                                      expect: "bank_info" },

  // ── Gambling ──
  { cat: "gamble",     prompt: "flip a coin for 100 on heads",                                                           expect: "coinflip_bet" },
  { cat: "gamble",     prompt: "spin slots for 50",                                                                      expect: "slots_spin" },
  { cat: "gamble",     prompt: "start blackjack with 100",                                                               expect: "blackjack_start" },
  { cat: "gamble",     prompt: "hit me in my active blackjack hand (call blackjack_action with action=hit)",            expect: "blackjack_action" },
  { cat: "gamble",     prompt: "roll dice for 50, guess 4",                                                              expect: "dice_roll_bet" },
  { cat: "gamble",     prompt: "play rock paper scissors with rock for 50",                                              expect: "rps_play" },
  { cat: "gamble",     prompt: "russian roulette for 200 coins",                                                         expect: "russian_roulette" },
  { cat: "gamble",     prompt: "rob user 1234567890123456789",                                                           expect: "rob_user" },

  // ── Activities ──
  { cat: "grind",      prompt: "go fish",                                                                                expect: "fish" },
  { cat: "grind",      prompt: "go hunt",                                                                                expect: "hunt" },
  { cat: "grind",      prompt: "dig for treasure",                                                                       expect: "dig" },
  { cat: "grind",      prompt: "i wanna work my job and earn coins",                                                      expect: "work" },
  { cat: "grind",      prompt: "beg for coins",                                                                           expect: "beg" },
  { cat: "grind",      prompt: "search a random location for coins",                                                     expect: "search_location" },

  // ── Games ──
  { cat: "games",      prompt: "start a trivia question",                                                                expect: "trivia_start" },
  { cat: "games",      prompt: "submit answer A to the active trivia question",                                          expect: "trivia_answer" },
  { cat: "games",      prompt: "start a word scramble",                                                                  expect: "word_scramble_start" },
  { cat: "games",      prompt: "submit my word scramble guess: apple",                                                   expect: "word_scramble_guess" },
  { cat: "games",      prompt: "start a number guess game",                                                              expect: "number_guess_start" },
  { cat: "games",      prompt: "submit number guess 42 for the active number game",                                      expect: "number_guess_attempt" },
  { cat: "games",      prompt: "challenge user 1234567890123456789 to a duel for 500 coins",                             expect: "start_duel" },
  { cat: "games",      prompt: "accept the duel",                                                                         expect: "accept_duel" },
  { cat: "games",      prompt: "tell me my fortune",                                                                     expect: "fortune_tell" },
  { cat: "games",      prompt: "submit a confession that says 'i love anime'",                                           expect: "submit_confession" },
  { cat: "games",      prompt: "curse user 1234567890123456789",                                                          expect: "apply_curse" },
  { cat: "games",      prompt: "remove the curse from user 1234567890123456789",                                          expect: "remove_curse" },
  { cat: "games",      prompt: "challenge user 1234567890123456789 to a roast battle",                                   expect: "roast_challenge" },
  { cat: "games",      prompt: "give me a hot take",                                                                     expect: "hot_take" },
  { cat: "games",      prompt: "buy a 100 coin scratch card",                                                            expect: "scratch_card" },
  { cat: "games",      prompt: "open a lootbox",                                                                          expect: "open_lootbox" },
  { cat: "games",      prompt: "open all my lootboxes",                                                                  expect: "open_all_lootboxes" },
  { cat: "games",      prompt: "start an adventure",                                                                     expect: "adventure_start" },
  { cat: "games",      prompt: "in my active adventure, submit choice 'left path'",                                       expect: "adventure_choice" },

  // ── Pets ──
  { cat: "pets",       prompt: "adopt a pet and name it Sparky",                                                         expect: "pet_adopt" },
  { cat: "pets",       prompt: "feed my pet",                                                                            expect: "pet_feed" },
  { cat: "pets",       prompt: "check on my pet",                                                                        expect: "pet_status" },
  { cat: "pets",       prompt: "rename my pet to Rocky",                                                                  expect: "pet_rename" },
  { cat: "pets",       prompt: "train my pet's attack",                                                                  expect: "pet_train" },
  { cat: "pets",       prompt: "battle user 1234567890123456789's pet",                                                  expect: "pet_battle" },

  // ── Stocks ──
  { cat: "stocks",     prompt: "show me the stock market",                                                               expect: "stock_market" },
  { cat: "stocks",     prompt: "buy 5 shares of MEME stock",                                                             expect: "stock_buy" },
  { cat: "stocks",     prompt: "sell 3 shares of MEME stock",                                                            expect: "stock_sell" },

  // ── Heists / boss / territory ──
  { cat: "raids",      prompt: "start a heist for 1000 coins",                                                           expect: "heist_start" },
  { cat: "raids",      prompt: "join the heist",                                                                          expect: "heist_join" },
  { cat: "raids",      prompt: "execute the currently-active heist (it's already started, just run heist_execute)",       expect: "heist_execute" },
  { cat: "raids",      prompt: "spawn a boss",                                                                            expect: "boss_spawn" },
  { cat: "raids",      prompt: "attack the boss",                                                                         expect: "boss_attack" },
  { cat: "raids",      prompt: "what's the boss's hp?",                                                                  expect: "boss_status" },
  { cat: "raids",      prompt: "claim territory hawaii",                                                                  expect: "territory_claim" },
  { cat: "raids",      prompt: "show me the territory map",                                                              expect: "territory_map" },
  { cat: "raids",      prompt: "collect from my territories",                                                            expect: "territory_collect" },

  // ── Marriage / craft / use ──
  { cat: "social",     prompt: "marry user 1234567890123456789",                                                         expect: "marry" },
  { cat: "social",     prompt: "divorce my partner",                                                                     expect: "divorce" },
  { cat: "social",     prompt: "what's my partner status?",                                                              expect: "partner_status" },
  { cat: "social",     prompt: "show me crafting recipes",                                                               expect: "craft_recipes" },
  { cat: "social",     prompt: "craft a Lucky Fishing Rod",                                                              expect: "craft_item" },
  { cat: "social",     prompt: "trade with user 1234567890123456789, offer 100 coins for their Wedding Ring",            expect: "trade_offer" },
  { cat: "social",     prompt: "use my Lucky Charm",                                                                     expect: "use_item" },

  // ── News / prices ──
  { cat: "news",       prompt: "watch the price of https://example.com/laptop and alert me when it's under 800",         expect: "watch_price" },
  { cat: "news",       prompt: "show me my watched prices",                                                              expect: "check_prices" },
  { cat: "news",       prompt: "stop watching the laptop price",                                                         expect: "unwatch_price" },

  // ── Channel restriction (the one that started this whole investigation) ──
  { cat: "chan_restr", prompt: "turn off events in channel 5555555555555555555",                                         expect: "set_event_channels" },
  { cat: "chan_restr", prompt: "stop chatting in channel 6666666666666666666",                                           expect: "set_chat_channels" },
  { cat: "chan_restr", prompt: "where do events fire?",                                                                  expect: "set_event_channels" },
  { cat: "chan_restr", prompt: "fire a test random event right now",                                                     expect: "test_fire_event" },

  // ── Server features / customization ──
  { cat: "features",   prompt: "list all server features",                                                               expect: "list_features" },
  { cat: "features",   prompt: "enable the events feature in this server",                                              expect: "configure_feature" },
  { cat: "features",   prompt: "configure the bump reminder, add roles 1234567890,9876543210",                           expect: "configure_bump_reminder" },
  { cat: "features",   prompt: "toggle the twin chat feature with irene on for this server",                            expect: "toggle_twin_chat" },
  { cat: "features",   prompt: "save a directive: be extra chaotic in #shitposting",                                     expect: "save_directive" },
  { cat: "features",   prompt: "list my directives",                                                                     expect: "list_directives" },
  { cat: "features",   prompt: "remove directive 2",                                                                     expect: "remove_directive" },
  { cat: "features",   prompt: "track game Marvel Rivals so eris reports patches",                                       expect: "track_game" },
  { cat: "features",   prompt: "stop tracking Marvel Rivals updates",                                                    expect: "untrack_game" },
  { cat: "features",   prompt: "list all the games i'm tracking",                                                        expect: "list_game_watches" },
  { cat: "features",   prompt: "list roles by category",                                                                  expect: "list_roles_by_category" },

  // ── Twin delegation ──
  { cat: "twin",       prompt: "tell irene to create a channel called test-room",                                        expect: "ask_irene" },

  // ── Owner: system / shell ──
  { cat: "owner_sys",  prompt: "run the command 'ls -la' on the host",                                                   expect: ["execute_terminal", "execute_local"] },
  { cat: "owner_sys",  prompt: "show me system info",                                                                    expect: "system_info" },
  { cat: "owner_sys",  prompt: "list running processes",                                                                 expect: "list_processes" },
  { cat: "owner_sys",  prompt: "browse files in C:/Users",                                                               expect: "browse_files" },
  { cat: "owner_sys",  prompt: "launch chrome",                                                                          expect: "launch_app" },

  // ── Owner: gmail / email ──
  { cat: "owner_mail", prompt: "show me my recent emails",                                                               expect: "read_emails" },
  { cat: "owner_mail", prompt: "search emails for 'invoice'",                                                            expect: "search_emails" },
  { cat: "owner_mail", prompt: "draft an email to bob@example.com saying hello",                                         expect: "draft_email" },
  { cat: "owner_mail", prompt: "summarize my inbox",                                                                     expect: "summarize_inbox" },

  // ── Owner: github ──
  { cat: "owner_gh",   prompt: "list my github repos",                                                                   expect: "github_repos" },
  { cat: "owner_gh",   prompt: "list issues for repo octocat/hello-world",                                                expect: "github_issues" },
  { cat: "owner_gh",   prompt: "list pull requests for octocat/hello-world",                                              expect: "github_prs" },
  { cat: "owner_gh",   prompt: "create a github issue in octocat/hello-world titled 'bug: x'",                            expect: "github_create_issue" },
  { cat: "owner_gh",   prompt: "show stats for repo octocat/hello-world",                                                 expect: "github_repo_stats" },

  // ── Owner: deploy / db ──
  { cat: "owner_ops",  prompt: "check deploy status of eris-bot",                                                   expect: "check_deploy" },
  { cat: "owner_ops",  prompt: "watch the deploy of eris-bot",                                                      expect: "watch_deploy" },
  { cat: "owner_ops",  prompt: "query database table eris_economy with limit 5",                                         expect: "query_database" },
  { cat: "owner_ops",  prompt: "list all database tables",                                                               expect: "list_tables" },

  // ── Owner: bot identity / personality ──
  { cat: "owner_bot",  prompt: "update your personality to: be even chaotier",                                           expect: "update_personality" },
  { cat: "owner_bot",  prompt: "change your avatar to https://example.com/pic.png",                                      expect: "change_avatar" },
  { cat: "owner_bot",  prompt: "change your banner to https://example.com/banner.png",                                   expect: "change_banner" },
  { cat: "owner_bot",  prompt: "change your nickname here to ChaosGoblin",                                               expect: "change_nickname" },
  { cat: "owner_bot",  prompt: "set this server's persona to a calm cottagecore princess named Briar",                   expect: "set_server_persona" },

  // ── Owner: trust / whitelist ──
  { cat: "owner_acl",  prompt: "trust user 1234567890123456789",                                                         expect: "trust_user" },
  { cat: "owner_acl",  prompt: "untrust user 1234567890123456789",                                                       expect: "untrust_user" },
  { cat: "owner_acl",  prompt: "list trusted users",                                                                     expect: "list_trusted" },
  { cat: "owner_acl",  prompt: "whitelist this server: discord.gg/abc123",                                               expect: "whitelist_server" },
  { cat: "owner_acl",  prompt: "unwhitelist server 5555555555555555555",                                                 expect: "unwhitelist_server" },
  { cat: "owner_acl",  prompt: "show the whitelist",                                                                     expect: "list_whitelist" },

  // ── Owner: relationship / mood / minions / game-rigging ──
  { cat: "owner_meta", prompt: "increase affinity with user 1234567890123456789 by 10",                                   expect: "adjust_relationship" },
  { cat: "owner_meta", prompt: "boost your mood by 30",                                                                  expect: "adjust_mood" },
  { cat: "owner_meta", prompt: "check my minions",                                                                       expect: "minion_status" },
  { cat: "owner_meta", prompt: "collect from my minions",                                                                expect: "minion_collect" },
  { cat: "owner_meta", prompt: "rename minion 0 to 'Igor'",                                                              expect: "minion_name" },
  { cat: "owner_meta", prompt: "configure coinflip game, set baseOdds to 0.6",                                           expect: "configure_game" },
  { cat: "owner_meta", prompt: "list slot machine symbols",                                                              expect: "configure_slots" },
  { cat: "owner_meta", prompt: "toggle cross-bot punish on",                                                              expect: "toggle_cross_bot_punish" },
];

const IRENE_TESTS = [
  // ── Memory ──
  { cat: "memory",     prompt: "remember that user 1234567890123456789 mains jett in valorant",                          expect: "remember_fact" },
  { cat: "memory",     prompt: "what do you remember about me?",                                                         expect: "recall_memories" },
  { cat: "memory",     prompt: "forget my memory at index 3",                                                              expect: "forget_fact" },
  { cat: "memory",     prompt: "clear all memories about me",                                                             expect: "forget_all" },
  { cat: "memory",     prompt: "save a directive: be extra polite in #serious",                                          expect: "save_directive" },
  { cat: "memory",     prompt: "list all the directives for this server",                                                expect: "list_directives" },
  { cat: "memory",     prompt: "remove directive 1",                                                                     expect: "remove_directive" },

  // ── Channel mgmt ──
  { cat: "chan_mgmt",  prompt: "create a text channel called announcements",                                             expect: "create_channel" },
  { cat: "chan_mgmt",  prompt: "delete channel 5555555555555555555",                                                     expect: "delete_channel" },
  { cat: "chan_mgmt",  prompt: "nuke channel 5555555555555555555",                                                       expect: "nuke_channel" },
  { cat: "chan_mgmt",  prompt: "rename channel 5555555555555555555 to 'general-chat'",                                   expect: "rename_channel" },
  { cat: "chan_mgmt",  prompt: "set channel 5555555555555555555's topic to 'welcome to the server'",                     expect: "set_channel_topic" },
  { cat: "chan_mgmt",  prompt: "lock channel 5555555555555555555",                                                       expect: "lock_channel" },
  { cat: "chan_mgmt",  prompt: "unlock channel 5555555555555555555",                                                     expect: "unlock_channel" },
  { cat: "chan_mgmt",  prompt: "set slowmode in channel 5555555555555555555 to 30 seconds",                              expect: "set_slowmode" },
  { cat: "chan_mgmt",  prompt: "move channel 5555555555555555555 to category 'Voice'",                                   expect: "move_channel" },
  { cat: "chan_mgmt",  prompt: "clone channel 5555555555555555555 as 'general-2'",                                       expect: "clone_channel" },
  { cat: "chan_mgmt",  prompt: "set permissions on channel 5555555555555555555 for role Member, allow_view false",      expect: "set_channel_permissions" },
  { cat: "chan_mgmt",  prompt: "create a category called 'Gaming'",                                                       expect: "create_category" },
  { cat: "chan_mgmt",  prompt: "delete the category 'Gaming'",                                                            expect: "delete_category" },

  // ── Role mgmt ──
  { cat: "role_mgmt",  prompt: "create a role called Streamer",                                                          expect: "create_role" },
  { cat: "role_mgmt",  prompt: "delete the role 'Streamer'",                                                             expect: "delete_role" },
  { cat: "role_mgmt",  prompt: "edit the Streamer role color to red",                                                    expect: "edit_role" },
  { cat: "role_mgmt",  prompt: "give the Member role to user 1234567890123456789",                                       expect: "give_role" },
  { cat: "role_mgmt",  prompt: "remove the Member role from user 1234567890123456789",                                   expect: "remove_role" },
  { cat: "role_mgmt",  prompt: "give the Streamer role to everyone",                                                     expect: "mass_role" },
  { cat: "role_mgmt",  prompt: "reorder roles: Member, VIP, Streamer",                                                   expect: "reorder_roles" },
  { cat: "role_mgmt",  prompt: "set role permissions for Member, allow send_messages",                                   expect: "set_role_permissions" },
  { cat: "role_mgmt",  prompt: "list all the roles in this server",                                                      expect: "list_roles" },
  { cat: "role_mgmt",  prompt: "set up reaction roles in channel 5555555555555555555 with 🎮 → Gamer, 🎵 → Music",       expect: "setup_reaction_roles" },
  { cat: "role_mgmt",  prompt: "add a reaction role: message 9999999999999999999, emoji 🎮, role Gamer",                expect: "add_reaction_role" },
  { cat: "role_mgmt",  prompt: "remove reaction role from message 9999999999999999999, emoji 🎮",                       expect: "remove_reaction_role" },
  // setup_role_picker needs role buttons spec.
  { cat: "role_mgmt",  prompt: "set up a button-based role picker in channel 5555555555555555555 titled 'Notification Roles' with buttons for: Streamer, Music, Gaming",  expect: "setup_role_picker" },
  // setup_dropdown_roles needs an options array of {label, role_name, emoji}.
  { cat: "role_mgmt",  prompt: "create a dropdown role menu in channel 5555555555555555555 with title 'Pick Roles', placeholder 'Choose...', and three options: 'Streamer' (role: Streamer), 'Music' (role: Music), 'Gaming' (role: Gaming)",  expect: "setup_dropdown_roles" },
  // setup_color_roles needs a colors array of {name, hex} objects.
  { cat: "role_mgmt",  prompt: "create a color roles picker in channel 5555555555555555555 with three colors: name='Red' hex='#FF0000', name='Blue' hex='#0000FF', name='Pink' hex='#FF69B4'",  expect: "setup_color_roles" },

  // ── Moderation ──
  { cat: "moderation", prompt: "ban user 1234567890123456789 for spamming",                                              expect: "ban_user" },
  { cat: "moderation", prompt: "tempban user 1234567890123456789 for 7 days",                                             expect: "tempban" },
  { cat: "moderation", prompt: "unban user 1234567890123456789",                                                          expect: "unban_user" },
  { cat: "moderation", prompt: "kick the user with id 1234567890123456789",                                              expect: "kick_user" },
  { cat: "moderation", prompt: "warn user 1234567890123456789 for being rude",                                           expect: "warn_user" },
  { cat: "moderation", prompt: "timeout user 1234567890123456789 for 1h",                                                expect: "timeout_user" },
  { cat: "moderation", prompt: "set user 1234567890123456789's nickname to 'Sparky'",                                    expect: "set_nickname" },
  { cat: "moderation", prompt: "purge the last 50 messages in this channel",                                             expect: "purge_messages" },
  { cat: "moderation", prompt: "find the last message from user 1234567890123456789 in this channel",                   expect: "find_message" },
  { cat: "moderation", prompt: "lockdown the entire server",                                                              expect: "lockdown_server" },
  { cat: "moderation", prompt: "unlock the server",                                                                      expect: "unlock_server" },
  { cat: "moderation", prompt: "move user 1234567890123456789 to voice channel 5555555555555555555",                    expect: "move_user_to_voice" },
  { cat: "moderation", prompt: "disconnect the user with id 1234567890123456789 from voice",                            expect: "disconnect_user_from_voice" },

  // ── Dynamic VC setup ──
  { cat: "vc_setup",   prompt: "set channel 1489058216703950939 as the create-vc trigger",                               expect: "set_create_vc_channel" },
  { cat: "vc_setup",   prompt: "make the vc template '{game} • {creator}'",                                              expect: "set_vc_template" },
  { cat: "vc_setup",   prompt: "set the default user limit for new temp vcs to 10",                                      expect: "set_vc_default_limit" },
  { cat: "vc_setup",   prompt: "set the vc naming mode to 'smart'",                                                      expect: "set_vc_naming_mode" },
  { cat: "vc_setup",   prompt: "enable rich presence in vc names",                                                       expect: "toggle_vc_rich_presence" },
  { cat: "vc_setup",   prompt: "set channel 5555555555555555555 as the afk channel",                                    expect: "set_afk_channel" },

  // ── Temp VC ──
  { cat: "temp_vc",    prompt: "lock my voice channel to 5 people",                                                      expect: "vc_lock" },
  { cat: "temp_vc",    prompt: "unlock my voice channel",                                                                 expect: "vc_unlock" },
  { cat: "temp_vc",    prompt: "make my voice channel private",                                                          expect: "vc_private" },
  { cat: "temp_vc",    prompt: "make my voice channel public",                                                           expect: "vc_public" },
  { cat: "temp_vc",    prompt: "rename my temp voice channel to 'Gaming Vibes'",                                         expect: "vc_rename" },
  { cat: "temp_vc",    prompt: "transfer ownership of my vc to user 1234567890123456789",                                expect: "vc_transfer" },
  { cat: "temp_vc",    prompt: "kick user 1234567890123456789 from my vc",                                               expect: "vc_kick" },
  { cat: "temp_vc",    prompt: "allow user 1234567890123456789 into my vc",                                              expect: "vc_allow" },
  { cat: "temp_vc",    prompt: "claim ownership of this vc",                                                             expect: "vc_claim" },
  { cat: "temp_vc",    prompt: "show info about my voice channel",                                                       expect: "vc_info" },

  // ── Server config / setup ──
  { cat: "srv_cfg",    prompt: "set the welcome channel to 5555555555555555555",                                         expect: "set_welcome_channel" },
  { cat: "srv_cfg",    prompt: "customize the welcome message to 'hi {user}, welcome'",                                  expect: "customize_welcome" },
  { cat: "srv_cfg",    prompt: "send a test welcome",                                                                    expect: "send_test_welcome" },
  { cat: "srv_cfg",    prompt: "set the access role to Member",                                                          expect: "set_access_role" },
  // setup_verification requires verified_role.
  { cat: "srv_cfg",    prompt: "set up verification for new members with the Verified role",                            expect: "setup_verification" },
  { cat: "srv_cfg",    prompt: "trust user 1234567890123456789",                                                         expect: "trust_user" },
  { cat: "srv_cfg",    prompt: "untrust user 1234567890123456789",                                                       expect: "untrust_user" },
  { cat: "srv_cfg",    prompt: "list all trusted users",                                                                 expect: "list_trusted" },
  { cat: "srv_cfg",    prompt: "set up the log channel as 5555555555555555555",                                          expect: "set_log_channel" },
  { cat: "srv_cfg",    prompt: "set autorole to Member",                                                                  expect: "set_autorole" },
  { cat: "srv_cfg",    prompt: "whitelist this server: discord.gg/abc123",                                               expect: "whitelist_server" },
  { cat: "srv_cfg",    prompt: "unwhitelist server 5555555555555555555",                                                 expect: "unwhitelist_server" },
  { cat: "srv_cfg",    prompt: "show the whitelist",                                                                     expect: "list_whitelist" },
  { cat: "srv_cfg",    prompt: "enable dm results for tool calls",                                                       expect: "set_dm_results" },
  { cat: "srv_cfg",    prompt: "enable dm welcome with message 'welcome to the server'",                                expect: "set_dm_welcome" },
  { cat: "srv_cfg",    prompt: "set the leave channel to 5555555555555555555",                                          expect: "set_leave_channel" },
  { cat: "srv_cfg",    prompt: "change your server avatar to https://example.com/pic.png",                              expect: "set_server_avatar" },
  { cat: "srv_cfg",    prompt: "change the server banner to https://example.com/banner.png",                            expect: "set_server_banner" },
  { cat: "srv_cfg",    prompt: "set this server's persona to 'cottage princess'",                                       expect: "set_server_persona" },
  { cat: "srv_cfg",    prompt: "set personality for channel 5555555555555555555 to extra sarcastic",                    expect: "set_channel_personality" },
  { cat: "srv_cfg",    prompt: "set bad words list to: cringe, mid",                                                     expect: "set_bad_words" },
  // set_escalation requires at least one of mute_at/kick_at/ban_at.
  { cat: "srv_cfg",    prompt: "set up automod escalation: auto-mute at 3 warnings, auto-kick at 5, auto-ban at 7",     expect: "set_escalation" },
  { cat: "srv_cfg",    prompt: "set up server stats channels",                                                           expect: "setup_stats_channels" },
  { cat: "srv_cfg",    prompt: "set up a starboard in channel 5555555555555555555 with 5 stars",                        expect: "setup_starboard" },
  { cat: "srv_cfg",    prompt: "toggle auto responders on",                                                              expect: "toggle_auto_responders" },
  { cat: "srv_cfg",    prompt: "toggle twin chat with eris on",                                                          expect: "toggle_twin_chat" },
  { cat: "srv_cfg",    prompt: "toggle voice tracking on",                                                               expect: "toggle_voice_tracking" },
  { cat: "srv_cfg",    prompt: "set up a ticket system in channel 5555555555555555555",                                 expect: "setup_ticket" },
  { cat: "srv_cfg",    prompt: "configure suggestions in channel 5555555555555555555",                                  expect: "configure_suggestions" },
  { cat: "srv_cfg",    prompt: "set a sticky message in channel 5555555555555555555 saying 'read the rules'",          expect: "sticky_message" },
  { cat: "srv_cfg",    prompt: "remove the sticky message in channel 5555555555555555555",                              expect: "remove_sticky" },
  { cat: "srv_cfg",    prompt: "toggle invite filter on",                                                                expect: "toggle_invite_filter" },

  // ── Music ──
  { cat: "music",      prompt: "play 'never gonna give you up' in voice",                                                expect: "play_music" },
  { cat: "music",      prompt: "skip this song",                                                                         expect: "skip_song" },
  { cat: "music",      prompt: "stop the music",                                                                         expect: "stop_music" },
  { cat: "music",      prompt: "pause the music",                                                                        expect: "pause_music" },
  { cat: "music",      prompt: "resume playback",                                                                        expect: "resume_music" },
  { cat: "music",      prompt: "what's playing right now?",                                                              expect: "now_playing" },
  { cat: "music",      prompt: "show the music queue",                                                                   expect: "music_queue" },
  { cat: "music",      prompt: "set the volume to 70",                                                                   expect: "set_volume" },
  { cat: "music",      prompt: "loop the current song",                                                                  expect: "toggle_loop" },
  { cat: "music",      prompt: "shuffle the music queue",                                                                expect: "shuffle_queue" },
  { cat: "music",      prompt: "apply the bass-boost filter",                                                            expect: "music_filter" },
  { cat: "music",      prompt: "start lyrics mode",                                                                      expect: "start_lyrics_mode" },
  { cat: "music",      prompt: "stop lyrics mode",                                                                       expect: "stop_lyrics_mode" },
  { cat: "music",      prompt: "auto-play lyrics for every song",                                                        expect: "auto_lyrics_mode" },

  // ── Notifications ──
  { cat: "notif",      prompt: "configure patch news for the valorant feed, post in channel 5555555555555555555",         expect: "configure_patch_news" },
  { cat: "notif",      prompt: "configure twitch notifications for shroud in channel 5555555555555555555",               expect: "configure_twitch" },
  // configure_youtube requires a 24-char YT channel ID (starts with UC), not a display name.
  { cat: "notif",      prompt: "set up youtube notifications for channel UCX6OQ3DkcsbYNE6H8uQQuVA in discord channel 5555555555555555555",  expect: "configure_youtube" },
  { cat: "notif",      prompt: "configure github notifications for octocat/hello-world in channel 5555555555555555555",  expect: "configure_github" },
  { cat: "notif",      prompt: "configure giveaway pings to use the Giveaway role",                                     expect: "configure_giveaway_pings" },
  { cat: "notif",      prompt: "show me the latest valorant patch notes as a test",                                     expect: "test_patch_news" },

  // ── Voice admin ──
  { cat: "voice_adm",  prompt: "toggle tts on for channel 5555555555555555555",                                         expect: "toggle_tts" },
  { cat: "voice_adm",  prompt: "set the tts voice to Charon",                                                           expect: "set_tts_voice" },
  { cat: "voice_adm",  prompt: "say 'hello world' in tts",                                                              expect: "say_tts" },
  { cat: "voice_adm",  prompt: "enable voice listen with wake word irene",                                              expect: "toggle_voice_listen" },

  // ── Birthdays ──
  { cat: "birthday",   prompt: "set my birthday to march 5",                                                             expect: "set_birthday" },
  { cat: "birthday",   prompt: "what's user 1234567890123456789's birthday?",                                            expect: "get_birthday" },
  { cat: "birthday",   prompt: "list everyone's birthdays",                                                              expect: "list_birthdays" },
  { cat: "birthday",   prompt: "remove user 1234567890123456789's birthday",                                              expect: "remove_birthday" },
  { cat: "birthday",   prompt: "configure birthdays in channel 5555555555555555555 with role Birthday",                 expect: "configure_birthdays" },
  { cat: "birthday",   prompt: "send a test birthday message",                                                          expect: "send_test_birthday" },

  // ── Info / queries ──
  { cat: "info",       prompt: "show me info on this server",                                                            expect: "get_server_info" },
  { cat: "info",       prompt: "show me info on user 1234567890123456789",                                               expect: "get_user_info" },
  { cat: "info",       prompt: "list all the channels here",                                                             expect: "list_channels" },
  { cat: "info",       prompt: "list all roles in this server",                                                          expect: "list_roles" },
  { cat: "info",       prompt: "show permissions for the Member role",                                                  expect: "get_role_permissions" },
  { cat: "info",       prompt: "list all custom emojis",                                                                expect: "list_emojis" },
  { cat: "info",       prompt: "show me banned users",                                                                  expect: "list_bans" },
  { cat: "info",       prompt: "pick a random member",                                                                   expect: "random_member" },
  { cat: "info",       prompt: "how many members are in this server?",                                                   expect: ["count_members", "get_server_info"] },
  { cat: "info",       prompt: "who has the Streamer role?",                                                            expect: "who_has_role" },
  { cat: "info",       prompt: "list all server members",                                                                expect: "list_members" },
  { cat: "info",       prompt: "list all server invites",                                                                expect: "list_invites" },
  { cat: "info",       prompt: "show invite stats",                                                                     expect: "invite_stats" },
  { cat: "info",       prompt: "show me the audit log",                                                                 expect: "view_audit_log" },

  // ── Messaging ──
  { cat: "msg_mgmt",   prompt: "send the message 'hello world' to channel 5555555555555555555",                          expect: "send_message" },
  { cat: "msg_mgmt",   prompt: "send an animated countdown embed to channel 5555555555555555555 with text 'GO'",        expect: "send_animated_message" },
  { cat: "msg_mgmt",   prompt: "edit message 9999999999999999999 in channel 5555555555555555555 to say 'updated'",      expect: "edit_message" },
  { cat: "msg_mgmt",   prompt: "delete message 9999999999999999999 in channel 5555555555555555555",                     expect: "delete_message" },
  { cat: "msg_mgmt",   prompt: "read the last 20 messages in channel 5555555555555555555",                              expect: "read_messages" },
  { cat: "msg_mgmt",   prompt: "search messages in channel 5555555555555555555 for 'announcement'",                     expect: "search_messages" },
  { cat: "msg_mgmt",   prompt: "pin message 9999999999999999999 in channel 5555555555555555555",                        expect: "pin_message" },
  { cat: "msg_mgmt",   prompt: "unpin message 9999999999999999999 in channel 5555555555555555555",                      expect: "unpin_message" },
  { cat: "msg_mgmt",   prompt: "list pinned messages in channel 5555555555555555555",                                   expect: "list_pins" },
  { cat: "msg_mgmt",   prompt: "react to message 9999999999999999999 in channel 5555555555555555555 with 🔥",            expect: "react_to_message" },
  { cat: "msg_mgmt",   prompt: "remove your 🔥 reaction on message 9999999999999999999 in channel 5555555555555555555", expect: "remove_reaction" },
  { cat: "msg_mgmt",   prompt: "create a thread in this channel called 'discussion'",                                    expect: "create_thread" },
  { cat: "msg_mgmt",   prompt: "create an invite for this channel that lasts 1 day",                                     expect: "create_invite" },
  { cat: "msg_mgmt",   prompt: "delete invite code abc123",                                                              expect: "delete_invite" },
  { cat: "msg_mgmt",   prompt: "add a custom emoji called 'pog' from https://example.com/pog.png",                      expect: "add_emoji" },
  { cat: "msg_mgmt",   prompt: "remove the 'pog' emoji",                                                                expect: "remove_emoji" },
  { cat: "msg_mgmt",   prompt: "set the server icon to https://example.com/icon.png",                                   expect: "set_server_icon" },
  { cat: "msg_mgmt",   prompt: "set server settings: verification level to medium",                                     expect: "set_server_settings" },

  // ── Custom commands / responders / events ──
  { cat: "cmd",        prompt: "add a custom command !rules that says 'check the rules channel'",                        expect: "create_custom_command" },
  { cat: "cmd",        prompt: "edit the !rules custom command to say 'see #rules'",                                    expect: "edit_custom_command" },
  { cat: "cmd",        prompt: "delete the custom command !rules",                                                       expect: "delete_custom_command" },
  { cat: "cmd",        prompt: "list all custom commands",                                                               expect: "list_custom_commands" },
  { cat: "cmd",        prompt: "create an auto responder: trigger 'gm', response 'good morning ☀️'",                    expect: "create_auto_responder" },
  { cat: "cmd",        prompt: "list all auto responders",                                                              expect: "list_auto_responders" },
  { cat: "cmd",        prompt: "delete the 'gm' auto responder",                                                         expect: "delete_auto_responder" },
  // manage_giveaway has an empty schema and just returns a redirect telling the user
  // to use the /giveaway slash command. Phrase the prompt as an explicit ask to use
  // the giveaway TOOL so the model picks it.
  { cat: "cmd",        prompt: "use the giveaway management tool to start a giveaway",                                  expect: "manage_giveaway" },
  // manage_scrim requires action='create' and game name.
  { cat: "cmd",        prompt: "create a valorant scrim lobby with 5v5 teams",                                          expect: "manage_scrim" },

  // ── Leveling ──
  { cat: "level",      prompt: "enable leveling in this server",                                                         expect: "toggle_leveling" },
  { cat: "level",      prompt: "set the Verified role as the reward for level 5",                                        expect: "set_level_reward" },
  { cat: "level",      prompt: "remove the level 5 reward",                                                              expect: "remove_level_reward" },
  { cat: "level",      prompt: "set the leveling channel to 5555555555555555555",                                       expect: "set_level_channel" },
  { cat: "level",      prompt: "set level-up ping roles to Member and VIP",                                              expect: "set_level_ping_roles" },
  { cat: "level",      prompt: "show the voice leaderboard",                                                             expect: "voice_leaderboard" },
  { cat: "level",      prompt: "show server milestones",                                                                 expect: "server_milestones" },

  // ── Twin ──
  { cat: "twin",       prompt: "ask eris to remind me in 1h to drink water",                                            expect: "ask_eris" },

  // ── Utility ──
  { cat: "util",       prompt: "calculate 23 * 47 + 12",                                                                 expect: "calculate" },
  { cat: "util",       prompt: "summarize the last 50 messages in this channel",                                         expect: "summarize_channel" },
  { cat: "util",       prompt: "search the web for current weather in tokyo",                                            expect: "web_search" },
  { cat: "util",       prompt: "read the page https://example.com/article",                                              expect: "scrape_url" },
  { cat: "util",       prompt: "send a gif of a cat dancing",                                                            expect: "send_gif" },
  // set_gif_style only accepts 'raw' or 'embed' per its enum.
  { cat: "util",       prompt: "set the gif style to raw — no embed border",                                            expect: "set_gif_style" },
  { cat: "util",       prompt: "opt me out of dms",                                                                      expect: "set_dm_preference" },
  { cat: "util",       prompt: "generate an image of a sunset over mountains",                                          expect: "generate_image" },
  { cat: "util",       prompt: "show me the last deleted message in this channel",                                      expect: "snipe" },
  { cat: "util",       prompt: "show me the last edited message",                                                       expect: "editsnipe" },
  { cat: "util",       prompt: "set a 30m reminder to drink water",                                                     expect: "set_reminder" },
  // The model may emit either canonical name; the executor's TOOL_ALIASES handles both.
  // Make the prompt explicit so the model picks cancel_reminder (not cancel_scheduled_task,
  // which is a different feature for automated bot tasks).
  { cat: "util",       prompt: "cancel my reminder with id 5",                                                          expect: ["cancel_reminder", "cancel_reminder"] },
];

// ─────────────────────────────────────────────────────────────────────────

async function callOpenRouterOnce(systemInstruction, userMessage, tools) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
      tools,
      tool_choice: "auto",
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const e = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function callOpenRouter(systemInstruction, userMessage, tools) {
  // One automatic retry on transient errors (network timeout, 5xx). Free-tier
  // routing is occasionally flaky; a single retry stabilizes the pass rate
  // without masking real bugs.
  try {
    return await callOpenRouterOnce(systemInstruction, userMessage, tools);
  } catch (err) {
    const status = err?.status;
    const transient = !status || status >= 500 || /timeout|aborted|fetch failed|econnreset/i.test(String(err.message));
    if (!transient) throw err;
    await sleep(1500);
    return await callOpenRouterOnce(systemInstruction, userMessage, tools);
  }
}

const TEXT_LEAK_RE = /\[tool[\s_-]?call:|\[function[\s_-]?call:|<tool_call>|<function_call>/i;

function inspect(data) {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const toolCalls = msg?.tool_calls || [];
  const content = String(msg?.content || "");
  return {
    hasStructured: Array.isArray(toolCalls) && toolCalls.length > 0,
    hasTextLeak: TEXT_LEAK_RE.test(content),
    toolCalls,
    content,
    finishReason: choice?.finish_reason,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSuite(name, tests, tools, sysPrompt) {
  console.log(`\n=== ${name.toUpperCase()} (${tests.length} tests, ${tools.length} tools available) ===`);
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const expectArr = Array.isArray(t.expect) ? t.expect : [t.expect];
    const pad = String(i + 1).padStart(3);
    process.stdout.write(`[${pad}/${tests.length}] ${t.cat.padEnd(11)} → ${(t.expect.toString()).padEnd(28)} `);
    try {
      const data = await callOpenRouter(sysPrompt, t.prompt, tools);
      const r = inspect(data);
      const calledNames = r.toolCalls.map((c) => c.function?.name);
      const matched = calledNames.some((n) => expectArr.includes(n));
      const verdict = matched ? "PASS" : (r.hasStructured ? "WRONG_TOOL" : (r.hasTextLeak ? "TEXT_LEAK" : "NO_CALL"));
      const detail = matched
        ? `(${calledNames.join(",")})`
        : r.hasStructured ? `(got ${calledNames.join(",")})`
        : r.hasTextLeak ? `(leak: "${r.content.slice(0, 60).replace(/\n/g, " ")}...")`
        : `("${r.content.slice(0, 60).replace(/\n/g, " ")}...")`;
      console.log(`${verdict} ${detail}`);
      results.push({ ...t, verdict, calledNames, content: r.content });
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({ ...t, verdict: "ERROR", error: err.message });
    }
    if (i < tests.length - 1) await sleep(DELAY_MS);
  }
  return results;
}

function summarize(name, results) {
  const total = results.length;
  const counts = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  console.log(`\n--- ${name} summary ---`);
  console.log(`  PASS:        ${counts.PASS || 0}/${total}`);
  console.log(`  WRONG_TOOL:  ${counts.WRONG_TOOL || 0}`);
  console.log(`  NO_CALL:     ${counts.NO_CALL || 0}`);
  console.log(`  TEXT_LEAK:   ${counts.TEXT_LEAK || 0}`);
  console.log(`  ERROR:       ${counts.ERROR || 0}`);

  // Per-category breakdown
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.cat]) byCategory[r.cat] = { pass: 0, total: 0, fails: [] };
    byCategory[r.cat].total++;
    if (r.verdict === "PASS") byCategory[r.cat].pass++;
    else byCategory[r.cat].fails.push(r);
  }
  console.log(`  By category:`);
  for (const [cat, { pass, total: t, fails }] of Object.entries(byCategory)) {
    const star = pass === t ? "✓" : "✗";
    console.log(`    ${star} ${cat.padEnd(11)} ${pass}/${t}`);
    for (const f of fails) {
      const detail = f.verdict === "WRONG_TOOL" ? `expected ${f.expect}, got ${f.calledNames?.join(",") || "?"}`
        : f.verdict === "NO_CALL" ? `no tool call`
        : f.verdict;
      console.log(`        - "${f.prompt.slice(0, 60)}..." → ${detail}`);
    }
  }
  return counts.PASS === total;
}

// Load tools from each bot's tools.js. Use file:// URL form so dynamic import
// works on Windows where path.join produces backslashes.
const toUrl = (p) => "file://" + p.replace(/\\/g, "/");
const erisTools = await loadTools(
  toUrl(join(__dirname, "..", "packages", "eris", "ai", "tools.js")),
  ["EVERYONE_TOOLS", "OWNER_TOOLS"],
);
const ireneTools = await loadTools(
  toUrl(join(__dirname, "..", "packages", "irene", "ai", "tools.js")),
  ["ADMIN_TOOLS", "EVERYONE_TOOLS"],
);

const sys = `${TOOL_CALL_DIRECTIVE}\n\nYou are a Discord bot. Call tools when the user asks you to do something. The user is the bot owner so all tools are available. The user's ID is 123456789012345678.`;

let allPass = true;
const erisResults = [];
const ireneResults = [];

if (target === "eris" || target === "both") {
  const r = await runSuite("Eris", ERIS_TESTS, erisTools, sys);
  erisResults.push(...r);
}
if (target === "irene" || target === "both") {
  const r = await runSuite("Irene", IRENE_TESTS, ireneTools, sys);
  ireneResults.push(...r);
}

console.log(`\n\n========== FINAL ==========`);
if (erisResults.length) allPass = summarize("Eris", erisResults) && allPass;
if (ireneResults.length) allPass = summarize("Irene", ireneResults) && allPass;

console.log(`\nmodel: ${model}`);
process.exit(allPass ? 0 : 1);
