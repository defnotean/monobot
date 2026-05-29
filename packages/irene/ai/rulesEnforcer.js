// ─── Rules enforcer — composes detector + escalation + Discord action ────────
// One entry point: `enforceMessage(message)`.
//
// Skip conditions (any one returns immediately, no I/O):
//   • not in a guild
//   • author is a bot (including ourselves)
//   • author is the guild owner
//   • author has ManageGuild perms (admins/mods)
//   • auto-mod is disabled for this guild
//   • no rules stored
//   • user is in a per-process recent-action cooldown (60s)
//   • user is exempt from all rules (global exemption)
//
// Otherwise: pre-filter → LLM judge → escalation → action.

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import {
  getRules, isAutoModEnabled, isUserExempt,
  recordViolation, getRecentViolations,
} from "../database.js";
import { analyzeMessage } from "./rulesDetector.js";
import { decideAction } from "./rulesEscalation.js";
import { sendModLog, log } from "../utils/logger.js";

const ACTION_COOLDOWN_MS = 60_000;
const _recentActions = new Map(); // userId → ts

function inCooldown(userId, now = Date.now()) {
  const last = _recentActions.get(userId);
  if (!last) return false;
  if (now - last > ACTION_COOLDOWN_MS) {
    _recentActions.delete(userId);
    return false;
  }
  return true;
}

function markActioned(userId, now = Date.now()) {
  _recentActions.set(userId, now);
  // Cheap GC — clear the map if it grows large
  if (_recentActions.size > 1000) {
    for (const [uid, ts] of _recentActions) {
      if (now - ts > ACTION_COOLDOWN_MS) _recentActions.delete(uid);
    }
  }
}

/**
 * Build the mod-log embed for an auto-mod action.
 */
function buildAuditEmbed({ user, action, ruleNumber, ruleText, severity, explanation, messageContent, channelId, messageId }) {
  const colorByKind = {
    log_only: 0x95a5a6,
    delete: 0xf39c12,
    warn: 0xf39c12,
    delete_and_timeout: 0xe74c3c,
  };
  const titleByKind = {
    log_only: "ℹ️ rule violation logged (no action)",
    delete: "🗑️ message deleted",
    warn: "⚠️ user warned",
    delete_and_timeout: "⏰ user timed out",
  };
  const minutes = action.timeoutMs ? Math.round(action.timeoutMs / 60_000) : null;
  const durationStr = minutes != null
    ? minutes >= 60
      ? `${Math.round(minutes / 60)}h`
      : `${minutes}m`
    : null;

  const desc = [
    `**user:** ${user} (\`${user.id}\`)`,
    `**rule:** #${ruleNumber} [${severity}]${ruleText ? ` — ${ruleText}` : ""}`,
    `**action:** ${action.kind}${durationStr ? ` (${durationStr})` : ""}`,
    explanation ? `**why:** ${explanation}` : null,
    messageContent ? `**message:** ${String(messageContent).slice(0, 400)}${messageContent.length > 400 ? "…" : ""}` : null,
    `**source:** <#${channelId}> · [jump](https://discord.com/channels/${user.guildId ?? "@me"}/${channelId}/${messageId})`,
  ].filter(Boolean).join("\n");

  return new EmbedBuilder()
    .setColor(colorByKind[action.kind] ?? 0x5865F2)
    .setTitle(titleByKind[action.kind] ?? "auto-mod")
    .setDescription(desc)
    .setTimestamp();
}

async function applyAction({ message, action, ruleNumber, severity }) {
  const tasks = [];
  // Delete the message if requested
  if (action.deleteMessage) {
    tasks.push(message.delete().catch((err) => log(`[Enforcer] delete failed: ${err?.message ?? err}`)));
  }
  // Apply timeout if requested. The reason gets stored in the audit log.
  if (action.timeoutMs && action.timeoutMs > 0) {
    const member = message.guild.members.cache.get(message.author.id) ?? null;
    if (member && member.moderatable) {
      tasks.push(
        member.timeout(action.timeoutMs, `auto-mod: ${action.reason}`)
          .catch((err) => log(`[Enforcer] timeout failed: ${err?.message ?? err}`))
      );
    } else {
      log(`[Enforcer] cannot timeout ${message.author.tag} — member not moderatable`);
    }
  }
  // For "warn" — DM the user with the rule citation. Best-effort.
  if (action.kind === "warn") {
    const text = `you got an auto-mod warning in **${message.guild.name}** for ${action.reason}. please review the server rules.`;
    tasks.push(message.author.send(text).catch(() => {}));
  }
  await Promise.allSettled(tasks);
  // Record in violation history (used for escalation on next offense)
  recordViolation(
    message.guild.id,
    message.author.id,
    ruleNumber,
    message.id,
    severity,
    action.kind,
  );
}

