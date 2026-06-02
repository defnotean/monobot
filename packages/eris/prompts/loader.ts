// ─── Prompt Loader: reads .md personality files and combines them ──────────

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const content = readFileSync(join(__dirname, `${name}.md`), "utf8");
  cache.set(name, content);
  return content;
}

export function clearCache(): void {
  cache.clear();
}

/**
 * Build the full Eris personality prompt from separate .md files.
 * Template variables like {{OWNER_ID}} are replaced with actual values.
 *
 * The prompt uses "eris" as the default name throughout. When a server has a
 * custom persona via set_server_persona, messageCreate.js replaces all
 * occurrences of "eris" with the custom name using regex. This means:
 * - The .md files should always reference "eris" (lowercase)
 * - Per-server renaming happens at runtime, not here
 * - Custom personality text from set_server_persona fully overrides this prompt
 */
export function buildPersonality(ownerId: string, ownerName = "defnotean"): string {
  const parts = [
    loadPrompt("eris-personality"),
    loadPrompt("eris-tool-guide"),
    loadPrompt("eris-relationships")
      .replace(/\{\{OWNER_ID\}\}/g, ownerId)
      .replace(/\{\{OWNER_NAME\}\}/g, ownerName),
    loadPrompt("eris-rules"),
  ];
  return parts.join("\n\n");
}

/**
 * Apply a server-specific name override to a personality prompt.
 * Replaces all occurrences of "eris"/"Eris" with the custom name.
 */
export function applyNameOverride(prompt: string, customName: string): string {
  if (!customName || customName.toLowerCase() === "eris") return prompt;
  return prompt.replace(/\beris\b/gi, customName).replace(/\bEris\b/g, customName);
}
