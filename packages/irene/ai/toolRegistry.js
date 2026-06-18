// ai/toolRegistry.js — Two-tier tool loading system
// Tier 1: Full schemas sent as API tools parameter (bounded most relevant)
// Tier 2: Compact grouped name catalog in system prompt (everything else)
// The AI can call ANY tool by name — the executor dispatches regardless of tier.

import { log } from "../utils/logger.js";

// ─── Tier-1 cap ─────────────────────────────────────────────────────────────
// Hard ceiling on full schemas sent per turn (the always-include core may
// exceed it — see the floor in selectByMessage — so core tools are never
// silently dropped). Override with TOOLS_TIER1_MAX: local 14B deployments
// want 16–20; hosted defaults to 32 (the previous hardcoded value — no
// behavior change when unset). Read once at module init.
const _tier1MaxEnv = parseInt(process.env.TOOLS_TIER1_MAX || "", 10);
export const MAX_TIER1_TOOLS =
  Number.isInteger(_tier1MaxEnv) && _tier1MaxEnv > 0 ? _tier1MaxEnv : 32;

/**
 * Channel key shape consumed by Irene two-tier selection.
 * Server turns are keyed by guild+user; DMs are per-user.
 * @param {any} message
 * @returns {string|null}
 */
export function channelKeyFor(message) {
  if (!message) return null;
  const userId = message.author?.id || "unknown";
  return message.guild ? `${message.guild.id}-${userId}` : `dm-${userId}`;
}

class ToolRegistry {
  constructor() {
    this._tools = new Map();           // name -> full tool definition
    this._categories = new Map();      // category -> { names: string[], keywords: RegExp }
    this._toolCategories = new Map();  // name -> category
    this._alwaysInclude = new Set();   // tool names always in Tier 1
    this._recentUsage = new Map();     // channelKey -> [toolName, toolName, ...]
    this._maxRecent = 10;
  }

  // ─── Registration ───

  registerTools(tools, category, keywordPattern) {
    if (!this._categories.has(category)) {
      this._categories.set(category, { names: [], keywords: keywordPattern || null });
    }
    const cat = this._categories.get(category);
    for (const tool of tools) {
      this._tools.set(tool.name, tool);
      if (!this._toolCategories.has(tool.name) || category !== "always_include") {
        this._toolCategories.set(tool.name, category);
      }
      if (!cat.names.includes(tool.name)) cat.names.push(tool.name);
    }
  }

  registerAlwaysInclude(names) {
    for (const n of names) this._alwaysInclude.add(n);
  }

  // ─── Selection ───

