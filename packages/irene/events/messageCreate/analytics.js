// ─── packages/irene/events/messageCreate/analytics.js ─────────────────────
// Post-response state persistence and side effects: humanity tracking,
// sleep/nap detection, longmemory episode extraction, role auto-assign,
// DM-result mirror, and the rare afterthought follow-up. All of these
// run AFTER the firewall has cleared and the reply has been delivered.

import { MessageFlags } from "discord.js";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import {
  getMood, getGuildSettings, isDmOptout, getDmResults,
} from "../../database.js";
import {
  markBotResponded, isSleeping, triggerSleep,
  SLEEP_TRIGGERS, NAP_TRIGGERS,
} from "./gates.js";
import {
  getConvClient, activeProviderNeedsGeminiClient,
} from "./aiInvoke.js";
import { validateAssignableRole } from "../../ai/executors/customCommandExecutor.js";

let _modHumanity, _modLongmemory, _modStats;
const lazyHumanity   = async () => (_modHumanity   ??= await import("../../ai/humanity.js"));
const lazyLongmemory = async () => (_modLongmemory ??= await import("../../ai/longmemory.js"));
const lazyStats      = async () => (_modStats      ??= await import("../../commands/utility/stats.js"));

// Track AI usage for /stats.
export function trackAiUsage(guild) {
  if (!guild) return;
  lazyStats().then(({ trackAiMessage }) => trackAiMessage(guild.id)).catch(() => {});
}

// Track human interaction + detect "moments" (warm memories, embarrassments).
export async function trackHumanityState(message, content, reply, sentimentScore, isCreator) {
  try {
    const { trackHumanInteraction, detectMoment } = await lazyHumanity();
    trackHumanInteraction(message.author.id, message.author.username, content || message.content, sentimentScore, isCreator);
    detectMoment(message.author.id, content || message.content, reply || "", sentimentScore);
  } catch {}
  markBotResponded(message.guildId || "dm", message.author.id);
}

// Nap/sleep detection — only admins and bot owner can tell her to nap/sleep.
// She can still decide to nap on her own (auto-sleep below), but random
// users can't force it.
export function detectSleepIntent({ message, isAdmin, userMsg, resolvedReply, sentimentScore }) {
  const canControlSleep = isAdmin || message.author.id === config.ownerId;
  const userSaidNap = NAP_TRIGGERS.test(userMsg);
  const botSaidNap = NAP_TRIGGERS.test(resolvedReply);
  if (canControlSleep && ((userSaidNap && botSaidNap) || (userSaidNap && sentimentScore >= 0))) {
    triggerSleep(true); // nap = short sleep + energy/mood boost
  } else if (botSaidNap && !userSaidNap) {
    // Bot decided to nap on her own (from low energy prompt) — always allow
    triggerSleep(true);
  } else {
    // Full sleep detection — only admins/owner, or she says it late at night on her own
    const userSaidSleep = SLEEP_TRIGGERS.test(userMsg);
    const botSaidSleep = SLEEP_TRIGGERS.test(resolvedReply);
    if ((canControlSleep && userSaidSleep && botSaidSleep) || (botSaidSleep && new Date().getHours() >= 22)) {
      triggerSleep(false);
    }
  }
}

// Auto-sleep — if energy drops too low, she decides to rest on her own.
export async function maybeAutoSleep(message) {
  const currentMood = getMood();
  if (currentMood.energy <= 15 && !isSleeping()) {
    log(`[AUTO-SLEEP] Irene energy critically low (${currentMood.energy}), auto-napping`);
    try {
      await message.channel.send("im so tired... gonna take a quick nap, wake me up later 💤");
    } catch {}
    triggerSleep(true); // auto-nap, not full sleep
  }
}

// Afterthought — sometimes send a short follow-up like a real person.
// Reduced to 4% with strict dedup to prevent "repeated herself" perception.
export function maybeAfterthought({ message, resolvedReply, systemPromptWithMemory, isTwinMsg }) {
  if (isTwinMsg) return;
  if (resolvedReply.length <= 50) return;
  if (Math.random() >= 0.04) return;
  const afterDelay = 3000 + Math.floor(Math.random() * 4000);
  setTimeout(async () => {
    try {
      const convClient = getConvClient();
      if (!convClient || !activeProviderNeedsGeminiClient()) return;
      const afterResponse = await convClient.models.generateContent({
        model: config.geminiFastModel,
        contents: [{ role: "user", parts: [{ text: `you just said: "${resolvedReply.substring(0, 100)}". send a VERY short afterthought that adds NEW info — a correction, tangent, or "oh wait also". MAX 6 words. NEVER repeat any words from what you just said. examples: "actually wait nvm", "oh also check ur dms", "that came out wrong lol"` }] }],
        config: { systemInstruction: "you are irene. lowercase, casual, texting style. this is an afterthought, NOT a repeat.", maxOutputTokens: 30 },
      });
      const afterText = afterResponse.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      // Strict dedup: reject if >40% of words overlap with original reply
      if (afterText && afterText.length > 2 && afterText.length < 60) {
        const afterWords = new Set(afterText.toLowerCase().split(/\s+/));
        const replyWords = new Set(resolvedReply.toLowerCase().split(/\s+/));
        const overlap = [...afterWords].filter(w => replyWords.has(w) && w.length > 2).length;
        if (overlap / afterWords.size < 0.4) {
          await message.channel.send(afterText);
        }
      }
    } catch {}
  }, afterDelay);
}

// DM the result too if commands were used — only if server has DM results
// enabled AND the user hasn't individually opted out.
export async function mirrorToDm({ toolsUsed, isDM, guild, message, chunks }) {
  if (!(toolsUsed && !isDM && getDmResults(guild.id) && !isDmOptout(message.author.id))) return;
  try {
    const dm = await message.author.createDM();
    for (const chunk of chunks) await dm.send({ content: chunk, flags: MessageFlags.SuppressEmbeds });
  } catch {}
}

// Long-term memory — extract episodes, update mood narrative.
// Inner thoughts captured LIVE from model's reasoning tokens in dual.js.
export async function recordEpisode({ message, content, reply, sentimentScore }) {
  try {
    const { analyzeExchange } = await lazyLongmemory();
    analyzeExchange(message.author.id, message.channel.id, content || message.content, reply || "", sentimentScore);
  } catch {}
}

// Auto-assign the Irene access role if configured or a role named
// "irene-perms" exists.
export async function autoAssignAccessRole({ isDM, message, guild }) {
  if (isDM || !message.member) return;
  try {
    const settings = getGuildSettings(guild.id);
    const accessRoleId = settings?.irene_access_role_id;
    const accessRole = accessRoleId
      ? guild.roles.cache.get(accessRoleId)
      : guild.roles.cache.find((r) => r.name.toLowerCase() === "irene-perms");
    if (accessRole && !message.member.roles.cache.has(accessRole.id)) {
      const roleErr = validateAssignableRole(guild, accessRole, { actor: message.member, actionLabel: "Access role" });
      if (roleErr) {
        log(`[AccessRole] Skipping unsafe access role ${accessRole.id} in ${guild.name}: ${roleErr}`);
        return;
      }
      await message.member.roles.add(accessRole).catch(() => {});
    }
  } catch {}
}
