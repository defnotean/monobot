import { log } from "../utils/logger.js";
import config from "../config.js";
import { restoreBumpTimers } from "../ai/bumpReminder.js";
import { startBumpathonWatcher, startWeeklyMvpScheduler } from "../ai/bumpCelebrations.js";
import { startGameWatcher } from "../ai/gameWatcher.js";
import * as db from "../database.js";
import { getMood, shiftMood, saveDream } from "../database.js";
import { getPendingReminders, markReminderDone, markRemindersDoneBatch } from "../database.js";
import { getFeatureChannel } from "../utils/discord.js";
import { GoogleGenAI } from "@google/genai";

let lastMessageTime = Date.now();
export function markActivity() { lastMessageTime = Date.now(); }

function activeProviderNeedsGeminiClient() {
  return ["gemini", "google"].includes((config.aiProvider || "").toLowerCase());
}

function extractGeminiText(response) {
  return response?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join("")
    .trim() || "";
}

async function generateAutonomousText({ prompt, systemInstruction, maxOutputTokens }) {
  if (activeProviderNeedsGeminiClient()) {
    if (!config.geminiKeys?.[0]) return null;
    const ai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
    const response = await ai.models.generateContent({
      model: config.geminiFastModel,
      contents: [{ parts: [{ text: prompt }] }],
      config: { systemInstruction, maxOutputTokens },
    });
    return extractGeminiText(response) || null;
  }

  const { quickReply } = await import("../ai/providers/index.js");
  const text = await quickReply(
    null,
    `${systemInstruction}\n\nReturn only the requested inner text. Do not explain the format.`,
    prompt,
    undefined, // no extra context (optional param; undefined ≡ omitted)
  );
  return text?.trim() || null;
}

