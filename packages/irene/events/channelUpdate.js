import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { tempChannels, tempTextChannels } from "../utils/tempvc.js";

export const name = "channelUpdate";

const MAX_FIELD = 1024;
function clip(s) {
  if (!s) return "";
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD - 3) + "..." : s;
}

function fmtTopic(t) {
  if (!t) return "*(none)*";
  return t.length > 150 ? t.slice(0, 147) + "…" : t;
}

export async function execute(oldChannel, newChannel) {
  if (!newChannel.guild) return;
  // Skip noisy temp VC auto-renames and permission churn
  if (tempChannels.has(newChannel.id)) return;
  if ([...tempTextChannels.values()].includes(newChannel.id)) return;

  // Collect paired before/after lines for every changed property.
  const beforeLines = [];
  const afterLines = [];
  const changedKeys = [];

  if (oldChannel.name !== newChannel.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`#${oldChannel.name}\``);
    afterLines.push(`**Name** · \`#${newChannel.name}\``);
  }
  if (oldChannel.topic !== newChannel.topic) {
    changedKeys.push("Topic");
    beforeLines.push(`**Topic** · ${fmtTopic(oldChannel.topic)}`);
    afterLines.push(`**Topic** · ${fmtTopic(newChannel.topic)}`);
  }
  if (oldChannel.nsfw !== newChannel.nsfw) {
    changedKeys.push("NSFW");
    beforeLines.push(`**NSFW** · ${oldChannel.nsfw ? "✅ yes" : "❌ no"}`);
    afterLines.push(`**NSFW** · ${newChannel.nsfw ? "✅ yes" : "❌ no"}`);
  }
  if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
    changedKeys.push("Slowmode");
    beforeLines.push(`**Slowmode** · ${oldChannel.rateLimitPerUser || 0}s`);
    afterLines.push(`**Slowmode** · ${newChannel.rateLimitPerUser || 0}s`);
  }
  if (oldChannel.parentId !== newChannel.parentId) {
    changedKeys.push("Category");
    beforeLines.push(`**Category** · ${oldChannel.parent?.name ? `\`${oldChannel.parent.name}\`` : "*(none)*"}`);
    afterLines.push(`**Category** · ${newChannel.parent?.name ? `\`${newChannel.parent.name}\`` : "*(none)*"}`);
  }
  if (oldChannel.bitrate !== newChannel.bitrate && newChannel.bitrate) {
    changedKeys.push("Bitrate");
    beforeLines.push(`**Bitrate** · ${Math.round((oldChannel.bitrate || 0) / 1000)}kbps`);
    afterLines.push(`**Bitrate** · ${Math.round(newChannel.bitrate / 1000)}kbps`);
  }
  if (oldChannel.userLimit !== newChannel.userLimit && newChannel.userLimit !== undefined) {
    changedKeys.push("User Limit");
    beforeLines.push(`**User Limit** · ${oldChannel.userLimit || "unlimited"}`);
    afterLines.push(`**User Limit** · ${newChannel.userLimit || "unlimited"}`);
  }
  if (oldChannel.rawPosition !== newChannel.rawPosition) {
    changedKeys.push("Position");
    beforeLines.push(`**Position** · ${oldChannel.rawPosition}`);
    afterLines.push(`**Position** · ${newChannel.rawPosition}`);
  }

  // Permission overwrite diff — more informative than just noting "permissions changed"
  const oldPerms = oldChannel.permissionOverwrites?.cache;
  const newPerms = newChannel.permissionOverwrites?.cache;
  if (oldPerms && newPerms) {
    const oldKeys = new Set(oldPerms.keys());
    const newKeys = new Set(newPerms.keys());
    const added = [...newKeys].filter((k) => !oldKeys.has(k));
    const removed = [...oldKeys].filter((k) => !newKeys.has(k));
    if (added.length || removed.length) {
      changedKeys.push("Permissions");
      const addedList = added.map((id) => {
        const p = newPerms.get(id);
        return `<@${p.type === 1 ? "" : "&"}${id}>${p.type === 1 ? "" : " (role)"}`;
      }).join(", ");
      const removedList = removed.map((id) => {
        const p = oldPerms.get(id);
        return `<@${p.type === 1 ? "" : "&"}${id}>${p.type === 1 ? "" : " (role)"}`;
      }).join(", ");
      if (addedList) beforeLines.push(`**+ Overwrites** · ${addedList.slice(0, 400)}`);
      if (removedList) afterLines.push(`**− Overwrites** · ${removedList.slice(0, 400)}`);
    }
  }

  if (!changedKeys.length) return;

  // Audit log attribution
  let actor = null;
  let reason = null;
  try {
    const audit = await newChannel.guild.fetchAuditLogs({ type: 11, limit: 1 }); // CHANNEL_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newChannel.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(newChannel.guild, logEvent({
    kind: "channelUpdate",
    actor,
    reason: reason || undefined,
    description: `<#${newChannel.id}> was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Channel": `<#${newChannel.id}> · \`${newChannel.id}\``,
      "Category": newChannel.parent ? `\`${newChannel.parent.name}\`` : null,
    },
    fields: [
      { name: "📋 Before", value: clip(beforeLines.join("\n")) || "*(no before state)*", inline: true },
      { name: "📝 After",  value: clip(afterLines.join("\n"))  || "*(no after state)*",  inline: true },
    ],
    footerNote: `Channel ID: ${newChannel.id}`,
  }));
}
