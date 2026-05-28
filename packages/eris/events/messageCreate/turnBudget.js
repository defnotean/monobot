// ─── packages/eris/events/messageCreate/turnBudget.js ───────────────────────
// Force-research trigger + per-turn character budget heuristics. Prompt
// rules alone kept getting ignored, so the orchestrator stitches these
// deterministic hints onto the system instruction right before the AI call.

/**
 * Compute the per-turn character budget and any mandatory tool-call directives
 * to append to the system instruction. Returns the suffix to append plus the
 * resolved character budget (used later when trimming over-budget replies).
 *
 * @param {object} opts
 * @param {string} opts.cleanMessage Normalized user message.
 * @param {boolean} opts.isOwner    Whether the speaker is the bot owner.
 * @param {string} opts.authorId    Discord user ID of the speaker.
 * @returns {{ suffix: string, charBudget: number }}
 */
export function computeTurnBudget({ cleanMessage, isOwner, authorId }) {
  let suffix = "";
  // Default 250 matches eris-rules.md ceilings ("casual chat <150, factual <250").
  // Vent / research lanes need more headroom for empathetic / cited replies.
  let charBudget = 250;

  const t = (cleanMessage || "").toLowerCase();
  const isGreeting = /^(hi|hey|hello|yo|sup|wasup|what'?s up|how are (you|u)|hru|how r u|gm|gn|good (morning|night))[\s\.\!\?]*$/i.test(t);
  const isMusicShare = /(here'?s my (spotify|music|soundcloud)|check out my (music|spotify|soundcloud|stuff)|listen to my (music|stuff))/i.test(t);
  const factualQ = /\b(how many|how much|what year|what date|when did|when was|who invented|who discovered|who wrote|who (said|made|created)|what is the|what are the|define|formula for|number of|amount of|percentage of|layers? of|parameters?|stats? (on|for)|statistics|ratio of)\b/i.test(t);
  const whQuestion = /\b(what|which|who|when|where|why|how|how many|how much|how old|how long)\b[^?]{0,200}\?/i.test(t);
  const challenge = /(you'?re wrong|ur wrong|that'?s wrong|thats wrong|hallucinat|look it up|do research|google it|verify (that|this)|my book says|book says|source\??$|cite (this|that)|no you are|no u are)/i.test(t);
  const studyCtx = /(homework|quiz|test question|exam|fill.?in.?the.?blank|multiple choice|word bank|assignment|textbook|chapter \d|inquizitive)/i.test(t);
  const needsResearch = !isGreeting && !isMusicShare && t.length >= 5 && (factualQ || whQuestion || challenge || studyCtx);
  const isVent = /(im sad|i'?m sad|venting|im upset|i'?m upset|had a bad day|something happened|my day|just need to talk|i feel like)/i.test(t);
  if (needsResearch) {
    suffix += `\n\n[MANDATORY_SEARCH — THIS MESSAGE REQUIRES RESEARCH]\nThe user's message has been flagged as a factual question, assignment, or factual challenge. Your FIRST action this turn MUST be a web_search tool call. You are forbidden from outputting ANY text, disclaimer, hedge, or answer BEFORE the search results come back. No "let me check" preamble — just call the tool. If the question has multiple independent parts, fire multiple parallel web_search calls in this same turn. After the search results arrive, answer in ONE short reply (under ~250 chars) that pairs the answer with the reason drawn from the search results. Do NOT claim you "just checked" unless a web_search call appears in this turn's tool history. If no useful results came back, say honestly "couldnt find solid info on that" — do not fill in from memory.`;
  }
  // Whitelist owner-action force — same hallucination pattern as Irene:
  // weaker models refuse owner-only whitelist tools in prose ("only the
  // bot owner can manage the whitelist") instead of calling the tool,
  // even when boss is the requester. Force a structured call.
  const whitelistVerb = /\b(whitelist|unwhitelist|delist)\b/i.test(t)
    && /\b(remove|delete|drop|kick|off|out|unwhitelist|delist|add|whitelist|list|show|view)\b/i.test(t);
  if (isOwner && whitelistVerb) {
    suffix += `\n\n[MANDATORY_WHITELIST_ACTION — boss is asking about the server whitelist]\nThe user (verified Discord ID ${authorId}) IS the bot owner. Your owner-only tools — list_whitelist, whitelist_server, unwhitelist_server — ARE callable for them THIS turn. Emit a structured tool call right now. Do NOT respond in prose with "only the bot owner can manage the whitelist" or any variant — that text is FACTUALLY WRONG because the requester IS the owner. If they named a server (e.g. "jett") without an ID, call list_whitelist first to get the guild ID, then unwhitelist_server with that ID.`;
  }
  charBudget = isVent ? 600 : needsResearch ? 400 : 250;
  suffix += `\n\n[LENGTH BUDGET — this turn: VISIBLE reply text MUST be ≤ ${charBudget} characters. count your output chars. replies over this limit will be truncated by the system at the last sentence boundary. 1 short sentence if possible, 2 max. no preamble ("ok so", "anyway"), no trailing wrap-up ("pretty insane tbh"), no speculation past what you know for sure. TOOL CALLS AND THEIR ARGUMENTS DO NOT COUNT — emit them whenever they're needed regardless of this budget.]`;

  // Identity reminder — fresh every turn so the model doesn't drift into
  // self-mentions like "@Eris" when meaning the sister. The post-processor
  // strips self-pings as a safety net, but this prevents the confusion at
  // the source.
  suffix += `\n\n[IDENTITY — YOU ARE ERIS. Your twin sister is IRENE. When you reference your sister by name in visible text, write "Irene" (or "@Irene" to actually ping her), never "Eris". Never @-mention yourself. If you're tempted to write "@Eris" in your own reply, you almost certainly meant your sister — write "@Irene" instead.]`;

  return { suffix, charBudget };
}
