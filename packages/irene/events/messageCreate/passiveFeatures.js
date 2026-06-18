// Passive messageCreate side effects that must keep their orchestrator order.

import { ChannelType } from "discord.js";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { getTtsChannels } from "../../database.js";
import { validateAssignableRole } from "../../ai/executors/customCommandExecutor.js";
import { isSleeping, wakeSleep } from "./gates.js";
import { processStickyMessage, processAutoResponders } from "./commandPrefix.js";

let _modAfk, _modHighlight, _modLeveling;
const lazyAfk = async () => (_modAfk ??= await import("../../commands/utility/afk.js"));
const lazyHighlight = async () => (_modHighlight ??= await import("../../commands/utility/highlight.js"));
const lazyLeveling = async () => (_modLeveling ??= await import("../../utils/leveling.js"));

export async function handleSleepWake(message) {
  if (!isSleeping()) return false;

  const isOwner = message.author?.id === config.ownerId;
  const mentioned = message.mentions?.has(message.client.user);
  const saidWakeUp = /\b(wake\s*up|get\s*up|wakey|rise\s*and\s*shine)\b/i.test(message.content);
  if (isOwner && (mentioned || saidWakeUp)) {
    wakeSleep();
    await message.reply("im up im up 🥱").catch(() => {});
  }
  return true;
}

export async function maybeAutoTts(message) {
  if (
    message.author.bot ||
    !message.guild ||
    (message.channel.type !== ChannelType.GuildVoice && message.channel.type !== ChannelType.GuildStageVoice)
  ) {
    return;
  }

  const ttsChannels = getTtsChannels(message.guild.id);
  if (
    ttsChannels.includes(message.channel.id) &&
    message.content &&
    !message.content.startsWith("!") &&
    !message.mentions.has(message.client.user)
  ) {
    const { playTTS } = await import("../../music/player.js");
    playTTS(
      message.guild.id,
      `${message.member?.displayName ?? message.author.username} says: ${message.content}`,
      message.channel,
      message.channel,
    ).catch((err) => log(`[TTS] Auto-TTS failed: ${err.message}`));
  }
}

export function detectTtsToggleShortcut(content = "") {
  const t = String(content).toLowerCase();
  if (!/\btts\b|text\s*(?:-|to)?\s*speech|text-to-speech/.test(t)) return null;
  if (/\bvoice\s+listen\b|\bwake\s*word\b|\blisten(?:ing)?\s+in\s+(?:vc|voice)\b/.test(t)) return null;
  if (/\b(?:turn|switch)\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\s+(?:back\s+)?off\b/.test(t)) return false;
  if (/\b(?:turn|switch)\s+(?:back\s+)?off\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\b/.test(t)) return false;
  if (/\b(?:disable|stop)\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\b/.test(t)) return false;
  if (/\b(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\s+off\b/.test(t)) return false;
  if (/\b(?:turn|switch)\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\s+(?:back\s+)?on\b/.test(t)) return true;
  if (/\b(?:turn|switch)\s+(?:back\s+)?on\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\b/.test(t)) return true;
  if (/\b(?:enable|start)\s+(?:the\s+)?(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\b/.test(t)) return true;
  if (/\b(?:tts|text\s*(?:-|to)?\s*speech|text-to-speech)\s+on\b/.test(t)) return true;
  return null;
}

export async function handleTtsToggleShortcut({ message, content, isDM, isAdmin }) {
  const ttsShortcut = detectTtsToggleShortcut(content);
  if (ttsShortcut === null || isDM || !message.guild) return false;

  if (!isAdmin && message.author.id !== config.ownerId) {
    await message.reply("you need admin perms to toggle TTS").catch((e) => log(`[Error] ${e.message}`));
    return true;
  }

  const { execute: executeAudioTool } = await import("../../ai/executors/audioExecutor.js");
  const result = await executeAudioTool("toggle_tts", { enabled: ttsShortcut }, message, { guild: message.guild });
  await message.reply(String(result)).catch((e) => log(`[Error] ${e.message}`));
  return true;
}

export async function runPassiveSideEffects({ message, isDM }) {
  if (!isDM && !message.author.bot) {
    await processStickyMessage(message);
  }

  if (!isDM) {
    await processAutoResponders(message);
  }

  if (!isDM) {
    lazyAfk().then(({ checkAfkReturn, checkAfkMentions }) => {
      checkAfkReturn(message);
      checkAfkMentions(message);
    }).catch(() => {});
  }

  if (!isDM) {
    lazyHighlight().then(({ checkHighlights }) => checkHighlights(message).catch(() => {})).catch(() => {});
  }

  if (!isDM && message.guild) {
    await applyLevelingRewards(message);
  }
}

async function applyLevelingRewards(message) {
  const { addXp, getLevelSettings, getLevelRewards } = await lazyLeveling();
  const settings = getLevelSettings(message.guild.id);
  if (!settings.enabled) return;

  const result = addXp(message.guild.id, message.author.id, settings.xpPerMessage);
  if (!result?.leveledUp) return;

  const rewards = getLevelRewards(message.guild.id);
  const reward = rewards.find((r) => r.level === result.level);
  if (reward) {
    const role = message.guild.roles.cache.get(reward.roleId);
    if (role) {
      const roleErr = validateAssignableRole(message.guild, role, { actor: message.member, actionLabel: "Level reward" });
      if (roleErr) log(`[Leveling] Skipping unsafe reward role ${role.id} in ${message.guild.name}: ${roleErr}`);
      else message.member?.roles.add(role).catch(() => {});
    }
  }

  const levelPingIds = Array.isArray(settings.ping_role_ids) ? settings.ping_role_ids : [];
  const levelPingStr = levelPingIds.map((id) => `<@&${id}>`).join(" ");
  const announceText = `${levelPingStr ? levelPingStr + " " : ""}gg ${message.author}, you just hit **level ${result.level}**!${reward ? ` you got the **${message.guild.roles.cache.get(reward.roleId)?.name ?? ""}** role` : ""}`;
  const announceChannel = settings.announceChannel
    ? message.guild.channels.cache.get(settings.announceChannel)
    : message.channel;
  (announceChannel ?? message.channel).send(announceText).catch(() => {});
}
