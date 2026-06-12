// ─── PC Agent Hardening ─────────────────────────────────────────────────────
// Defense-in-depth for owner-only machine-level tools. The primary line is the
// `isOwner()` check in each executor; this module adds:
//
//   1. A kill switch (PC_AGENT_DISABLED=1) that disables every PC-agent tool
//      even for the owner, without needing a redeploy.
//   2. A destructive-command detector that forces an explicit `confirm: true`
//      argument before running things like `rm -rf`, `format`, `del /s`, etc.
//      This blocks the LLM from accidentally issuing a catastrophic command.
//   3. An append-only audit log. Every invocation of an owner-only tool is
//      recorded to Supabase (`eris_pc_audit`), with a local fallback so the
//      log survives database outages.

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import config from "../config.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_FALLBACK_PATH = join(__dirname, "..", "logs", "pc-audit.log");

export function isPcAgentEnabled() {
  return !config.pcAgentDisabled;
}

export function pcAgentDisabledMessage() {
  return "pc agent is disabled (PC_AGENT_DISABLED=1) — set it to 0 and restart to re-enable";
}

// Commands that must never run without an explicit `confirm: true`.
// Patterns are matched case-insensitively against the full command string.
// Keep this list conservative — false positives are fine (user can re-send
// with confirm), false negatives wipe the machine.
//
// All patterns use the `u` flag and a unicode-aware whitespace class so
// NBSP / zero-width / ideographic space bypasses match. The input is also
// NFKC-normalized and stripped of zero-width characters before matching to
// fold homoglyphs/confusables to canonical form.
const WS = "[\\s\\u00A0\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]";
const DESTRUCTIVE_PATTERNS = [
  // POSIX rm
  new RegExp(`\\brm${WS}+(-[a-z]*[rfRF][a-z]*${WS}+)?[\\/~]`, "iu"),     // rm -rf /, rm -r ~/
  new RegExp(`\\brm${WS}+-[a-z]*[rfRF]`, "iu"),                          // rm -rf anything (incl. -fr ordering)
  // Windows del / erase (erase is the synonym for del)
  new RegExp(`\\b(del|erase)${WS}+\\/[sfq]`, "iu"),                      // del /s, erase /s/f/q
  // rmdir and its alias rd (PowerShell + cmd)
  new RegExp(`\\b(rmdir|rd)${WS}+\\/s`, "iu"),                           // rmdir /s, rd /s
  new RegExp(`\\brd${WS}+(-[a-z]*[rfRF][a-z]*${WS}+)?[\\/~]`, "iu"),     // rd alias used POSIX-style
  new RegExp(`\\bformat${WS}+[a-z]:`, "iu"),                             // format C:
  /\bdiskpart\b/iu,
  new RegExp(`\\bmkfs(\\.|${WS})`, "iu"),                                // mkfs, mkfs.ext4
  new RegExp(`\\bdd${WS}+[^|]*\\bof=\\/dev\\/`, "iu"),                   // dd if=... of=/dev/sda
  /\b:(?:\(\s*\)\s*\{\s*:\|:&\s*\}\s*;\s*:|\s*\(\)\s*\{\s*:\|:)/iu,      // fork bomb
  new RegExp(`\\breg${WS}+delete\\b`, "iu"),
  new RegExp(`\\bsc${WS}+delete\\b`, "iu"),
  /\bshutdown\b/iu,
  new RegExp(`\\bnet${WS}+user\\b.*\\/(add|delete)`, "iu"),
  new RegExp(`\\btakeown${WS}+\\/f`, "iu"),
  /\bicacls\b.*\/deny/iu,
  // PowerShell Remove-Item and its aliases (ri, rd, rm, del, erase, rmdir)
  // with -Recurse and -Force in ANY order, including parameter abbreviations
  // (-r/-rec/-recurse, -f/-fo/-force). Lookaheads make flag order irrelevant.
  new RegExp(`\\b(?:Remove-Item|ri|rd|rm|del|erase|rmdir)\\b(?=[^|]*${WS}-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?\\b)(?=[^|]*${WS}-f(?:o(?:r(?:ce?)?)?)?\\b)`, "iu"),
  /\bStop-Computer\b/iu,
  /\bRestart-Computer\b/iu,
  /\bClear-EventLog\b/iu,
  // Output redirection (>, >>) writes files anywhere the shell can reach
  // (Startup folder = persistence) — confirmable, not silent. `2>&1`-style
  // stream merges and `->`/`=>` arrows are excluded.
  /(?:^|[^-=>])>{1,2}(?!&)/u,
  // PowerShell file-writing cmdlets and .NET static file writers.
  /\b(?:Set-Content|Add-Content|Out-File|Tee-Object)\b/iu,
  /\[(?:System\.)?IO\.File\]\s*::\s*Write/iu,
  // PowerShell -EncodedCommand is opaque to every regex below it — reject
  // outright. Match canonical and abbreviated forms (-enc, -ec, -e).
  new RegExp(`\\bpowershell(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
  new RegExp(`\\bpwsh(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
  // cmd /c rebuilds (env-substitution smuggling).
  new RegExp(`\\bcmd(\\.exe)?\\b[^|]*${WS}\\/c\\b`, "iu"),
];

// Opaque/elevation patterns are hard-blocked, not confirmable. They prevent
// review of the actual command that will run or cross a privilege boundary.
const HARD_BLOCK_PATTERNS = [
  new RegExp(`\\bpowershell(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
  new RegExp(`\\bpwsh(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
  new RegExp(`\\bcmd(\\.exe)?\\b[^|]*${WS}\\/c\\b`, "iu"),
  new RegExp(`\\b(?:bash|sh|zsh|fish)${WS}+-c\\b`, "iu"),
  /\b(?:Invoke-Expression|iex)\b/iu,
  /\bStart-Process\b[^|]*(?:^|\s)-Verb\s+RunAs\b/iu,
  /\bSet-ExecutionPolicy\b/iu,
  new RegExp(`\\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\\b[^|]*(?:\\||;|&&)${WS}*(?:sh|bash|pwsh|powershell|iex|Invoke-Expression)\\b`, "iu"),
];

// Chain operators — if a destructive command sits after `;`, `&&`, `||`, `|`,
// `&`, backtick, `$()`, or an output redirection (`>`, `>>`), the leading
// clause shouldn't mask it. Split on these and re-check each fragment.
const CHAIN_SPLIT = /(?:&&|\|\||;|\||&|`|\$\(|>{1,2})/u;

/**
 * Normalize a command for pattern matching. NFKC folds homoglyphs/width
 * variants to canonical form, then we drop common zero-width chars so e.g.
 * `r<ZWJ>m` becomes `rm` for the regex pass. The executed command is NOT
 * touched — this is only the input to the gate.
 */
function normalizeForMatch(command) {
  if (typeof command !== "string") return "";
  let s;
  try {
    s = command.normalize("NFKC");
  } catch {
    s = command;
  }
  // ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM, SOFT HYPHEN.
  s = s.replace(/[​-‍⁠﻿­]/g, "");
  return s;
}

function matchDestructive(normalized) {
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(normalized)) return pat.source;
  }
  return null;
}

function matchHardBlocked(normalized) {
  for (const pat of HARD_BLOCK_PATTERNS) {
    if (pat.test(normalized)) return pat.source;
  }
  return null;
}

/**
 * Check if a shell command looks destructive. Returns the matched pattern if so,
 * or null if it seems safe. Handles unicode-whitespace bypass, chained
 * operators, and PowerShell -EncodedCommand smuggling.
 */
export function looksDestructive(command) {
  if (!command || typeof command !== "string") return null;
  const normalized = normalizeForMatch(command);
  if (!normalized) return null;

  // Whole-command match.
  const whole = matchDestructive(normalized);
  if (whole) return whole;

  // Split on chain operators and re-check each fragment so e.g.
  //   echo hi && rm -rf /
  // is caught even when the leading clause is innocuous.
  if (CHAIN_SPLIT.test(normalized)) {
    for (const part of normalized.split(CHAIN_SPLIT)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const hit = matchDestructive(trimmed);
      if (hit) return hit;
    }
  }
  return null;
}

export function looksHardBlocked(command) {
  if (!command || typeof command !== "string") return null;
  const normalized = normalizeForMatch(command);
  if (!normalized) return null;

  const whole = matchHardBlocked(normalized);
  if (whole) return whole;

  if (CHAIN_SPLIT.test(normalized)) {
    for (const part of normalized.split(CHAIN_SPLIT)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const hit = matchHardBlocked(trimmed);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Gate a shell command invocation. Returns either `{ ok: true }` or an error
 * string suitable for returning from a tool executor.
 */
export function gateShellCommand(command, input) {
  if (!isPcAgentEnabled()) return { ok: false, error: pcAgentDisabledMessage() };
  if (!command) return { ok: false, error: "no command provided" };
  const hardBlocked = looksHardBlocked(command);
  if (hardBlocked) {
    return {
      ok: false,
      error: `refusing - this shell form is not allowed even with confirm (matched /${hardBlocked}/). use a direct, reviewable command instead.`,
    };
  }
  const destructive = looksDestructive(command);
  if (destructive && !input?.confirm) {
    return {
      ok: false,
      error: `refusing — this command looks destructive (matched /${destructive}/). re-send with confirm: true if you really mean it.`,
    };
  }
  return { ok: true };
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

/**
 * Append an audit entry. Non-blocking — failures are logged but never thrown.
 */
export async function auditLog(entry) {
  const row = {
    bot: config.botName || "eris",
    tool: entry.tool || "unknown",
    user_id: entry.userId || null,
    guild_id: entry.guildId || null,
    channel_id: entry.channelId || null,
    command: entry.command ? String(entry.command).substring(0, 2000) : null,
    result: entry.result ? String(entry.result).substring(0, 500) : null,
    confirmed: !!entry.confirmed,
    created_at: new Date().toISOString(),
  };

  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from("eris_pc_audit").insert(row);
      if (!error) return;
      log(`[Audit] Supabase insert failed (${error.message}) — falling back to local log`);
    }
  } catch (e) {
    log(`[Audit] Supabase unavailable (${e.message}) — falling back to local log`);
  }

  try {
    mkdirSync(dirname(AUDIT_FALLBACK_PATH), { recursive: true });
    appendFileSync(AUDIT_FALLBACK_PATH, JSON.stringify(row) + "\n");
  } catch (e) {
    log(`[Audit] Local log write failed: ${e.message}`);
  }
}
