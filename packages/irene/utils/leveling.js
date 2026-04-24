// ─── XP/Leveling Engine ─────────────────────────────────────────────────────
// In-memory store with JSON backup structure. No database imports.

const levelData = {
  users: {},        // guildId -> userId -> { xp, totalXp }
  lastXpTime: {},   // guildId -> userId -> timestamp
  rewards: {},      // guildId -> level -> roleId
  settings: {},     // guildId -> { enabled, announceChannel, xpPerMessage, xpCooldownMs, xpPerVcMinute }
  multipliers: {},  // guildId -> { global: num, roles: { roleId: num }, weekends: num }
};

// ─── XP Formula ──────────────────────────────────────────────────────────────
export function xpNeededForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function getLevelFromXp(totalXp) {
  let level = 0;
  let xpUsed = 0;
  while (true) {
    const needed = xpNeededForLevel(level + 1);
    if (xpUsed + needed > totalXp) break;
    xpUsed += needed;
    level++;
  }
  return level;
}

// ─── Initialize ──────────────────────────────────────────────────────────────
export function initLevelData(loaded) {
  if (!loaded) return;
  if (loaded.users) levelData.users = loaded.users;
  if (loaded.lastXpTime) levelData.lastXpTime = loaded.lastXpTime;
  if (loaded.rewards) levelData.rewards = loaded.rewards;
  if (loaded.settings) levelData.settings = loaded.settings;
  if (loaded.multipliers) levelData.multipliers = loaded.multipliers;
}

export function getLevelData() {
  return JSON.parse(JSON.stringify(levelData));
}

// ─── User XP Management ──────────────────────────────────────────────────────

export function addXp(guildId, userId, amount, member = null) {
  // Initialize if needed
  if (!levelData.users[guildId]) levelData.users[guildId] = {};
  if (!levelData.lastXpTime[guildId]) levelData.lastXpTime[guildId] = {};

  // Get current time and check cooldown
  const now = Date.now();
  const lastTime = levelData.lastXpTime[guildId][userId] || 0;
  const settings = levelData.settings[guildId] || {};
  const cooldownMs = settings.xpCooldownMs || 60000; // default 60 seconds

  if (now - lastTime < cooldownMs) {
    return null; // cooldown active, no XP added
  }

  // Calculate multiplier
  let multiplier = 1;
  const guildMultipliers = levelData.multipliers[guildId] || {};

  // Global multiplier
  if (guildMultipliers.global) {
    multiplier *= guildMultipliers.global;
  }

  // Weekend multiplier
  const day = new Date().getDay();
  if ((day === 0 || day === 6) && guildMultipliers.weekends) {
    multiplier *= guildMultipliers.weekends;
  }

  // Role-based multiplier — pick the BEST applicable role so users with
  // multiple XP roles get their strongest bonus instead of whichever role
  // happened to come first in the cache iteration order.
  if (member && guildMultipliers.roles) {
    let bestRoleMult = 1;
    for (const roleId of member.roles.cache.keys()) {
      const m = guildMultipliers.roles[roleId];
      if (m && m > bestRoleMult) bestRoleMult = m;
    }
    multiplier *= bestRoleMult;
  }

  const finalAmount = Math.floor(amount * multiplier);

  // Update user data
  const user = levelData.users[guildId][userId] || { totalXp: 0 };
  const oldLevel = getLevelFromXp(user.totalXp);

  user.totalXp += finalAmount;

  // Recalculate XP for current level
  const newLevel = getLevelFromXp(user.totalXp);
  let xpForCurrentLevel = 0;
  for (let i = 0; i < newLevel; i++) {
    xpForCurrentLevel += xpNeededForLevel(i + 1);
  }
  user.xp = user.totalXp - xpForCurrentLevel;

  levelData.users[guildId][userId] = user;
  levelData.lastXpTime[guildId][userId] = now;

  const xpNeeded = xpNeededForLevel(newLevel + 1);
  const leveledUp = newLevel > oldLevel;

  return {
    level: newLevel,
    leveledUp,
    xp: user.xp,
    xpNeeded,
    xpGained: finalAmount,
    multiplier,
  };
}

export function getXpData(guildId, userId) {
  if (!levelData.users[guildId] || !levelData.users[guildId][userId]) {
    return { xp: 0, level: 0, totalXp: 0 };
  }

  const user = levelData.users[guildId][userId];
  const level = getLevelFromXp(user.totalXp);

  // Calculate XP for current level
  let xpForCurrentLevel = 0;
  for (let i = 0; i < level; i++) {
    xpForCurrentLevel += xpNeededForLevel(i + 1);
  }
  const xp = user.totalXp - xpForCurrentLevel;

  return {
    xp,
    level,
    totalXp: user.totalXp,
  };
}

// ─── Leaderboard ────────────────────────────────────────────────────────────

export function getLeaderboard(guildId, limit = 10) {
  if (!levelData.users[guildId]) return [];

  const users = Object.entries(levelData.users[guildId]).map(([userId, user]) => {
    const level = getLevelFromXp(user.totalXp);
    return { userId, xp: user.totalXp - getLevelForXpCalc(user.totalXp), level, totalXp: user.totalXp };
  });

  return users.sort((a, b) => b.totalXp - a.totalXp).slice(0, limit);
}

