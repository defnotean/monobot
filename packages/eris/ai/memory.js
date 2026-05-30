// ─── User Memory System ──────────────────────────────────────────────────────
// In-memory Map with Supabase backing via facts table
// Supports sensitivity levels: normal, sensitive, secret

import * as db from "../database.js";
import { compareMemoryPriority, rankMemoryFact } from "@defnotean/shared/innerState";

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

  const trimmedFact = fact.trim();
  const meta = rankMemoryFact(trimmedFact, importance);
  const existing = await db.getFacts(userId, MAX_PER_USER);

  // Duplicate check
  const lower = trimmedFact.toLowerCase();
  if (existing.some(f => (f.fact_text || f).toLowerCase().includes(lower) || lower.includes((f.fact_text || f).toLowerCase()))) {
    return { success: false, message: "already remembered something similar" };
  }

  if (existing.length >= MAX_PER_USER) {
    const lowest = [...existing].sort(compareMemoryPriority)[0];
    const lowestMeta = rankMemoryFact(lowest?.fact_text || lowest, lowest?.importance);
    if (!lowest?.id || meta.weight <= lowestMeta.weight) {
      return { success: false, message: "memory full — only important/core facts can replace low-priority memories" };
    }
    await db.deleteFact(userId, lowest.id);
  }

  const ok = await db.saveFact(userId, trimmedFact, sensitivity, meta.importance);
  return ok ? { success: true, message: `remembered: ${trimmedFact}` } : { success: false, message: "failed to save" };
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
      const meta = rankMemoryFact(text, f.importance);
      const prefix = meta.importance === "core" ? "core: " : meta.importance === "important" ? "important: " : meta.importance === "trivial" ? "tentative: " : "";
      const factLine = `${prefix}${text}`;
      const level = f.sensitivity || "normal";
      if (level === "secret") secretFacts.push(factLine);
      else if (level === "sensitive") sensitiveFacts.push(factLine);
      else normalFacts.push(factLine);
    }

    const parts = [];
    parts.push("[MEMORY RULE: memories are useful but not perfect. Treat tentative memories as low confidence; do not overstate them, and ask/hedge if precision matters.]");
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
