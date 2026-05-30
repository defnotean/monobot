/**
 * @file packages/eris/database/userContent.js
 * @module packages/eris/database/userContent
 *
 * Conversation history (Supabase direct — too large for memory), the editable
 * personality system-prompt, per-server persona overrides, plus the per-user
 * persistent stores: facts/memory (with sensitivity tiers + optional TTL),
 * the outbound local-commands queue (HMAC-signed), notes, reminders, and code
 * snippets. Reminder mutations write through the shared `data.reminders` cache
 * held in core. Imports the Supabase client + cache from core.
 */
import { createHmac } from "node:crypto";
import { getSupabase, data } from "./core.js";
import config from "../config.js";
import { log } from "../utils/logger.js";

// ─── CONVERSATIONS (Supabase direct — too large for memory) ───
export async function saveInteraction(userId, username, channelId, content, isBot = false) {
  const supabase = getSupabase();
  if (!supabase || !userId || !channelId) return;
  const { error } = await supabase.from("eris_memories").insert({ user_id: userId, username, channel_id: channelId, content, is_bot: isBot });
  if (error) log(`[DB] saveInteraction: ${error.message}`);
}

export async function getRecentHistory(channelId, limit = 15) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows, error } = await supabase.from("eris_memories").select("*").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return rows.reverse();
}

// ─── PERSONALITY ───
export async function getPersonality() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: row } = await supabase.from("eris_personality").select("instructions").eq("id", "eris").single();
  return row?.instructions || null;
}

export async function updatePersonality(instructions) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_personality").upsert({ id: "eris", instructions });
  return !error;
}

// ─── PER-SERVER PERSONA (name + personality override) ───
const _serverPersonas = new Map(); // guildId → { name, personality }

export function getServerPersona(guildId) {
  return _serverPersonas.get(guildId) || null;
}

export function setServerPersona(guildId, name, personality = null) {
  if (!name && !personality) { _serverPersonas.delete(guildId); }
  else { _serverPersonas.set(guildId, { name: name || "Eris", personality: personality || null }); }
  // Persist to Supabase. Wrap in Promise.resolve: the PostgREST query builder is
  // a thenable but has no `.catch`, so a bare `.catch` here would throw
  // "catch is not a function" the moment this fire-and-forget write rejects.
  const supabase = getSupabase();
  if (supabase) Promise.resolve(supabase.from("bot_data").upsert({ id: "eris_server_personas", data: Object.fromEntries(_serverPersonas) })).catch(e => log(`[DB] ${e.message}`));
}

export function getAllServerPersonas() { return Object.fromEntries(_serverPersonas); }

// Load persisted personas on startup
(async () => {
  const supabase = getSupabase();
  if (!supabase) return;
  // Direct cast: this IIFE runs at module-eval before initDatabase() assigns the
  // client, so TS's control-flow narrows the module-level `supabase` let to never
  // here even though the runtime guard above proves it's a live client.
  const sb = /** @type {import("@supabase/supabase-js").SupabaseClient} */ (supabase);
  try {
    const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_server_personas").single();
    if (row?.data) for (const [gid, p] of Object.entries(row.data)) _serverPersonas.set(gid, p);
  } catch (e) { log(`[DB] ${e.message}`); }
})();

// ─── FACTS / MEMORY ───

