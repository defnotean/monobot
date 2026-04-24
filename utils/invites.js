// ─── Invite Tracking ──────────────────────────────────────────────────────────
// Caches invite use counts per guild so we can detect which invite was used
// when a member joins.

import { log } from "./logger.js";

// guildId → Map(code → { uses, inviter, channel })
export const guildInvites = new Map();

export async function cacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    for (const invite of invites.values()) {
      map.set(invite.code, {
        uses: invite.uses ?? 0,
        inviter: invite.inviter,
        channel: invite.channel,
        maxUses: invite.maxUses,
      });
    }
    guildInvites.set(guild.id, map);
  } catch (err) {
    log(`[Invites] Failed to cache invites for "${guild.name}": ${err.message}`);
  }
}

export async function findUsedInvite(guild) {
  try {
    const cached = guildInvites.get(guild.id) ?? new Map();
    const fresh = await guild.invites.fetch();

    for (const invite of fresh.values()) {
      const old = cached.get(invite.code);
      if (!old) {
        // Brand-new invite that was used on first use
        if ((invite.uses ?? 0) > 0) {
          return invite;
        }
        continue;
      }
      if ((invite.uses ?? 0) > (old.uses ?? 0)) {
        return invite;
      }
    }

    // Check vanity URL if guild has one
    try {
      const vanity = await guild.fetchVanityData();
      if (vanity?.uses !== undefined) {
        const cachedVanity = cached.get("VANITY");
        if (!cachedVanity || vanity.uses > cachedVanity.uses) {
          return { code: guild.vanityURLCode ?? "VANITY", uses: vanity.uses, inviter: null, channel: null };
        }
      }
    } catch {}

    return null;
  } catch (err) {
    log(`[Invites] findUsedInvite error for "${guild.name}": ${err.message}`);
    return null;
  }
}

export async function refreshInvites(guild) {
  await cacheInvites(guild);
}
