// ─── Scheduled Task Runner ─────────────────────────────────────────────────
// Fires deferred tool calls created via the schedule_task AI tool.
// Uses dynamic imports to dodge the ai/executor.js ↔ advancedExecutor cycle.

import { log } from "./logger.js";
import { ADMIN_TOOLS } from "../ai/tools.js";
import { TOOL_ALIASES } from "../ai/toolAliases.js";
import { isAdminMember } from "./permissions.js";

// Max delay — setTimeout clamps at 2^31-1 ms (~24.8 days). We cap the
// queue-creation AND restore-path at 30 days.
export const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const TASK_EXEC_TIMEOUT_MS = 60_000;

// Map<taskId, NodeJS.Timeout> — kept in memory so cancel_scheduled_task can clear.
export const scheduledTaskTimers = new Map();
// Set<taskId> — tasks currently firing (serialization guard against double-arm re-entry).
const _firing = new Set();

// Tools that must never be scheduled (prevents recursion / fork bombs).
// All names are stored LOWERCASE; callers must normalize before lookup.
export const NON_SCHEDULABLE = new Set([
  "schedule_task",
  "cancel_scheduled_task",
  "list_scheduled_tasks",
]);

export function normalizeToolName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

// Admin-class tools — derived from the same source that builds the admin-only
// tool schema, so newly added admin tools cannot bypass scheduled execution.
export const ADMIN_TOOL_NAMES = new Set(
  ADMIN_TOOLS.map((tool) => normalizeToolName(tool?.name)).filter(Boolean)
);

export function resolveScheduledToolName(name) {
  const normalized = normalizeToolName(name);
  return normalizeToolName(TOOL_ALIASES[normalized] || normalized);
}

export function isAdminToolName(name) {
  return ADMIN_TOOL_NAMES.has(resolveScheduledToolName(name));
}

// Restore idempotency — ready-event racing could trigger restore twice.
let _restored = false;

// Rebuilds the minimum "message" shape sub-executors expect, from stored IDs.
async function rehydrateMessage(client, { guildId, channelId, authorId }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  let channel = guild.channels.cache.get(channelId);
  if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const author = await client.users.fetch(authorId).catch(() => null);
  if (!author) return null;

  const member = await guild.members.fetch(authorId).catch(() => null);

  return {
    client,
    guild,
    channel,
    author,
    member,
    id: `scheduled-${Date.now()}`,
    reply: async (payload) => channel.send(typeof payload === "string" ? { content: payload } : payload),
    _scheduled: true,
  };
}

