import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "autoModerationActionExecution";

const ACTION_TYPES = {
  1: "Block Message",
  2: "Send Alert",
  3: "Timeout",
  4: "Block Member Interaction",
};

const TRIGGER_TYPES = {
  1: "Keyword Filter",
  3: "Spam Detection",
  4: "Keyword Preset",
  5: "Mention Spam",
  6: "Member Profile",
};

export async function execute(execution) {
  const actionLabel = ACTION_TYPES[execution.action.type] ?? `Action ${execution.action.type}`;
  const triggerLabel = TRIGGER_TYPES[execution.ruleTriggerType] ?? `Trigger ${execution.ruleTriggerType}`;

  // Resolve the user for avatar/tag
  let user = null;
  try {
    user = await execution.guild.client.users.fetch(execution.userId).catch(() => null);
  } catch {}

  await sendModLog(execution.guild, logEvent({
    kind: "audit",
    title: `Auto-Mod · ${actionLabel}`,
    target: user,
    description: `<@${execution.userId}> triggered auto-mod rule **${execution.ruleName || "(unnamed)"}** in <#${execution.channelId}>.`,
    meta: {
      "User": user
        ? `<@${execution.userId}> · \`${user.tag}\` · \`${execution.userId}\``
        : `<@${execution.userId}> · \`${execution.userId}\``,
      "Rule": `\`${execution.ruleName || "(unnamed)"}\` · ID \`${execution.ruleId}\``,
      "Trigger Type": triggerLabel,
      "Channel": `<#${execution.channelId}>`,
      "Matched Keyword": execution.matchedKeyword ? `\`${execution.matchedKeyword}\`` : null,
      "Matched Content": execution.matchedContent ? `\`${execution.matchedContent.slice(0, 120)}\`` : null,
      "Action Taken": actionLabel,
      "Timeout Duration": execution.action.type === 3 && execution.action.metadata?.durationSeconds
        ? `${execution.action.metadata.durationSeconds}s`
        : null,
      "Alert Channel": execution.action.metadata?.channelId
        ? `<#${execution.action.metadata.channelId}>`
        : null,
    },
    fields: execution.content
      ? [{ name: "Full Content", value: execution.content.slice(0, 1024), inline: false }]
      : undefined,
    color: 0xed4245, // red — auto-mod hits are always worth looking at
    footerNote: `Rule ID: ${execution.ruleId}`,
  }));
}
