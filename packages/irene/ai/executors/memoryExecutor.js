// ─── Memory Executor ────────────────────────────────────────────────────────

const HANDLED = new Set([
  "remember_fact", "recall_memories", "forget_memory",
  "clear_all_memories", "summarize_channel",
  "save_my_take", "recall_my_take",
  "save_self_fact", "recall_self_facts", "forget_self_fact",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, findMember } = ctx;

  switch (toolName) {
    case "remember_fact": {
      const { addMemory, getMemories } = await import("../memory.js");
      const target = findMember(guild, input.user);
      if (!target) return `couldn't find user "${input.user}"`;

      // Deduplication — check for existing similar facts
      const existing = getMemories(guild.id, target.id);
      const factLower = (input.fact || "").toLowerCase().trim();
      for (const m of existing) {
        const existLower = (m.fact || "").toLowerCase().trim();
        if (existLower.includes(factLower) || factLower.includes(existLower)) {
          return `i already know that — "${m.fact}"`;
        }
        const newWords = new Set(factLower.split(/\s+/));
        const existWords = new Set(existLower.split(/\s+/));
        let overlap = 0;
        for (const w of newWords) if (existWords.has(w)) overlap++;
        const total = Math.max(newWords.size, existWords.size);
        if (total > 2 && overlap / total > 0.7) {
          return `i already know something similar — "${m.fact}"`;
        }
      }

      addMemory(guild.id, target.id, input.fact, message.author.id);
      return `remembered "${input.fact}" about ${target.user.username}`;
    }

    case "recall_memories": {
      const { getMemories, buildMemoryContext } = await import("../memory.js");
      if (input.user) {
        const target = findMember(guild, input.user);
        if (!target) return `couldn't find user "${input.user}"`;
        const mems = getMemories(guild.id, target.id);
        return mems.length ? `Memories about ${target.user.username}:\n${mems.map((m, i) => `${i + 1}. ${m.fact}`).join("\n")}` : `no memories about ${target.user.username}`;
      }
      const context = buildMemoryContext(guild.id, [message.author.id]);
      return context || "no memories stored yet";
    }

    case "forget_memory": {
      const { removeMemory, getMemories } = await import("../memory.js");
      const target = findMember(guild, input.user);
      if (!target) return `couldn't find user "${input.user}"`;
      if (target.id !== message.author.id && !message.member?.permissions?.has?.("Administrator")) {
        return "you can only forget your own memories — admins can forget anyone's";
      }
      const idx = Math.floor(input.index) - 1;
      const mems = getMemories(guild.id, target.id);
      if (mems.length === 0) return `no memories stored about ${target.user.username}`;
      if (idx < 0 || idx >= mems.length) return `invalid index — ${target.user.username} has ${mems.length} memories (use 1-${mems.length})`;
      const forgotten = mems[idx].fact;
      const result = removeMemory(guild.id, target.id, idx);
      return result.success ? `forgotten: "${forgotten}" about ${target.user.username}` : `failed: ${result.message}`;
    }

    case "clear_all_memories": {
      const { clearMemories } = await import("../memory.js");
      const target = findMember(guild, input.user);
      if (!target) return `couldn't find user "${input.user}"`;
      if (target.id !== message.author.id && !message.member?.permissions?.has?.("Administrator")) {
        return "you can only clear your own memories — admins can clear anyone's";
      }
      const result = clearMemories(guild.id, target.id);
      return result.success ? `wiped all memories about ${target.user.username} — completely forgotten` : "no memories to clear";
    }

    case "summarize_channel": {
      const channel = input.channel_name ? findChannel(guild, input.channel_name) : message.channel;
      if (!channel) return `couldn't find channel "${input.channel_name}"`;
      const count = Math.min(input.message_count || 50, 200);
      try {
        const msgs = await channel.messages.fetch({ limit: count });
        const lines = [...msgs.values()].reverse().map((m) => `${m.author.username}: ${m.content?.slice(0, 200) || "(no text)"}`).join("\n");
        return `Last ${msgs.size} messages in #${channel.name}:\n${lines.slice(0, 3000)}`;
      } catch (err) {
        return `failed to read messages: ${err.message}`;
      }
    }

    // ─── Self-opinion tracking ─────────────────────────────────────────────
    // Persists into the personality row so Irene stays consistent with her
    // OWN stances across conversations.

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
  }
}
