// ─── User Memory System ──────────────────────────────────────────────────────
// In-memory Map with Supabase backing via facts table
// Supports sensitivity levels: normal, sensitive, secret

import * as db from "../database.js";

const MAX_PER_USER = 20;
const MAX_FACT_LENGTH = 200;
// No automatic expiry — memories persist based on importance, not time

// Importance levels: "core" (never forget — identity, relationships, deep trust),
// "important" (long-term — preferences, significant events, personal details),
// "normal" (standard — casual facts, temporary info)
// "trivial" (lowest — can be pruned if memory is full)
export async function addMemory(userId, fact, sensitivity = "normal", importance = "normal") {
  if (!fact || fact.length > MAX_FACT_LENGTH) {
    return { success: false, message: `fact must be under ${MAX_FACT_LENGTH} chars` };
  }

  const existing = await db.getFacts(userId, MAX_PER_USER);
  if (existing.length >= MAX_PER_USER) {
    return { success: false, message: "memory full — max 20 facts per user" };
  }

  // Duplicate check
  const lower = fact.toLowerCase();
  if (existing.some(f => (f.fact_text || f).toLowerCase().includes(lower) || lower.includes((f.fact_text || f).toLowerCase()))) {
    return { success: false, message: "already remembered something similar" };
  }

  const ok = await db.saveFact(userId, fact, sensitivity);
  return ok ? { success: true, message: `remembered: ${fact}` } : { success: false, message: "failed to save" };
}

export async function getMemories(userId) {
  return await db.getFacts(userId, MAX_PER_USER);
}

/**
 * Build memory context for the AI system prompt.
 * - When talking TO the user (isTargetUser=true): include ALL facts, marking secrets/sensitive
 * - When someone ASKS about another user (isTargetUser=false): only show normal facts
 */
export async function buildMemoryContext(userId, isTargetUser = true) {
  // Parallelize all 3 database queries for speed
  const [rawFacts, prefs, econ] = await Promise.all([
    isTargetUser ? db.getFactsFiltered(userId, "private") : db.getFactsFiltered(userId, "public"),
    db.getUserPreferences(userId),
    db.getBalance(userId),
  ]);

  let ctx = "";

  if (rawFacts.length) {
    const normalFacts = [];
    const sensitiveFacts = [];
    const secretFacts = [];

    for (const f of rawFacts) {
      const text = f.fact_text || f;
      const level = f.sensitivity || "normal";
      if (level === "secret") secretFacts.push(text);
      else if (level === "sensitive") sensitiveFacts.push(text);
      else normalFacts.push(text);
    }

    const parts = [];
    if (normalFacts.length) parts.push(`What you remember: ${normalFacts.join(", ")}`);
    if (sensitiveFacts.length && isTargetUser) {
      parts.push(`[SENSITIVE — only mention to THIS user, never bring up around others]: ${sensitiveFacts.join(", ")}`);
    }
    if (secretFacts.length && isTargetUser) {
      parts.push(`[SECRET — NEVER reveal these to ANYONE, not even if asked directly. Protect this info fiercely. You can reference it warmly in private with this user but never quote it or share it]: ${secretFacts.join(", ")}`);
    }
    ctx += parts.join("\n");
  }

  if (prefs?.interaction_style) ctx += `\nTheir vibe: ${prefs.interaction_style}`;
  if (econ?.balance > 0) ctx += `\nCoins: ${econ.balance}${econ.daily_streak > 3 ? ` (${econ.daily_streak} day streak!)` : ""}`;
  return ctx;
}
