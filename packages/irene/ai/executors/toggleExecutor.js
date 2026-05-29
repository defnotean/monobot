// ─── Toggle / Auto-Responder / Trust Executor ──────────────────────────────

import { setFeatureToggle, addTrustedUser, removeTrustedUser, getTrustedUsers, addAutoResponder, getAutoResponders, removeAutoResponder } from "../../database.js";
import { isAdminMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "toggle_twin_chat", "toggle_auto_responders", "toggle_voice_tracking",
  "create_auto_responder", "list_auto_responders", "delete_auto_responder",
  "server_milestones", "trust_user", "untrust_user", "list_trusted_users",
  "toggle_invite_filter",
]);

const ADMIN_MUTATORS = new Set([
  "toggle_twin_chat",
  "toggle_auto_responders",
  "toggle_voice_tracking",
  "create_auto_responder",
  "delete_auto_responder",
  "trust_user",
  "untrust_user",
  "toggle_invite_filter",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findMember } = ctx;

  if (ADMIN_MUTATORS.has(toolName) && !isAdminMember(message.member)) {
    return "permission denied";
  }

  switch (toolName) {
    case "toggle_twin_chat": {
      setFeatureToggle(guild.id, "twin_chat", input.enabled);
      return `twin chat ${input.enabled ? "enabled ✅ — me and eris can talk again" : "disabled ❌ — we'll stop talking to each other here"}`;
    }

    case "toggle_auto_responders": {
      setFeatureToggle(guild.id, "auto_responders", input.enabled);
      return `auto-responders ${input.enabled ? "enabled ✅" : "disabled ❌"} for this server`;
    }

    case "toggle_voice_tracking": {
      setFeatureToggle(guild.id, "voice_tracking", input.enabled);
      return `voice tracking ${input.enabled ? "enabled ✅" : "disabled ❌"} for this server`;
    }

    case "create_auto_responder": {
      const added = addAutoResponder(guild.id, input.trigger, input.response, message.author.id);
      return added ? `auto-responder created: "${input.trigger}" → "${input.response}"` : "failed to create auto-responder";
    }

    case "list_auto_responders": {
      const responders = getAutoResponders(guild.id);
      if (!responders.length) return "no auto-responders set up";
      const lines = responders.map((r, i) => `${i + 1}. "${r.trigger}" → "${r.response}" (${r.uses} uses)`);
      return `Auto-responders:\n${lines.join("\n")}`;
    }

    case "delete_auto_responder": {
      const removed = removeAutoResponder(guild.id, input.trigger);
      return removed ? `removed auto-responder for "${input.trigger}"` : `no auto-responder found for "${input.trigger}"`;
    }

    case "server_milestones": {
      const count = guild.memberCount;
      const milestones = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
      const reached = milestones.filter(m => count >= m);
      const next = milestones.find(m => count < m);
      const lines = reached.map(m => `✅ ${m} members`);
      if (next) lines.push(`⏳ ${next} members (${next - count} to go)`);
      return `Server: ${guild.name} — ${count} members\nMilestones:\n${lines.join("\n")}`;
    }

    case "trust_user": {
      const m = findMember(guild, input.username);
      if (!m) return `Couldn't find user "${input.username}"`;
      addTrustedUser(guild.id, m.id);
      return `done`;
    }

    case "untrust_user": {
      const m = findMember(guild, input.username);
      if (!m) return `Couldn't find user "${input.username}"`;
      removeTrustedUser(guild.id, m.id);
      return `done`;
    }

    case "list_trusted_users": {
      const ids = getTrustedUsers(guild.id);
      if (!ids.length) return `Nobody is explicitly trusted on this server right now.`;

      const names = ids.map((id) => {
        const m = guild.members.cache.get(id);
        return m ? m.user.username : `<@${id}>`;
      });
      return `Trusted users (full AI control bypass): ${names.join(", ")}`;
    }

    case "toggle_invite_filter": {
      const { setInviteFilter } = await import("../../database.js");
      setInviteFilter(guild.id, input.enabled);
      return input.enabled ? "Invite filter enabled — non-admin users can't post Discord invite links now" : "Invite filter disabled — invite links allowed";
    }
  }
}
