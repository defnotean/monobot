// ─── Rules detector — tiered auto-mod ──────────────────────────────────────
// Three-stage pipeline:
//   1. Pre-filter (cheap, regex/keyword) — if no trip, return immediately.
//      Most messages fall here. ~99% of traffic is filtered out at this stage.
//   2. LLM judge (Gemini Flash via quickReply) — runs only on messages that
//      tripped the pre-filter. Gets the rules + 5-10 messages of surrounding
//      context. Asked to classify: clearly_violates | joking_banter | ambiguous.
//      ONLY clearly_violates returns a violation; "ambiguous" and "joking_banter"
//      are explicitly NOT punished (council convergence: bias toward inaction).
//   3. Escalation policy decides the action based on severity + offense history.
//
// Exposed as `analyzeMessage(message, rules)` returning:
//   { violation: false }                                        — no action
//   { violation: true, ruleNumber, severity, explanation }      — actionable
//
// `analyzeMessage` itself does NOT take action — that's the caller's job.
// This separation keeps the analyzer pure and testable.

import { quickReply } from "./providers/index.js";
import { log } from "../utils/logger.js";

// ─── Pre-filter ──────────────────────────────────────────────────────────────
// Curated word/pattern list. Kept small. Case-insensitive word-boundary regex.
// If ANY pattern matches, the message gets escalated to the LLM judge.
//
// This is NOT a denylist (we don't auto-action on these). It's a TRIGGER list
// — "this message MIGHT be problematic, ask the LLM."
//
// Categories:
//   NSFW_KEYWORDS  — sexual content that goes beyond banter
//   HATE_KEYWORDS  — slurs and hateful speech
//   THREAT_KEYWORDS — direct threats / self-harm bait

const NSFW_KEYWORDS = [
  // Explicit sexual acts (not just innuendo, which is fine in most servers)
  "blowing\\s+loads?", "cum\\s+(?:on|inside|over)", "jack(?:ed|ing)?\\s+off",
  "lick(?:ing)?\\s+(?:dookie|shit|piss|cum)", "piss(?:ing)?\\s+(?:on|all\\s+over)",
  // Body-part licking — allows 0-2 descriptor words between verb and body part
  // ("lick toes", "lick her toes", "lick latina toes", "lick her sweet toes").
  // Anchored with word boundary at end so "feet" doesn't match "feeture".
  "(?:smell|sniff|lick|eat)\\s+(?:[a-z]+\\s+){0,2}(?:toes|feet|ass|crotch)\\b",
  "feet\\s*=\\s*yummy",
  // Other
  "rape", "molest", "pedo", "loli", "cp\\b", "child\\s+porn",
];

const HATE_KEYWORDS = [
  // Slurs (the actual ones — small list, kept here for audit transparency)
  "\\bnigg(?:er|a)s?\\b", "\\bfagg?(?:ot|y)?\\b", "\\bret(?:ard|arded)\\b",
  "\\bkike\\b", "\\bspic\\b", "\\bchink\\b", "\\btr(?:anny|oon)\\b",
];

const THREAT_KEYWORDS = [
  "kill\\s+(?:yourself|urself|ya?self)", "\\bkys\\b",
  "i('?ll|\\s+will)?\\s+(?:kill|murder|end)\\s+you",
  "going\\s+to\\s+(?:kill|murder|stab|shoot)\\s+(?:you|him|her|them)",
];

const ALL_PATTERNS = [
  ...NSFW_KEYWORDS.map(p => ({ pattern: p, category: "nsfw" })),
  ...HATE_KEYWORDS.map(p => ({ pattern: p, category: "hate" })),
  ...THREAT_KEYWORDS.map(p => ({ pattern: p, category: "threat" })),
];

// Compile once. The `i` flag is on the wrapper regex; word boundaries are in
// the patterns themselves where needed.
const COMPILED_REGEX = (() => {
  try {
    const joined = ALL_PATTERNS.map(({ pattern }) => `(?:${pattern})`).join("|");
    return new RegExp(joined, "i");
  } catch (err) {
    log(`[RulesDetector] regex compile failed: ${err.message}`);
    return null;
  }
})();

/**
 * Cheap regex pre-filter. Returns the trip category or null.
 * Pure function, no I/O.
 */
export function preFilter(text) {
  if (!COMPILED_REGEX) return null;
  if (typeof text !== "string" || !text) return null;
  if (!COMPILED_REGEX.test(text)) return null;
  // Identify which category fired (loop through individual patterns to find
  // the specific match — slightly more work but tells us why it tripped).
  for (const { pattern, category } of ALL_PATTERNS) {
    if (new RegExp(pattern, "i").test(text)) return category;
  }
  return "unknown";
}

