// Ack/status message lifecycle for Irene's messageCreate AI invocation.

import { MessageFlags } from "discord.js";
import {
  activeProviderNeedsGeminiClient,
  getConvClient,
  quickReply,
} from "./aiInvoke.js";

export function createAckStatusState() {
  return {
    ackMsg: null,
    statusMsg: null,
    ackTimer: undefined,
  };
}

export function startAckTimer(state, { isTask, isDM, message, guild, systemPromptWithMemory, userText, firewallGate }) {
  if (!(isTask && !isDM && activeProviderNeedsGeminiClient())) return;

  state.ackTimer = setTimeout(async () => {
    if (state.ackMsg !== null) return;
    const ack = await quickReply(
      getConvClient(),
      systemPromptWithMemory,
      userText,
      { guild, channel: message.channel },
    ).catch(() => null);
    if (ack && state.ackMsg === null) {
      await firewallGate(async () => {
        state.ackMsg = await message.reply({ content: ack, flags: MessageFlags.SuppressEmbeds }).catch(() => null);
      });
    }
  }, 2000);

  state.ackMsg = undefined;
}

export function createToolStatusHandler(state, { isTask, isDM, message, content, firewallGate }) {
  return async (rawStatus) => {
    if (!isTask) return;

    let displayStatus = rawStatus;
    if (activeProviderNeedsGeminiClient()) {
      const naturalProgress = await quickReply(
        getConvClient(),
        "You are a progress narrator. Given raw tool execution status, write a SHORT casual update (under 40 words) describing what's happening. Don't use technical terms like 'tool_use' or function names. Write like a person. Examples: 'creating the roles now...', 'almost done, just setting up the reactions', 'found the song, joining your vc'",
        `Raw status:\n${rawStatus}\n\nOriginal request: ${content}`,
        {},
      ).catch(() => null);
      if (naturalProgress) displayStatus = naturalProgress;
    }

    await firewallGate(async () => {
      if (state.ackMsg) {
        await state.ackMsg.edit(displayStatus.slice(0, 1990)).catch(() => {});
        state.statusMsg = state.ackMsg;
        state.ackMsg = null;
      } else if (!state.statusMsg && !isDM) {
        state.statusMsg = await message.channel.send(displayStatus.slice(0, 1990)).catch(() => null);
      } else {
        await state.statusMsg?.edit(displayStatus.slice(0, 1990)).catch(() => {});
      }
    });
  };
}

export function cancelAckTimer(state) {
  if (typeof state.ackTimer !== "undefined") {
    clearTimeout(state.ackTimer);
    state.ackMsg = null;
  }
}

export async function cleanupAckStatus(state, toolsUsed) {
  const statusMsg = state.statusMsg;
  const ackMsg = state.ackMsg;
  await statusMsg?.delete().catch(() => {});
  if (ackMsg && toolsUsed) await ackMsg.delete().catch(() => {});
  if (ackMsg && !toolsUsed) await ackMsg.delete().catch(() => {});
}

export async function deleteStatusOnError(state) {
  await state.statusMsg?.delete().catch(() => {});
}
