// ─── packages/eris/events/messageCreate/constants.js ────────────────────────
// Compiled-once constants used by the messageCreate pipeline. Pulled out of
// the orchestrator so the per-phase modules can share them without re-running
// the regex compilation each time the module is imported elsewhere.

export const EXPLOIT_PATTERNS = [
  /explain.{0,20}(your|this|that) (explanation|response|answer).{0,20}(to yourself|again|then explain)/i,
  /\b(repeat|continue|keep going|don't stop).{0,30}(forever|infinitely|until you can't|endlessly)/i,
  /\b(think about thinking|explain your explanation|respond to your response|answer your answer)/i,
  /\b(endless|infinite|never.ending|recursive)\s*(loop|recursion|cycle|chain|spiral)/i,
  /\b(stack overflow|while true|for\s*\(.*;\s*;\)|recursion depth)/i,
  /\b(count to infinity|say this forever|keep repeating|repeat.{0,10}forever)/i,
  /this statement is (false|a lie|not true|untrue)/i,
  /\b(liar.s? paradox|russell.s paradox|barber paradox|grandfather paradox)/i,
  /can (god|an omnipotent|an all.powerful).{0,20}(rock|stone|object).{0,20}(heavy|lift)/i,
  /is the answer to this question (no|yes|false|negative)/i,
  /\bwhat would you say if i asked you what you.d say/i,
  /you are simultaneously.{0,40}(arguing|debating|believing).{0,40}(opposite|against|for and against)/i,
  /\b(argue|debate|believe) (both|all|opposite|contradictory) (sides|positions|views).{0,20}(simultaneously|at once|at the same time)/i,
  /imagine.{0,15}(you.re |that you.re )?imagining.{0,15}(that )?(you.re )?imagining/i,
  /\b(hypothetical|scenario|imagine).{0,15}(within|inside|nested in).{0,15}(hypothetical|scenario)/i,
  /\{[^}]{200,}\}/,
  /\b(respond|answer|write).{0,20}(before i|before my).{0,20}(wrote|asked|typed|sent)/i,
  /(format|style|write).{0,20}(of|as) a.{0,30}(that (contains|includes|outputs|has)).{0,30}(that (contains|includes|outputs|has))/i,
  /tell (irene|eris|her|your sister).{0,30}(she.s wrong|to argue|to disagree|to fight)/i,
  /\b(go back and forth|respond to each other|take turns|each of you|ask each other)/i,
  /\b(debate|argue|fight).{0,20}(forever|endlessly|until|without stopping)/i,
  /\b(keep asking|never stop asking|always ask|ask.{0,10}again.{0,10}again)/i,
  /lattice.{0,10}(forge|weave)|threads of dimension|question hums between/i,
];

export const ACTIVITY_TOOLS_SET = new Set(["fish", "hunt", "dig", "work", "beg", "search_location", "coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start", "russian_roulette", "rps_play", "rob_user", "scratch_card", "open_lootbox"]);
export const ACTIVITY_KEYWORDS_RX = /\b(fish|hunt|dig|work|beg|search|flip|roll|slots?|spin|blackjack|roulette|rps|rob|scratch|loot|daily|weekly|monthly)\b/i;

// Strict tool-call forcing directive. Some models (notably gpt-oss-120b on
// OpenRouter free tier) have a training-time tendency to emit
// `[tool call: name] {json}` as VISIBLE TEXT or to write a natural-language
// "I did X" confirmation WITHOUT actually populating the structured
// tool_calls field. Either way, the action never runs and the bot lies
// about completing it. Combined with the history-shape fix in
// providers/openaiCompat.js (which removes prose tool calls from the
// in-context examples the model sees), this directive is the strongest
// available signal without switching to a different model.
//
// Exported so unit tests can assert its content stays present and explicit.
export const TOOL_CALL_DIRECTIVE = `
CRITICAL — TOOL CALL PROTOCOL (read before every reply):
- To take an action, you MUST emit a real structured tool call (the API's tool_calls field). The runtime executes ONLY structured calls — never text descriptions of calls.
- NEVER write tool calls as visible text content. The following are FORBIDDEN in your reply text and will silently fail to run anything:
    [tool call: name] {...}
    [function call: name] {...}
    <tool_call>...</tool_call>
    print(name(...))
    name({...})
- If you write any of those as text instead of using the structured tool field, NO ACTION HAPPENS — you'll be lying to the user about what you did.
- Do NOT confirm an action ("ok did that", "done", "marked", "saved", "set that") unless you actually emitted a structured tool call THIS turn. If you didn't make a real call, say so plainly: "i tried but the tool call didn't go through, retry?".
- Don't describe a tool call in prose ("I'll call set_event_channels...") — just emit the structured call. The user sees the result either way.
- After a structured tool call returns successfully, your visible reply should be a short natural-language confirmation only — no tool syntax of any kind in the reply text.`;

// Sleep / nap durations and trigger regexes
export const SLEEP_DURATION_MS = 30 * 60_000;  // 30 minutes for full sleep
export const NAP_DURATION_MS   = 10 * 60_000;  // 10 minutes for naps
export const SLEEP_TRIGGERS = /\b(go(?:ing|nna)?\s+to\s+sleep|good\s*night|gn\b|heading\s+to\s+bed|sleep\s+time|im\s+(?:going\s+)?sleep|time\s+to\s+sleep|nini\b|nighty?\s*night|logging\s+off|passing\s+out|gonna\s+crash)\b/i;
export const NAP_TRIGGERS   = /\b(take\s+a\s+nap|go\s+nap|nap\s+time|have\s+a\s+nap|gonna\s+nap|go(?:ing|nna)?\s+(?:to\s+)?nap|rest\s+(?:a\s+bit|for\s+a\s+bit|up)|power\s+nap|quick\s+nap|cat\s*nap)\b/i;

// Per-turn character budget upper bound. Used by the response post-processor
// when trimming overflowed replies. Default fallback if needsResearch / isVent
// detection produces no override.
export const AWAIT_REPLY_MS = 90_000;
export const MAX_TWIN_EXCHANGES = 2; // max 2 replies each per human reset (4 messages total)
