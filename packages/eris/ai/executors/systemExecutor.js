// ─── System Sub-Executor ────────────────────────────────────────────────────
// Handles: execute_terminal, execute_local, browse_files, launch_app,
//          system_info, list_processes
// Owner-only tools. Called from main executor.js via delegation.
//
// Defense-in-depth:
//   - isOwner() gate (primary line of defense).
//   - PC_AGENT_DISABLED=1 env kill switch.
//   - Destructive-command detector requires `confirm: true`.
//   - Every invocation is written to an append-only audit log.

import { exec } from "child_process";
import { isOwner, denyMessage } from "../../utils/permissions.js";
import { isPcAgentEnabled, pcAgentDisabledMessage, gateShellCommand, auditLog } from "../../utils/pcAgent.js";
import * as db from "../../database.js";

const HANDLED = new Set([
  "execute_terminal", "execute_local", "browse_files", "launch_app",
  "system_info", "list_processes",
]);

function truncate(str, max = 1500) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + "\n...(truncated)" : str;
}

function execPromise(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ stdout: stdout || "", stderr: stderr || err.message });
      else resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// Build a PowerShell invocation that embeds a script via -EncodedCommand.
// Avoids cmd.exe/PowerShell quoting and metacharacter pitfalls entirely:
// the payload is base64 (UTF-16 LE), so arbitrary user input is safe inside
// the script body as long as PowerShell string quoting is correct.
function psEncoded(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function isShellLikeApp(app) {
  const base = String(app || "").trim().split(/[\\/]/).pop()?.toLowerCase() || "";
  return /^(?:powershell|powershell\.exe|pwsh|pwsh\.exe|cmd|cmd\.exe|bash|bash\.exe|sh|sh\.exe|zsh|fish|wscript|wscript\.exe|cscript|cscript\.exe|mshta|mshta\.exe)$/i.test(base);
}

function hasShellLikeLaunchArgs(args) {
  return /(?:^|\s)(?:-(?:command|encodedcommand|enc|ec|e|c)\b|\/c\b)/i.test(String(args || ""));
}

// Escape a value for use inside a PowerShell single-quoted string literal.
// Inside '...' only ' is special and is escaped by doubling it.
function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function audit(tool, message, command, result, confirmed) {
  await auditLog({
    tool,
    userId: message?.author?.id,
    guildId: message?.guild?.id,
    channelId: message?.channel?.id,
    command,
    result,
    confirmed,
  });
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;
  if (!isOwner(message.author.id)) return denyMessage(toolName === "execute_terminal" ? "terminal" : "local");
  if (!isPcAgentEnabled()) {
    await audit(toolName, message, input?.command || input?.path || input?.app || null, "blocked: pc agent disabled", false);
    return pcAgentDisabledMessage();
  }

  switch (toolName) {

    case "execute_terminal": {
      const cmd = input.command || input.cmd;
      const gate = gateShellCommand(cmd, input);
      if (!gate.ok) {
        await audit(toolName, message, cmd, `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const { stdout, stderr } = await execPromise(cmd, 15000);
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
      const result = truncate(output || "(no output)");
      await audit(toolName, message, cmd, "executed", !!input?.confirm);
      return result;
    }

    case "execute_local": {
      const command = input.command || input.cmd;
      const description = input.description || input.desc || command;
      const gate = gateShellCommand(command, input);
      if (!gate.ok) {
        await audit(toolName, message, command, `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const ok = await db.queueLocalCommand(command, message.channel.id, message.author.id);
      await audit(toolName, message, command, ok ? "queued" : "queue failed", !!input?.confirm);
      return ok ? `queued: ${description}` : "failed to queue command";
    }

    case "system_info": {
      const cmd = `powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"`;
      const gate = gateShellCommand(cmd, input);
      if (!gate.ok) {
        await audit(toolName, message, "system_info", `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const ok = await db.queueLocalCommand(cmd, message.channel.id, message.author.id);
      await audit(toolName, message, "system_info", ok ? "queued" : "queue failed", false);
      return ok ? "queued: system info request" : "failed to queue command";
    }

    case "list_processes": {
      // Optional name filter — schema documents `filter` so the model can
      // narrow to e.g. "chrome" or "node". Whitelist alnum/dot/hyphen so we
      // can't be coerced into PowerShell injection.
      const rawFilter = String(input.filter || "").trim();
      const safeFilter = /^[A-Za-z0-9._-]{1,40}$/.test(rawFilter) ? rawFilter : "";
      const filterClause = safeFilter ? ` | Where-Object { $_.Name -like '*${safeFilter}*' }` : "";
      const cmd = `powershell -Command "Get-Process${filterClause} | Sort-Object -Property CPU -Descending | Select-Object -First 15 Name,Id,CPU,WorkingSet | ConvertTo-Json"`;
      const gate = gateShellCommand(cmd, input);
      if (!gate.ok) {
        await audit(toolName, message, `list_processes${safeFilter ? ` filter=${safeFilter}` : ""}`, `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const ok = await db.queueLocalCommand(cmd, message.channel.id, message.author.id);
      await audit(toolName, message, `list_processes${safeFilter ? ` filter=${safeFilter}` : ""}`, ok ? "queued" : "queue failed", false);
      return ok ? `queued: process list request${safeFilter ? ` (filter: ${safeFilter})` : ""}` : "failed to queue command";
    }

    case "launch_app": {
      const app = input.app || input.application || input.path;
      if (!app) return "no application specified";
      const args = input.args || input.arguments || "";
      if (isShellLikeApp(app) || hasShellLikeLaunchArgs(args)) {
        await audit(toolName, message, `launch ${app} ${args}`.trim(), "blocked: shell-like launch", !!input?.confirm);
        return "launch_app only opens ordinary applications. use execute_terminal for shell/interpreter commands.";
      }
      const script = args
        ? `Start-Process -FilePath ${psSingleQuote(app)} -ArgumentList ${psSingleQuote(args)}`
        : `Start-Process -FilePath ${psSingleQuote(app)}`;
      // Gate the inner PowerShell script BEFORE encoding — gating the psEncoded
      // wrapper would always trip the -EncodedCommand pattern. This catches e.g.
      // launch_app app='powershell' args='-Command Stop-Computer'.
      const gate = gateShellCommand(`${app} ${args}`.trim() + "\n" + script, input);
      if (!gate.ok) {
        await audit(toolName, message, `launch ${app} ${args}`.trim(), `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const cmd = psEncoded(script);
      const ok = await db.queueLocalCommand(cmd, message.channel.id, message.author.id);
      await audit(toolName, message, `launch ${app} ${args}`.trim(), ok ? "queued" : "queue failed", false);
      return ok ? `queued: launch ${app}` : "failed to queue command";
    }

    case "browse_files": {
      const path = input.path || input.directory || input.dir || "~";
      const script = `Get-ChildItem -LiteralPath ${psSingleQuote(path)} | Select-Object Name,Length,LastWriteTime,Mode | ConvertTo-Json`;
      // Gate the inner script + raw path BEFORE encoding (see launch_app note).
      const gate = gateShellCommand(`${path}\n${script}`, input);
      if (!gate.ok) {
        await audit(toolName, message, `browse ${path}`, `blocked: ${gate.error}`, !!input?.confirm);
        return gate.error;
      }
      const cmd = psEncoded(script);
      const ok = await db.queueLocalCommand(cmd, message.channel.id, message.author.id);
      await audit(toolName, message, `browse ${path}`, ok ? "queued" : "queue failed", false);
      return ok ? `queued: browse ${path}` : "failed to queue command";
    }

    default:
      return undefined;
  }
}
