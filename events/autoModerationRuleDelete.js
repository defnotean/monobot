import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

const TRIGGER_TYPES = {
  1: "Keyword Filter",
  3: "Spam Detection",
  4: "Keyword Preset",
  5: "Mention Spam",
  6: "Member Profile",
};

export const name = "autoModerationRuleDelete";

export async function execute(rule) {
  let actor = null;
  let reason = null;
  try {
    const audit = await rule.guild.fetchAuditLogs({ type: 142, limit: 1 }); // AUTO_MODERATION_RULE_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === rule.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(rule.guild, logEvent({
    kind: "audit",
    title: "Auto-Mod Rule Deleted",
    actor,
    reason: reason || undefined,
    description: `Auto-mod rule \`${rule.name}\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${rule.name}\``,
      "Rule ID": `\`${rule.id}\``,
      "Trigger": TRIGGER_TYPES[rule.triggerType] ?? `type ${rule.triggerType}`,
      "Was Enabled": rule.enabled ? "yes" : "no",
    },
    color: 0xed4245,
    footerNote: `Rule ID: ${rule.id}`,
  }));
}