  /**
   * @param {string} text
   * @param {{ isAdmin?: boolean, channelKey?: string|null, adminTools?: Array<{name: string, description?: string}>, everyoneTools?: Array<{name: string, description?: string}> }} [opts]
   * @returns {{ tier1: any[], tier2Catalog: string, tier2Names: string[] }}
   */
  selectByMessage(text, { isAdmin = false, channelKey = null, adminTools = [], everyoneTools = [] } = {}) {
    const lower = (text || "").toLowerCase();
    const scores = new Map();
    const bumpScore = (name, score) => {
      scores.set(name, Math.max(scores.get(name) || 0, score));
    };

    for (const name of this._alwaysInclude) bumpScore(name, 1000);

    // Add tools from categories whose keywords match
    for (const [, cat] of this._categories) {
      if (cat.keywords && cat.keywords.test(lower)) {
        for (const name of cat.names) bumpScore(name, 700);
      }
    }

    // Boost recently used tools in this channel
    if (channelKey) {
      const recent = this._recentUsage.get(channelKey);
      if (recent) {
        for (let i = 0; i < recent.length; i++) {
          const name = recent[i];
          if (this._tools.has(name)) {
            bumpScore(name, 900 - i);
          }
        }
      }
    }

    // Determine which tools the user has access to
    const accessibleNames = new Set();
    if (isAdmin) {
      for (const t of adminTools) accessibleNames.add(t.name);
    }
    for (const t of everyoneTools) accessibleNames.add(t.name);

    const accessible = [...accessibleNames]
      .map((name, index) => ({ name, index, tool: this._tools.get(name) }))
      .filter((entry) => entry.tool);
    const alwaysAccessible = accessible.filter((entry) => this._alwaysInclude.has(entry.name));
    const tier1Limit = Math.max(MAX_TIER1_TOOLS, alwaysAccessible.length);
    const ranked = accessible
      .filter((entry) => scores.has(entry.name))
      .sort((a, b) => {
        const scoreDelta = (scores.get(b.name) || 0) - (scores.get(a.name) || 0);
        return scoreDelta || a.index - b.index;
      });
    const tier1NameSet = new Set(ranked.slice(0, tier1Limit).map((entry) => entry.name));

    this._shadowLogCaps(ranked, alwaysAccessible.length, tier1NameSet);

    // Split into tiers. Tier 1 is bounded to keep per-turn schema volume
    // predictable; any relevant tools beyond the cap remain reachable by exact
    // name through Tier 2.
    const tier1 = [];
    const tier2ByCategory = new Map();
    const tier2Names = [];

    for (const { name, tool } of accessible) {
      if (tier1NameSet.has(name)) {
        tier1.push(tool);
      } else {
        const category = this._toolCategories.get(name) || "other";
        if (!tier2ByCategory.has(category)) tier2ByCategory.set(category, []);
        tier2ByCategory.get(category).push(name);
        tier2Names.push(name);
      }
    }

    // Build a compact catalog for the system prompt. Exact names are enough for
    // dispatch and preserve the reachability invariant without spending a line
    // of description tokens on every demoted tool.
    const tier2Lines = [...tier2ByCategory]
      .map(([category, names]) => `- ${category}: ${names.join(", ")}`);
    const tier2Catalog = tier2Lines.length > 0
      ? `\n\nOTHER AVAILABLE TOOLS (call these through use_tool with {tool_name, arguments}; schemas are omitted here to save tokens):\n${tier2Lines.join("\n")}`
      : "";

    return { tier1, tier2Catalog, tier2Names };
  }

  // ─── Shadow cap telemetry ───

  /**
   * When TOOLS_SHADOW_LOG is truthy, log what Tier-1 caps of 16 and 20 WOULD
   * have dropped from this selection (tool names) — rollout telemetry for
   * tuning TOOLS_TIER1_MAX. Zero behavior change: the selection itself is
   * untouched and nothing is logged when the env is unset. The always-include
   * floor applies to the hypothetical caps too, mirroring the real cap.
   * @param {Array<{ name: string }>} ranked
   * @param {number} alwaysCount
   * @param {Set<string>} tier1NameSet
   */
  _shadowLogCaps(ranked, alwaysCount, tier1NameSet) {
    if (!process.env.TOOLS_SHADOW_LOG) return;
    const droppedAt = (cap) => {
      const kept = new Set(
        ranked.slice(0, Math.max(cap, alwaysCount)).map((entry) => entry.name)
      );
      return ranked
        .filter((entry) => tier1NameSet.has(entry.name) && !kept.has(entry.name))
        .map((entry) => entry.name);
    };
    const drop16 = droppedAt(16);
    const drop20 = droppedAt(20);
    log(
      `[REGISTRY] shadow-cap tier1=${tier1NameSet.size} ` +
      `cap16-drops(${drop16.length})=[${drop16.join(", ")}] ` +
      `cap20-drops(${drop20.length})=[${drop20.join(", ")}]`
    );
  }

  // ─── Usage tracking ───

  trackUsage(channelKey, toolName) {
    if (!channelKey) return;
    let recent = this._recentUsage.get(channelKey);
    if (!recent) {
      recent = [];
      this._recentUsage.set(channelKey, recent);
    }
    // Move to front, dedup
    const idx = recent.indexOf(toolName);
    if (idx !== -1) recent.splice(idx, 1);
    recent.unshift(toolName);
    if (recent.length > this._maxRecent) recent.pop();

    // Prune old channels if map grows too large
    if (this._recentUsage.size > 1000) {
      const keys = [...this._recentUsage.keys()];
      for (let i = 0; i < 200; i++) this._recentUsage.delete(keys[i]);
    }
  }

  // ─── Lookup ───

  getToolByName(name) {
    return this._tools.get(name) || null;
  }

  getDeclaration(name) {
    return this.getToolByName(name);
  }

  getAllToolNames() {
    return [...this._tools.keys()];
  }

