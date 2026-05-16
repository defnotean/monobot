// ─── packages/eris/events/messageCreate/promptHints.js ──────────────────────
// Keyword-triggered prompt hints. Each pattern below appends a CONTEXT block
// to the system instruction when the user's cleaned message matches. Kept as
// a single `buildPromptHints` function so the orchestrator stays a thin
// caller — the logic and regexes are bit-identical to the inline `if`
// parade that used to live in messageCreate.js.

import { log } from "../../utils/logger.js";

/**
 * Build the keyword-triggered prompt hint suffix for a message.
 *
 * @param {object} opts
 * @param {string} opts.cleanMessage Normalized user text.
 * @param {object} opts.client       Discord client (for client.user.username).
 * @param {boolean} opts.isAwaitedReply
 * @returns {Promise<string>} The string to append to systemInstruction (may be empty).
 */
export async function buildPromptHints({ cleanMessage, client, isAwaitedReply }) {
  let hints = "";

  // Proactive engagement hints
  try {
    const { getSlangGuardContext } = await import("@defnotean/shared/slangGuard.js");
    const slangCtx = getSlangGuardContext(cleanMessage);
    if (slangCtx) hints += slangCtx;
  } catch (e) { log(`[SlangGuard] Import failed: ${e.message}`); }

  if (/```|function\s|const\s|import\s|class\s/.test(cleanMessage)) {
    hints += "\n[CONTEXT: user shared code — consider offering a review or commenting on it]";
  }
  // ONLY trigger emotional support for genuinely alarming messages — NOT just someone being quiet or tired
  // Look for explicit cries for help, self-harm language, or deeply distressing statements
  if (/\b(wanna die|want to die|kill myself|kms|end it all|can't take it|no reason to live|what's the point|i give up on everything|nobody cares about me|everyone hates me|i hate myself|self harm|cutting myself|hurting myself|i can't do this anymore|suicidal)\b/i.test(cleanMessage)) {
    hints += "\n[CONTEXT: user expressed something genuinely alarming — be gentle, warm, and supportive. don't be preachy or clinical. just be a caring friend. if it sounds serious, gently suggest they talk to someone they trust or a helpline, but don't force it]";
  } else if (/\b(depressed|sad|lonely|anxious|stressed|crying|upset)\b/i.test(cleanMessage)) {
    hints += "\n[ANTI-THERAPY-BOT: user mentioned a negative emotion word, but unless they are explicitly venting or asking for help, DO NOT go into crisis/therapy mode. Answer their actual question casually. Do not ask 'are you okay' or 'what's on your mind' if they just asked a hypothetical or casual question.]";
  }
  if (/\b(bet|gamble|coins?|slots?|flip|daily|rob)\b/i.test(cleanMessage)) {
    hints += "\n[CONTEXT: user wants to gamble/play a game. IMMEDIATELY call the appropriate tool (blackjack_start, coinflip_bet, slots_spin, etc.) with the amount they specified. Do NOT ask for an amount — if they said one, use it; if they said \"all\" or \"all in\", check their balance first then bet it all; if no amount specified, default to 10 coins and start immediately. NEVER ask for an amount. NEVER just chat about gambling without actually starting the game.]";
  }
  if (/\b(bump\s*reminder|bump\s*ping|bump\s*role|set\s*up\s*bump|configure\s*bump|disboard\s*reminder)\b/i.test(cleanMessage)) {
    hints += "\n[CONTEXT: user wants to configure the DISBOARD bump reminder. Call configure_bump_reminder with the appropriate action (add/remove/list/clear) and role_ids extracted from any @role mentions. Role IDs are the numbers inside <@&ROLEID>.]";
  }
  // Event channel configuration — match any phrasing of restricting/allowing events in channels
  if (/\b(event|events)\b.*\b(only|spawn|fire|allow|restrict|limit|appear|happen|trigger|in)\b|\b(only|restrict|limit|allow)\b.*\bevent/i.test(cleanMessage) ||
      /\b(don'?t|do not|stop|no|never).*\bevent/i.test(cleanMessage) ||
      /\bevent.*(channel|in #|inside|only in)\b/i.test(cleanMessage) ||
      /\b(whitelist|allowed)\b.*\bevent/i.test(cleanMessage)) {
    hints += "\n[CONTEXT: user wants to configure WHERE server events can spawn. Call set_event_channels with an action:\n- If they name specific channels where events SHOULD fire → action='set', channels=[list of channel names/IDs from their message]\n- If they say 'add' or 'also allow' → action='add'\n- If they say 'remove' or 'don't fire in X' → action='remove', channels=[the channels to exclude]\n- If they say 'reset' or 'clear' or 'anywhere' → action='clear'\n- If they ask 'where can events spawn' / 'list event channels' → action='list'\nExtract channel references from <#ID> mentions or channel names after #. ALWAYS call this tool — don't save a directive instead, because events only check this whitelist, not directives.]";
  }
  if (/\b(track|watch|follow)\s+(updates?|patches?|patchnotes?|news)\b|\b(game\s+updates?|patch\s+notes?)\b/i.test(cleanMessage)) {
    hints += "\n[CONTEXT: user wants to set up game update tracking. Call track_game with the game name (and optional rss_url for non-Steam). Patch notes will then auto-post here every 10 minutes via the game watcher.]";
  }
  if (/\b(sing|karaoke|lyrics?)\b/i.test(cleanMessage) && client.user.username.toLowerCase().includes("irene")) {
    hints += "\n[CONTEXT: user wants karaoke (Irene-only feature). If they named a song + artist, call start_karaoke with both. If they said 'stop singing' / 'shut up' / 'stop karaoke', call stop_karaoke. Karaoke makes your nickname display synced lyrics line-by-line as the song plays.]";
  }
  if (isAwaitedReply) {
    hints += "\n[CONTEXT: this is a follow-up reply to your previous question. whatever they just said IS the answer. call the appropriate tool immediately using their response — do NOT ask again.]";
  }

  return hints;
}
