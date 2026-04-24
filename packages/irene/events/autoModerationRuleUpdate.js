import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "autoModerationRuleUpdate";

export async function execute(oldRule, newRule) {
  const changedKeys = [];
  const beforeLines = [];
  const afterLines = [];

  if (oldRule?.name !== newRule.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldRule?.name ?? "?"}\``);
    afterLines.push(`**Name** · \`${newRule.name}\``);
  }
  if (oldRule?.enabled !== newRule.enabled) {
    changedKeys.push(newRule.enabled ? "Enabled" : "Disabled");
    beforeLines.push(`**Enabled** · ${oldRule?.enabled ? "✅ yes" : "❌ no"}`);
    afterLines.push(`**Enabled** · ${newRule.enabled ? "✅ yes" : "❌ no"}`);
  }
  const oldKW = oldRule?.triggerMetadata?.keywordFilter?.length ?? 0;
  const newKW = newRule.triggerMetadata?.keywordFilter?.length ?? 0;
  if (oldKW !== newKW) {
    changedKeys.push("Keywords");
    beforeLines.push(`**Keywords** · ${oldKW} filtered`);
    afterLines.push(`**Keywords** · ${newKW} filtered`);
  }
  const oldActions = oldRule?.actions?.length ?? 0;
  const newActions = newRule.actions?.length ?? 0;
  if (oldActions !== newActions) {
    changedKeys.push("Actions");
    beforeLines.push(`**Actions** · ${oldActions}`);
    afterLines.push(`**Actions** · ${newActions}`);
  }

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newRule.guild.fetchAuditLogs({ type: 141, limit: 1 }); // AUTO_MODERATION_RULE_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newRule.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(newRule.guild, logEvent({
    kind: "audit",
    title: "Auto-Mod Rule Updated",
    actor,
    reason: reason || undefined,
    description: `Auto-mod rule \`${newRule.name}\` was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Name": `\`${newRule.name}\``,
      "Rule ID": `\`${newRule.id}\``,
    },
    fields: [
      { name: "📋 Before", value: beforeLines.join("\n") || "*(unchanged)*", inline: true },
      { name: "📝 After",  value: afterLines.join("\n")  || "*(unchanged)*", inline: true },
    ],
    color: 0x5865f2,
    footerNote: `Rule ID: ${newRule.id}`,
  }));
}