// Actually run the scheduled task. Called by setTimeout and on-startup restore.
async function fireScheduledTask(task, client) {
  scheduledTaskTimers.delete(task.id);
  if (_firing.has(task.id)) return; // already firing — prevent reentry
  _firing.add(task.id);

  let removed = false;
  const { removeScheduledTask, flushNow } = await import("../database.js");
  // Async + flushed — removeScheduledTask alone only mutates in-memory state
  // and schedules a debounced 2s write. If the bot crashes inside that
  // window, the task's DB row survives and fires again on restart (double-
  // execution on a 'timeout 5m then untimeout' means the untimeout doubles).
  // flushNow() collapses the debounce so the removal is durable before we
  // return.
  const safeRemove = async () => {
    if (removed) return;
    removed = true;
    try {
      removeScheduledTask(task.id);
      await flushNow();
    } catch (err) {
      log(`[Schedule] remove failed for #${task.id}: ${err.message}`);
    }
  };

  try {
    // Re-check denylist — a tool added to NON_SCHEDULABLE after this task
    // was queued must NOT fire.
    const normalized = normalizeToolName(task.toolName);
    if (!normalized || NON_SCHEDULABLE.has(normalized)) {
      log(`[Schedule] Task #${task.id} refused — non-schedulable or missing toolName`);
      await safeRemove();
      return;
    }

    const msg = await rehydrateMessage(client, task);
    if (!msg) {
      // Guild may be temporarily unavailable — don't drop immediately on cold
      // boot. Re-arm once after a short delay; only drop on repeat failure.
      if (!task._rehydrateAttempted) {
        task._rehydrateAttempted = true;
        const timer = setTimeout(() => fireScheduledTask(task, client), 30_000);
        scheduledTaskTimers.set(task.id, timer);
        log(`[Schedule] Task #${task.id} rehydrate failed — retrying in 30s`);
        return;
      }
      log(`[Schedule] Task #${task.id} (${task.toolName}) skipped — guild/channel/user no longer reachable`);
      await safeRemove();
      return;
    }

    // Admin re-check — demoted users shouldn't get delayed admin powers.
    if (isAdminToolName(normalized) && !isAdminMember(msg.member)) {
      log(`[Schedule] Task #${task.id} (${task.toolName}) dropped — scheduler ${task.authorId} no longer admin`);
      await safeRemove();
      return;
    }

    // Remove BEFORE executing so a crash mid-execute can't cause re-fire on
    // restart (tradeoff: lose the action on crash; duplicate bans are worse
    // than missed ones). await so the flush durably commits before the tool
    // actually runs.
    await safeRemove();

    const { executeTool } = await import("../ai/executor.js");
    const result = await Promise.race([
      executeTool(normalized, task.toolInput, msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error("execute timeout")), TASK_EXEC_TIMEOUT_MS)),
    ]);

    log(`[Schedule] Task #${task.id} fired: ${task.toolName} → ${String(result ?? "(no result)").slice(0, 140)}`);
  } catch (err) {
    log(`[Schedule] Task #${task.id} failed: ${err.message}`);
    await safeRemove();
  } finally {
    _firing.delete(task.id);
  }
}

// Register a timer for a task that hasn't fired yet. Fires immediately if overdue.
// Defensive against malformed task rows — callers pass them unvalidated from DB.
export function armScheduledTask(task, client) {
  if (!task || typeof task !== "object" || !task.id || !task.toolName || typeof task.fireAt !== "number" || !Number.isFinite(task.fireAt)) {
    log(`[Schedule] refusing to arm malformed task: ${JSON.stringify(task).slice(0, 200)}`);
    return -1;
  }

  const existing = scheduledTaskTimers.get(task.id);
  if (existing) clearTimeout(existing);

  const delta = task.fireAt - Date.now();
  if (delta > MAX_DELAY_MS) {
    // Corrupted or far-future row — drop it rather than fire immediately.
    // flushNow so a restart doesn't see the same bad row and try again.
    log(`[Schedule] Task #${task.id} (${task.toolName}) rejected — fireAt ${delta}ms in the future exceeds cap`);
    (async () => {
      try {
        const { removeScheduledTask, flushNow } = await import("../database.js");
        removeScheduledTask(task.id);
        await flushNow();
      } catch {}
    })();
    return -1;
  }
  const delay = Math.max(0, delta);
  const timer = setTimeout(() => fireScheduledTask(task, client), delay);
  scheduledTaskTimers.set(task.id, timer);
  return delay;
}

// Rehydrate all pending tasks at bot startup.
export async function restoreScheduledTasks(client) {
  if (_restored) return;
  _restored = true;
  let tasks = [];
  try {
    const { getScheduledTasks } = await import("../database.js");
    tasks = getScheduledTasks() || [];
  } catch (err) {
    log(`[Schedule] Failed to load tasks: ${err.message}`);
    return;
  }
  if (!Array.isArray(tasks)) {
    log(`[Schedule] getScheduledTasks returned non-array — skipping restore`);
    return;
  }
  let armed = 0;
  for (const task of tasks) {
    try {
      if (armScheduledTask(task, client) >= 0) armed++;
    } catch (err) {
      log(`[Schedule] Failed to arm task ${task?.id}: ${err.message}`);
    }
  }
  if (armed) log(`[Schedule] Restored ${armed} pending scheduled task(s)`);
}
