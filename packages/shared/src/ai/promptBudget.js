export const DEFAULT_PROMPT_CHAR_BUDGET = 100000;
export const DEFAULT_RUNTIME_ANCHOR = "\n\n[Currently speaking:";
export const DEFAULT_MIN_CORE_CHARS = 4000;

/**
 * @param {number | string | null | undefined} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function resolvePromptCharBudget(value, fallback = DEFAULT_PROMPT_CHAR_BUDGET) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @typedef {object} PromptBudgetOptions
 * @property {number | string} [budget]
 * @property {string} [runtimeAnchor]
 * @property {number} [minCoreChars]
 * @property {(message: string) => void} [log]
 */

/**
 * @param {string} prompt
 * @param {PromptBudgetOptions} [options]
 * @returns {string}
 */
export function applyPromptBudget(prompt, {
  budget = DEFAULT_PROMPT_CHAR_BUDGET,
  runtimeAnchor = DEFAULT_RUNTIME_ANCHOR,
  minCoreChars = DEFAULT_MIN_CORE_CHARS,
  log,
} = {}) {
  const promptBudget = resolvePromptCharBudget(budget);
  let systemInstruction = prompt;

  if (systemInstruction.length > promptBudget) {
    const runtimeStart = systemInstruction.indexOf(runtimeAnchor);
    if (runtimeStart > 0) {
      const runtime = systemInstruction.slice(runtimeStart);
      const coreRoom = Math.max(minCoreChars, promptBudget - runtime.length);
      const core = systemInstruction.slice(0, Math.min(runtimeStart, coreRoom));
      systemInstruction = core + runtime;
    }

    if (systemInstruction.length > promptBudget) {
      systemInstruction = systemInstruction.slice(0, promptBudget);
    }

    log?.(`[PERF] Prompt budgeted to ${systemInstruction.length} chars`);
  }

  return systemInstruction;
}
