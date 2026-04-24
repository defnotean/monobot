import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "autoModerationRuleCreate";

const TRIGGER_TYPES = {
  1: "Keyword Filter",
  3: "Spam Detection",
  4: "Keyword Preset",
  5: "Mention Spam",
  6: "Member Profile",
};

export async function execute(rule) {
  let actor = null;
  let reason = null;
  try {
    const audit = await rule.guild.fetchAuditLogs({ type: 140, limit: 1 }); // AUTO_MODERATION_RULE_CREATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === rule.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const actionSummary = rule.actions?.map((a) => {
    const types = { 1: "Block", 2: "Alert", 3: "Timeout", 4: "Block Interaction" };
    return types[a.type] || `Action ${a.type}`;
  }).join(", ");

  await sendModLog(rule.guild, logEvent({
    kind: "audit",
    title: "Auto-Mod Rule Created",
    actor,
    reason: reason || undefined,
    description: `Auto-mod rule \`${rule.name}\` was created${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${rule.name}\``,
      "Rule ID": `\`${rule.id}\``,
      "Trigger": TRIGGER_TYPES[rule.triggerType] ?? `type ${rule.triggerType}`,
      "Enabled": rule.enabled ? "✅ yes" : "❌ no",
      "Actions": actionSummary || "*(none)*",
      "Keyword Count": rule.triggerMetadata?.keywordFilter?.length ?? null,
      "Preset Count": rule.triggerMetadata?.presets?.length ?? null,
    },
    color: 0x57f287,
    footerNote: `Rule ID: ${rule.id}`,
  }));
}
