// ─── Leveling Executor ──────────────────────────────────────────────────────

const HANDLED = new Set([
  "set_level_reward", "remove_level_reward", "toggle_leveling",
  "set_level_channel", "set_level_ping_roles",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, findRole, findRoles } = ctx;

  switch (toolName) {
    case "set_level_reward": {
      const { setLevelReward } = await import("../../utils/leveling.js");
      const role = findRole(guild, input.role_name);
      if (!role) return `couldn't find role "${input.role_name}"`;
      setLevelReward(guild.id, input.level, role.id);
      return `set level ${input.level} reward to ${role.name}`;
    }

    case "remove_level_reward": {
      const { removeLevelReward } = await import("../../utils/leveling.js");
      removeLevelReward(guild.id, input.level);
      return `removed level ${input.level} reward`;
    }

    case "toggle_leveling": {
      const { setLevelSettings, getLevelSettings } = await import("../../utils/leveling.js");
      const current = getLevelSettings(guild.id);
      setLevelSettings(guild.id, { ...current, enabled: input.enabled });
      return `leveling ${input.enabled ? "enabled" : "disabled"}`;
    }

    case "set_level_channel": {
      const { setLevelSettings, getLevelSettings } = await import("../../utils/leveling.js");
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `couldn't find channel "${input.channel_name}"`;
      const current = getLevelSettings(guild.id);
      setLevelSettings(guild.id, { ...current, announceChannel: ch.id });
      return `level-up announcements set to #${ch.name}`;
    }

    case "set_level_ping_roles": {
      const { setLevelSettings, getLevelSettings } = await import("../../utils/leveling.js");
      const current = getLevelSettings(guild.id);
      if (input.ping_roles.toLowerCase() === "none") {
        setLevelSettings(guild.id, { ...current, ping_role_ids: [] });
        return "Level-up ping roles cleared — no roles will be pinged on level-up.";
      }
      const roleIds = findRoles(guild, input.ping_roles);
      if (!roleIds.length) return `No roles found matching "${input.ping_roles}"`;
      setLevelSettings(guild.id, { ...current, ping_role_ids: roleIds });
      const roleNames = roleIds.map((id) => guild.roles.cache.get(id)?.name ?? id);
      return `Level-up ping roles set to: ${roleNames.map((n) => `@${n}`).join(", ")}`;
    }
  }
}
