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
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*[rfRF][a-z]*\s+)?[\/~]/i,     // rm -rf /, rm -r ~/
  /\brm\s+-[a-z]*[rfRF]/i,                       // rm -rf anything
  /\bdel\s+\/[sfq]/i,                            // del /s, del /f, del /q
  /\brmdir\s+\/s/i,                              // rmdir /s
  /\bformat\s+[a-z]:/i,                          // format C:
  /\bdiskpart\b/i,
  /\bmkfs(\.|\s)/i,                              // mkfs, mkfs.ext4
  /\bdd\s+[^|]*\bof=\/dev\//i,                   // dd if=... of=/dev/sda
  /\b:(?:\(\s*\)\s*{\s*:\|:&\s*}\s*;\s*:|\s*\(\)\s*\{\s*:\|:)/i, // fork bomb
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bshutdown\b/i,
  /\bnet\s+user\b.*\/(add|delete)/i,
  /\btakeown\s+\/f/i,
  /\bicacls\b.*\/deny/i,
  /\bRemove-Item\b[^|]*-Recurse[^|]*-Force/i,   // PowerShell Remove-Item -Recurse -Force
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
  /\bClear-EventLog\b/i,
];

/**
 * Check if a shell command looks destructive. Returns the matched pattern if so,
 * or null if it seems safe.
 */
export function looksDestructive(command) {
  if (!command || typeof command !== "string") return null;
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(command)) return pat.source;
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
