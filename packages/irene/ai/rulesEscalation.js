// ─── Rules escalation policy ─────────────────────────────────────────────────
// Maps (severity, prior offense count for this user+rule) → an action.
// Pure function — takes the violation context and returns an action descriptor.
// The caller actually performs the punishment (delete, timeout, etc.).
//
// Per council convergence:
//   • No auto-ban. Bans are mod-only — auto-ban is too aggressive and the
//     punishment ladder for serious repeat offenders maxes at 24h timeout.
//     If it gets to that point, mods take over.
//   • "low" severity ignores the first offense entirely (silent log only).
//   • "high" severity skips ahead one step (1st offense gets a timeout,
//     not a warning).
//
// Action descriptor shape:
//   {
//     kind:    "log_only" | "delete" | "warn" | "timeout" | "delete_and_timeout"
//     reason:  string       — human-friendly, included in mod-log embed
//     timeoutMs: number?    — only for "timeout" / "delete_and_timeout"
//     deleteMessage: bool   — should we also delete the offending message?
//   }

const TIMEOUT_LADDER_MS = [
  10 * 60_000,        // 10 min
  60 * 60_000,        // 1 hr
  6 * 60 * 60_000,    // 6 hr
  24 * 60 * 60_000,   // 24 hr
];

/**
 * Decide what to do given:
 *   severity        — "low" | "medium" | "high" — the cited rule's severity
 *   priorOffenses   — number of prior violations of THIS rule by THIS user (30-day window)
 *   ruleText        — the rule text (for the action's `reason` field)
 *   ruleNumber      — for citation
 *
 * Returns an action descriptor (see top of file).
 */
export function decideAction({ severity = "medium", priorOffenses = 0, ruleText = "", ruleNumber = 0 } = {}) {
  // Effective offense count — high severity skips one rung, low severity adds one.
  let effective = priorOffenses;
  if (severity === "high") effective += 1;
  else if (severity === "low") effective -= 1;

  const cite = ruleText
    ? `rule ${ruleNumber}: "${ruleText.slice(0, 100)}${ruleText.length > 100 ? "…" : ""}"`
    : `rule ${ruleNumber}`;

  // effective < 0  → silent log (low severity, first offense)
  if (effective < 0) {
    return {
      kind: "log_only",
      reason: `first low-severity offense for ${cite} — logged, no action`,
      deleteMessage: false,
      timeoutMs: 0,
    };
  }

  // effective === 0  → delete + warn
  if (effective === 0) {
    return {
      kind: "warn",
      reason: `${cite}`,
      deleteMessage: true,
      timeoutMs: 0,
    };
  }

  // effective 1..4  → timeouts via ladder
  const ladderIdx = Math.min(effective - 1, TIMEOUT_LADDER_MS.length - 1);
  const timeoutMs = TIMEOUT_LADDER_MS[ladderIdx];
  return {
    kind: "delete_and_timeout",
    reason: `${cite} (offense ${effective + 1})`,
    deleteMessage: true,
    timeoutMs,
  };
}

export { TIMEOUT_LADDER_MS };
