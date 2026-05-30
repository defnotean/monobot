// ─── Directive Executor ─────────────────────────────────────────────────────
//
// Persistent behavioral rules injected into Irene's system prompt as admin-set
// overrides. The save/remove admin gate here is a SECURITY BOUNDARY, not a
// courtesy — it covers EVERY provider (incl. nvidia/openaiCompat, which have no
// admin tool filter) and the scheduled-task fire path. list_directives stays
// open (read-only). Do not weaken these checks.

import { isAdminMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "save_directive", "list_directives", "remove_directive",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel } = ctx;

  switch (toolName) {
    case "save_directive": {
      // Directives are injected into Irene's system prompt as admin-set
      // overrides — gating them is a security boundary, not a courtesy. This
      // handler gate covers EVERY provider (incl. nvidia/openaiCompat, which
      // have no admin tool filter) and the scheduled-task fire path. A missing
      // message.member (DM / failed rehydrate) is treated as non-admin.
      if (!isAdminMember(message.member)) {
        return "only admins/mods can set or remove directives";
      }
      const { addDirective } = await import("../../database.js");
      const directive = String(input.directive || "").trim();
      if (!directive) return "give me the rule text — what should i remember to do?";
      if (directive.length > 500) return "directive is too long (max 500 chars)";
      let channelId = null;
      if (input.channel_name) {
        const ch = findChannel(guild, input.channel_id || input.channel_name);
        if (ch) channelId = ch.id;
      }
      const result = addDirective(guild.id, directive, channelId, message.author.id);
      if (!result.success) return result.reason;
      return `saved directive #${result.index + 1}: "${directive}"${channelId ? ` (applies to <#${channelId}>)` : " (server-wide)"}`;
    }

    case "list_directives": {
      const { getDirectives } = await import("../../database.js");
      const directives = getDirectives(guild.id);
      if (!directives.length) return "no directives saved for this server";
      return directives.map((d, i) => `${i + 1}. ${d.text}${d.channel ? ` (channel: <#${d.channel}>)` : ""}`).join("\n");
    }

    case "remove_directive": {
      if (!isAdminMember(message.member)) {
        return "only admins/mods can set or remove directives";
      }
      const { removeDirective } = await import("../../database.js");
      const keyword = String(input.keyword || "").trim();
      if (!keyword) return "give me a directive number or keyword to remove";
      const idx = /^\d+$/.test(keyword) ? parseInt(keyword, 10) - 1 : keyword;
      const result = removeDirective(guild.id, idx);
      if (!result.success) return result.reason;
      return `removed directive: "${result.removed}"`;
    }
  }
}
