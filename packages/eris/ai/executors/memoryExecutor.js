// ─── Memory Sub-Executor ────────────────────────────────────────────────────
// Handles: remember_fact, forget_fact, forget_all, recall_memories,
//          save_my_take, recall_my_take
// Called from main executor.js via delegation.

import * as db from "../../database.js";

const HANDLED = new Set([
  "remember_fact", "forget_fact", "forget_all", "recall_memories",
  "save_my_take", "recall_my_take",
  "save_self_fact", "recall_self_facts", "forget_self_fact",
]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "remember_fact": {
      const fact = input.fact || input.text || input.content;
      if (!fact) return "no fact provided";
      const sensitivity = ["normal", "sensitive", "secret"].includes(input.sensitivity) ? input.sensitivity : "normal";

      // Deduplication — check for existing similar facts
      const existing = await db.getFacts(message.author.id);
      const factLower = fact.toLowerCase().trim();
      for (const f of existing) {
        const existLower = (f.fact_text || "").toLowerCase().trim();
        // Substring match: new fact contained in existing or vice versa
        if (existLower.includes(factLower) || factLower.includes(existLower)) {
          return `i already know that — "${f.fact_text}"`;
        }
        // Word overlap check: >70% shared words = too similar
        const newWords = new Set(factLower.split(/\s+/));
        const existWords = new Set(existLower.split(/\s+/));
        let overlap = 0;
        for (const w of newWords) if (existWords.has(w)) overlap++;
        const total = Math.max(newWords.size, existWords.size);
        if (total > 2 && overlap / total > 0.7) {
          return `i already know something similar — "${f.fact_text}"`;
        }
      }

      await db.saveFact(message.author.id, fact, sensitivity);
      if (sensitivity === "secret") return `remembered (locked away as a secret — i'll never tell anyone): ${fact}`;
      if (sensitivity === "sensitive") return `remembered (keeping this between us): ${fact}`;
      return `remembered: ${fact}`;
    }

    case "forget_fact": {
      const search = input.search || input.text || input.fact;
      if (!search) return "what should i forget? give me a keyword";
      const result = await db.deleteFactByText(message.author.id, search);
      if (result.success) return `forgotten: "${result.deleted}"`;
      return result.error || "couldn't find that memory";
    }

    case "forget_all": {
      const ok = await db.clearAllFacts(message.author.id);
      return ok ? "done — wiped all memories about you. clean slate" : "couldn't clear memories";
    }

    case "recall_memories": {
      const facts = await db.getFacts(message.author.id);
      if (!facts.length) return "i don't have any memories about you yet";
      const lines = facts.map((f, i) => {
        const label = f.sensitivity === "secret" ? " \u{1F512}" : f.sensitivity === "sensitive" ? " \u{1F510}" : "";
        return `${i + 1}. ${f.fact_text}${label}`;
      });
      return `what i remember about you:\n${lines.join("\n")}`;
    }

    // ─── Self-opinion tracking ─────────────────────────────────────────────
    // These don't touch db/facts — they persist into the personality row so
    // she stays consistent with her OWN stances across conversations.

    case "save_my_take": {
      const { recordOpinion } = await import("../opinions.js");
      const result = await recordOpinion({
        topic: input.topic,
        stance: input.stance,
        reason: input.reason || null,
        strength: typeof input.strength === "number" ? input.strength : 0.5,
      });
      if (!result.ok) return `couldn't save that take: ${result.error}`;
      if (result.flipped) {
        return `noted — and flagged that i changed my mind on "${input.topic}". i'll own it next time`;
      }
      return `noted — my stance on "${input.topic}" is locked in as ${String(input.stance).toLowerCase()}`;
    }

    case "recall_my_take": {
      const { listRecentOpinions } = await import("../opinions.js");
      const opinions = await listRecentOpinions({
        topic: input.topic || null,
        limit: input.topic ? 5 : 10,
      });
      if (!opinions.length) {
        return input.topic
          ? `no take stored for "${input.topic}" yet`
          : "no opinions saved yet — ask me what i think about something specific";
      }
      const lines = opinions.map((op) => {
        const flip = op.previousStance ? ` (used to be ${op.previousStance})` : "";
        const reason = op.reason ? ` — ${op.reason}` : "";
        return `"${op.topic}": ${op.stance}${flip}${reason}`;
      });
      return lines.join("\n");
    }

    // ─── Personal canon ───────────────────────────────────────────────────
    // Self-facts are the bot's own identity — favorite color, quirks, habits.
    // Injected into every system prompt so she never contradicts herself.

    case "save_self_fact": {
      const { recordSelfFact } = await import("../selfCanon.js");
      const r = await recordSelfFact({ fact: input.fact, category: input.category });
      if (!r.ok) return `couldn't save that fact: ${r.error}`;
      return r.updated ? `updated: ${input.fact}` : `locked in: ${input.fact}`;
    }

    case "recall_self_facts": {
      const { listSelfFacts } = await import("../selfCanon.js");
      const facts = await listSelfFacts({ category: input.category || null });
      if (!facts.length) return input.category ? `no canon in category "${input.category}"` : "no self-facts stored yet";
      return facts.map(f => `- ${f.fact}${f.category && f.category !== "misc" ? ` (${f.category})` : ""}`).join("\n");
    }

    case "forget_self_fact": {
      const { forgetSelfFact } = await import("../selfCanon.js");
      const removed = await forgetSelfFact(input.search);
      return removed ? `forgot that ${removed.fact}` : `no matching self-fact for "${input.search}"`;
    }

    default:
      return undefined;
  }
}
