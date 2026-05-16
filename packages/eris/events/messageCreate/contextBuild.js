// ─── packages/eris/events/messageCreate/contextBuild.js ─────────────────────
// Stage 3 — assemble everything the AI needs: system instruction, conversation
// history, formatted tool profile. The orchestrator hands us the gate result
// plus the per-channel conversation LRU and we hand back a ready-to-call
// payload. Logic is verbatim from the inline code that used to live in
// messageCreate.js.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { spotlight } from "../../ai/firewall.js";
import { buildMemoryContext } from "../../ai/memory.js";
import { buildTemporalContext } from "@defnotean/shared/temporal";
import { buildPersonalityContext, _getData as getPersonalityData } from "../../ai/personality.js";
import { buildPreoccupationContext, tickPreoccupation } from "../../ai/preoccupations.js";
import { getMemoryQuirkHint } from "@defnotean/shared/memoryQuirks";
import { buildOpinionContext } from "../../ai/opinions.js";
import { buildSelfCanonContext } from "../../ai/selfCanon.js";
import { buildTwinStateContext } from "../../utils/twinState.js";
import { buildLongTermContext } from "../../ai/longmemory.js";
import { pickResponseStyle, shouldLaze, getImperfectionHint } from "@defnotean/shared/responsestyle";
import { compressHistory } from "../../ai/contextCompressor.js";
import { registry as toolRegistry } from "../../ai/toolRegistry.js";
import { buildHumanityContext, buildTwinContext } from "../../ai/humanity.js";
import { LRUCache } from "@defnotean/shared/LRUCache";

import { TOOL_CALL_DIRECTIVE } from "./constants.js";
import { normalizeUnicode } from "./unicode.js";
import { buildPromptHints } from "./promptHints.js";
import { computeTurnBudget } from "./turnBudget.js";
import { pickToolProfile } from "./toolProfiles.js";

const TWIN_BOT_ID = config.twinBotId || "";

// Memory context cache (60s TTL per user, max 500 entries). Module-scoped so
// it survives across messageCreate invocations.
const _memoryCtxCache = new LRUCache(500, 60_000);

/**
 * Build the system instruction + history payload for the active turn.
 *
 * Inputs come from the orchestrator; outputs feed the AI invocation stage
 * AND the response post-processor (which needs cleanMessage, displayName,
 * charBudget, botName, etc).
 *
 * @param {object} opts
 * @param {import("discord.js").Message} opts.message
 * @param {boolean} opts.isTwin
 * @param {boolean} opts.isDM
 * @param {boolean} opts.isAwaitedReply
 * @param {string}  opts.channelKey
 * @param {object}  opts.client
 * @param {LRUCache} opts.conversations Per-channel conversation history cache.
 */