function getLevelForXpCalc(totalXp) {
  let xpUsed = 0;
  let level = 0;
  while (true) {
    const needed = xpNeededForLevel(level + 1);
    if (xpUsed + needed > totalXp) break;
    xpUsed += needed;
    level++;
  }
  return xpUsed;
}

// ─── Rewards ────────────────────────────────────────────────────────────────

export function getLevelRewards(guildId) {
  if (!levelData.rewards[guildId]) return [];
  return Object.entries(levelData.rewards[guildId]).map(([level, roleId]) => ({
    level: parseInt(level),
    roleId,
  })).sort((a, b) => a.level - b.level);
}

export function setLevelReward(guildId, level, roleId, guild = null) {
  if (!levelData.rewards[guildId]) levelData.rewards[guildId] = {};

  // Validate role exists in guild if guild provided
  if (guild) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return { success: false, error: "Role not found in this guild" };
    }
  }

  levelData.rewards[guildId][level] = roleId;
  return { success: true };
}

export function removeLevelReward(guildId, level) {
  if (!levelData.rewards[guildId]) return;
  delete levelData.rewards[guildId][level];
}

/**
 * Give reward roles to a user based on their level
 * Validates roles exist before applying
 */
export async function applyLevelRewards(member, guildId, level, guild) {
  const rewards = getLevelRewards(guildId);
  const rewardsForLevel = rewards.filter((r) => r.level <= level);

  for (const reward of rewardsForLevel) {
    // Validate role still exists
    const role = guild.roles.cache.get(reward.roleId);
    if (!role) {
      continue; // Skip if role was deleted
    }

    // Skip if member already has role
    if (member.roles.cache.has(reward.roleId)) {
      continue;
    }

    try {
      await member.roles.add(reward.roleId);
    } catch (err) {
      // Log but continue with other rewards
      console.error(`Failed to add reward role to ${member.user.tag}:`, err.message);
    }
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function getLevelSettings(guildId) {
  return levelData.settings[guildId] || {
    enabled: false,
    announceChannel: null,
    xpPerMessage: 10,
    xpCooldownMs: 60000,
    xpPerVcMinute: 5,
  };
}

export function setLevelSettings(guildId, settings) {
  levelData.settings[guildId] = {
    ...getLevelSettings(guildId),
    ...settings,
  };
}

// ─── Multipliers ────────────────────────────────────────────────────────────

export function getMultipliers(guildId) {
  return levelData.multipliers[guildId] || {
    global: 1,
    roles: {},
    weekends: 1,
  };
}

export function setGlobalMultiplier(guildId, multiplier) {
  if (!levelData.multipliers[guildId]) levelData.multipliers[guildId] = {};
  levelData.multipliers[guildId].global = Math.max(0.1, multiplier);
}

export function setRoleMultiplier(guildId, roleId, multiplier, guild = null) {
  // Validate role exists if guild provided
  if (guild) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return { success: false, error: "Role not found" };
    }
  }

  if (!levelData.multipliers[guildId]) levelData.multipliers[guildId] = {};
  if (!levelData.multipliers[guildId].roles) levelData.multipliers[guildId].roles = {};

  levelData.multipliers[guildId].roles[roleId] = Math.max(0.1, multiplier);
  return { success: true };
}

export function removeRoleMultiplier(guildId, roleId) {
  if (levelData.multipliers[guildId]?.roles) {
    delete levelData.multipliers[guildId].roles[roleId];
  }
}

export function setWeekendMultiplier(guildId, multiplier) {
  if (!levelData.multipliers[guildId]) levelData.multipliers[guildId] = {};
  levelData.multipliers[guildId].weekends = Math.max(0.1, multiplier);
}

// ─── Admin Functions ────────────────────────────────────────────────────────

export function resetUserXp(guildId, userId) {
  if (!levelData.users[guildId] || !levelData.users[guildId][userId]) {
    return { success: false, error: "User not found" };
  }
  delete levelData.users[guildId][userId];
  if (levelData.lastXpTime[guildId]) {
    delete levelData.lastXpTime[guildId][userId];
  }
  return { success: true };
}

export function setUserLevel(guildId, userId, level) {
  if (!levelData.users[guildId]) levelData.users[guildId] = {};

  // Calculate totalXp needed for that level
  let totalXp = 0;
  for (let i = 1; i <= level; i++) {
    totalXp += xpNeededForLevel(i);
  }

  // Initialize user if needed
  if (!levelData.users[guildId][userId]) {
    levelData.users[guildId][userId] = { totalXp: 0 };
  }

  const user = levelData.users[guildId][userId];
  user.totalXp = totalXp;

  // Recalculate current level XP
  let xpForCurrentLevel = 0;
  for (let i = 0; i < level; i++) {
    xpForCurrentLevel += xpNeededForLevel(i + 1);
  }
  user.xp = totalXp - xpForCurrentLevel;

  return { success: true, totalXp, level };
}

// ─── Rank Info ──────────────────────────────────────────────────────────────

export function getGuildRank(guildId, userId) {
  if (!levelData.users[guildId]) return 0;

  const users = Object.entries(levelData.users[guildId])
    .map(([uid, user]) => ({ userId: uid, totalXp: user.totalXp }))
    .sort((a, b) => b.totalXp - a.totalXp);

  const rank = users.findIndex((u) => u.userId === userId) + 1;
  return rank > 0 ? rank : 0;
}

export function getTotalUsers(guildId) {
  return Object.keys(levelData.users[guildId] || {}).length;
}
