// ─── Moderation Executor ────────────────────────────────────────────────────

import { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { addWarning, getWarnings, deleteWarning, clearWarnings, logAudit, removeTempBan, getGuildSettings, getSupabase } from "../../database.js";
import { sendModLog } from "../../utils/logger.js";
import { modEmbed, logEvent, buildUndoRow } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";
import { getEscalation } from "../../database.js";
import { firePunishSignal } from "../../utils/twinPunish.js";

// ─── Durable moderation audit trail ─────────────────────────────────────────
//
// In addition to the existing in-memory ring (database.js#logAudit, 100 entries
// per guild, lost on restart) and the sendModLog channel embed, every mod
// action is appended to a durable `irene_mod_audit` Supabase table so it
// survives restarts and is queryable by (guild_id, ts). The original
// natural-language instruction is recorded for AI-initiated actions so
// "ban the spammer" is auditable against who it resolved to.
//
// Best-effort, fire-and-forget: the in-memory ring write (logAudit) still runs
// inline as before; the Supabase append is a SECOND sink that never blocks or
// fails a moderation action. If Supabase is unconfigured or the table is
// missing we degrade to the ring (already written) and log once.
const AUDIT_TABLE = "irene_mod_audit";
let _auditDegraded = false; // table/columns missing → stop hammering, ring only

// Schema-missing detection mirrors music/settingsStore.js: 42P01 undefined_table,
// 42703 undefined_column, PGRST205 relation-not-in-schema-cache.
function _auditSchemaMissing(error) {
  if (!error) return false;
  const code = error.code || "";
  if (code === "42P01" || code === "42703" || code === "PGRST205") return true;
  const msg = (error.message || "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

// Append one audit row. Never throws — all failures are caught and logged so
// the caller's moderation action is never blocked by an audit-write problem.
// `entry` = { guildId, actorId, targetId, action, reason, source, instruction }.
export function writeModAudit(entry) {
  let supabase;
  try {
    // try/catch also guards test mocks that omit the getSupabase export —
    // calling an undefined import throws a TypeError, which we swallow to a no-op.
    supabase = getSupabase();
  } catch {
    return;
  }
  if (!supabase || _auditDegraded || !entry?.guildId) return;

  const row = {
    guild_id: String(entry.guildId),
    actor_id: entry.actorId != null ? String(entry.actorId) : null,
    target_id: entry.targetId != null ? String(entry.targetId) : null,
    action: String(entry.action || "unknown"),
    reason: entry.reason != null ? String(entry.reason).slice(0, 1024) : null,
    source: String(entry.source || "ai-tool"),
    instruction: entry.instruction != null ? String(entry.instruction).slice(0, 2000) : null,
    ts: new Date().toISOString(),
  };

  Promise.resolve()
    .then(() => supabase.from(AUDIT_TABLE).insert(row))
    .then(({ error } = {}) => {
      if (error) {
        if (_auditSchemaMissing(error)) {
          if (!_auditDegraded) {
            _auditDegraded = true;
            log(`[ModAudit] Table "${AUDIT_TABLE}" missing — durable audit disabled, using in-memory ring only`);
          }
        } else {
          log(`[ModAudit] Write failed for ${row.guild_id}/${row.action}: ${error.message}`);
        }
      }
    })
    .catch((err) => log(`[ModAudit] Write error for ${row.guild_id}/${row.action}: ${err?.message || err}`));
}

// Reset degraded state — used by tests to isolate cases.
export function _resetAuditForTest() {
  _auditDegraded = false;
}

function _memberLabel(member) {
  return member?.user?.tag || member?.displayName || member?.id || "that user";
}

function _notBannableMessage(member) {
  return `I can't ban ${_memberLabel(member)} - they are higher than me or Discord says this target is not bannable`;
}

async function _banMember(member, options, label) {
  if (!member?.bannable) return { ok: false, message: _notBannableMessage(member) };
  try {
    await member.ban(options);
    return { ok: true };
  } catch (error) {
    const msg = error?.message || String(error);
    log(`[Moderation] ${label} failed for ${member?.id || "unknown"}: ${msg}`);
    return { ok: false, message: `Failed to ban ${_memberLabel(member)}: ${msg}` };
  }
}

// Mirror of _banMember for kicks. The caller already enforces the moderator's
// permission and the role hierarchy; this only wraps the Discord API call so a
// failure (bot lacking Kick Members, target left mid-action, rate limit) is
// logged and surfaced as a clear error string instead of throwing uncaught out
// of the tool loop. No new precheck — behavior on success is unchanged.
async function _kickMember(member, reason, label) {
  try {
    await member.kick(reason);
    return { ok: true };
  } catch (error) {
    const msg = error?.message || String(error);
    log(`[Moderation] ${label} failed for ${member?.id || "unknown"}: ${msg}`);
    return { ok: false, message: `Failed to kick ${_memberLabel(member)}: ${msg}` };
  }
}

// Mirror of _banMember for timeouts (and timeout removal when ms === null).
// Caller enforces perms + hierarchy; this only catches transient API failures
// so the tool loop can report them rather than crash.
async function _timeoutMember(member, ms, reason, label) {
  try {
    await member.timeout(ms, reason);
    return { ok: true };
  } catch (error) {
    const msg = error?.message || String(error);
    log(`[Moderation] ${label} failed for ${member?.id || "unknown"}: ${msg}`);
    return { ok: false, message: `Failed to timeout ${_memberLabel(member)}: ${msg}` };
  }
}

// Resolve the durable-audit `source` from the executor ctx. Slash commands and
// scheduled/presence-triggered calls don't set aiInitiated, so they're treated
// as the slash-equivalent path ('slash'). The AI tool loop sets aiInitiated;
// a confirmed replay also sets confirmedAction.
function _auditSource(ctx) {
  if (ctx?.confirmedAction) return "ai-tool-confirmed";
  if (ctx?.aiInitiated) return "ai-tool";
  return "slash";
}

// The original natural-language instruction lives on message.content when the
// action came from the AI tool loop. Slash commands have no meaningful content
// (or it's the raw command text), so only surface it for AI-initiated paths.
function _auditInstruction(message, ctx) {
  if (!ctx?.aiInitiated && !ctx?.confirmedAction) return null;
  const c = message?.content;
  return typeof c === "string" && c.trim() ? c : null;
}

// Prefix audit-log reason with the invoking moderator's tag so Discord's
// own audit log attributes the action to the right person (otherwise it
// just says "Irene").
function _attributedReason(actor, reason) {
  const tag = actor?.tag || actor?.username || "unknown";
  const r = reason ? String(reason).slice(0, 450) : "No reason";
  return `[${tag}] ${r}`.slice(0, 512);
}

// Check invoking member retains the needed permission (for scheduled tasks
// where the moderator may have been demoted between queue and fire).
function _memberHasPerm(member, perm, guild) {
  if (!member) return false;
  if (member.id === guild.ownerId) return true;
  try {
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return !!member.permissions?.has?.(perm);
  } catch { return false; }
}

const DURATION_MS = {
  "1m": 60_000, "5m": 300_000, "10m": 600_000, "30m": 1_800_000,
  "1h": 3_600_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "7d": 604_800_000,
};

// ─── Destructive-action confirmation store ──────────────────────────────────
//
// AI-initiated (LLM tool-call) destructive actions — ban / kick / tempban, and
// purges affecting more than PURGE_CONFIRM_THRESHOLD messages — are NOT
// executed inline. A single hallucinated tool call shouldn't be able to ban a
// member or wipe a channel. Instead we stash the resolved action under a short
// random token and post a Confirm/Cancel button row; a permitted human must
// click Confirm (perms + hierarchy are re-verified at click time) before it
// commits. Cancel or TTL-expiry discards it.
//
// Slash mod commands (explicit human intent) bypass this entirely — they run
// their own handlers in commands/moderation/*.js and never reach this
// executor. The gate keys off `ctx.aiInitiated`; see execute() below.
export const PENDING_TTL_MS = 120_000; // 2 min — long enough to read + click
export const PENDING_MAX = 100;        // hard cap so a token flood can't grow unbounded
export const PURGE_CONFIRM_THRESHOLD = 50; // purges over this need confirmation

const _pendingActions = new Map(); // token → { action, input, guildId, channelId, requestedBy, requiredPerm, targetId, summary, createdAt }

function _newToken() {
  // 8 hex chars — collision-safe enough for a 100-entry map and keeps the
  // modconfirm:<token> customId well under Discord's 100-char limit.
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

function _sweepPending(now = Date.now()) {
  for (const [token, p] of _pendingActions) {
    if (now - p.createdAt > PENDING_TTL_MS) _pendingActions.delete(token);
  }
}

// Stash a resolved destructive action and return its token. Sweeps expired
// entries first, then evicts the oldest if still at cap.
export function createPendingAction(pending) {
  _sweepPending();
  if (_pendingActions.size >= PENDING_MAX) {
    const oldest = _pendingActions.keys().next().value;
    if (oldest !== undefined) _pendingActions.delete(oldest);
  }
  const token = _newToken();
  _pendingActions.set(token, { ...pending, createdAt: Date.now() });
  return token;
}

// Read without consuming — returns null if missing or TTL-expired.
export function getPendingAction(token) {
  const p = _pendingActions.get(token);
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    _pendingActions.delete(token);
    return null;
  }
  return p;
}

// Read + delete atomically — used by Confirm/Cancel so a double-click can't
// commit twice.
export function consumePendingAction(token) {
  const p = getPendingAction(token);
  if (p) _pendingActions.delete(token);
  return p;
}

// Build the Confirm/Cancel button row for a pending token. Mirrors the
// modundo:<...> customId convention (handled in events/interactionCreate.js).
export function buildConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modconfirm:${token}`).setLabel("Confirm").setEmoji("✅").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`modcancel:${token}`).setLabel("Cancel").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
  );
}

// Commit a previously-confirmed action. `member` is the human who clicked
// Confirm; their perms + hierarchy are re-verified here (NOT trusting the
// original requester). `guild` / `clickedBy` come from the interaction.
// Returns a human-readable result string. Pure-ish: all Discord/DB effects go
// through the passed-in `deps` so it's unit-testable.
export async function commitPendingAction(pending, { guild, member, clickedBy, deps }) {
  const { findMember, checkHierarchy } = deps;
  if (!_memberHasPerm(member, pending.requiredPerm, guild)) {
    return { ok: false, message: "you don't have permission to confirm this action" };
  }

  const reason = pending.input?.reason || "No reason";

  if (pending.action === "ban_user" || pending.action === "tempban") {
    const target = findMember(guild, pending.input.username);
    if (!target) return { ok: false, message: `Couldn't find user "${pending.input.username}" anymore` };
    if (target.id === guild.client?.user?.id) return { ok: false, message: "I can't ban myself lol" };
    const hierErr = checkHierarchy(member, target, guild);
    if (hierErr) return { ok: false, message: hierErr };

    if (pending.action === "tempban") {
      const banResult = await _banMember(target, { reason: _attributedReason(clickedBy, `[TEMP ${pending.durationStr}] ${reason}`) }, "confirmed tempban");
      if (!banResult.ok) return banResult;
      deps.addTempBan(guild.id, target.id, target.user.tag, pending.durationMs, reason, clickedBy.id);
      deps.firePunishSignal?.({ guildId: guild.id, userId: target.id, action: "ban", reason }).catch(() => {});
      // Durable audit: actor is the human who CLICKED Confirm; record the
      // original AI instruction stashed at defer time.
      writeModAudit({
        guildId: guild.id, actorId: clickedBy.id, targetId: target.id,
        action: "tempban", reason: `[${pending.durationStr}] ${reason}`,
        source: "ai-tool-confirmed", instruction: pending.instruction || null,
      });
      return { ok: true, message: `Temp-banned ${target.user.tag} for ${pending.durationStr} — reason: ${reason}.` };
    }

    const banResult = await _banMember(target, { deleteMessageDays: pending.input.delete_messages || 0, reason: _attributedReason(clickedBy, reason) }, "confirmed ban");
    if (!banResult.ok) return banResult;
    deps.firePunishSignal?.({ guildId: guild.id, userId: target.id, action: "ban", reason }).catch(() => {});
    // Mirror the inline ban_user mod-log + undo row so a button-confirmed ban
    // is indistinguishable from any other ban (actor is the human who clicked).
    await sendModLog(guild, {
      embed: logEvent({
        kind: "ban",
        target: target.user,
        actor: clickedBy,
        reason,
        meta: {
          "Nickname": target.nickname,
          "Joined": target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : null,
          "Account Created": target.user.createdTimestamp ? `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>` : null,
          "Delete Messages": pending.input.delete_messages ? `${pending.input.delete_messages}d` : null,
          "Prior Warnings": String(getWarnings(guild.id, target.id).length),
          "Invoked Via": "AI tool (confirmed)",
        },
      }),
      components: [buildUndoRow("ban", target.id)].filter(Boolean),
    });
    deps.logAudit(guild.id, "ban", clickedBy.id, pending.input.username);
    // Durable audit: actor is the confirming human; include the original
    // natural-language instruction so "ban the spammer" is traceable.
    writeModAudit({
      guildId: guild.id, actorId: clickedBy.id, targetId: target.id,
      action: "ban", reason, source: "ai-tool-confirmed", instruction: pending.instruction || null,
    });
    return { ok: true, message: `Banned ${target.user.tag}. Reason: ${reason}` };
  }

  if (pending.action === "kick_user") {
    const target = findMember(guild, pending.input.username);
    if (!target) return { ok: false, message: `Couldn't find user "${pending.input.username}" anymore` };
    const hierErr = checkHierarchy(member, target, guild);
    if (hierErr) return { ok: false, message: hierErr };
    const kickResult = await _kickMember(target, _attributedReason(clickedBy, reason), "confirmed kick");
    if (!kickResult.ok) return kickResult;
    deps.firePunishSignal?.({ guildId: guild.id, userId: target.id, action: "kick", reason }).catch(() => {});
    // Mirror the inline kick_user mod-log so a button-confirmed kick is logged
    // identically (kick uses a bare embed payload, no undo row — same as inline).
    await sendModLog(guild, logEvent({
      kind: "kick",
      target: target.user,
      actor: clickedBy,
      reason,
      meta: {
        "Nickname": target.nickname,
        "Joined": target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : null,
        "Account Created": target.user.createdTimestamp ? `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>` : null,
        "Prior Warnings": String(getWarnings(guild.id, target.id).length),
        "Invoked Via": "AI tool (confirmed)",
      },
    }));
    deps.logAudit(guild.id, "kick", clickedBy.id, pending.input.username);
    writeModAudit({
      guildId: guild.id, actorId: clickedBy.id, targetId: target.id,
      action: "kick", reason, source: "ai-tool-confirmed", instruction: pending.instruction || null,
    });
    return { ok: true, message: `Kicked ${target.user.tag}. Reason: ${reason}` };
  }

  if (pending.action === "purge_messages") {
    // Replay the purge through the normal executor case now that a human has
    // confirmed. We rebuild a minimal message from the click context and set
    // `confirmedAction` so the purge case skips the confirm gate. The stored
    // `message` is reused for its channel/client; author becomes the clicker
    // so audit attribution is correct.
    const replayMsg = { ...pending.message, member, author: clickedBy };
    const replayCtx = { ...pending.ctx, confirmedAction: true };
    const result = await execute("purge_messages", pending.input, replayMsg, replayCtx);
    return { ok: true, message: String(result) };
  }

  return { ok: false, message: `unknown pending action: ${pending.action}` };
}

const HANDLED = new Set([
  "ban_user", "kick_user", "warn_user", "timeout_user",
  "untimeout_user", "unban_user", "unmute_user",
  "remove_warning", "clear_warnings",
  "lockdown_server", "unlock_server", "purge_messages",
  "find_message", "snipe", "editsnipe", "tempban",
]);

// A destructive AI-initiated action that should be deferred to a human
// Confirm click. Returns the pending-confirm result object, or null if this
// call should execute immediately (not AI-initiated, already confirmed, or a
// purge under the threshold).
function _maybeDeferToConfirm(toolName, input, message, ctx, opts = {}) {
  // Slash mod commands never reach this executor; only the AI tool path sets
  // ctx.aiInitiated. If the dispatch hasn't been wired to set the flag yet
  // (see openConcerns), the gate stays off and behavior is unchanged.
  if (!ctx?.aiInitiated) return null;
  // A confirmed replay (human already clicked Confirm) must not re-defer.
  if (ctx?.confirmedAction) return null;

  const requiredPerm = opts.requiredPerm;
  const summary = opts.summary;
  const token = createPendingAction({
    action: toolName,
    input,
    guildId: ctx.guild?.id,
    channelId: message?.channel?.id,
    requestedBy: message?.author?.id,
    requiredPerm,
    durationStr: opts.durationStr,
    durationMs: opts.durationMs,
    targetId: opts.targetId,
    summary,
    // Capture the original natural-language instruction NOW (e.g. "ban the
    // spammer") so the durable audit on confirm can record what was asked
    // against who it resolved to and who confirmed it.
    instruction: _auditInstruction(message, ctx),
    // Stash the live message/ctx so a confirmed purge can be replayed.
    message,
    ctx,
  });
  return {
    content: `⚠️ ${summary} — this was requested by the AI. A moderator must confirm.`,
    components: [buildConfirmRow(token)],
    _pendingToken: token, // surfaced for tests / callers; harmless in a Discord payload
  };
}

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, by, findChannel, findMember, checkHierarchy } = ctx;

  switch (toolName) {
    case "ban_user": {
      // Permission re-check runs FIRST — before findMember, hierarchy check,
      // any DB write, or Discord API call — so a caller without BanMembers
      // can't probe membership or trigger lookups via this tool.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't ban users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      if (member.id === message.client.user.id) return "I can't ban myself lol";
      const banHierErr = checkHierarchy(message.member, member, guild);
      if (banHierErr) return banHierErr;
      const bannableErr = !member.bannable ? _notBannableMessage(member) : null;
      if (bannableErr) return bannableErr;
      // AI-initiated bans defer to a human Confirm click (see store above).
      const banDefer = _maybeDeferToConfirm("ban_user", input, message, ctx, {
        requiredPerm: PermissionFlagsBits.BanMembers,
        targetId: member.id,
        summary: `Ban **${member.user.tag}** (reason: ${input.reason || "No reason"})`,
      });
      if (banDefer) return banDefer;
      const reason = input.reason || "No reason";
      const banResult = await _banMember(member, { deleteMessageDays: input.delete_messages || 0, reason: _attributedReason(message.author, reason) }, "inline ban");
      if (!banResult.ok) return banResult.message;
      // Fire cross-bot punish signal — Eris will apply economy consequences
      // (zero the balance) if the guild has opted in via cross_bot_punish.
      firePunishSignal({ guildId: guild.id, userId: member.id, action: "ban", reason }).catch(() => {});
      await sendModLog(guild, {
        embed: logEvent({
          kind: "ban",
          target: member.user,
          actor: message.author,
          reason,
          meta: {
            "Nickname": member.nickname,
            "Joined": member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : null,
            "Account Created": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
            "Delete Messages": input.delete_messages ? `${input.delete_messages}d` : null,
            "Prior Warnings": String(getWarnings(guild.id, member.id).length),
            "Invoked Via": "AI tool",
          },
        }),
        components: [buildUndoRow("ban", member.id)].filter(Boolean),
      });
      logAudit(guild.id, "ban", message.author.id, input.username);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "ban", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Banned ${member.user.tag}. Reason: ${reason}`;
    }

    case "kick_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.KickMembers, guild))
        return "You can't kick users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const kickHierErr = checkHierarchy(message.member, member, guild);
      if (kickHierErr) return kickHierErr;
      // AI-initiated kicks defer to a human Confirm click.
      const kickDefer = _maybeDeferToConfirm("kick_user", input, message, ctx, {
        requiredPerm: PermissionFlagsBits.KickMembers,
        targetId: member.id,
        summary: `Kick **${member.user.tag}** (reason: ${input.reason || "No reason"})`,
      });
      if (kickDefer) return kickDefer;
      const reason = input.reason || "No reason";
      const kickResult = await _kickMember(member, _attributedReason(message.author, reason), "inline kick");
      if (!kickResult.ok) return kickResult.message;
      firePunishSignal({ guildId: guild.id, userId: member.id, action: "kick", reason }).catch(() => {});
      await sendModLog(guild, logEvent({
        kind: "kick",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Joined": member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : null,
          "Account Created": `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
          "Prior Warnings": String(getWarnings(guild.id, member.id).length),
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "kick", message.author.id, input.username);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "kick", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Kicked ${member.user.tag}. Reason: ${reason}`;
    }

    case "warn_user": {
      // Match the /warn slash-command gate: ModerateMembers is the canonical
      // permission for warn (the slash command sets it as defaultMemberPerms
      // and re-checks via requirePermission). Without this gate, the
      // upstream ADMIN_TOOLS check is the only barrier — and a stale
      // trusted_users entry can let a now-non-mod issue warnings + trigger
      // auto-escalation bans.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't warn users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const warnHierErr = checkHierarchy(message.member, member, guild);
      if (warnHierErr) return warnHierErr;
      const newWarn = addWarning(guild.id, member.id, message.author.id, input.reason);
      const warnings = getWarnings(guild.id, member.id);
      await sendModLog(guild, {
        embed: logEvent({
          kind: "warn",
          target: member.user,
          actor: message.author,
          reason: input.reason,
          meta: {
            "Warning ID": `#${newWarn?.id ?? "?"}`,
            "Total Warnings": `${warnings.length}`,
            "Nickname": member.nickname,
            "Invoked Via": "AI tool",
          },
        }),
        components: newWarn?.id
          ? [buildUndoRow("warn", member.id, newWarn.id)].filter(Boolean)
          : [],
      });

      // Feature 13: DM the warned user
      const warnDmEmbed = new EmbedBuilder()
        .setTitle("⚠️ Warning Received")
        .setColor(0xfee75c)
        .addFields(
          { name: "Server", value: guild.name, inline: true },
          { name: "Reason", value: input.reason || "No reason provided", inline: false },
          { name: "Total Warnings", value: String(warnings.length), inline: true },
          { name: "Note", value: "Contact a moderator if you think this is a mistake", inline: false },
        )
        .setTimestamp();
      await member.send({ embeds: [warnDmEmbed] }).catch(() => {});

      // Feature 14: Auto-escalation — AI-PATH CAP
      //
      // AUDIT (docs/audits/AUDIT-irene-moderation.md, risk #4):
      //   A single LLM hallucination producing `warn_user` on a user
      //   already at `ban_at - 1` would silently auto-ban with no
      //   confirmation. Per the council convergence in
      //   ai/rulesEscalation.js ("No auto-ban. Bans are mod-only.") and
      //   the audit's risk-#4 remediation, the AI tool path must NEVER
      //   auto-ban or auto-kick.
      //
      // Policy: AI-initiated warns cap escalation at TIMEOUT (24h max).
      // BAN and KICK on warn-threshold are slash-command-only — a mod
      // running `/warn add` makes that choice consciously. The AI path
      // can warn, time out (up to 24h), and surface the would-be action
      // in mod-log so a human can run `/ban` or `/kick` themselves.
      const escalation = getEscalation(guild.id);
      const count = warnings.length;
      let escalationNote = "";

      // Determine the highest configured tier the user has crossed.
      let crossedTier = null;
      if (escalation.ban_at && count >= escalation.ban_at) crossedTier = "ban";
      else if (escalation.kick_at && count >= escalation.kick_at) crossedTier = "kick";
      else if (escalation.mute_at && count >= escalation.mute_at) crossedTier = "mute";

      if (crossedTier === "ban" || crossedTier === "kick") {
        // AI path CAPs at 24h timeout. Surface the would-be action in
        // mod-log so a human can run `/ban` or `/kick` consciously.
        try {
          const capMs = 24 * 60 * 60_000; // 24h max
          await member.timeout(capMs, _attributedReason(message.author, `AI-path cap: ${count} warnings (would have ${crossedTier}ed under server policy)`));
          await sendModLog(guild, logEvent({
            kind: "timeout",
            target: member.user,
            reason: `AI-path cap: ${count} warnings`,
            meta: {
              "Duration": "24h",
              "Until": `<t:${Math.floor((Date.now() + capMs) / 1000)}:R>`,
              "Trigger": "auto-escalation (capped)",
              "Warning Count": `${count}`,
              "Configured Action": crossedTier,
              "Policy Note": `AI path caps at 24h timeout; ${crossedTier} requires mod slash-command`,
              "Invoked Via": "AI tool (automatic, capped)",
            },
          }));
          escalationNote = ` — auto-timed out 24h (would-be ${crossedTier} requires mod action)`;
        } catch (error) {
          log(`[Moderation] warn auto-timeout cap failed for ${member.id}: ${error?.message || error}`);
        }
      } else if (crossedTier === "mute") {
        try {
          await member.timeout(10 * 60 * 1000, _attributedReason(message.author, `Auto-escalation: ${count} warnings`)); // 10 min timeout
          await sendModLog(guild, logEvent({
            kind: "timeout",
            target: member.user,
            reason: `Auto-escalation: ${count} warnings`,
            meta: {
              "Duration": "10m",
              "Until": `<t:${Math.floor((Date.now() + 10 * 60_000) / 1000)}:R>`,
              "Trigger": "auto-escalation",
              "Warning Count": `${count}`,
              "Mute Threshold": `${escalation.mute_at}`,
              "Invoked Via": "AI tool (automatic)",
            },
          }));
          escalationNote = ` — auto-timed out (${count} warnings)`;
        } catch (error) {
          log(`[Moderation] warn auto-timeout failed for ${member.id}: ${error?.message || error}`);
        }
      }

      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "warn", reason: input.reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Warned ${member.user.tag} (${warnings.length} total). Reason: ${input.reason}${escalationNote}`;
    }

    case "timeout_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't timeout users.";
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const timeoutHierErr = checkHierarchy(message.member, member, guild);
      if (timeoutHierErr) return timeoutHierErr;
      const ms = DURATION_MS[input.duration];
      if (!ms) return `Invalid duration: ${input.duration}`;
      const timeoutResult = await _timeoutMember(member, ms, _attributedReason(message.author, input.reason || "No reason"), "inline timeout");
      if (!timeoutResult.ok) return timeoutResult.message;
      await sendModLog(guild, {
        embed: logEvent({
          kind: "timeout",
          target: member.user,
          actor: message.author,
          reason: input.reason || "No reason provided",
          meta: {
            "Duration": input.duration,
            "Until": `<t:${Math.floor((Date.now() + ms) / 1000)}:F> (<t:${Math.floor((Date.now() + ms) / 1000)}:R>)`,
            "Nickname": member.nickname,
            "Invoked Via": "AI tool",
          },
        }),
        components: [buildUndoRow("timeout", member.id)].filter(Boolean),
      });
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "timeout", reason: input.reason || "No reason provided",
        source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Timed out ${member.user.tag} for ${input.duration}`;
    }

    case "untimeout_user": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ModerateMembers, guild))
        return "You can't untimeout users.";
      if (!member.isCommunicationDisabled()) return `${member.user.tag} isn't timed out.`;
      const reason = input.reason || "No reason";
      try {
        await member.timeout(null, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to remove timeout: ${err.message}`;
      }
      await sendModLog(guild, logEvent({
        kind: "untimeout",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "untimeout", message.author.id, input.username);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "untimeout", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Removed timeout from ${member.user.tag}. Reason: ${reason}`;
    }

    case "unban_user": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't unban users.";
      const reason = input.reason || "No reason";
      let targetId = input.user_id?.trim();

      // Resolve by username/tag via ban list if no ID given
      if (!targetId) {
        if (!input.username) return "Need a user_id or username to unban.";
        try {
          const bans = await guild.bans.fetch();
          const lower = input.username.toLowerCase().replace(/^@/, "");
          const hit = bans.find(
            (b) =>
              b.user.tag.toLowerCase() === lower ||
              b.user.username.toLowerCase() === lower ||
              b.user.id === input.username
          );
          if (!hit) return `Couldn't find a banned user matching "${input.username}".`;
          targetId = hit.user.id;
        } catch (err) {
          return `Failed to look up bans: ${err.message}`;
        }
      }

      if (!/^\d{17,20}$/.test(targetId)) return `"${targetId}" doesn't look like a valid user ID.`;

      let ban;
      try {
        ban = await guild.bans.fetch(targetId);
      } catch (err) {
        if (err.code === 10026) return `User ${targetId} isn't banned.`;
        return `Failed to fetch ban: ${err.message}`;
      }

      try {
        await guild.members.unban(targetId, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to unban: ${err.message}`;
      }

      removeTempBan(guild.id, targetId);

      await sendModLog(guild, logEvent({
        kind: "unban",
        target: ban.user,
        actor: message.author,
        reason,
        meta: {
          "User ID": `\`${targetId}\``,
          "Original Ban Reason": ban.reason || "*(none recorded)*",
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "unban", message.author.id, ban.user.tag);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId,
        action: "unban", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Unbanned ${ban.user.tag}. Reason: ${reason}`;
    }

    case "unmute_user": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageRoles, guild))
        return "You can't unmute users.";
      // Look up configured mute role first; fall back to any role whose name
      // matches "muted" case-insensitively so we don't fail on servers that
      // use "Silenced", "muted", etc.
      const gs = getGuildSettings(guild.id) || {};
      let muteRole = gs.mute_role_id ? guild.roles.cache.get(gs.mute_role_id) : null;
      if (!muteRole) muteRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "muted");
      if (!muteRole) return "No mute role configured (set one via /setup or name a role 'Muted').";
      if (!member.roles.cache.has(muteRole.id)) return `${member.user.tag} isn't muted.`;
      const reason = input.reason || "No reason";
      try {
        await member.roles.remove(muteRole, _attributedReason(message.author, reason));
      } catch (err) {
        return `Failed to remove mute: ${err.message}`;
      }
      await sendModLog(guild, logEvent({
        kind: "unmute",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Nickname": member.nickname,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "unmute", message.author.id, input.username);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "unmute", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Unmuted ${member.user.tag}. Reason: ${reason}`;
    }

    case "remove_warning": {
      const id = Number(input.warning_id);
      if (!Number.isInteger(id) || id <= 0) return "warning_id must be a positive integer.";
      const result = deleteWarning(id, guild.id);
      if (!result.changes) return `No warning with ID ${id} found in this server.`;
      const reason = input.reason || "No reason";
      await sendModLog(guild, logEvent({
        kind: "warnRemoved",
        actor: message.author,
        reason,
        meta: {
          "Warning ID": `#${id}`,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "remove_warning", message.author.id, String(id));
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: String(id),
        action: "remove_warning", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Removed warning #${id}.`;
    }

    case "clear_warnings": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const hierErr = checkHierarchy(message.member, member, guild);
      if (hierErr) return hierErr;
      const before = getWarnings(guild.id, member.id).length;
      if (!before) return `${member.user.tag} has no warnings to clear.`;
      const result = clearWarnings(guild.id, member.id);
      const reason = input.reason || "No reason";
      await sendModLog(guild, logEvent({
        kind: "warnsCleared",
        target: member.user,
        actor: message.author,
        reason,
        meta: {
          "Warnings Cleared": `${result.changes}`,
          "Invoked Via": "AI tool",
        },
      }));
      logAudit(guild.id, "clear_warnings", message.author.id, input.username);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: member.id,
        action: "clear_warnings", reason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Cleared ${result.changes} warning${result.changes === 1 ? "" : "s"} from ${member.user.tag}.`;
    }

    case "lockdown_server": {
      // Mirror ban/kick: re-check the invoking member's Discord perm at point
      // of effect. Without this, a stale trusted_users entry could lock the
      // whole server via the AI path. ManageChannels matches the safety helper.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageChannels, guild))
        return "You can't lock down the server.";
      const { activateLockdown } = await import("../../utils/safety.js");
      const lockReason = input.reason || "manual lockdown by admin";
      const ok = await activateLockdown(guild, lockReason);
      if (ok) {
        writeModAudit({
          guildId: guild.id, actorId: message.author.id, targetId: guild.id,
          action: "lockdown", reason: lockReason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
        });
      }
      return ok ? "server locked down — all text channels restricted to admins only" : "server is already in lockdown";
    }

    case "unlock_server": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageChannels, guild))
        return "You can't unlock the server.";
      const { deactivateLockdown } = await import("../../utils/safety.js");
      const unlockReason = input.reason || "manual unlock by admin";
      const ok = await deactivateLockdown(guild, unlockReason);
      if (ok) {
        writeModAudit({
          guildId: guild.id, actorId: message.author.id, targetId: guild.id,
          action: "unlock", reason: unlockReason, source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
        });
      }
      return ok ? "lockdown lifted — channels restored to normal" : "server wasn't in lockdown";
    }

    case "find_message": {
      // find_message scans channel history for a moderator — gate it like the
      // other read-into-mod tools. Without this re-check a stale trusted_users
      // entry could let a non-mod search arbitrary channels via the AI path.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageMessages, guild))
        return "You can't search messages.";
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const maxScan = Math.min(Math.max(input.limit || 200, 1), 500);
      const wantFirst = (input.position ?? "first") === "first";

      // Resolve target user if provided
      let targetUserId = null;
      if (input.from_user) {
        const member = findMember(guild, input.from_user);
        if (!member) return `Couldn't find user "${input.from_user}"`;
        targetUserId = member.id;
      }

      const searchLower = input.contains?.toLowerCase() ?? null;

      // Fetch in batches
      const matches = [];
      let lastId = undefined;
      let scanned = 0;
      while (scanned < maxScan) {
        const batchSize = Math.min(100, maxScan - scanned);
        const opts = { limit: batchSize };
        if (lastId) opts.before = lastId;
        const batch = await ch.messages.fetch(opts);
        if (batch.size === 0) break;
        for (const m of batch.values()) {
          let ok = true;
          if (targetUserId && m.author.id !== targetUserId) ok = false;
          if (searchLower && !m.content.toLowerCase().includes(searchLower)) ok = false;
          if (ok) matches.push(m);
        }
        scanned += batch.size;
        lastId = batch.last()?.id;
      }

      if (!matches.length) return "No matching messages found.";

      // matches are newest→oldest (Discord fetch order). "first" = oldest = last in array
      const pick = wantFirst ? matches[matches.length - 1] : matches[0];
      const preview = pick.content.slice(0, 80) || "(no text content)";
      const ts = `<t:${Math.floor(pick.createdTimestamp / 1000)}:R>`;

      return [
        `Found message from **${pick.author.username}** ${ts}`,
        `ID: \`${pick.id}\``,
        `Preview: "${preview}"`,
        `Scanned ${scanned} messages, ${matches.length} matched.`,
      ].join("\n");
    }

    case "purge_messages": {
      // Match /purge slash-command gate (ManageMessages). Audit flagged this
      // as HIGH severity — previously relied on the upstream ADMIN_TOOLS
      // gate alone, so a stale trusted_users entry could drive a 500-message
      // delete with no per-perm re-check.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageMessages, guild))
        return "You can't purge messages.";
      // Large AI-initiated purges defer to a human Confirm click. Sub-threshold
      // purges (and all confirmed replays / slash-equivalent paths) run inline.
      const requestedCount = Math.min(Math.max(input.count || 100, 1), 500);
      if (requestedCount > PURGE_CONFIRM_THRESHOLD) {
        const purgeDefer = _maybeDeferToConfirm("purge_messages", input, message, ctx, {
          requiredPerm: PermissionFlagsBits.ManageMessages,
          summary: `Purge up to **${requestedCount}** messages`,
        });
        if (purgeDefer) return purgeDefer;
      }
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;

      const maxScan = Math.min(Math.max(input.count || 100, 1), 500);

      // ── Fetch messages in batches of 100 ────────────────────────────
      const allMessages = [];
      let lastId = input.before_message_id ?? undefined;
      while (allMessages.length < maxScan) {
        const batchSize = Math.min(100, maxScan - allMessages.length);
        const opts = { limit: batchSize };
        if (lastId) opts.before = lastId;
        const batch = await ch.messages.fetch(opts);
        if (batch.size === 0) break;
        for (const m of batch.values()) allMessages.push(m);
        lastId = batch.last()?.id;
      }

      if (!allMessages.length) return "No messages found.";

      // ── Apply filters ────────────────────────────────────────────────
      const hasMedia = (m) =>
        m.attachments.size > 0 ||
        m.embeds.some((e) => ["image","video","gifv"].includes(e.type) || e.image || e.video);
      const urlRe = /https?:\/\/\S+/i;

      let filtered = allMessages;

      // Position filters
      if (input.after_message_id) {
        const afterId = BigInt(input.after_message_id);
        filtered = filtered.filter((m) => BigInt(m.id) > afterId);
      }

      // Date filters
      if (input.before_date) {
        const beforeTs = new Date(input.before_date).getTime();
        if (!isNaN(beforeTs)) filtered = filtered.filter((m) => m.createdTimestamp < beforeTs);
      }
      if (input.after_date) {
        const afterTs = new Date(input.after_date).getTime();
        if (!isNaN(afterTs)) filtered = filtered.filter((m) => m.createdTimestamp > afterTs);
      }

      // User filters — fail loud when a name can't be resolved. Previously
      // these silently no-op'd, so "delete bob's spam" with an unresolvable
      // bob purged the last N messages from EVERYONE in the channel.
      if (input.from_user) {
        const member = findMember(guild, input.from_user);
        if (!member) return `Couldn't find user "${input.from_user}" — refusing to purge without the from_user filter. Use @mention or user ID.`;
        filtered = filtered.filter((m) => m.author.id === member.id);
      }
      if (input.exclude_user) {
        const member = findMember(guild, input.exclude_user);
        if (!member) return `Couldn't find user "${input.exclude_user}" — refusing to purge without the exclude_user filter.`;
        filtered = filtered.filter((m) => m.author.id !== member.id);
      }
      if (input.only_keep_media_from_user) {
        const member = findMember(guild, input.only_keep_media_from_user);
        if (!member) return `Couldn't find user "${input.only_keep_media_from_user}".`;
        filtered = filtered.filter((m) => !(m.author.id === member.id && hasMedia(m)));
      }

      // Content type
      if (input.content_type === "media") filtered = filtered.filter((m) => hasMedia(m));
      else if (input.content_type === "text") filtered = filtered.filter((m) => !hasMedia(m));

      // Text content filters
      if (input.contains) {
        const lower = input.contains.toLowerCase();
        filtered = filtered.filter((m) => m.content.toLowerCase().includes(lower));
      }
      if (input.not_contains) {
        const lower = input.not_contains.toLowerCase();
        filtered = filtered.filter((m) => !m.content.toLowerCase().includes(lower));
      }

      // Link filter
      if (input.has_links === true) filtered = filtered.filter((m) => urlRe.test(m.content));
      else if (input.has_links === false) filtered = filtered.filter((m) => !urlRe.test(m.content));

      // Always skip pinned messages unless explicitly asked to include them
      if (input.is_pinned === true) filtered = filtered.filter((m) => m.pinned);
      else filtered = filtered.filter((m) => !m.pinned);

      if (!filtered.length) return "No messages matched those filters.";

      // ── Split into bulk-deletable (< 14 days) and old (>= 14 days) ────
      const fourteenDaysMs = 14 * 24 * 60 * 60_000;
      const cutoff = Date.now() - fourteenDaysMs + 60_000; // 1 min buffer
      const recent = filtered.filter((m) => m.createdTimestamp >= cutoff);
      const old    = filtered.filter((m) => m.createdTimestamp < cutoff);

      let totalDeleted = 0;

      // Bulk delete recent messages in chunks of 100
      for (let i = 0; i < recent.length; i += 100) {
        const chunk = recent.slice(i, i + 100);
        try {
          const deleted = await ch.bulkDelete(chunk, true);
          totalDeleted += deleted.size;
        } catch (err) {
          log(`[Purge] Bulk batch error: ${err.message}`);
        }
      }

      // Delete old messages in parallel batches of 5 with rate limit spacing
      let oldDeleted = 0;
      for (let i = 0; i < old.length; i += 5) {
        const batch = old.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map((m) => m.delete()));
        oldDeleted += results.filter((r) => r.status === "fulfilled").length;
        if (i + 5 < old.length) await new Promise((r) => setTimeout(r, 1100));
      }
      totalDeleted += oldDeleted;

      logAudit(guild.id, "purge", message.author.id, `${totalDeleted} messages`);
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: ch.id,
        action: "purge", reason: `${totalDeleted} messages from #${ch.name}`,
        source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      const parts = [`Deleted ${totalDeleted} messages from #${ch.name}`];
      if (recent.length > 0) parts.push(`${recent.length} bulk-deleted (recent)`);
      if (oldDeleted > 0)    parts.push(`${oldDeleted} individually deleted (older than 14 days)`);
      if (old.length - oldDeleted > 0) parts.push(`${old.length - oldDeleted} failed to delete`);
      return parts.join(" — ");
    }

    case "snipe": {
      // snipe is an EVERYONE_TOOL, so the upstream ADMIN_TOOLS gate doesn't
      // cover it — re-check here so a non-mod can't exfiltrate deleted message
      // content via the AI. ManageMessages mirrors the deleted-message scope.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageMessages, guild))
        return "You can't snipe deleted messages.";
      const { getSnipedMessage, getSnipeCount } = await import("../../utils/snipe.js");
      const index = Math.max(0, (input.index || 1) - 1); // 1-based to 0-based
      const sniped = getSnipedMessage(message.channel.id, index);
      if (!sniped) return "nothing to snipe — no recently deleted messages in this channel (messages expire after 30 min)";
      const counts = getSnipeCount(message.channel.id);
      const elapsed = Math.floor((Date.now() - sniped.deletedAt) / 1000);
      const timeStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`;
      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setAuthor({ name: sniped.author, iconURL: sniped.avatar || undefined })
        .setDescription(sniped.content || "(no text)")
        .setFooter({ text: `deleted ${timeStr} • ${index + 1}/${counts.deletes} sniped messages` })
        .setTimestamp(sniped.deletedAt);
      if (sniped.attachments?.length) embed.setImage(sniped.attachments[0].url || sniped.attachments[0]);
      if (sniped.stickers?.length) embed.addFields({ name: "Stickers", value: sniped.stickers.join(", "), inline: true });
      await message.channel.send({ embeds: [embed] });
      return `sniped message ${index + 1}/${counts.deletes} — by ${sniped.author}`;
    }

    case "editsnipe": {
      // Same exfil concern as snipe — gate it so a non-mod can't pull edited
      // message before/after content via the AI.
      if (!_memberHasPerm(message.member, PermissionFlagsBits.ManageMessages, guild))
        return "You can't snipe edited messages.";
      const { getEditSnipe, getSnipeCount } = await import("../../utils/snipe.js");
      const index = Math.max(0, (input.index || 1) - 1);
      const edit = getEditSnipe(message.channel.id, index);
      if (!edit) return "nothing to editsnipe — no recently edited messages in this channel (edits expire after 30 min)";
      const counts = getSnipeCount(message.channel.id);
      const elapsed = Math.floor((Date.now() - edit.editedAt) / 1000);
      const timeStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`;
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setAuthor({ name: edit.author, iconURL: edit.avatar || undefined })
        .addFields(
          { name: "Before", value: edit.before.slice(0, 1024) || "(empty)" },
          { name: "After", value: edit.after.slice(0, 1024) || "(empty)" },
        )
        .setFooter({ text: `edited ${timeStr} • ${index + 1}/${counts.edits} edit-sniped` })
        .setTimestamp(edit.editedAt);
      if (edit.messageUrl) embed.setURL(edit.messageUrl);
      await message.channel.send({ embeds: [embed] });
      return `edit-sniped message ${index + 1}/${counts.edits} — by ${edit.author}`;
    }

    case "tempban": {
      if (!_memberHasPerm(message.member, PermissionFlagsBits.BanMembers, guild))
        return "You can't tempban users.";
      const target = findMember(guild, input.username);
      if (!target) return `Couldn't find user "${input.username}"`;
      if (target.id === message.client.user.id) return "I can't ban myself lol";
      const hierErr = checkHierarchy(message.member, target, guild);
      if (hierErr) return hierErr;
      if (!target.bannable) return `I can't ban ${target.user.tag} — they have higher permissions than me`;

      const durationStr = input.duration || "1h";
      const match = durationStr.match(/^(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?$/i);
      if (!match) return "Invalid duration — use formats like: 30m, 2h, 1d, 1w";

      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const multipliers = { m: 60000, min: 60000, h: 3600000, hr: 3600000, hour: 3600000, d: 86400000, day: 86400000, w: 604800000, week: 604800000 };
      const durationMs = num * (multipliers[unit] || 3600000);

      // AI-initiated tempbans defer to a human Confirm click (same as ban_user).
      const tempbanDefer = _maybeDeferToConfirm("tempban", input, message, ctx, {
        requiredPerm: PermissionFlagsBits.BanMembers,
        targetId: target.id,
        durationStr,
        durationMs,
        summary: `Temp-ban **${target.user.tag}** for ${durationStr} (reason: ${input.reason || "No reason provided"})`,
      });
      if (tempbanDefer) return tempbanDefer;

      const reason = input.reason || "No reason provided";

      const banResult = await _banMember(target, { reason: _attributedReason(message.author, `[TEMP ${durationStr}] ${reason}`) }, "inline tempban");
      if (!banResult.ok) return banResult.message;
      const { addTempBan } = await import("../../database.js");
      addTempBan(guild.id, target.id, target.user.tag, durationMs, reason, message.author.id);
      // Send "ban" to Eris rather than "tempban" — Eris doesn't distinguish
      // sub-types of ban for economy enforcement, only that the user was
      // banned. Keeping tempban as a separate signal would silently no-op on
      // Eris's side. See dashboard.js for the punish action vocabulary.
      firePunishSignal({ guildId: guild.id, userId: target.id, action: "ban", reason }).catch(() => {});
      writeModAudit({
        guildId: guild.id, actorId: message.author.id, targetId: target.id,
        action: "tempban", reason: `[${durationStr}] ${reason}`,
        source: _auditSource(ctx), instruction: _auditInstruction(message, ctx),
      });
      return `Temp-banned ${target.user.tag} for ${durationStr} — reason: ${reason}. They'll be automatically unbanned.`;
    }
  }
}