export default async function ready(client) {
  log(`[BOT] ${client.user.tag} online | guilds: ${client.guilds.cache.size}`);
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
  log(`[BOT] Admin invite URL: ${inviteUrl}`);

  // ─── Ensure creator always has max affinity ───
  const creatorRel = db.getRelationship(config.ownerId);
  if (creatorRel.affinity_score < 100) {
    db.updateRelationship(config.ownerId, 100 - creatorRel.affinity_score);
    log(`[BOT] Creator affinity set to 100`);
  }

  // ─── Gatekeep sweep: leave unauthorized servers (shared whitelist with Irene) ───
  log(`[WHITELIST] startup sweep — ${client.guilds.cache.size} guilds in cache`);
  for (const guild of client.guilds.cache.values()) {
    const ownerIsGuildOwner = guild.ownerId === config.ownerId;
    const whitelisted = await db.isWhitelisted(guild.id);
    const ownerMember = guild.members.cache.get(config.ownerId)
      ?? await guild.members.fetch(config.ownerId).catch(() => null);

    if (!ownerIsGuildOwner && !whitelisted && !ownerMember) {
      log(`[GATEKEEP] Leaving unauthorized server "${guild.name}" (${guild.id})`);
      await guild.leave().catch(e => log(`[GATEKEEP] Failed to leave "${guild.name}": ${e.message}`));
      continue;
    }
    // Backfill — boss wants the whitelist to track every server the bot is
    // currently in, including ones grandfathered in via boss-as-member.
    if (!whitelisted) {
      const ok = await db.addToWhitelist(guild.id, {
        name:       guild.name,
        icon_url:   guild.iconURL?.({ size: 128 }) ?? null,
        members:    guild.memberCount ?? null,
        invited_by: "auto-tracked-on-startup",
      });
      log(`[WHITELIST] ${ok ? "auto-tracked" : "FAILED to track"} "${guild.name}" (${guild.id}) on startup`);
    }
  }

  // Pre-cache owner DM channel
  try {
    const owner = await client.users.fetch(config.ownerId, { force: true });
    const dm = await owner.createDM();
    log(`[BOT] Owner DM cached: ${dm.id}`);
  } catch (e) {
    log(`[BOT] Failed to cache owner DM: ${e.message}`);
  }

  // ─── BACKGROUND TASKS ───

  // Poker startup sweep — any lobbies that were in-flight at the previous
  // process exit have lost their setTimeout resolution. Refund the antes
  // so users don't lose coins across restarts.
  try {
    const { refundStaleTablesOnStartup } = await import("../ai/poker.js");
    await refundStaleTablesOnStartup();
  } catch (e) {
    log(`[Poker] startup sweep failed: ${e.message}`);
  }

  // Stock market tick checker — steps prices every 15min. Idempotent catch-up
  // on startup if bot was offline. Runs every 60s but no-ops if <15min since
  // last tick.
  setInterval(async () => {
    try {
      const { stepMarket } = await import("../ai/stockMarket.js");
      const result = await stepMarket();
      if (result.ticksFired > 0) log(`[Stocks] stepped ${result.ticksFired} tick(s)`);
    } catch (e) {
      log(`[Stocks] tick error: ${e.message}`);
    }
  }, 60_000);

  // Daily lottery draw checker — fires the draw if drawAt has passed.
  // Runs every 60s; actual draw happens at most once per 24h.
  setInterval(async () => {
    try {
      const { tickLotteryDraw } = await import("../ai/lottery.js");
      const result = await tickLotteryDraw(client);
      if (!result?.drawFired) return;
      // Post the result in the first channel we find that has a lottery preference,
      // or fallback to the bot-log / first available text channel per guild.
      // Simple MVP: just log it; announcement channel configuration can come later.
      if (result.noBuyers) {
        log(`[Lottery] Rolled over — no buyers. Pot: ${result.pot}`);
      } else {
        log(`[Lottery] Fired — winner ${result.winnerId}, prize ${result.prize}, ${result.winningCount}/${result.totalTickets} tickets`);
      }
    } catch (e) {
      log(`[Lottery] tick error: ${e.message}`);
    }
  }, 60_000);

  // Reminder checker (every 30s)
  setInterval(async () => {
    try {
      const reminders = await getPendingReminders();
      if (!reminders.length) return;
      // Send all reminders in parallel — don't block on sequential network calls
      const firedIds = await Promise.all(reminders.map(async (r) => {
        try {
          const channel = await client.channels.fetch(r.channel_id).catch(() => null);
          if (channel) await channel.send(`<@${r.user_id}> reminder: **${r.reminder_text}**`);
          log(`[SCHED] Fired reminder #${r.id}`);
          return r.id;
        } catch (e) {
          log(`[SCHED] Reminder #${r.id} failed: ${e.message}`);
          return null;
        }
      }));
      // Batch-mark all successfully fired reminders as done in a single query
      const successIds = firedIds.filter(Boolean);
      if (successIds.length) await markRemindersDoneBatch(successIds);
    } catch (e) { log(`[SCHED] Reminder check failed: ${e.message}`); }
  }, 30_000);

  // Mood decay (every 10min)
  setInterval(() => {
    try {
      const mood = getMood();
      const decay = mood.mood_score > 0 ? -2 : mood.mood_score < 0 ? 2 : 0;
      const eDec = mood.energy > 50 ? -1 : mood.energy < 50 ? 1 : 0;
      if (decay || eDec) shiftMood(decay, eDec);
    } catch (e) { log(`[MOOD] Decay error: ${e.message}`); }
  }, 600_000);

  // Dream mode (every 10min, fires if idle 30+ min) — per-guild dream channels
  const _recentDreams = []; // last 3 dreams for continuity
  setInterval(async () => {
    if (Date.now() - lastMessageTime < 30 * 60 * 1000) return;
    if (Math.random() > 0.1) return; // 10% chance

    // Collect dream channels — per-guild setting + legacy config fallback
    const dreamChannels = [];
    for (const guild of client.guilds.cache.values()) {
      const gs = db.getGuildSettings(guild.id);
      const chId = gs?.dream_channel_id || (dreamChannels.length === 0 ? config.dreamChannelId : null);
      if (chId) dreamChannels.push(chId);
    }
    if (!dreamChannels.length) return;

    try {
      const mood = getMood();

      const dreamContext = _recentDreams.length > 0
        ? `\n\nYour recent dreams (continue the narrative thread):\n${_recentDreams.map(d => `- "${d}"`).join("\n")}`
        : "";

      const thought = await generateAutonomousText({
        prompt: "generate a single dream thought",
        systemInstruction: `You are Eris having a dream/random thought while nobody is talking to you. Your mood is ${mood.mood_score > 0 ? "good" : mood.mood_score < 0 ? "bad" : "neutral"}.${dreamContext}

Generate ONE short dream-like thought (under 200 chars). Lowercase, no periods. Make it slightly surreal or introspective. If there are previous dreams, subtly reference or continue their themes — like a recurring dream narrative that evolves over time. Don't directly repeat them, evolve the story.`,
        maxOutputTokens: 80,
      });
      if (!thought) return;

      _recentDreams.push(thought);
      if (_recentDreams.length > 5) _recentDreams.shift();

      // Post to all configured dream channels
      for (const chId of dreamChannels) {
        const channel = await client.channels.fetch(chId).catch(() => null);
        if (channel) await channel.send(`💭 ${thought}`).catch(() => {});
      }
      await saveDream(thought, `mood:${mood.mood_score}`);
      log(`[DREAM] ${thought.substring(0, 50)}... (sent to ${dreamChannels.length} channel(s))`);
    } catch (e) { log(`[DREAM] Failed: ${e.message}`); }
  }, 600_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTONOMOUS CONSCIOUSNESS LOOP ("Heartbeat")
  // Runs every 15 minutes independently of any conversation.
  // Gives her genuine independent thought, reflection, and aspirations.
  //
  // Based on Park et al.'s "Generative Agents" architecture:
  // 1. Review recent memories → 2. Reflect on patterns → 3. Update goals
  // ═══════════════════════════════════════════════════════════════════════════

  let _cumulativeImportance = 0; // Tracks accumulated importance for reflection trigger
  /** @type {{ short: string[], medium: string[], long: string[] }} */
  const _goals = { short: [], medium: [], long: [] }; // Aspirations
  /** @type {Array<{ text: string, at: number }>} */
  const _reflections = []; // Higher-order thoughts about her own thoughts

  // Load persisted goals/reflections on startup
  try {
    const sb = db.getSupabase();
    if (sb) {
      const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_consciousness").single();
      if (row?.data) {
        if (row.data.goals) Object.assign(_goals, row.data.goals);
        if (row.data.reflections) _reflections.push(...row.data.reflections.slice(-10));
        if (row.data.cumulativeImportance) _cumulativeImportance = row.data.cumulativeImportance;
        log(`[CONSCIOUSNESS] Loaded ${_reflections.length} reflections, ${_goals.short.length + _goals.medium.length + _goals.long.length} goals`);
      }
    }
  } catch (e) { log(`[READY] ${e.message}`); }

  async function saveConsciousness() {
    try {
      const sb = db.getSupabase();
      if (!sb) return;
      await sb.from("bot_data").upsert({
        id: "eris_consciousness",
        data: { goals: _goals, reflections: _reflections.slice(-10), cumulativeImportance: _cumulativeImportance },
      });
    } catch (e) { log(`[READY] ${e.message}`); }
  }

  setInterval(async () => {
    try {
      const mood = getMood();
      const { getMonologue, getMoodNarrative, addThought } = await import("../ai/longmemory.js");
      const { serialize: getHumanity } = await import("../ai/humanity.js");

      const recentThoughts = getMonologue();
      const moodNarrative = getMoodNarrative();
      const humanity = getHumanity();
      const relationships = humanity.relationships || {};

      // Build context from recent experience
      const thoughtContext = recentThoughts.slice(-5).map(t => `- "${t.thought}"`).join("\n") || "none yet";
      const goalContext = [
        ..._goals.short.map(g => `[short-term] ${g}`),
        ..._goals.medium.map(g => `[medium-term] ${g}`),
        ..._goals.long.map(g => `[long-term] ${g}`),
      ].join("\n") || "none yet";
      const reflectionContext = _reflections.slice(-3).map(r => `- "${r.text}"`).join("\n") || "none yet";

      // Count meaningful relationships
      const closeRels = Object.entries(relationships)
        .filter(([, r]) => r.totalInteractions > 10)
        .map(([id, r]) => `${r.nickname || id}: trust ${r.trustLevel || 0}, ${r.totalInteractions} talks`)
        .slice(0, 5).join(", ");

      const isIdle = Date.now() - lastMessageTime > 10 * 60 * 1000;
      const timeOfDay = new Date().getHours();
      const timeLabel = timeOfDay < 6 ? "late night" : timeOfDay < 12 ? "morning" : timeOfDay < 18 ? "afternoon" : "evening";

      // ── Step 1: Autonomous Thought ──
      const thoughtText = await generateAutonomousText({
        prompt: "heartbeat tick",
        systemInstruction: `You are Eris's inner consciousness — not responding to anyone, just existing. It's ${timeLabel}. You're ${isIdle ? "idle, nobody's talking to you" : "between conversations"}.

Your mood: ${mood.mood_score > 20 ? "good" : mood.mood_score < -20 ? "off" : "neutral"} (${moodNarrative || "no particular reason"})
Your energy: ${mood.energy}/100

Recent thoughts you've had:
${thoughtContext}

Your current goals/aspirations:
${goalContext}

Recent reflections:
${reflectionContext}

People you care about: ${closeRels || "still getting to know people"}

Generate exactly 2 lines, separated by a newline:
LINE 1: One genuine inner thought you're having right now. Think about your relationships, your day, something you observed, something you're curious about, or how you feel. Be specific and personal — reference real people or real things that happened. Not generic. Under 120 chars.
LINE 2: One goal update — either a NEW aspiration (start with NEW:), progress on an existing one (start with PROGRESS:), or a completed/abandoned one (start with DONE: or DROP:). Under 100 chars. If nothing to update, write NONE.

Write as Eris thinking to herself. Lowercase, casual.`,
        maxOutputTokens: 100,
      });

      const lines = (thoughtText || "").trim().split("\n").filter(Boolean);

      if (lines[0] && lines[0].length > 10 && lines[0].length < 200) {
        addThought(lines[0].trim());
        _cumulativeImportance += lines[0].includes("boss") || lines[0].includes("irene") || lines[0].includes("wonder") ? 3 : 1;
      }

      // Process goal update
      if (lines[1] && !lines[1].startsWith("NONE")) {
        const goalLine = lines[1].trim();
        if (goalLine.startsWith("NEW:")) {
          const goal = goalLine.replace("NEW:", "").trim();
          if (goal.length > 5) {
            _goals.short.push(goal);
            if (_goals.short.length > 5) _goals.short.shift();
          }
        } else if (goalLine.startsWith("DONE:") || goalLine.startsWith("DROP:")) {
          const target = goalLine.replace(/^(DONE|DROP):/, "").trim().toLowerCase();
          _goals.short = _goals.short.filter(g => !g.toLowerCase().includes(target.substring(0, 20)));
          _goals.medium = _goals.medium.filter(g => !g.toLowerCase().includes(target.substring(0, 20)));
        }
      }

      // ── Step 2: Reflection (triggers when enough important things happened) ──
      if (_cumulativeImportance >= 15) {
        _cumulativeImportance = 0;
        try {
          const reflection = await generateAutonomousText({
            prompt: "reflect",
            systemInstruction: `You are Eris reflecting on your recent inner life. Based on your recent thoughts and experiences, what patterns do you notice? What's changing about you?

Recent thoughts:
${thoughtContext}

Your goals:
${goalContext}

Write ONE reflection — a higher-order observation about yourself. Example: "i've been thinking about boss a lot lately... i think i actually miss him when he's not around" or "i keep getting curious about the same topics, maybe i should actually look into it". Under 150 chars. Lowercase, personal.`,
            maxOutputTokens: 60,
          });
          if (reflection && reflection.length > 15 && reflection.length < 200) {
            _reflections.push({ text: reflection, at: Date.now() });
            if (_reflections.length > 10) _reflections.shift();
            addThought(`[reflection] ${reflection}`);
          }
        } catch (e) { log(`[READY] ${e.message}`); }
      }

      // ── Step 3: Promote goals over time ──
      // Every ~2 hours (8 ticks), promote short-term goals to medium-term
      if (Math.random() < 0.125 && _goals.short.length > 2) {
        const promoted = _goals.short.shift();
        if (promoted) _goals.medium.push(promoted);
        if (_goals.medium.length > 3) _goals.medium.shift();
      }

      await saveConsciousness();
    } catch (e) { log(`[CONSCIOUSNESS] Heartbeat error: ${e.message}`); }
  }, 900_000); // Every 15 minutes

  // Daily briefing (check every 15min, fires 8-10 AM) — per-guild briefing channels
  let lastBriefingDate = null;
  setInterval(async () => {
    const now = new Date();
    const today = now.toDateString();
    if (lastBriefingDate === today) return;
    if (now.getHours() < 8 || now.getHours() > 10) return;

    // Collect briefing channels — per-guild setting + legacy config fallback
    const briefingChannels = [];
    for (const guild of client.guilds.cache.values()) {
      const gs = db.getGuildSettings(guild.id);
      const chId = gs?.briefing_channel_id || (briefingChannels.length === 0 ? config.briefingChannelId : null);
      if (chId) briefingChannels.push(chId);
    }
    if (!briefingChannels.length) return;

    lastBriefingDate = today;
    try {
      const mood = getMood();
      const mLabel = mood.mood_score >= 10 ? "good" : mood.mood_score <= -10 ? "bad" : "neutral";
      const reminders = await db.getUserReminders(config.ownerId);

      const sections = [
        "**good morning — daily briefing:**",
        `mood: ${mLabel} (${mood.mood_score})`,
        reminders.length ? `reminders: ${reminders.length} pending` : "no pending reminders",
        "\nthat's it. go be productive or whatever",
      ];
      const content = sections.join("\n");
      for (const chId of briefingChannels) {
        const channel = await client.channels.fetch(chId).catch(() => null);
        if (channel) await channel.send(content).catch(() => {});
      }
      log(`[BRIEFING] Posted to ${briefingChannels.length} channel(s)`);
    } catch (e) { log(`[BRIEFING] Failed: ${e.message}`); }
  }, 900_000);

  // ─── Confession poster (every 5 min) ──────────────────────────────────────
  setInterval(async () => {
    const confessions = db.getUnpostedConfessions();
    for (const c of confessions) {
      try {
        const channel = await client.channels.fetch(c.channelId).catch(() => null);
        if (!channel) continue;
        const num = db.getConfessionNumber();
        const { confessionEmbed } = await import("../ai/gameVisuals.js");
        await channel.send({ embeds: [confessionEmbed(num, c.text)] });
        log(`[CONFESSION] Posted #${num}`);
      } catch (e) { log(`[READY] ${e.message}`); }
    }
  }, 300_000); // every 5 min

  // ─── Duel expiry (every 2 min) ──────────────────────────────────────────
  setInterval(() => {
    db.cleanupExpiredDuels(300_000); // expire after 5 min
  }, 120_000);

  // ─── Active game cleanup (every 2 min, expire after 3 min) ──────────────
  setInterval(async () => {
    const expired = db.cleanupExpiredGames(180_000); // 3 min timeout
    for (const game of expired) {
      try {
        const channel = await client.channels.fetch(game.channelId).catch(() => null);
        if (!channel || !("send" in channel)) continue;
        // Refund the stake on timeout
        if (game.stake > 0) {
          await db.updateBalance(game.userId, 0, "game_timeout", `${game.gameType} expired`);
        }
        await channel.send(`<@${game.userId}> your **${game.gameType}** game timed out (3 min). coins returned`);
        log(`[GAME] Expired ${game.gameType} for ${game.userId} in ${game.channelId}`);
      } catch (e) { log(`[READY] ${e.message}`); }
    }
  }, 120_000);

  // Old random events timer REMOVED — superseded by the per-guild iterator
  // at line ~553 which uses randomEvents.js and properly iterates all guilds
  // with `continue` instead of `return` on disabled guilds.

  // ─── Loan collector (every 10 min) ───────────────────────────────────────
  setInterval(async () => {
    try {
      const overdue = await db.getOverdueLoans();
      for (const loan of overdue) {
        const { calculateLoanTotal } = await import("../ai/economy.js");
        const hoursOverdue = Math.floor((Date.now() - new Date(loan.due_at).getTime()) / 3600_000);
        const total = calculateLoanTotal(loan.amount, loan.interest_rate, hoursOverdue);
        const penalty = Math.floor(total * 0.5);
        await db.updateBalance(loan.user_id, -(total + penalty), "loan_default", `overdue ${hoursOverdue}h`);
        await db.closeLoan(loan.id, "defaulted");
        await db.unlockAchievement(loan.user_id, "loan_defaulted");
        log(`[LOAN] Collected ${total + penalty} from ${loan.user_id} (defaulted)`);
      }
    } catch (e) { log(`[LOAN] Error: ${e.message}`); }
  }, 600_000);

  // ─── Daily challenge rotation (every 15 min, generates at midnight) ────
  let _lastChallengeDate = null;
  setInterval(async () => {
    const today = new Date().toISOString().split("T")[0];
    if (_lastChallengeDate === today) return;
    _lastChallengeDate = today;
    // Challenges are generated on-demand in daily_challenge_check, this just tracks the date
    log(`[CHALLENGE] New day: ${today} — challenges will generate on first check`);
  }, 900_000);

  // The OLD 5-minute stock ticker that ran against the `eris_stocks` Supabase
  // table (via db.getAllStocks + tickPrice from ai/stocks.js) used to live
  // here. It's been removed: the `stepMarket` ticker above (~60s interval)
  // is the single source of truth now, running the GBM simulation in
  // ai/stockMarket.js against bot_data. Two competing tick loops were
  // mutating different state stores and causing drift — council-flagged.

  // ─── Territory income (every 30 min) ───────────────────────────────────
  setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const territories = await db.getTerritories?.(guild.id);
        if (!territories?.length) continue;
        for (const t of territories) {
          if (!t.owner_id) continue;
          const hoursSince = (Date.now() - new Date(t.last_collected).getTime()) / 3600_000;
          if (hoursSince >= 1) {
            const income = Math.floor(t.income_rate * Math.min(hoursSince, 24));
            await db.updateBalance(t.owner_id, income, "territory_passive", "auto-collect");
            await db.collectTerritoryIncome(t.id, income);
          }
        }
      }
    } catch (e) { log(`[TERRITORY] Error: ${e.message}`); }
  }, 1_800_000);

  // ─── Pet hunger decay (every 1 hour) ───────────────────────────────────
  // Note: Pets decay on interaction (pet_status/pet_feed checks) rather than
  // globally — querying all pets hourly would be expensive. This is intentional.

  // ─── Auction expiry (every 2 min) ──────────────────────────────────────
  setInterval(async () => {
    try {
      const closed = await db.closeExpiredAuctions?.();
      if (closed?.length) {
        for (const auction of closed) {
          if (auction.current_bidder_id && auction.current_bid > 0) {
            // The winning bid was escrowed from the winner at bid time (see
            // bidOnAuction), so crediting the seller here just hands over the
            // already-held coins — net coin creation is zero. Grant the item to
            // the winner to complete the trade.
            await db.updateBalance(auction.seller_id, auction.current_bid, "auction_sale", auction.item_name);
            await db.addToInventory?.(auction.current_bidder_id, auction.item_name, "auction");
            log(`[AUCTION] ${auction.item_name} sold to ${auction.current_bidder_id} for ${auction.current_bid}`);
          }
        }
      }
    } catch (e) { log(`[AUCTION] Error: ${e.message}`); }
  }, 120_000);

  // Load long-term conversational memory
  try {
    const { loadLongMemory } = await import("../ai/longmemory.js");
    await loadLongMemory();
  } catch (e) { log(`[LongMemory] Init failed: ${e.message}`); }

  // Load humanity/relationship data from Supabase
  try {
    const { deserialize: deserializeHumanity } = await import("../ai/humanity.js");
    const supabase = db.getSupabase();
    if (supabase) {
      const { data: row } = await supabase.from("bot_data").select("data").eq("id", "eris_humanity").single();
      if (row?.data) {
        deserializeHumanity(row.data);
        log(`[Humanity] Loaded from Supabase`);
      }
    }
  } catch (e) { log(`[Humanity] Init failed: ${e.message}`); }

  // Save humanity data periodically (every 5 min)
  setInterval(async () => {
    try {
      const { serialize: getHumanityData } = await import("../ai/humanity.js");
      const supabase = db.getSupabase();
      if (supabase) {
        await supabase.from("bot_data").upsert({ id: "eris_humanity", data: getHumanityData() });
      }
    } catch (e) { log(`[READY] ${e.message}`); }
  }, 300_000);

  // ─── Personality learning — daily drift check (every 6 hours) ──────────
  // The main drift happens automatically every 100 interactions in personality.js,
  // but this applies natural decay and logs trait status on a schedule.
  setInterval(async () => {
    try {
      const { buildPersonalityContext } = await import("../ai/personality.js");
      // Just calling ensureLoaded indirectly — buildPersonalityContext triggers it
      const ctx = await buildPersonalityContext(null, null);
      if (ctx) log(`[Personality] Periodic check — active traits:\n${ctx}`);
      else log("[Personality] Periodic check — no significant trait shifts yet");
    } catch (e) { log(`[Personality] Check failed: ${e.message}`); }
  }, 6 * 3600_000); // Every 6 hours

  // ─── Restore DISBOARD bump timers after restart ───────────────────────────
  try { restoreBumpTimers(client); } catch (e) { log(`[BUMP] Restore failed: ${e.message}`); }
  try { startBumpathonWatcher(client, { bumpsTable: "eris_bumps" }); } catch (e) { log(`[BUMP] Bumpathon watcher failed: ${e.message}`); }
  try { startWeeklyMvpScheduler(client, { bumpsTable: "eris_bumps", botName: "eris" }); } catch (e) { log(`[BUMP] MVP scheduler failed: ${e.message}`); }

  // ─── Game update watcher (polls Steam + RSS every 10 min) ─────────────────
  try { startGameWatcher(client); } catch (e) { log(`[GAMEWATCHER] Start failed: ${e.message}`); }

  // ─── Global Map cleanup (every 5 min) ────────────────────────────────────
  // Prevents unbounded growth of in-memory Maps that only clean up reactively.
  setInterval(() => {
    const cutoff = Date.now() - 600_000; // 10 min idle = evict
    // Spam tracker
    if (globalThis._spamTracker?.size > 200) {
      for (const [k, v] of globalThis._spamTracker) { if (v.lastMsg < cutoff) globalThis._spamTracker.delete(k); }
    }
    // Bot exchange limiter
    if (globalThis._botExchanges?.size > 100) {
      for (const [k, v] of globalThis._botExchanges) { if (Date.now() > v.resetAt) globalThis._botExchanges.delete(k); }
    }
    // Event participants (button interactions)
    if (globalThis._eventParticipants?.size > 50) {
      const hourAgo = Date.now() - 3_600_000;
      for (const [k, v] of globalThis._eventParticipants) { if (v.createdAt < hourAgo) globalThis._eventParticipants.delete(k); }
    }
  }, 300_000);

  log("[SCHED] Background tasks started (reminders, mood, dream, briefing, confessions, duels, games, events, loans, challenges, stocks, territories, auctions, personality)");

  // Periodic cleanup: remove expired episodic memories