// Optional TTL for sensitive-tier facts (privacy: emotional disclosures the
// user flagged as "sensitive" shouldn't necessarily live forever). Off by
// default — set SENSITIVE_FACT_TTL_DAYS to a positive integer to enable. Secret
// and normal facts are never auto-expired here (secrets are access-gated and
// never embedded; normal facts persist by importance, not time).
const _SENSITIVE_FACT_TTL_DAYS = (() => {
  const raw = process.env.SENSITIVE_FACT_TTL_DAYS;
  if (raw == null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

// Tracks whether the `expires_at` column (migration 006) is deployed. The first
// insert that trips a column-not-found error flips this off and never retries —
// every later write then drops to the legacy row shape (no expiry) so facts keep
// persisting before migrations/006 is applied. Mirrors the
// `_localCmdSigColsAvailable` latch idiom.
let _factExpiryColAvailable = true;

export async function saveFact(userId, factText, sensitivity = "normal", importance = "normal") {
  const supabase = getSupabase();
  if (!supabase) return false;
  const baseRow = { user_id: userId, fact_text: factText, sensitivity, importance: importance || "normal" };
  /** @type {typeof baseRow & { expires_at?: string }} */
  const row = { ...baseRow };
  // Stamp an expiry only for sensitive-tier facts when a TTL is configured AND
  // the column is known to exist. Degrades to the legacy (no-expiry) shape
  // otherwise so nothing breaks before migration 006.
  if (_factExpiryColAvailable && _SENSITIVE_FACT_TTL_DAYS > 0 && sensitivity === "sensitive") {
    row.expires_at = new Date(Date.now() + _SENSITIVE_FACT_TTL_DAYS * 86_400_000).toISOString();
  }
  const { error } = await supabase.from("eris_facts").insert(row);
  if (error) {
    // Migration 006 (expires_at column) not applied yet — retry with the legacy
    // shape so fact writes keep succeeding. Latch the column off for the process
    // lifetime so we don't pay the failed round-trip on every write.
    if (_factExpiryColAvailable && row.expires_at !== undefined &&
        (error.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(error.message || ""))) {
      _factExpiryColAvailable = false;
      log(`[DB] saveFact: eris_facts.expires_at column missing — falling back to no-expiry inserts. Apply migrations/006_facts_expiry.sql to enable sensitive-fact TTL.`);
      const { error: retryErr } = await supabase.from("eris_facts").insert(baseRow);
      return !retryErr;
    }
    return false;
  }
  return true;
}

export async function getFacts(userId, limit = 20) {
  const supabase = getSupabase();
  if (!supabase) return [];
  // Newest-first so a long-term user's most recent facts reach context rather
  // than being crowded out by the oldest `limit` rows. Coordinates with the
  // write-side cap enforced in memory.js/memoryExecutor.js.
  // Selecting expires_at (when present) lets us hide already-expired sensitive
  // facts from context immediately, even before the prune cron sweeps the row.
  // The column may not exist pre-migration-006; PostgREST silently omits it and
  // the filter below is a no-op in that case.
  const { data: rows } = await supabase.from("eris_facts").select("id, fact_text, sensitivity, importance, expires_at, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  return _filterExpiredFacts(rows);
}

// Drop facts whose expires_at has passed. Rows without the column (legacy /
// pre-migration) carry no expires_at and are always kept.
function _filterExpiredFacts(rows) {
  if (!rows) return [];
  const now = Date.now();
  return rows.filter(r => {
    if (!r || r.expires_at == null) return true;
    const t = Date.parse(r.expires_at);
    return !Number.isFinite(t) || t > now;
  });
}

/**
 * Hard-delete sensitive-tier facts whose expires_at has elapsed. Best-effort:
 * returns 0 (and logs nothing loud) when the column is missing or Supabase is
 * offline. Intended to be called from the same maintenance cron that prunes
 * episodic memories. Degrades safely everywhere.
 */
export async function pruneExpiredFacts() {
  const supabase = getSupabase();
  if (!supabase || !_factExpiryColAvailable) return { deleted: 0 };
  try {
    const result = await supabase
      .from("eris_facts")
      .delete()
      .not("expires_at", "is", null)
      .lt("expires_at", new Date().toISOString());
    if (result?.error) {
      if (/column .* does not exist|Could not find the .* column/i.test(result.error.message || "")) {
        _factExpiryColAvailable = false;
      }
      return { deleted: 0 };
    }
    return { deleted: result?.count ?? 0 };
  } catch {
    return { deleted: 0 };
  }
}

export async function getFactsGlobal(userId, limit = 20) {
  const supabase = getSupabase();
  if (!supabase) return [];
  // Get facts across all servers — no guild filter. Selecting + filtering
  // expires_at keeps this consistent with getFacts so a future caller that
  // builds context off getFactsGlobal can't surface already-expired sensitive
  // facts. No-op pre-migration-006 (PostgREST omits the missing column).
  const { data: rows } = await supabase.from("eris_facts").select("id, fact_text, sensitivity, importance, expires_at, created_at").eq("user_id", userId).order("created_at", { ascending: true }).limit(limit);
  return _filterExpiredFacts(rows);
}

/**
 * @returns {Promise<{ success: true, deleted: string } | { success: false, error?: string }>}
 */
export async function deleteFactByText(userId, searchText) {
  const supabase = getSupabase();
  // Offline: keep the object shape (rather than a bare false) so callers can
  // read .success/.error without a type guard; no error message means the
  // caller falls through to its generic "couldn't find that memory" line.
  if (!supabase) return { success: false };
  const facts = await getFacts(userId);
  const lower = searchText.toLowerCase();
  const match = facts.find(f => (f.fact_text || "").toLowerCase().includes(lower));
  if (!match) return { success: false, error: "no matching memory found" };
  const { error } = await supabase.from("eris_facts").delete().eq("id", match.id).eq("user_id", userId);
  return error ? { success: false, error: error.message } : { success: true, deleted: match.fact_text };
}

export async function clearAllFacts(userId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_facts").delete().eq("user_id", userId);
  return !error;
}

/**
 * Get only facts that are safe to show in a given context.
 * - "private" context: returns ALL facts (including secrets) — used when building context for this user only
 * - "public" context: returns only "normal" facts — used when another user asks about someone
 */
export async function getFactsFiltered(userId, context = "private") {
  const allFacts = await getFacts(userId);
  if (context === "private") return allFacts; // user gets to see their own secrets in context
  return allFacts.filter(f => (f.sensitivity || "normal") === "normal"); // others only see normal facts
}

export async function deleteFact(userId, factId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_facts").delete().eq("id", factId).eq("user_id", userId);
  return !error;
}

// ─── LOCAL COMMANDS ───
// One-time warning latch so an unsigned-enqueue config gap is logged loudly
// without spamming the log on every command.
let _localCmdSignWarned = false;
// Tracks whether the sig/ts columns (migration 004) are deployed. The first
// insert that trips a column-not-found error flips this to false and never
// retries — every later enqueue then drops straight to the legacy row shape so
// the command queue keeps working before migrations/004 is applied. Mirrors the
// `_rpcAddBalanceAvailable` latch idiom above.
let _localCmdSigColsAvailable = true;

export async function queueLocalCommand(command, channelId, requestedBy) {
  const supabase = getSupabase();
  if (!supabase) return false;
  // The PC-agent poller requires an HMAC signature over the request so a
  // forged local_commands row can't drive owner machine-level execution.
  // sig = HMAC_SHA256(secret, `${requested_by}.${command}.${ts}`).
  const ts = Date.now();
  const secret = config.twinApiSecret || config.pcAgentSecret || null;
  // Legacy row shape (pre-migration-004): no sig/ts columns.
  const baseRow = { command, channel_id: channelId, requested_by: requestedBy, status: "pending" };
  /** @type {typeof baseRow & { ts?: number, sig?: string }} */
  const row = { ...baseRow };
  if (_localCmdSigColsAvailable) {
    row.ts = ts;
    if (secret) {
      row.sig = createHmac("sha256", secret).update(`${requestedBy}.${command}.${ts}`).digest("hex");
    } else if (!_localCmdSignWarned) {
      _localCmdSignWarned = true;
      log(`[DB] queueLocalCommand: NO twinApiSecret/pcAgentSecret configured — enqueuing UNSIGNED local commands. The PC-agent poller will reject these. Set TWIN_API_SECRET.`);
    }
  }
  const { error } = await supabase.from("local_commands").insert(row);
  if (error) {
    // Migration 004 (sig/ts columns) not applied yet — PostgREST reports the
    // unknown column as PGRST204 / "column ... does not exist" / "Could not
    // find the ... column". Latch the columns off for the process lifetime and
    // retry with the legacy row so PC-agent enqueues still succeed.
    if (_localCmdSigColsAvailable &&
        (error.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(error.message || ""))) {
      _localCmdSigColsAvailable = false;
      log(`[DB] queueLocalCommand: local_commands.sig/ts columns missing — falling back to unsigned legacy enqueue. Apply migrations/004_local_commands_signature.sql to enable signed commands.`);
      const { error: retryErr } = await supabase.from("local_commands").insert(baseRow);
      return !retryErr;
    }
    return false;
  }
  return true;
}

// ─── NOTES ───
export async function saveNote(userId, title, content) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_notes").insert({ user_id: userId, title, content });
  return !error;
}

export async function getNotes(userId, limit = 20) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_notes").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  return rows || [];
}

export async function deleteNote(userId, noteId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_notes").delete().eq("id", noteId).eq("user_id", userId);
  return !error;
}

export async function searchNotes(userId, query) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const safeQuery = String(query || "")
    .replace(/[,.()%*:\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!safeQuery) return [];
  const { data: rows } = await supabase.from("eris_notes").select("*").eq("user_id", userId).or(`title.ilike.%${safeQuery}%,content.ilike.%${safeQuery}%`).limit(10);
  return rows || [];
}

// ─── REMINDERS ───
export async function saveReminder(userId, channelId, text, remindAt) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const row = { user_id: userId, channel_id: channelId, reminder_text: text, remind_at: remindAt, status: "pending" };
  // Return the inserted row so the cache carries the DB-assigned id. Without it
  // the cached row has no id and markReminderDone (which filters by id) can
  // never evict it — the reminder lingers in the cache forever.
  const { data: inserted, error } = await supabase.from("eris_reminders").insert(row).select().single();
  if (!error) data.reminders.push(inserted ? { ...inserted } : row);
  return !error;
}

export async function getPendingReminders() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
  const { data: rows } = await supabase.from("eris_reminders").select("*").eq("status", "pending").gte("remind_at", fiveMinAgo.toISOString()).lte("remind_at", now.toISOString());
  return rows || [];
}