/**
 * Main entry — call from messageCreate.js for every guild message.
 * Returns true if an action was taken (for caller logging), false otherwise.
 * NEVER throws — auto-mod failures must never break the message handler.
 */
export async function enforceMessage(message) {
  try {
    if (!message?.guildId) return false;
    if (message.author?.bot) return false;
    if (!isAutoModEnabled(message.guildId)) return false;

    const rules = getRules(message.guildId);
    if (rules.length === 0) return false;

    // Skip server owner + admins/mods (anyone with ManageGuild/ManageMessages)
    const member = message.member;
    if (member) {
      if (member.id === message.guild.ownerId) return false;
      if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return false;
      if (member.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return false;
    }

    // Global exemption short-circuit (cheap check before pre-filter)
    if (isUserExempt(message.guildId, message.author.id, null)) return false;

    // Per-user cooldown — second message in 60s after action doesn't double-action
    if (inCooldown(message.author.id)) return false;

    // Build context — the last few messages in this channel for the LLM judge.
    // Cheap: messages.cache is already populated with recent traffic.
    const channelMessages = message.channel?.messages?.cache;
    const contextMessages = channelMessages
      ? [...channelMessages.values()]
          .filter(m => m.id !== message.id && !m.author.bot)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .slice(-8)
          .map(m => ({ author: m.author.username ?? "?", content: String(m.content ?? "").slice(0, 200) }))
      : [];

    const result = await analyzeMessage({
      message: { author: message.author.username ?? "?", content: message.content, id: message.id },
      rules,
      contextMessages,
      client: message.client,
    });

    if (!result.violation) return false;

    // Per-rule exemption check (after we know which rule was cited)
    if (isUserExempt(message.guildId, message.author.id, result.ruleNumber)) {
      log(`[Enforcer] user ${message.author.tag} exempt from rule ${result.ruleNumber} — skipping action`);
      return false;
    }

    // Compute escalation
    const priorList = getRecentViolations(message.guildId, message.author.id);
    const priorOffenses = priorList.filter(v => v.ruleNumber === result.ruleNumber).length;
    const cited = rules.find(r => r.number === result.ruleNumber);
    const action = decideAction({
      severity: result.severity,
      priorOffenses,
      ruleText: cited?.text ?? "",
      ruleNumber: result.ruleNumber,
    });

    // Apply
    if (action.kind !== "log_only") {
      await applyAction({ message, action, ruleNumber: result.ruleNumber, severity: result.severity });
    } else {
      // Even for log_only, count it as a recorded violation so the next
      // offense escalates correctly.
      recordViolation(message.guildId, message.author.id, result.ruleNumber, message.id, result.severity, action.kind);
    }

    // Audit
    const embed = buildAuditEmbed({
      user: message.author,
      action,
      ruleNumber: result.ruleNumber,
      ruleText: cited?.text ?? "",
      severity: result.severity,
      explanation: result.explanation,
      messageContent: message.content,
      channelId: message.channelId,
      messageId: message.id,
    });
    await sendModLog(message.guild, embed).catch((err) => log(`[Enforcer] modlog failed: ${err?.message ?? err}`));

    markActioned(message.author.id);
    log(`[Enforcer] ${message.author.tag} → ${action.kind} for rule #${result.ruleNumber} in ${message.guild.name}`);
    return true;
  } catch (err) {
    log(`[Enforcer] unexpected error: ${err?.message ?? err}`);
    if (err?.stack) log(err.stack);
    return false;
  }
}