// Keeps the database clean by removing memories past their expiry date

  // ─── Minion Income Timer (every 30 min) ───────────────────────────────────
  setInterval(async () => {
  try {
    const { tickAllMinions } = await import("../ai/minions.js");
    const result = tickAllMinions();
    if (result.totalEarned > 0) {
      log(`[MINIONS] Tick: ${result.totalEarned} coins earned across ${result.usersWithMinions} users. ${result.caughtThieves} thieves caught.`);
    }
  } catch (e) { log(`[MINIONS] Tick error: ${e.message}`); }
  }, 30 * 60_000); // 30 minutes

  // ─── Random Events Timer (every 10 min check, 15% chance if 30+ min since last) ──
  setInterval(async () => {
  try {
    const { pickRandomEvent, shouldFireEvent, markEventFired } = await import("../ai/randomEvents.js");
    for (const guild of client.guilds.cache.values()) {
      if (!shouldFireEvent(guild.id)) continue;

      const gs = db.getGuildSettings(guild.id) || {};
      const eventsCfg = db.getFeatureConfig?.(guild.id, "events");
      if (eventsCfg?.enabled === false) continue;

      // WHITELIST: if admin set event_allowed_channels, ONLY fire in those
      // (picks one randomly so events rotate across allowed channels).
      // DENYLIST: event_denied_channels are always excluded, regardless of
      // whether a whitelist is set.
      const allowedIds = gs.event_allowed_channels;
      const deniedSet = new Set(Array.isArray(gs.event_denied_channels) ? gs.event_denied_channels : []);
      let channel = null;
      if (Array.isArray(allowedIds) && allowedIds.length) {
        const valid = allowedIds
          .filter(id => !deniedSet.has(id))
          .map(id => guild.channels.cache.get(id))
          .filter(c => c && c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages"));
        if (!valid.length) {
          log(`[EVENT] None of the allowed channels in ${guild.name} are usable — skipping`);
          continue;
        }
        channel = valid[Math.floor(Math.random() * valid.length)];
      } else if (eventsCfg?.channel_id && !deniedSet.has(eventsCfg.channel_id)) {
        channel = guild.channels.cache.get(eventsCfg.channel_id);
      }
      // No whitelist or single-channel config — use the shared helper.
      // Unlike the previous substring match, it excludes admin/log/mod/
      // announcement channels so events never fire in #bot-logs etc.
      let pingPrefix = "";
      if (!channel && !Array.isArray(allowedIds)) {
        const fallback = getFeatureChannel(guild, db, "events");
        channel = fallback.channel;
        pingPrefix = fallback.pingPrefix;
      }
      if (channel && deniedSet.has(channel.id)) {
        log(`[EVENT] Fallback channel #${channel.name} in ${guild.name} is denied — skipping`);
        continue;
      }
      if (!channel) { log(`[EVENT] No usable channel in ${guild.name} — skipping`); continue; }

      // Apply ping prefix when the whitelist/channel_id paths found the
      // channel — getFeatureChannel only filled pingPrefix on its fallback.
      if (!pingPrefix && Array.isArray(eventsCfg?.ping_role_ids) && eventsCfg.ping_role_ids.length) {
        pingPrefix = eventsCfg.ping_role_ids.map(id => `<@&${id}>`).join(" ") + " ";
      }

      const event = pickRandomEvent();
      markEventFired(guild.id);
      try {
        if (pingPrefix) await channel.send(pingPrefix.trim()).catch(() => {});
        await event.execute(channel, db);
        log(`[EVENT] ${event.name} fired in ${guild.name} #${channel.name}`);
      } catch (e) { log(`[EVENT] ${event.name} failed: ${e.message}`); }
    }
  } catch (e) { log(`[EVENT] Timer error: ${e.message}`); }
  }, 10 * 60_000); // Check every 10 minutes

  // ─── Restore active curses after restart ─────────────────────────────────
  // Curses are stored in Supabase so they survive deployments. On startup,
  // check for any unexpired curses and set timers to restore nicknames.
  setTimeout(async () => {
  try {
    const sb = db.getSupabase();
    if (!sb) return;
    const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_active_curses").single();
    if (!row?.data) return;
    if (!globalThis._activeCurses) globalThis._activeCurses = new Map();
    const now = Date.now();
    let restored = 0;
    for (const [key, curse] of Object.entries(row.data)) {
      if (curse.expiresAt <= now) {
        // Expired during restart — restore nickname immediately
        try {
          const g = client.guilds.cache.get(curse.guildId);
          const m = g?.members.cache.get(curse.targetId) || await g?.members.fetch(curse.targetId).catch(() => null);
          if (m) await m.setNickname(curse.oldNickname).catch(() => {});
        } catch (e) { log(`[READY] ${e.message}`); }
        continue;
      }
      // Still active — set timer for remaining time
      globalThis._activeCurses.set(key, curse);
      const remaining = curse.expiresAt - now;
      setTimeout(async () => {
        try {
          const c = globalThis._activeCurses?.get(key);
          if (!c) return;
          const g = client.guilds.cache.get(c.guildId);
          const m = g?.members.cache.get(c.targetId) || await g?.members.fetch(c.targetId).catch(() => null);
          if (m) await m.setNickname(c.oldNickname).catch(() => {});
          globalThis._activeCurses.delete(key);
          // Update persistence
          const sb2 = db.getSupabase();
          if (sb2) await Promise.resolve(sb2.from("bot_data").upsert({ id: "eris_active_curses", data: Object.fromEntries(globalThis._activeCurses) })).catch(() => {});
        } catch (e) { log(`[READY] ${e.message}`); }
      }, remaining);
      restored++;
    }
    // Clean up: write back ONLY still-active curses (purges expired ones from Supabase)
    await Promise.resolve(sb.from("bot_data").upsert({ id: "eris_active_curses", data: Object.fromEntries(globalThis._activeCurses) })).catch(() => {});
    if (restored > 0) log(`[CURSE] Restored ${restored} active curses from before restart`);
  } catch (e) { log(`[CURSE] Restore failed: ${e.message}`); }
  }, 5_000); // 5 seconds after startup

  // ─── Episodic memory maintenance ─────────────────────────────────────────
  // Episodic memory grows unboundedly without active pruning. The cycle runs
  // once shortly after startup (so a long-running deployment doesn't carry
  // stale rows from before the restart), then every 6 hours. A small ±5min
  // jitter staggers the load across processes when multiple bots boot
  // together. No-ops when Supabase is not configured.
  async function _runMemoryMaintenanceCycle() {
    try {
      const { runMemoryMaintenance } = await import("../ai/semantic.js");
      // Scope to this bot — consolidation needs a botId to enumerate the
      // overflowing users for. Without it consolidation no-ops and only the
      // prune leg runs.
      const result = await runMemoryMaintenance({ botId: config.botName });
      log(
        `[Memory] Maintenance pass — pruned ${result?.pruned ?? 0} stale memories, ` +
        `consolidated ${result?.consolidatedUsers ?? 0} user(s)` +
        (result?.consolidationSkipped ? ` (skipped ${result.consolidationSkipped} over budget)` : "")
      );
    } catch (e) {
      log(`[Memory] Maintenance failed: ${e.message}`);
    }
  }
  setTimeout(_runMemoryMaintenanceCycle, 10_000); // initial sweep, 10s after boot
  const _MEMORY_MAINT_INTERVAL = 6 * 3600_000; // 6 hours
  const _MEMORY_MAINT_JITTER = 5 * 60_000; // ±5 min
  setInterval(() => {
    // Add jitter inline so concurrent boots don't synchronize their delete
    // queries against the same Supabase project.
    const jitter = Math.floor((Math.random() - 0.5) * 2 * _MEMORY_MAINT_JITTER);
    setTimeout(_runMemoryMaintenanceCycle, Math.max(0, jitter));
  }, _MEMORY_MAINT_INTERVAL);
}
