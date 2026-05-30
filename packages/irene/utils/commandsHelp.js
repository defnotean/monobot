// ─── Commands awareness ─────────────────────────────────────────────────────
// Builds a compact "here are your slash commands" string for Irene's system
// prompt. So when a user asks "how do I X", she suggests a real command
// instead of hallucinating one.
//
// Pure function: takes a Discord client.commands Map (or anything with
// .entries()) and returns a string. Safe to call with empty/missing input.

const MAX_DESCRIPTION_CHARS = 80;

/**
 * Format a single command into one line.
 * Returns "/{name} — {description}" with description trimmed.
 */
export function formatCommandLine(name, command) {
  const desc = command?.data?.description ?? "";
  const trimmed = String(desc).slice(0, MAX_DESCRIPTION_CHARS);
  return trimmed
    ? `/${name} — ${trimmed}`
    : `/${name}`;
}

/**
 * Build the system-prompt block listing all loaded slash commands.
 * Returns "" if no commands (so the caller can `if (block) prompt += block`).
 *
 * @param {Map<string, any> | Iterable<[string, any]>} commands
 *   Discord.js client.commands or a Map-like iterable of [name, commandModule]
 */
export function buildCommandsContext(commands) {
  if (!commands) return "";
  const _cmds = /** @type {any} */ (commands);
  const entries = typeof _cmds.entries === "function"
    ? [..._cmds.entries()]
    : Array.from(_cmds ?? []);
  if (entries.length === 0) return "";

  const lines = entries
    .map(([name, cmd]) => formatCommandLine(name, cmd))
    .sort();

  return [
    "[YOUR SLASH COMMANDS — these are the actual commands installed in this server.",
    "When a user asks how to do something, suggest a real command from this list.",
    "DO NOT invent commands. If nothing here matches, say so honestly:",
    ...lines,
    "]",
  ].join("\n");
}

export const __internals = { MAX_DESCRIPTION_CHARS };