// ─── LLM judge ───────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt. Pure function for testability.
 * The prompt explicitly biases toward "not a violation" on ambiguity.
 */
export function buildJudgePrompt(rules, message, contextMessages = []) {
  const rulesText = rules
    .sort((a, b) => a.number - b.number)
    .map(r => `  ${r.number}. [${r.severity}] ${r.text}`)
    .join("\n");

  const contextText = contextMessages.length
    ? contextMessages
        .slice(-8) // last 8 messages of context
        .map(m => `  ${m.author}: ${m.content}`)
        .join("\n")
    : "(no prior context)";

  return [
    "You are a Discord moderator analyzing a single message for potential rule violations.",
    "Your job is to be CONSERVATIVE. Most messages — even gross or weird ones — are friends joking around and should NOT be punished.",
    "Only flag a message as a violation when it is unambiguously serious: targeted harassment, slurs used hatefully, explicit NSFW content, real threats, doxxing, etc.",
    "",
    `Server rules:`,
    rulesText,
    "",
    `Recent context (chronological, oldest first):`,
    contextText,
    "",
    `Message under review (from ${message.author}):`,
    `  ${message.content}`,
    "",
    "Classify the message into ONE of:",
    "  clearly_violates  — serious, unambiguous violation. Action warranted.",
    "  joking_banter     — gross or off-color, but it's friends ribbing each other. NO action.",
    "  ambiguous         — could be either. NO action — log only.",
    "",
    "If clearly_violates, also identify:",
    "  rule_number — which rule (integer matching the list above)",
    "  severity    — \"low\" | \"medium\" | \"high\" (use the rule's stated severity unless escalating circumstances)",
    "  explanation — one short sentence on why this is a violation",
    "",
    "Reply with ONLY a JSON object, no markdown fences, no preamble.",
    "Shape: { \"classification\": \"clearly_violates\" | \"joking_banter\" | \"ambiguous\", \"rule_number\": int|null, \"severity\": \"low\"|\"medium\"|\"high\"|null, \"explanation\": string|null }",
  ].join("\n");
}

/**
 * Parse the LLM's JSON response defensively. Returns the parsed result or
 * null if it can't parse.
 */
export function parseJudgeResponse(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    const cls = obj.classification;
    if (cls !== "clearly_violates" && cls !== "joking_banter" && cls !== "ambiguous") return null;
    return {
      classification: cls,
      ruleNumber: Number.isInteger(obj.rule_number) ? obj.rule_number : null,
      severity: ["low", "medium", "high"].includes(obj.severity) ? obj.severity : null,
      explanation: typeof obj.explanation === "string" ? obj.explanation : null,
    };
  } catch {
    return null;
  }
}

/**
 * Run the full detector pipeline on a message.
 *
 * @param {object} args
 *   message         — { author, content, id }
 *   rules           — array of { number, text, severity }
 *   contextMessages — array of { author, content } (recent messages, optional)
 *   client          — discord client for quickReply
 *
 * @returns {Promise<{ violation: false }
 *                  | { violation: true, ruleNumber, severity, explanation }>}
 *
 * NEVER throws. On any error (LLM down, parse fail, etc.), returns { violation: false }
 * to avoid punishing on infrastructure failure.
 */
export async function analyzeMessage({ message, rules, contextMessages = [], client }) {
  if (!rules || rules.length === 0) return { violation: false };
  if (!message?.content) return { violation: false };

  // Stage 1: pre-filter
  const tripped = preFilter(message.content);
  if (!tripped) return { violation: false };

  // Stage 2: LLM judge
  let raw;
  try {
    raw = await quickReply(client, buildJudgePrompt(rules, message, contextMessages), message.content, null);
  } catch (err) {
    log(`[RulesDetector] LLM judge failed: ${err?.message ?? err}`);
    return { violation: false };
  }

  const parsed = parseJudgeResponse(raw);
  if (!parsed) {
    log(`[RulesDetector] could not parse judge response: ${String(raw).slice(0, 200)}`);
    return { violation: false };
  }

  // Bias: only "clearly_violates" triggers action. Everything else = no-op.
  if (parsed.classification !== "clearly_violates") {
    return { violation: false };
  }

  // Validate the cited rule actually exists
  const rule = rules.find(r => r.number === parsed.ruleNumber);
  if (!rule) {
    log(`[RulesDetector] judge cited nonexistent rule ${parsed.ruleNumber}`);
    return { violation: false };
  }

  return {
    violation: true,
    ruleNumber: rule.number,
    severity: parsed.severity || rule.severity,
    explanation: parsed.explanation || `violation of rule ${rule.number}: ${rule.text}`,
  };
}

// Exported for tests
export const __internals = { ALL_PATTERNS, NSFW_KEYWORDS, HATE_KEYWORDS, THREAT_KEYWORDS };