export async function markReminderDone(id) {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.from("eris_reminders").update({ status: "done" }).eq("id", id);
  data.reminders = data.reminders.filter(r => r.id !== id);
}

export async function markRemindersDoneBatch(ids) {
  const supabase = getSupabase();
  if (!supabase || !ids.length) return;
  await supabase.from("eris_reminders").update({ status: "done" }).in("id", ids);
  const idSet = new Set(ids);
  data.reminders = data.reminders.filter(r => !idSet.has(r.id));
}

export async function getUserReminders(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_reminders").select("*").eq("user_id", userId).eq("status", "pending").order("remind_at", { ascending: true });
  return rows || [];
}

export async function cancelReminder(userId, id) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_reminders").update({ status: "cancelled" }).eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── SNIPPETS ───
export async function saveSnippet(userId, name, language, code) {
  const supabase = getSupabase();
  if (!supabase) return false;
  await supabase.from("eris_snippets").delete().eq("user_id", userId).eq("name", name);
  const { error } = await supabase.from("eris_snippets").insert({ user_id: userId, name, language, code });
  return !error;
}

export async function getSnippet(userId, name) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: row } = await supabase.from("eris_snippets").select("*").eq("user_id", userId).eq("name", name).single();
  return row;
}

export async function listSnippets(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_snippets").select("name, language, created_at").eq("user_id", userId).order("created_at", { ascending: false });
  return rows || [];
}
