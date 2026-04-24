import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { getWarnings } from "../database.js";
import { recordServerRemoval } from "./voiceStateUpdate.js";
import { getEvidence, formatEvidence } from "../utils/messageEvidence.js";

export const name = "guildBanAdd";

function formatAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ${day % 30}d`;
  const yr = Math.floor(day / 365);
  return `${yr}y ${Math.floor((day % 365) / 30)}mo`;
}

export async function execute(ban) {
  let moderator = null;
  let reason = ban.reason;
  let banTimestamp = null;

  // Fetch up to 20 recent ban entries and find the one matching this user.
  // Doing limit:1 mis-attributes in mass-ban scenarios (raid cleanup).
  // Also retry once with a short delay — Discord's audit log is eventually
  // consistent (~500ms-2s) so immediate fetches frequently return null.
  const _lookup = async () => {
    try {
      const audit = await ban.guild.fetchAuditLogs({ type: 22, limit: 20 });
      const now = Date.now();
      for (const e of audit.entries.values()) {
        if (e.target?.id !== ban.user.id) continue;
        if (now - e.createdTimestamp > 15_000) continue;
        return e;
      }
    } catch {}
    return null;
  };
  let entry = await _lookup();
  if (!entry) { await new Promise(r => setTimeout(r, 1200)); entry = await _lookup(); }
  if (entry) {
    moderator = entry.executor;
    reason = entry.reason ?? reason;
    banTimestamp = entry.createdTimestamp;
  }

  // Flag this for the voice-state handler so a concurrent voice-disconnect
  // event can be attributed to the ban rather than reported as a self-leave.
  recordServerRemoval(ban.guild.id, ban.user.id, "ban", moderator, reason);

  // Pull everything we still know about this member from the cache before
  // they're gone for good — roles, nickname, join date, time in server.
  const cached = ban.guild.members.cache.get(ban.user.id);
  const cachedRoles = cached
    ? cached.roles.cache.filter((r) => r.id !== ban.guild.id).map((r) => `<@&${r.id}>`).join(" ")
    : null;
  const nickname = cached?.nickname || null;
  const joinedTs = cached?.joinedTimestamp || null;
  const timeInServer = joinedTs ? formatAge(Date.now() - joinedTs) : null;

  const now = Date.now();
  const createdTs = ban.user.createdTimestamp || null;
  const accountAgeMs = createdTs ? now - createdTs : null;
  const accountAge = accountAgeMs != null ? formatAge(accountAgeMs) : "unknown";
  const isNew = accountAgeMs != null && accountAgeMs < 7 * 86_400_000;

  // Current warning count in this guild — useful context for auto-escalation
  let warnCount = null;
  try {
    warnCount = getWarnings(ban.guild.id, ban.user.id)?.length ?? null;
  } catch {}

  const meta = {
    "User": `\`${ban.user.tag}\` · \`${ban.user.id}\``,
    "Account Created": createdTs ? `<t:${Math.floor(createdTs / 1000)}:F> (<t:${Math.floor(createdTs / 1000)}:R>)` : null,
    "Account Age": isNew ? `⚠️ ${accountAge} (new account)` : accountAge,
    "Joined Server": joinedTs ? `<t:${Math.floor(joinedTs / 1000)}:F> (<t:${Math.floor(joinedTs / 1000)}:R>)` : null,
    "Time in Server": timeInServer,
    "Nickname": nickname,
    "Prior Warnings": warnCount != null ? String(warnCount) : null,
    "Ban Executed": banTimestamp ? `<t:${Math.floor(banTimestamp / 1000)}:R>` : `<t:${Math.floor(now / 1000)}:R>`,
    "Bot Account": ban.user.bot ? "yes" : null,
  };

  // Trim role list at role-token boundaries so we don't truncate mid-mention.
  let rolesField = null;
  if (cachedRoles) {
    const roleTokens = cached.roles.cache
      .filter((r) => r.id !== ban.guild.id)
      .map((r) => `<@&${r.id}>`);
    let joined = "";
    let shown = 0;
    for (const tok of roleTokens) {
      if (joined.length + tok.length + 1 > 1000) break;
      joined += (joined ? " " : "") + tok;
      shown++;
    }
    const hidden = roleTokens.length - shown;
    const value = hidden > 0 ? `${joined} … +${hidden} more` : joined;
    rolesField = { name: `Roles at time of ban (${roleTokens.length})`, value, inline: false };
  }

  // Attach the last few messages this user sent before getting banned, if
  // the in-memory evidence buffer caught any. Discord embed field value
  // is capped at 1024 chars; truncate at the entry boundary so we don't
  // cut a message in half.
  let evidenceField = null;
  const evidence = getEvidence(ban.guild.id, ban.user.id);
  if (evidence.length > 0) {
    const full = formatEvidence(evidence);
    let value = full;
    if (value.length > 1024) {
      // Trim entries from the OLDEST side (keep the most recent context) until
      // we fit under 1024 with an ellipsis. Entries are most-recent-LAST.
      const lines = full.split("\n");
      while (lines.length > 1 && lines.join("\n").length > 1020) {
        lines.shift();
      }
      value = (full.split("\n").length > lines.length ? "… (older trimmed) …\n" : "") + lines.join("\n");
      if (value.length > 1024) value = value.slice(0, 1021) + "…";
    }
    evidenceField = {
      name: `Recent messages before ban (${evidence.length})`,
      value,
      inline: false,
    };
  }

  const fields = [rolesField, evidenceField].filter(Boolean);

  await sendModLog(ban.guild, logEvent({
    kind: "ban",
    target: ban.user,
    actor: moderator,
    reason: reason || "no reason provided",
    meta,
    fields: fields.length > 0 ? fields : undefined,
  }));
}
