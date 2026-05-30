// ─── Server Whitelist Executor (bot-owner only) ─────────────────────────────
//
// Controls which guilds the bot is allowed to stay in. Every tool here is gated
// to config.ownerId — the bot owner is the only one who can add/remove/view the
// whitelist. unwhitelist_server also leaves the guild (kicks the bot out).

import { addToWhitelist, removeFromWhitelist, getWhitelist } from "../../database.js";
import config from "../../config.js";
import { log } from "../../utils/logger.js";

const HANDLED = new Set([
  "whitelist_server", "unwhitelist_server", "list_whitelist",
]);

export async function execute(toolName, input, message, _ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {
    case "whitelist_server": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied whitelist_server — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can manage the whitelist.";
      }
      const raw = input.invite_or_id?.trim();
      if (!raw) return "Provide a Discord invite link or guild ID.";

      const inviteMatch = raw.match(/(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/);
      const code = inviteMatch?.[1];

      if (code) {
        try {
          const invite = await Promise.race([
            message.client.fetchInvite(code),
            new Promise((_, reject) => setTimeout(() => reject(new Error("invite lookup timed out after 10s")), 10_000)),
          ]);
          const g = invite.guild;
          if (!g) return "Couldn't resolve a server from that invite.";

          await addToWhitelist(g.id, {
            name:       g.name,
            icon_url:   g.iconURL?.({ size: 128 }) ?? null,
            members:    invite.memberCount ?? g.memberCount ?? null,
            invited_by: message.author.id,
          });

          return [
            `✅ **${g.name}** added to whitelist`,
            `ID: \`${g.id}\``,
            invite.memberCount ? `Members: ~${invite.memberCount}` : null,
            `The bot can now join this server.`,
          ].filter(Boolean).join("\n");
        } catch (err) {
          return `Couldn't resolve that invite — ${err.message}. Make sure it's a valid, non-expired invite.`;
        }
      }

      if (/^\d{17,20}$/.test(raw)) {
        const existingGuild = message.client.guilds.cache.get(raw);
        await addToWhitelist(raw, {
          name:       existingGuild?.name ?? "Unknown (ID-only)",
          icon_url:   existingGuild?.iconURL?.({ size: 128 }) ?? null,
          members:    existingGuild?.memberCount ?? null,
          invited_by: message.author.id,
        });
        return `✅ Guild \`${raw}\`${existingGuild ? ` (**${existingGuild.name}**)` : ""} added to whitelist.`;
      }

      return "That doesn't look like a Discord invite or guild ID. Send something like `discord.gg/abc123` or a numeric guild ID.";
    }

    case "unwhitelist_server": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied unwhitelist_server — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can manage the whitelist.";
      }
      const raw = input.guild_id?.trim();
      if (!raw) return "Provide a guild ID or server name.";

      // Resolve target — first try the whitelist data, then fall back to
      // current guild memberships. Boss's intent on "unwhitelist X" is
      // usually "kick the bot out of X"; if X isn't on the whitelist but
      // the bot is sitting in it (often because boss is a member, which
      // bypasses the gatekeep at events/ready.js), still leave it.
      let targetId = null;
      let targetName = null;
      let wasOnWhitelist = false;

      const wl = await getWhitelist();
      if (/^\d{17,20}$/.test(raw)) {
        if (wl[raw]) { targetId = raw; targetName = wl[raw].name; wasOnWhitelist = true; }
        else {
          const g = message.client.guilds.cache.get(raw);
          if (g) { targetId = raw; targetName = g.name; }
        }
      } else {
        const lower = raw.toLowerCase();
        const wlMatch = Object.entries(wl).find(([, info]) => info.name?.toLowerCase().includes(lower));
        if (wlMatch) { targetId = wlMatch[0]; targetName = wlMatch[1].name; wasOnWhitelist = true; }
        else {
          const g = [...message.client.guilds.cache.values()].find((x) => x.name?.toLowerCase().includes(lower));
          if (g) { targetId = g.id; targetName = g.name; }
        }
      }

      if (!targetId) return `No whitelisted server matching "${raw}", and the bot isn't in any server with that name/ID.`;

      if (wasOnWhitelist) await removeFromWhitelist(targetId);

      const targetGuild = message.client.guilds.cache.get(targetId);
      if (targetGuild) {
        await targetGuild.leave().catch(() => {});
        return wasOnWhitelist
          ? `✅ **${targetName}** (\`${targetId}\`) removed from whitelist and left the server.`
          : `✅ Left **${targetName}** (\`${targetId}\`). It wasn't on the whitelist, just kicked the bot out.`;
      }
      return wasOnWhitelist
        ? `✅ **${targetName}** (\`${targetId}\`) removed from whitelist.`
        : `Nothing to do — \`${targetId}\` wasn't on the whitelist and the bot isn't in that server.`;
    }

    case "list_whitelist": {
      if (message.author.id !== config.ownerId) {
        log(`[WHITELIST] denied list_whitelist — author=${message.author.id} userId=${config.ownerId}`);
        return "Only the bot owner can view the whitelist.";
      }
      const wl = await getWhitelist();
      log(`[WHITELIST] list_whitelist read — ${Object.keys(wl).length} entries: [${Object.keys(wl).join(", ") || "(empty)"}]`);
      const entries = Object.entries(wl);
      if (!entries.length) return "Whitelist is empty — the bot will only stay in servers you're a member of.";

      const lines = entries.map(([id, info]) => {
        const inGuild = message.client.guilds.cache.has(id);
        const status = inGuild ? "✅ joined" : "⏳ not joined yet";
        return `**${info.name}** — \`${id}\` — ${status}${info.members ? ` (~${info.members} members)` : ""}`;
      });
      return `📋 **Whitelisted Servers** (${entries.length}):\n${lines.join("\n")}`;
    }
  }
}
