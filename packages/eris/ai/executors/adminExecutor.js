// ─── Admin Sub-Executor ─────────────────────────────────────────────────────
// Handles: change_avatar, change_banner, change_name, change_nickname,
//          update_personality, set_server_persona, configure_game, configure_slots,
//          query_database, list_tables, whitelist_server, unwhitelist_server,
//          list_whitelist, trust_user, untrust_user, list_trusted,
//          configure_feature, list_features, toggle_twin_chat
// Called from main executor.js via delegation.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { isOwner, canCustomize, denyMessage, addTrustedUser, removeTrustedUser, getTrustedUsers } from "../../utils/permissions.js";
import { auditLog } from "../../utils/pcAgent.js";
import { resolveMember } from "../../utils/discord.js";
import { safeFetch } from "@defnotean/shared/safeFetch";

const PERSONALIZATION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT_TO_TYPE = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
const ALLOWED_IMAGE_TYPES = new Set(IMAGE_EXT_TO_TYPE.values());

// Resolve a user_id-or-name input to a verified Discord snowflake. The model
// often passes a username instead of an ID; without this resolver, we'd store
// literal strings like "bob" in trust/relationship tables and later mention
// `<@bob>` (broken ping). Returns null when nothing resolvable was provided.
async function _resolveUserSnowflake(input, message) {
  const raw = input?.user_id || input?.userId || input?.username || input?.target;
  if (!raw) return null;
  if (/^\d{17,20}$/.test(String(raw))) return String(raw);
  if (!message?.guild) return null;
  const member = await resolveMember(message.guild, String(raw));
  return member?.id || null;
}

// Fire-and-forget audit record for sensitive admin tools. Never throws.
function audit(tool, message, command, result) {
  auditLog({
    tool,
    userId: message?.author?.id,
    guildId: message?.guild?.id,
    channelId: message?.channel?.id,
    command: command ? JSON.stringify(command).substring(0, 2000) : null,
    result,
  }).catch(() => {});
}

const HANDLED = new Set([
  "change_avatar", "change_banner", "change_name", "change_nickname",
  "update_personality", "set_server_persona", "configure_game", "configure_slots",
  "query_database", "list_tables", "whitelist_server", "unwhitelist_server",
  "list_whitelist", "trust_user", "untrust_user", "list_trusted",
  "configure_feature", "list_features", "toggle_twin_chat",
  "save_directive", "list_directives", "remove_directive",
  "toggle_cross_bot_punish",
  "list_roles_by_category",
]);

function truncate(str, max = 1500) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + "\n...(truncated)" : str;
}

function canManageServerSettings(message) {
  if (!message?.guild || !message?.author?.id) return false;
  const hasManageGuild = message.member?.permissions?.has?.("ManageGuild");
  return canCustomize(message.author.id, message.guild) || hasManageGuild;
}

function getHeader(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()] ?? "";
}

function imageTypeFromUrl(rawUrl) {
  let path = "";
  try { path = new URL(rawUrl).pathname; }
  catch { path = String(rawUrl).split("?")[0]; }
  const ext = path.toLowerCase().split(".").pop();
  return IMAGE_EXT_TO_TYPE.get(ext || "") || null;
}