  getStats() {
    return {
      totalTools: this._tools.size,
      categories: this._categories.size,
      alwaysInclude: this._alwaysInclude.size,
    };
  }
}

// ─── Singleton ───
export const registry = new ToolRegistry();

// ─── Category Registration (called from tools.js) ───

export function registerPresenceBotTools(ADMIN_TOOLS, EVERYONE_TOOLS) {
  // ── Always-include (core tools available to everyone) ──
  const alwaysInclude = [
    "remember_fact", "recall_memories", "forget_fact", "forget_all",
    "send_gif", "show_image", "send_file", "edit_image", "web_search", "scrape_url", "calculate", "snipe", "editsnipe",
    "ask_eris", "set_reminder", "cancel_reminder",
  ];
  registry.registerAlwaysInclude(alwaysInclude);
  registry.registerTools(
    [...ADMIN_TOOLS, ...EVERYONE_TOOLS].filter(t => alwaysInclude.includes(t.name)),
    "always_include",
    null
  );

  // ── Admin tool categories with keyword triggers ──

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "create_channel", "delete_channel", "nuke_channel", "rename_channel",
      "set_channel_topic", "set_slowmode", "lock_channel", "unlock_channel",
      "move_channel", "clone_channel", "set_channel_permissions",
      "create_category", "delete_category",
    ].includes(t.name)),
    "channel_mgmt",
    /\b(create|delete|nuke|rename|topic|slowmode|lock|unlock|move|clone|channel|category|permissions?)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "set_role_permissions", "create_role", "delete_role", "edit_role",
      "reorder_roles", "give_role", "remove_role", "mass_role",
      "setup_reaction_roles", "add_reaction_role", "remove_reaction_role",
      "setup_role_picker", "setup_dropdown_roles", "setup_color_roles",
      "toggle_seasonal_colors", "preview_seasonal_palette", "force_seasonal_rotation",
      "set_ghost_ping_channels",
    ].includes(t.name)),
    "role_mgmt",
    /\b(role|assign|give role|remove role|reaction role|color role|role picker|dropdown|select menu|reorder|mass role|make me|promote|grant|admin|moderator|\bmod\b|staff|hoist)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "ban_user", "kick_user", "warn_user", "timeout_user",
      "lockdown_server", "unlock_server", "find_message",
      "purge_messages", "set_nickname", "move_user_to_voice",
      "disconnect_user_from_voice", "tempban",
    ].includes(t.name)),
    "moderation",
    /\b(ban|kick|warn|timeout|mute|purge|delete messages?|clean|nuke|lockdown|find message|nickname|move.*voice|disconnect|tempban|temp.?ban|boot|yeet|silence|gag|jail)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "set_welcome_channel", "customize_welcome", "set_access_role",
      "setup_verification", "trust_user", "untrust_user", "list_trusted",
      "set_log_channel", "set_autorole", "whitelist_server", "unwhitelist_server",
      "list_whitelist", "set_dm_results", "set_dm_welcome", "set_leave_channel",
      "set_server_avatar", "set_server_banner", "set_server_persona",
      "set_channel_personality", "set_bad_words", "set_escalation",
      "setup_stats_channels", "setup_starboard", "toggle_auto_responders",
      "toggle_twin_chat", "toggle_voice_tracking", "setup_ticket",
      "configure_suggestions", "sticky_message", "remove_sticky",
      "toggle_invite_filter",
    ].includes(t.name)),
    "server_config",
    /\b(welcome|verify|verification|trust|log|autorole|whitelist|dm result|leave|avatar|banner|persona|personality|bad words?|escalat|stats|starboard|auto.?respond|twin|voice track|ticket|suggest|sticky|invite.?filter)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "configure_patch_news", "configure_twitch", "configure_youtube",
      "configure_github", "configure_giveaway_pings", "test_patch_news",
    ].includes(t.name)),
    "notifications",
    /\b(patch|twitch|youtube|github|giveaway|notif|feed|stream|news)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "toggle_tts", "set_tts_voice", "say_tts", "toggle_voice_listen",
    ].includes(t.name)),
    "voice_admin",
    /\b(tts|text.?to.?speech|voice listen|wake word)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "self_repair",
    ].includes(t.name)),
    "self_repair",
    /\b(self.?repair|auto.?fix|bug|broken|having problems|fix yourself|patch yourself|diagnose yourself|restart yourself|codebase|tests?)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "configure_birthdays", "send_test_birthday", "send_test_welcome",
    ].includes(t.name)),
    "birthday_admin",
    /\b(birthday|bday)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "set_create_vc_channel", "set_vc_template", "set_vc_default_limit",
      "set_vc_naming_mode", "toggle_vc_rich_presence", "set_afk_channel",
    ].includes(t.name)),
    "dynamic_vc",
    /\b(vc|voice channel|dynamic|afk|naming mode|rich presence)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "send_message", "create_thread", "add_emoji", "remove_emoji",
      "create_invite", "create_custom_command", "edit_custom_command",
      "delete_custom_command", "list_custom_commands",
      "create_auto_responder", "list_auto_responders", "delete_auto_responder",
      "manage_giveaway", "manage_scrim",
      "edit_message", "delete_message", "read_messages", "search_messages",
      "pin_message", "unpin_message", "list_pins",
      "react_to_message", "remove_reaction",
    ].includes(t.name)),
    "message_mgmt",
    /\b(send message|thread|emoji|invite|custom command|auto.?respond|giveaway|scrim|edit message|read message|search message|pin|unpin|react|reaction)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "list_invites", "delete_invite", "invite_stats", "set_server_settings",
      "set_server_icon", "view_audit_log", "list_members",
    ].includes(t.name)),
    "server_mgmt",
    /\b(invite|server setting|verification|content filter|notification|afk|server icon|audit|log|member list|list members)\b/i
  );

  registry.registerTools(
    ADMIN_TOOLS.filter(t => [
      "set_level_reward", "remove_level_reward", "toggle_leveling",
      "set_level_channel", "set_level_ping_roles", "voice_leaderboard",
      "server_milestones",
    ].includes(t.name)),
    "leveling",
    /\b(level|xp|reward|leaderboard|milestone)\b/i
  );

  // ── Everyone tool categories ──

  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "play_music", "skip_song", "stop_music", "pause_music", "resume_music",
      "music_queue", "now_playing", "set_volume", "toggle_loop",
      "shuffle_queue", "music_filter",
    ].includes(t.name)),
    "music",
    /\b(play|skip|stop|pause|resume|queue|volume|loop|shuffle|filter|song|music|now.?playing|soundboard)\b/i
  );

  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "set_birthday", "get_birthday", "list_birthdays", "remove_birthday",
    ].includes(t.name)),
    "birthday",
    /\b(birthday|bday)\b/i
  );

  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "vc_info", "vc_private", "vc_public", "vc_lock", "vc_unlock",
      "vc_rename", "vc_transfer", "vc_kick", "vc_allow", "vc_claim",
    ].includes(t.name)),
    "temp_vc",
    /\b(vc|voice|private|public|lock|unlock|rename|transfer|kick|allow|claim)\b/i
  );

  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "get_server_info", "get_user_info", "list_channels", "list_roles",
      "get_role_permissions", "list_emojis", "list_bans", "random_member",
      "count_members", "who_has_role",
    ].includes(t.name)),
    "info",
    /\b(server info|user info|list channels?|list roles?|permissions?|emojis?|bans?|random member|count|who has)\b/i
  );

  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "set_gif_style", "set_dm_preference", "generate_image",
      "summarize_channel",
    ].includes(t.name)),
    "utility",
    /\b(gif style|dm prefer|generate|image|summarize|summary)\b/i
  );

  // Register any remaining tools that weren't categorized
  const registered = new Set();
  for (const [, cat] of registry._categories) {
    for (const n of cat.names) registered.add(n);
  }
  for (const n of registry._alwaysInclude) registered.add(n);

  const uncategorizedAdmin = ADMIN_TOOLS.filter(t => !registered.has(t.name));
  if (uncategorizedAdmin.length > 0) {
    registry.registerTools(uncategorizedAdmin, "other_admin", null);
  }

  const uncategorizedEveryone = EVERYONE_TOOLS.filter(t => !registered.has(t.name));
  if (uncategorizedEveryone.length > 0) {
    registry.registerTools(uncategorizedEveryone, "other_everyone", null);
  }

  const stats = registry.getStats();
  log(`[REGISTRY] ${stats.totalTools} tools registered across ${stats.categories} categories (${stats.alwaysInclude} always-included)`);
}
