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
 * Build the full Irene personality prompt from separate .md files.
 * Template variables like {{OWNER_ID}} are replaced with actual values.
 *
 * Like Eris, the prompt uses "irene" as the default name. Per-server
 * renaming via set_server_persona happens at runtime in messageCreate.js.
 * Custom personality text from set_server_persona fully overrides this prompt.
 */
export function buildPersonality(ownerId: string, ownerName = "defnotean"): string {
  return loadPrompt("irene-personality")
    .replace(/\{\{OWNER_ID\}\}/g, ownerId)
    .replace(/\{\{OWNER_NAME\}\}/g, ownerName);
}

/**
 * Apply a server-specific name override to a personality prompt.
 * Replaces all occurrences of "irene"/"Irene" with the custom name.
 */
export function applyNameOverride(prompt: string, customName: string): string {
  if (!customName || customName.toLowerCase() === "irene") return prompt;
  return prompt.replace(/\birene\b/gi, customName).replace(/\bIrene\b/g, customName);
}