async function fetchPersonalizationImage(imageUrl) {
  if (!imageUrl) throw new Error("no image URL provided");

  const res = await safeFetch(imageUrl, {
    binary: true,
    maxBytes: PERSONALIZATION_IMAGE_MAX_BYTES,
    timeoutMs: 10_000,
  }).catch((e) => {
    if (/response too large/i.test(e?.message || "")) {
      throw new Error("image is too large (max 8 MB)");
    }
    throw e;
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`image download failed (HTTP ${res.status})`);
  }

  const rawType = String(getHeader(res.headers, "content-type")).split(";")[0].trim().toLowerCase();
  if (rawType && !rawType.startsWith("image/") && rawType !== "application/octet-stream") {
    throw new Error("URL did not return an image");
  }

  const contentType = rawType.startsWith("image/")
    ? rawType
    : imageTypeFromUrl(res.url) || imageTypeFromUrl(imageUrl);
  if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error("image must be PNG, JPG, GIF, or WebP");
  }

  return { bytes: res.bytes, contentType };
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    // ─── Feature configuration ──────────────────────────────────────────

    case "configure_feature": {
      if (!message.guild) return "feature config only works in servers";
      // Server-level feature toggle — restricted to the creator, trusted
      // users, the server owner, or anyone with ManageGuild. Without this
      // gate a regular member could disable economy/events/stocks for the
      // whole guild.
      const hasManageGuild = message.member?.permissions?.has?.("ManageGuild");
      if (!canCustomize(message.author.id, message.guild) && !hasManageGuild) {
        return denyMessage();
      }
      const feature = (input.feature || "").toLowerCase().trim();
      const VALID = ["economy", "gambling", "events", "confessions", "boss_battles", "stocks", "heists", "territories", "pets", "daily_challenges", "achievements", "loans", "dreams", "briefing"];
      if (!VALID.includes(feature)) return `unknown feature "${feature}". valid: ${VALID.join(", ")}`;

      // Resolve channel from name, mention, ID, or partial match.
      // Handles emoji-prefixed names like "⛩️・insadong" when the AI just says "insadong"
      let resolvedCh = null;
      if (input.channel) {
        const mentionMatch = input.channel.match(/<#(\d+)>/);
        if (mentionMatch) {
          resolvedCh = message.guild.channels.cache.get(mentionMatch[1]);
        } else {
          const chInput = input.channel.replace(/^#/, "").toLowerCase().trim();
          resolvedCh = message.guild.channels.cache.get(chInput)                              // by ID
            ?? message.guild.channels.cache.find(c => c.name.toLowerCase() === chInput)       // exact name
            ?? message.guild.channels.cache.find(c => c.name.toLowerCase().includes(chInput)) // partial (emoji prefix)
            ?? message.guild.channels.cache.find(c => {                                       // strip emoji + symbols
              const stripped = c.name.replace(/[^\w\s-]/g, "").replace(/^[\s-]+/, "").toLowerCase().trim();
              return stripped === chInput || stripped.includes(chInput);
            });
        }
        if (!resolvedCh) return `channel "${input.channel}" not found in this server — try the exact name or use #channel mention`;
      }

      // Special handling for dream/briefing — stored as guild settings
      if (feature === "dreams" || feature === "briefing") {
        const key = feature === "dreams" ? "dream_channel_id" : "briefing_channel_id";
        if (resolvedCh) {
          db.setGuildSetting(message.guild.id, key, resolvedCh.id);
          return `${feature} channel set to <#${resolvedCh.id}> for this server`;
        }
        if (input.enabled === false) {
          db.setGuildSetting(message.guild.id, key, null);
          return `${feature} disabled for this server`;
        }
        const existing = db.getGuildSettings(message.guild.id)?.[key];
        return existing ? `${feature} channel: <#${existing}>` : `no ${feature} channel set — tell me which channel to use`;
      }

      const updates = {};
      if (input.enabled !== undefined) updates.enabled = input.enabled;
      if (resolvedCh) updates.channel_id = resolvedCh.id;
      if (input.ping_roles) {
        const roleNames = input.ping_roles.split(",").map(s => s.trim()).filter(Boolean);
        const roleIds = [];
        for (const name of roleNames) {
          const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase().replace(/^@/, "") && r.id !== message.guild.id);
          if (role) roleIds.push(role.id);
        }
        if (roleIds.length) updates.ping_role_ids = roleIds;
      }

      db.setFeatureConfig(message.guild.id, feature, updates);
      log(`[FEATURE] ${feature} configured in guild ${message.guild.id}: ${JSON.stringify(updates)}`);
      const parts = [];
      if (updates.enabled !== undefined) parts.push(`${feature}: ${updates.enabled ? "enabled \u2705" : "disabled \u274C"}`);
      if (updates.channel_id) parts.push(`channel: <#${updates.channel_id}>`);
      if (updates.ping_role_ids) parts.push(`ping roles: ${updates.ping_role_ids.map(id => `<@&${id}>`).join(", ")}`);
      return parts.length ? `configured ${feature} for this server:\n${parts.join("\n")}` : `${feature} config updated for this server`;
    }

    case "list_features": {
      if (!message.guild) return "feature config only works in servers";
      const FEATURES = ["economy", "gambling", "events", "confessions", "boss_battles", "stocks", "heists", "territories", "pets", "daily_challenges", "achievements", "loans"];
      const gs = db.getGuildSettings(message.guild.id) || {};
      const lines = FEATURES.map(f => {
        const cfg = db.getFeatureConfig(message.guild.id, f);
        const status = cfg.enabled ? "\u2705" : "\u274C";
        const channel = cfg.channel_id ? `<#${cfg.channel_id}>` : "none";
        const roles = cfg.ping_role_ids?.length ? cfg.ping_role_ids.map(id => `<@&${id}>`).join(", ") : "none";
        return `${status} **${f}** \u2014 channel: ${channel} | pings: ${roles}`;
      });
      // Add dream/briefing channels
      const dreamCh = gs.dream_channel_id ? `<#${gs.dream_channel_id}>` : "not set";
      const briefCh = gs.briefing_channel_id ? `<#${gs.briefing_channel_id}>` : "not set";
      lines.push(`\u2728 **dreams** \u2014 channel: ${dreamCh}`);
      lines.push(`\ud83d\udcdd **briefing** \u2014 channel: ${briefCh}`);
      return `server feature config:\n${lines.join("\n")}`;
    }

    case "toggle_twin_chat": {
      if (!message.guild) return "only works in servers";
      if (!canManageServerSettings(message)) return denyMessage("customize");
      db.setGuildSetting(message.guild.id, "twin_chat_enabled", input.enabled);
      return input.enabled ? "twin chat enabled \u2014 me and irene can talk to each other again" : "twin chat disabled \u2014 we'll stop talking to each other in this server";
    }

    case "toggle_cross_bot_punish": {
      if (!message.guild) return "only works in servers";
      if (!canManageServerSettings(message)) return denyMessage("customize");
      const settings = db.getGuildSettings(message.guild.id) || {};
      const current = !!settings.cross_bot_punish;
      const next = typeof input.enabled === "boolean" ? input.enabled : !current;
      db.setGuildSetting(message.guild.id, "cross_bot_punish", next);
      return next
        ? "cross-bot punishment **enabled** — when irene bans or kicks someone here, i'll zero their coin balance automatically. harsh but fair."
        : "cross-bot punishment **disabled** — bans/kicks from irene won't touch balances anymore.";
    }

    case "list_roles_by_category": {
      if (!message.guild) return "role categorization only works in servers";
      const { getRolesByCategory, categorizeRole } = await import("@defnotean/shared/roleCategorizer");
      const category = String(input?.category || "all").trim().toLowerCase();
      const formatRole = (r) => {
        const cat = categorizeRole(r, message.guild);
        const perms = r.permissions.toArray();
        const permSummary = perms.length <= 3 ? perms.join(", ") : `${perms.length} perms`;
        return `• **${r.name}** (\`${r.id}\`) — ${cat}${perms.length ? ` [${permSummary}]` : ""}`;
      };
      // Default behavior: dump every category. Lets the model call the tool
      // without forcing the user to pick one upfront.
      if (category === "all") {
        const cats = ["admin", "moderator", "helper", "bot", "cosmetic"];
        const sections = [];
        for (const cat of cats) {
          const matches = getRolesByCategory(message.guild, cat);
          if (matches.length) sections.push(`**${cat}** (${matches.length}):\n${matches.map(formatRole).join("\n")}`);
        }
        return sections.length ? sections.join("\n\n") : "no roles found in any category";
      }
      const matches = getRolesByCategory(message.guild, category);
      if (!matches.length) return `no roles in this server are categorized as **${category}**. (categorization is based on actual permissions — cosmetic roles with no power are skipped on purpose.)`;
      return `roles categorized as **${category}** (${matches.length}):\n${matches.map(formatRole).join("\n")}`;
    }

    case "save_directive": {
      if (!message.guild) return "directives only work in servers";
      if (!canManageServerSettings(message)) return denyMessage("customize");
      const text = input.directive || input.text || input.rule;
      if (!text) return "what's the rule? give me a directive to save";

      // Misroute guard: directives don't actually disable events or chat —
      // the schedulers/responders read from event_*_channels and
      // chat_muted_channels guild settings, not from the directives table.
      // If the model picked save_directive for a request that's clearly an
      // event-fire or chat-mute restriction, refuse with a redirect so the
      // model retries on the right tool instead of storing a useless string.
      const lower = String(text).toLowerCase();
      const eventIntent = /\b(events?|coin rain|chaos storm|lucky hour|pirate raid|random event)\b/.test(lower)
        && /\b(off|stop|disable|block|deny|don'?t|do not|no|never|only|restrict|allow|enable|whitelist|denylist|fire|trigger|spawn)\b/.test(lower);
      const chatIntent = !eventIntent
        && /\b(chat|talk|reply|respond|message|say)\b/.test(lower)
        && /\b(don'?t|do not|stop|never|mute|silent|quiet|shut up)\b/.test(lower);
      if (eventIntent) {
        return "this is an event-channel restriction, not a tone directive — call set_event_channels with action='deny' (block channels) or action='set' (only-allow channels). save_directive doesn't disable events; the scheduler ignores directives.";
      }
      if (chatIntent) {
        return "this is a chat-channel restriction, not a tone directive — call set_chat_channels with action='mute' to keep me quiet there. save_directive doesn't mute channels; @mention triggers ignore directives.";
      }

      // Resolve channel name to ID if provided
      let channelId = null;
      if (input.channel_name || input.channel) {
        const chName = (input.channel_name || input.channel).replace(/^#/, "").toLowerCase();
        const ch = message.guild.channels.cache.find(c =>
          c.name.toLowerCase() === chName || c.name.toLowerCase().includes(chName)
        ) ?? message.guild.channels.cache.get(chName);
        channelId = ch?.id || null;
      }
      const result = db.addDirective(message.guild.id, text, channelId, message.author.id);
      if (!result.success) return result.reason;
      log(`[DIRECTIVE] Saved in ${message.guild.id}: "${text}"${channelId ? ` (channel: ${channelId})` : " (server-wide)"}`);
      return `got it — saved: "${text}"${channelId ? ` (applies to <#${channelId}>)` : " (applies everywhere in this server)"}`;
    }

    case "list_directives": {
      if (!message.guild) return "directives only work in servers";
      const directives = db.getDirectives(message.guild.id);
      if (!directives.length) return "no directives set for this server";
      return directives.map((d, i) => {
        const scope = d.channel ? `<#${d.channel}>` : "server-wide";
        return `\`${i}\` ${d.text} *(${scope})*`;
      }).join("\n");
    }

    case "remove_directive": {
      if (!message.guild) return "directives only work in servers";
      if (!canManageServerSettings(message)) return denyMessage("customize");
      const keyword = input.keyword || input.index || input.text;
      if (!keyword && keyword !== 0) return "tell me which directive to remove — keyword or index number";
      const idx = /^\d+$/.test(String(keyword)) ? parseInt(keyword) : keyword;
      const result = db.removeDirective(message.guild.id, idx);
      if (!result.success) return result.reason;
      log(`[DIRECTIVE] Removed in ${message.guild.id}: "${keyword}"`);
      return `removed directive "${keyword}"`;
    }

    // ─── Personality / Customization ────────────────────────────────────

    case "update_personality": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("personality");
      // Schema field is `new_instructions` (tools.js); keep legacy fallbacks for
      // older history turns that used `instructions` / `text` / `personality`.
      const instructions = input.new_instructions || input.instructions || input.text || input.personality;
      if (!instructions) return "no personality instructions provided";
      const ok = await db.updatePersonality(instructions);
      audit(toolName, message, { instructions: instructions.substring(0, 200) }, ok ? "updated" : "failed");
      return ok ? "personality updated successfully" : "failed to update personality";
    }

    case "configure_game": {
      if (!isOwner(message.author.id)) return denyMessage();
      const { getGameConfig, setGameConfig, listGameConfig, resetGameConfig } = await import("../gambling.js");
      const game = (input.game || "").toLowerCase();
      const action = (input.action || "set").toLowerCase();
      if (action === "list" || game === "all") return listGameConfig();
      if (action === "reset") return resetGameConfig(game || "all");
      if (!input.setting) return `specify a setting to change. use action='list' to see all settings`;
      return setGameConfig(game, input.setting, input.value);
    }

    case "configure_slots": {
      if (!isOwner(message.author.id)) return denyMessage();
      const { addSlotSymbol, removeSlotSymbol, tweakSlotSymbol, listSlotSymbols, getSlotsConfig } = await import("../gambling.js");
      const action = (input.action || "").toLowerCase();
      if (action === "list" || action === "view") return listSlotSymbols();
      if (action === "add") {
        if (!input.emoji || !input.name) return "need emoji and name to add a symbol";
        return addSlotSymbol(input.emoji, input.name, input.weight || 10, input.tier || "junk");
      }
      if (action === "remove") {
        if (!input.name) return "need name of symbol to remove";
        return removeSlotSymbol(input.name);
      }
      if (action === "tweak" || action === "edit") {
        if (!input.name) return "need name of symbol to tweak";
        return tweakSlotSymbol(input.name, { weight: input.weight, tier: input.tier, emoji: input.emoji });
      }
      return `actions: list, add (emoji+name+weight+tier), remove (name), tweak (name+weight/tier/emoji).\n\nCurrent config:\n${listSlotSymbols()}`;
    }

    // ─── Database ───────────────────────────────────────────────────────

    case "query_database": {
      if (!isOwner(message.author.id)) return denyMessage();
      audit(toolName, message, { table: input.table, filter: input.query || input.filter }, "invoked");
      const supabase = db.getSupabase();
      if (!supabase) return "database not connected";
      try {
        const table = input.table;
        const filter = input.query || input.filter || "";
        const limit = input.limit || 20;
        if (!table) return "no table name provided";
        // Defense-in-depth: owner-gated already, but whitelist table names so
        // a prompt-injected tool call against the owner can't pivot into a
        // broader data dump. Keep this list aligned with list_tables below.
        const ALLOWED_TABLES = new Set([
          "eris_memories", "eris_facts", "eris_notes", "eris_reminders",
          "eris_snippets", "eris_mood", "eris_relationships", "eris_analytics",
          "eris_personality", "eris_news_watches", "eris_price_watches",
          "eris_deploy_watches", "eris_dreams", "local_commands",
          "eris_economy", "eris_inventory", "eris_pets", "eris_portfolios",
          "eris_stocks", "eris_daily_challenges", "eris_loans", "eris_bounties",
          "eris_marriages", "eris_heists", "eris_games", "eris_cooldowns",
          "eris_bump_joins", "eris_bumps", "bot_data",
        ]);
        if (!ALLOWED_TABLES.has(String(table))) {
          return `table "${table}" is not in the query whitelist. use list_tables to see options.`;
        }
        // `any`: this is a fully dynamic admin query (runtime table + filter
        // columns). Chaining typed PostgREST .eq()/.in() on it makes the filter
        // builder type recurse past TS's instantiation depth limit (TS2589).
        /** @type {any} */
        let q = supabase.from(table).select(input.select || "*").limit(limit);

        // Safe filtering: only allow whitelisted column names with .eq()
        const ALLOWED_COLUMNS = new Set([
          "user_id", "guild_id", "item_name", "type", "game_type", "date",
          "channel_id", "achievement_key", "challenge_type", "id", "status",
        ]);
        // Schema documents two shapes: a single column+value pair (`filter` as column
        // name + `filter_value`), or a `col=val,col=val` string. Accept both.
        if (filter && input.filter_value !== undefined && !filter.includes("=")) {
          if (!ALLOWED_COLUMNS.has(filter)) return `filter column "${filter}" not allowed. allowed: ${[...ALLOWED_COLUMNS].join(", ")}`;
          q = q.eq(filter, String(input.filter_value));
        } else if (filter) {
          const pairs = filter.split(",").map(s => s.trim()).filter(Boolean);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx === -1) return `invalid filter format — use "column=value" pairs separated by commas (e.g. "user_id=123,type=gamble") or pass filter+filter_value separately`;
            const col = pair.slice(0, eqIdx).trim();
            const val = pair.slice(eqIdx + 1).trim();
            if (!ALLOWED_COLUMNS.has(col)) return `filter column "${col}" not allowed. allowed: ${[...ALLOWED_COLUMNS].join(", ")}`;
            q = q.eq(col, val);
          }
        }

        const { data: rows, error } = await q;
        if (error) return `query error: ${error.message}`;
        return truncate(JSON.stringify(rows, null, 2));
      } catch (e) {
        return `database query failed: ${e.message}`;
      }
    }

    case "list_tables": {
      if (!isOwner(message.author.id)) return denyMessage();
      return [
        "eris_memories \u2014 conversation history",
        "eris_facts \u2014 remembered facts about users",
        "eris_notes \u2014 user notes",
        "eris_reminders \u2014 scheduled reminders",
        "eris_snippets \u2014 saved code snippets",
        "eris_mood \u2014 global mood state",
        "eris_relationships \u2014 user relationship data",
        "eris_analytics \u2014 tool usage analytics",
        "eris_personality \u2014 custom personality overrides",
        "eris_news_watches \u2014 tracked news topics",
        "eris_price_watches \u2014 tracked product prices",
        "eris_deploy_watches \u2014 monitored deployments",
        "eris_dreams \u2014 generated dream entries",
        "local_commands \u2014 queued local PC commands",
      ].join("\n");
    }

    // ─── Whitelist ──────────────────────────────────────────────────────

    case "whitelist_server": {
      if (!isOwner(message.author.id)) {
        log(`[WHITELIST] denied whitelist_server — author=${message.author.id} ownerId=${config.ownerId}`);
        return denyMessage();
      }
      let guildId = input.guild_id || input.server_id || "";
      let serverName = input.name || "Unknown";

      // Resolve invite links to guild IDs
      const inviteMatch = guildId.match(/discord\.gg\/([a-zA-Z0-9]+)/);
      if (inviteMatch) {
        try {
          const invite = await message.client.fetchInvite(inviteMatch[1]);
          guildId = invite.guild?.id;
          serverName = invite.guild?.name || serverName;
          if (!guildId) return "couldn't resolve that invite link \u2014 it might be expired or invalid";
        } catch (e) {
          return `couldn't resolve invite link: ${e.message}`;
        }
      }

      if (!guildId) return "need a guild/server ID or invite link";
      const ok = await db.addToWhitelist(guildId, { name: serverName });
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=8&scope=bot%20applications.commands`;
      return ok ? `server **${serverName}** (${guildId}) added to shared whitelist \u2014 both me and irene can stay there now\n\nuse this link to add me: ${inviteUrl}` : "failed to update whitelist";
    }

    case "unwhitelist_server": {
      if (!isOwner(message.author.id)) {
        log(`[WHITELIST] denied unwhitelist_server — author=${message.author.id} ownerId=${config.ownerId}`);
        return denyMessage();
      }
      const raw = String(input.guild_id || input.server_id || "").trim();
      if (!raw) return "need a guild/server ID or name";

      // Mirror Irene's behavior: try whitelist row first, fall back to current
      // memberships. Boss saying "unwhitelist X" means "kick the bot out of X"
      // even when X was never on the whitelist (e.g., grandfathered in via
      // boss-as-member at the gatekeep sweep).
      const wl = await db.getWhitelist();
      let targetId = null;
      let targetName = null;
      let wasOnWhitelist = false;

      if (/^\d{17,20}$/.test(raw)) {
        if (wl[raw]) { targetId = raw; targetName = wl[raw]?.name || "Unknown"; wasOnWhitelist = true; }
        else {
          const g = message.client.guilds.cache.get(raw);
          if (g) { targetId = raw; targetName = g.name; }
        }
      } else {
        const lower = raw.toLowerCase();
        const wlMatch = Object.entries(wl).find(([, info]) => (info?.name || "").toLowerCase().includes(lower));
        if (wlMatch) { targetId = wlMatch[0]; targetName = wlMatch[1]?.name || "Unknown"; wasOnWhitelist = true; }
        else {
          const g = [...message.client.guilds.cache.values()].find((x) => x.name?.toLowerCase().includes(lower));
          if (g) { targetId = g.id; targetName = g.name; }
        }
      }

      if (!targetId) return `nothing matching "${raw}" \u2014 not on the whitelist and not in any current server`;

      if (wasOnWhitelist) await db.removeFromWhitelist(targetId);

      const targetGuild = message.client.guilds.cache.get(targetId);
      if (targetGuild) {
        await targetGuild.leave().catch(() => {});
        return wasOnWhitelist
          ? `server **${targetName}** (${targetId}) removed from whitelist and left the server`
          : `left **${targetName}** (${targetId}) \u2014 wasn't on the whitelist, just kicked us out`;
      }
      return wasOnWhitelist
        ? `server **${targetName}** (${targetId}) removed from whitelist`
        : `nothing to do \u2014 \`${targetId}\` wasn't on the whitelist and we're not in that server`;
    }

    case "list_whitelist": {
      if (!isOwner(message.author.id)) {
        log(`[WHITELIST] denied list_whitelist — author=${message.author.id} ownerId=${config.ownerId}`);
        return denyMessage();
      }
      const wl = await db.getWhitelist();
      log(`[WHITELIST] list_whitelist read — ${Object.keys(wl).length} entries: [${Object.keys(wl).join(", ") || "(empty)"}]`);
      const entries = Object.entries(wl);
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=8&scope=bot%20applications.commands`;
      if (!entries.length) return `whitelist is empty \u2014 only servers where you're the owner are allowed\n\ninvite link: ${inviteUrl}`;
      const list = entries.map(([id, info]) => `${info.name || "Unknown"} (${id}) \u2014 added ${info.added_at || "unknown"}`).join("\n");
      return `${list}\n\ninvite link to add me to servers: ${inviteUrl}`;
    }

    // ─── Trust ──────────────────────────────────────────────────────────

    case "trust_user": {
      if (!isOwner(message.author.id)) return denyMessage();
      const userId = await _resolveUserSnowflake(input, message);
      if (!userId) return `couldn't find user "${input.user_id || input.username || ""}" \u2014 pass a Discord ID, mention, or exact username`;
      addTrustedUser(userId);
      audit(toolName, message, { user_id: userId }, "trusted");
      const user = message.client.users?.cache.get(userId);
      return `${user?.username || userId} is now trusted \u2014 they can customize my personality, avatar, name, etc`;
    }

    case "untrust_user": {
      if (!isOwner(message.author.id)) return denyMessage();
      const userId = await _resolveUserSnowflake(input, message);
      if (!userId) return `couldn't find user "${input.user_id || input.username || ""}" \u2014 pass a Discord ID, mention, or exact username`;
      removeTrustedUser(userId);
      audit(toolName, message, { user_id: userId }, "untrusted");
      const user = message.client.users?.cache.get(userId);
      return `${user?.username || userId} is no longer trusted`;
    }

    case "list_trusted": {
      if (!isOwner(message.author.id)) return denyMessage();
      const trusted = getTrustedUsers();
      if (!trusted.length) return "no trusted users \u2014 only you (the creator) have full access";
      const names = trusted.map(id => { const u = message.client.users?.cache.get(id); return u ? `${u.username} (${id})` : id; });
      return `trusted users: ${names.join(", ")}`;
    }

    // ─── Avatar / Banner / Name / Nickname ──────────────────────────────

    case "change_avatar": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("customize");
      try {
        const image = await fetchPersonalizationImage(input.image_url);
        await message.client.user.setAvatar(image.bytes);
        return "avatar updated successfully";
      } catch (e) {
        return `failed to change avatar: ${e.message}`;
      }
    }

    case "change_banner": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("customize");
      try {
        const image = await fetchPersonalizationImage(input.image_url);
        await message.client.user.setBanner(image.bytes);
        return "banner updated successfully";
      } catch (e) {
        return `failed to change banner: ${e.message}`;
      }
    }

    case "change_name": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("customize");
      try {
        await message.client.user.setUsername(input.name);
        return `username changed to "${input.name}"`;
      } catch (e) {
        return `failed to change name: ${e.message}`;
      }
    }

    case "change_nickname": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("customize");
      try {
        if (!message.guild) return "can only change nickname in a server";
        const me = await message.guild.members.fetchMe();
        await me.setNickname(input.nickname);
        // Also update per-server persona so personality and history labels match
        const currentPersona = db.getServerPersona(message.guild.id);
        db.setServerPersona(message.guild.id, input.nickname, currentPersona?.personality || null);
        return `nickname changed to "${input.nickname}" in this server \u2014 i'll go by that name here now`;
      } catch (e) {
        return `failed to change nickname: ${e.message}`;
      }
    }

    case "set_server_persona": {
      if (!canCustomize(message.author.id, message.guild)) return denyMessage("customize");
      if (!message.guild) return "can only set persona in a server";
      if (input.reset) {
        db.setServerPersona(message.guild.id, null, null);
        const me = await message.guild.members.fetchMe();
        await me.setNickname(null).catch(() => {});
        return "persona reset to default Eris";
      }
      const name = input.name || "Eris";
      const personality = input.personality || null;
      db.setServerPersona(message.guild.id, name, personality);
      try {
        const me = await message.guild.members.fetchMe();
        await me.setNickname(name);
      } catch {}
      return personality
        ? `i'm now **${name}** in this server with a custom personality`
        : `i'm now **${name}** in this server \u2014 same personality, new name`;
    }

    default:
      return undefined;
  }
}