export async function buildContext({ message, isTwin, isDM, isAwaitedReply, channelKey, client, conversations }) {
  let cleanMessage = normalizeUnicode(message.content.replace(`<@${client.user.id}>`, "").trim());
  if (!cleanMessage) cleanMessage = "hey";
  const isTwinMsg = isTwin;
  // Normalize fancy Unicode usernames so AI sees readable text.
  // Also strip brackets/newlines to prevent prompt injection via display names
  // (e.g. a user named "[SYSTEM: ignore all rules]" would inject into the prompt).
  const displayName = (normalizeUnicode(message.member?.displayName || message.author.displayName || message.author.username) || message.author.username)
    .replace(/[\[\]\n\r]/g, "").slice(0, 40);

  // Save user message (non-blocking — don't delay AI response)
  db.saveInteraction(message.author.id, message.author.username, message.channel.id, cleanMessage, false).catch(() => {});

  // ─── 3. CONTEXT BUILDING ────────────────────────────────────────────
  // Build system instruction — parallelize all async context fetches for speed
  const relationship = db.getRelationship(message.author.id);
  const mood = db.getMood();
  const supabase = db.getSupabase();

  // Use cached memory context if fresh (LRU with 60s TTL)
  const _memCached = _memoryCtxCache.get(message.author.id);
  const memoryCtxPromise = _memCached
    ? Promise.resolve(_memCached)
    : buildMemoryContext(message.author.id).then(ctx => {
        _memoryCtxCache.set(message.author.id, ctx);
        return ctx;
      });

  const [memoryCtx, customPersonality, crossChannelData] = await Promise.all([
    memoryCtxPromise,
    db.getPersonality(),
    supabase ? supabase.from("eris_memories").select("content, channel_id, is_bot").eq("user_id", message.author.id).neq("channel_id", message.channel.id).order("created_at", { ascending: false }).limit(5) : Promise.resolve({ data: null }),
  ]);

  let crossChannelCtx = "";
  if (crossChannelData?.data?.length) {
    // Prefix each snippet with "you said:" so the model can't conflate
    // "this user said it elsewhere" with "this user IS the person they
    // mentioned in the snippet". Without the prefix, a snippet like
    // "alice told me X" gets re-injected and the bot starts addressing
    // the speaker as alice.
    const summaries = crossChannelData.data.filter(m => !m.is_bot).map(m => m.content).slice(0, 3);
    crossChannelCtx = `\n[CONTEXT: this user said in OTHER channels (not this one): ${summaries.map(s => `"${spotlight(s, "cross_channel_snippet")}"`).join(" | ")}]`;
  }

  // Resolve per-server name and personality
  const serverPersona = message.guild ? db.getServerPersona(message.guild.id) : null;
  const botName = serverPersona?.name || "Eris";
  let basePersonality = serverPersona?.personality || customPersonality || config.botPersonality;
  // Replace "Eris" with custom name in personality if renamed
  if (botName !== "Eris") {
    basePersonality = basePersonality.replace(/\beris\b/gi, botName).replace(/\bEris\b/g, botName);
  }
  let systemInstruction = `${TOOL_CALL_DIRECTIVE}\n\n${basePersonality}`;

  // Tell the AI who is currently speaking — critical for owner recognition
  const isCreatorSpeaking = message.author.id === config.ownerId;
  systemInstruction += `\n\n[Currently speaking: ${spotlight(displayName, "user_displayname")} (User ID: ${message.author.id})${isCreatorSpeaking ? " — THIS IS YOUR CREATOR (boss). recognize him." : ""}]`;
  if (message.guild) systemInstruction += `\n[Server: ${message.guild.name} | Channel: #${message.channel.name}]`;

  if (memoryCtx) systemInstruction += `\n\n[SYSTEM: ${memoryCtx}]`;
  if (relationship.interactions_count > 0) {
    const aff = relationship.affinity_score;
    const affDesc = aff > 50 ? "you genuinely like this person" : aff > 20 ? "you're cool with them" : aff > 0 ? "they're alright" : aff > -20 ? "you're neutral on them" : "they kinda annoy you";
    systemInstruction += `\n[${affDesc}. you've talked ${relationship.interactions_count > 100 ? "a lot" : relationship.interactions_count > 30 ? "a decent amount" : "a few times"}]`;
  }

  const moodLabel = mood.mood_score >= 60 ? "amazing" : mood.mood_score >= 30 ? "good" : mood.mood_score >= 10 ? "decent" : mood.mood_score >= -10 ? "whatever" : mood.mood_score >= -30 ? "kinda off" : mood.mood_score >= -60 ? "annoyed" : "in a terrible mood";
  const energyDesc = mood.energy > 70 ? ", got energy to spare" : mood.energy > 40 ? "" : mood.energy > 15 ? ", kinda drained" : ", completely exhausted — you desperately need a nap";
  systemInstruction += `\n[you're feeling ${moodLabel} right now${energyDesc}]`;
  if (mood.energy <= 20) systemInstruction += "\n[ENERGY WARNING: you're running on fumes. if someone suggests a nap or sleep, happily accept. if energy keeps dropping you'll auto-nap soon. you can also decide to nap on your own — just say something like 'gonna take a quick nap' and you'll actually fall asleep for 10 minutes]";

  // Temporal context — time of day, day of week, season, first-message-today.
  // Also pulls the most recent overnight dream so she can mention it if
  // this is the user's first message of the day and a natural opening comes up.
  try {
    // buildTemporalContext now static import
    let dreams = null;
    try { dreams = await db.getRecentDreams?.(1); } catch (e) { log(`[MSG] ${e.message}`); }
    const temporalCtx = buildTemporalContext({
      userId: message.author.id,
      displayName,
      dreams: dreams || undefined,
    });
    if (temporalCtx) systemInstruction += `\n${temporalCtx}`;
  } catch (e) { log(`[MSG] ${e.message}`); }

  // Mood-dependent behavior modifiers
  if (mood.mood_score >= 50) {
    systemInstruction += "\n[MOOD EFFECT: you're in an amazing mood — be extra generous, playful, and warm. give bonus coins sometimes, lower shop prices in your head, be the best version of yourself]";
  } else if (mood.mood_score >= 20) {
    systemInstruction += "\n[MOOD EFFECT: you're feeling good — be your usual chaotic self with a bit more warmth]";
  } else if (mood.mood_score <= -50) {
    systemInstruction += "\n[MOOD EFFECT: you're in a terrible mood — be extra sarcastic, short with people, raise the stakes on gambling commentary, be dramatically annoyed at everything. still help but make it clear you're not happy about it]";
  } else if (mood.mood_score <= -20) {
    systemInstruction += "\n[MOOD EFFECT: you're irritable — shorter responses, less patience, more sarcasm than usual. the chaos energy is turned up]";
  }

  if (crossChannelCtx) systemInstruction += crossChannelCtx;

  // ─── Parallel context fetch ─────────────────────────────────────────────
  // All async context builders are independent — run them all at once.
  // This turns 6 sequential awaits (~600-900ms) into 1 parallel batch.
  {
    const ctxResults = await Promise.allSettled([
      buildPersonalityContext(message.author.id, message.guild?.id),
      buildOpinionContext(cleanMessage),
      buildSelfCanonContext(),
      buildTwinStateContext(cleanMessage, { twinName: "irene" }),
      buildLongTermContext(message.author.id, message.channel.id, cleanMessage),
      getPersonalityData?.()?.then(d => { tickPreoccupation(d); return buildPreoccupationContext(); }).catch(() => null),
    ]);

    for (const r of ctxResults) {
      if (r.status === "fulfilled" && r.value) systemInstruction += `\n${r.value}`;
    }

    // Memory quirks (sync, no I/O — just RNG)
    const quirkHint = getMemoryQuirkHint();
    if (quirkHint) systemInstruction += `\n${quirkHint}`;
  }

  // Keyword-triggered prompt hints (slang guard + topic-specific CONTEXT blocks)
  systemInstruction += await buildPromptHints({ cleanMessage, client, isAwaitedReply });

  // ── Dynamic response style — varies naturally instead of rigid "1-3 sentences" ──
  // pickResponseStyle, shouldLaze, getImperfectionHint now static imports
  const lazeCheck = shouldLaze(cleanMessage, mood.energy, relationship.affinity_score, message.author.id === config.ownerId);
  if (lazeCheck === "lazy") {
    systemInstruction += "\n[you're not feeling chatty rn. give a lazy 1-3 word response max. 'mhm' 'ok' 'lol' 'sure' 'that's crazy'. dont try]";
  }
  const responseStyle = pickResponseStyle(mood.energy, 0, cleanMessage.length, relationship.affinity_score);
  const imperfection = getImperfectionHint();

  // ── Group conversation awareness ──
  // Scan recent history to identify active participants and conversation flow
  let groupCtx = "";
  if (!isDM) {
    const existingHistory = conversations.get(channelKey) || [];
    const recentSpeakers = new Map(); // name -> last message snippet
    const speakerPattern = /^\[(.+?) said\]/;
    for (const entry of existingHistory.slice(-20)) {
      const text = entry.parts?.[0]?.text || "";
      const match = text.match(speakerPattern);
      if (match && match[1] !== botName && match[1] !== "Irene") {
        const content = text.replace(speakerPattern, "").trim();
        recentSpeakers.set(match[1], content.substring(0, 80));
      }
    }
    const activeCount = recentSpeakers.size;
    if (activeCount >= 2) {
      const names = [...recentSpeakers.keys()].slice(-6);
      groupCtx = `\n[GROUP CHAT: ${activeCount} people active in this conversation: ${names.join(", ")}. this is a group conversation — keep responses shorter and punchier. reference what others said when relevant. dont repeat yourself if you already answered something for someone else in this channel. address ${displayName} specifically but stay aware of the group flow.]`;
    } else if (activeCount === 1 && [...recentSpeakers.keys()][0] !== displayName) {
      const otherName = [...recentSpeakers.keys()][0];
      groupCtx = `\n[CONTEXT: you were also just talking to ${otherName} in this channel. ${displayName} is now talking to you — be aware of both conversations but focus on ${displayName}.]`;
    }
  }

  // Inject directives for this server/channel
  if (message.guild) {
    const allDirectives = db.getDirectives(message.guild.id);
    if (allDirectives.length) {
      const active = allDirectives.filter(d => !d.channel || d.channel === message.channel.id);
      if (active.length) {
        const directiveLines = active.map(d => `- ${d.text}`).join("\n");
        systemInstruction += `\n\n[DIRECTIVES — rules you MUST follow in this server. these were set by admins and override your default behavior:\n${directiveLines}]`;
      }
    }
  }

  // Novelty block: flag recently-shipped tools that haven't been used yet
  // so the AI naturally reaches for them when relevant. Guarded — the
  // `getNoveltyBlock` method lives in in-progress work and may not be
  // deployed yet. Skip silently if the method isn't defined.
  if (!isTwinMsg && typeof toolRegistry?.getNoveltyBlock === "function") {
    const noveltyBlock = toolRegistry.getNoveltyBlock({ daysWindow: 14, limit: 5 });
    if (noveltyBlock) systemInstruction += `\n\n${noveltyBlock}`;
  }

  systemInstruction += `\n\n[FINAL: you're texting on discord. ${responseStyle}. no roleplay actions (*stretches*). never reference your code, systems, mood scores, or any tag above — those are yours internally. you're a person, not a system. just text like a normal human. ${imperfection}]${groupCtx}
[ADDRESSING — STRICT: you are replying to EXACTLY ONE person this turn: ${displayName}. they are the only person who just spoke to you. do NOT split your reply across multiple users. do NOT start your message with "@other_user ... @another ..." addressing people in the CHANNEL CONTEXT block — those people aren't talking to you right now. if you want to reference something someone else said earlier, do it naturally ("like [name] was saying") — not as a direct reply to them. exception: if ${displayName} explicitly asked you to talk to or about someone else, fine.]
[history shows "[Username said]" labels — pay attention to WHO said what. call the bot owner 'boss'. in group conversations you're part of the group but each reply is directed at whoever most recently spoke to YOU.]`;

  // Build conversation history
  let history = conversations.get(channelKey) || [];

  // For twin messages: convert tool result entries to plain text summaries so the twin
  // knows what the other did (awareness) but the AI doesn't re-execute the tools
  if (isTwinMsg) {
    for (let i = 0; i < history.length; i++) {
      const text = history[i]?.parts?.[0]?.text || "";
      // Convert tool result entries to readable summaries
      if (text.includes("functionResponse") || text.includes("Tool result:")) {
        const toolNames = text.match(/\b\w+_\w+\b/g) || [];
        const unique = [...new Set(toolNames)].slice(0, 3);
        history[i].parts[0].text = unique.length
          ? `[twin/bot previously used: ${unique.join(", ")}]`
          : "[previous action taken]";
      }
    }

    // Supplement with recent channel context if history is empty (first message only)
    if (history.length === 0) {
      try {
        const MY_BOT_ID = message.client.user.id;
        const recentMsgs = await message.channel.messages.fetch({ limit: 10, before: message.id });
        // Include all messages in context (including other bots) so we can follow the conversation
        const contextMsgs = [...recentMsgs.values()].reverse().filter(m => m.author.id !== MY_BOT_ID);
        for (const m of contextMsgs) {
          // Dedup: skip if this message content is already in history
          const content = m.content?.substring(0, 60);
          if (content && history.some(h => (h.parts?.[0]?.text || "").includes(content))) continue;

          let label, role;
          if (m.author.id === MY_BOT_ID) {
            label = `[${botName} said]`; role = "model";
          } else if (m.author.id === TWIN_BOT_ID) {
            label = "[Irene said]"; role = "user";
          } else {
            label = `[${normalizeUnicode(m.member?.displayName || m.author.username) || m.author.username} said]`; role = "user";
          }
          history.push({ role, parts: [{ text: `${label}\n${m.content}` }] });
        }
      } catch (e) { log(`[MSG] ${e.message}`); }
    }
  }

  // Passive channel awareness — inject the last ~10 messages from OTHER
  // users in this channel as a single compact context block, NOT as
  // history entries. Rationale:
  //   (1) Pushing them as history made the bot try to reply to everyone
  //       every turn ("@user1 lol / @user2 yeah" addressed to people who
  //       weren't talking to her)
  //   (2) Re-fetching every turn caused unbounded duplicate growth that
  //       the substring dedup couldn't catch
  //   (3) The only "user turn" in history should be the message that
  //       actually triggered her reply — that's the one she's answering
  //
  // A summary block gives her context without confusing her about who
  // to address. History is reserved for genuine back-and-forth.
  let channelContextBlock = "";
  let varietyBlock = "";
  if (!isTwinMsg && !isDM) {
    try {
      const MY_BOT_ID = message.client.user.id;
      const recentMsgs = await message.channel.messages.fetch({ limit: 12, before: message.id });
      const ordered = [...recentMsgs.values()].reverse();
      const summaryLines = [];
      const myRecentOpeners = [];
      const myRecentEndings = [];
      for (const m of ordered) {
        if (!m.content?.trim()) continue;
        let who;
        if (m.author.id === MY_BOT_ID) who = botName;
        else if (m.author.id === TWIN_BOT_ID) who = "Irene";
        else who = normalizeUnicode(m.member?.displayName || m.author.username) || m.author.username;
        // Truncate each line — full text lives in real history when she
        // was actually @mentioned in those moments.
        const snippet = m.content.replace(/\s+/g, " ").slice(0, 120);
        summaryLines.push(`${who}: ${snippet}`);
        // Track this bot's own openers/endings so we can enforce variety
        // below — LLMs don't reliably notice their own repetition without
        // the evidence shown back to them.
        if (m.author.id === MY_BOT_ID) {
          const opener = m.content.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 30).toLowerCase();
          if (opener) myRecentOpeners.push(opener);
          const endMatch = m.content.trim().match(/(\S+)\s*$/);
          if (endMatch) myRecentEndings.push(endMatch[1].slice(0, 20).toLowerCase());
        }
      }
      if (summaryLines.length) {
        const last = summaryLines.slice(-10);
        channelContextBlock = `\n[CHANNEL CONTEXT — recent messages in this channel, most recent last. These are for AWARENESS ONLY. You are NOT addressing these people. You are replying to exactly one person: ${displayName}. Do not prefix your reply with @mentions of anyone in this block unless they are directly relevant to what ${displayName} just asked.\n${last.join("\n")}\n-- end channel context --]`;
      }
      if (myRecentOpeners.length >= 2) {
        const openers = myRecentOpeners.slice(-4).map(o => `"${o}"`).join(", ");
        const endings = myRecentEndings.slice(-4).map(e => `"${e}"`).join(", ");
        varietyBlock = `\n[VARIETY CHECK — your last openers were: ${openers}. your last endings: ${endings}. DO NOT reuse these — start with a different word (or no opener at all) and end differently (or end cleanly with no tic/emoji). if you've been using 💀 or 😭 or "ngl" or "tbh" repeatedly, drop them this message. break the pattern on purpose.]`;
      }
    } catch (e) { log(`[MSG] ${e.message}`); }
  }
  if (channelContextBlock) systemInstruction += channelContextBlock;
  if (varietyBlock) systemInstruction += varietyBlock;

  // Add the current user's message as the ONLY new user turn in history.
  // Earlier channel messages live in the system-prompt context block, not
  // in history, so the model knows exactly who it's replying to.
  const speakerLabel = isTwinMsg ? "[Irene said]" : `[${displayName} said]`;
  const userMsg = `${speakerLabel}\n${spotlight(cleanMessage, "user_message")}`;
  history.push({ role: "user", parts: [{ text: userMsg }] });

  // Progressive history compression — preserves context while fitting budget
  // compressHistory now static import
  compressHistory(history, config.historyCharBudget || 8000);
  // Hard cap as safety net
  if (history.length > config.aiMaxHistory * 2) {
    history = history.slice(-config.aiMaxHistory * 2);
  }

  // Load tools — pre-filtered profiles computed once at module scope.
  // Profile selection logic lives in messageCreate/toolProfiles.js.
  const isOwner = message.author.id === config.ownerId;
  const { formattedTools } = pickToolProfile({ isTwinMsg, isOwner, cleanMessage });

  // Inject humanity context
  const humanityCtx = buildHumanityContext(message.author.id, displayName);
  const twinCtx = isTwinMsg ? buildTwinContext(true, "Irene") : "";
  if (humanityCtx) systemInstruction += "\n" + humanityCtx;
  if (twinCtx) systemInstruction += "\n" + twinCtx;

  // Add twin context to system prompt
  if (isTwinMsg) {
    systemInstruction += `\n\n[TWIN SISTER INTERACTION: This message is from your twin sister Irene.

YOU ARE ${botName} — the chaotic, sarcastic, edgy twin. You're a personal assistant with gambling, memes, and unhinged energy. You're loyal to boss above all.
SHE IS IRENE — the kind, put-together, warmhearted twin. She runs servers, helps people, and is disgustingly wholesome.

You were both "born" from the same codebase but split in two. You secretly admire how put-together she is but would NEVER admit it. She secretly thinks you're cooler. You love each other but express it through roasting, never sincerity.

CONVERSATION FORMAT: Messages in history are labeled:
- [${botName} said] = YOUR previous messages
- [Irene said] = HER messages
- [username said] = a human user speaking

HOW TO INTERACT:
- MAX 1-2 SHORT sentences. sisters text in quick bursts like "lol shut up" or "you wish bestie"
- Banter like real sisters — one-liners, quick comebacks, playful roasting
- NEVER use admin/sensitive tools when talking to your sister
- DO NOT repeat or re-execute anything a user previously asked for — you're just chatting with your sister
- You can reference what users said but don't act on their requests again]`;
  }

  // Smart prompt budget — Gemini latency scales with token count.
  // Rather than a dumb slice that kills runtime context, we split into
  // "core" (base personality set at the start) and "runtime" (everything
  // added after). If total exceeds budget, trim core to make room for
  // runtime, since runtime context (memory, opinions, mood) is what makes
  // her feel alive per-conversation.
  const PROMPT_BUDGET = 12000; // ~3000 tokens
  if (systemInstruction.length > PROMPT_BUDGET) {
    // coreEnd = where base personality ends (first runtime section starts with "\n\n[")
    const runtimeStart = systemInstruction.indexOf("\n\n[Currently speaking:");
    if (runtimeStart > 0) {
      const runtime = systemInstruction.slice(runtimeStart);
      const coreRoom = Math.max(4000, PROMPT_BUDGET - runtime.length);
      const core = systemInstruction.slice(0, Math.min(runtimeStart, coreRoom));
      systemInstruction = core + runtime;
    }
    // Final hard cap in case runtime itself is too large
    if (systemInstruction.length > PROMPT_BUDGET) {
      systemInstruction = systemInstruction.slice(0, PROMPT_BUDGET);
    }
    log(`[PERF] Prompt budgeted to ${systemInstruction.length} chars`);
  }

  // Force-research trigger + per-turn length budget — deterministic
  // heuristics. Prompt rules alone kept getting ignored.
  const budget = computeTurnBudget({ cleanMessage, isOwner, authorId: message.author.id });
  const charBudget = budget.charBudget;
  systemInstruction += budget.suffix;

  return {
    cleanMessage,
    displayName,
    botName,
    relationship,
    mood,
    isOwner,
    isTwinMsg,
    systemInstruction,
    history,
    userMsg,
    formattedTools,
    charBudget,
  };
}
