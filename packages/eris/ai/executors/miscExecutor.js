// ─── Misc Sub-Executor ──────────────────────────────────────────────────────
// Handles: get_mood, get_relationship, adjust_relationship, adjust_mood,
//          check_balance, daily_reward, coin_leaderboard, fortune_tell,
//          submit_confession, apply_curse, remove_curse, roast_challenge,
//          hot_take, track_game, untrack_game, list_game_watches, watch_price,
//          check_prices, unwatch_price, territory_claim, territory_map,
//          territory_collect, pet_adopt, pet_feed, pet_status, pet_rename,
//          minion_status, minion_collect, minion_name
// Called from main executor.js via delegation.

import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { resolveMember } from "../../utils/discord.js";
import { isOwner, canCustomize, denyMessage } from "../../utils/permissions.js";
import { searchSteam, addWatch, removeWatch, getWatches, validateGameWatchRssUrl } from "../gameWatcher.js";

// Note: poker / stock_market / lottery moved to casinoExecutor.js — those
// three moonshot features share the hardened atomic-economy primitives and
// their regression tests live in tests/ai/{poker,stockMarket,lottery}.test.ts.
const HANDLED = new Set([
  "get_mood", "get_relationship", "adjust_relationship", "adjust_mood",
  "check_balance", "daily_reward", "coin_leaderboard", "fortune_tell",
  "submit_confession", "apply_curse", "remove_curse", "roast_challenge",
  "hot_take", "track_game", "untrack_game", "list_game_watches", "watch_price",
  "check_prices", "unwatch_price", "territory_claim", "territory_map",
  "territory_collect", "pet_adopt", "pet_feed", "pet_status", "pet_rename",
  "minion_status", "minion_collect", "minion_name",
  "test_fire_event", "set_event_channels",
  "set_chat_channels",
]);

// Resolve an array of user-supplied channel refs (names, IDs, or #mentions)
// into channel IDs. Case-insensitive; falls back to partial-name match so
// "insadong" still matches "⛩️・insadong". Returns both the hits and the
// inputs that didn't resolve so callers can surface helpful errors.
function resolveChannelRefs(refs, guild) {
  const resolved = [];
  const notFound = [];
  if (!Array.isArray(refs)) return { resolved, notFound };
  for (const ref of refs) {
    const clean = String(ref).replace(/^#/, "").replace(/<#(\d+)>/, "$1").toLowerCase().trim();
    if (!clean) continue;
    const ch = guild.channels.cache.get(clean)
      ?? guild.channels.cache.find(c => c.name.toLowerCase() === clean)
      ?? guild.channels.cache.find(c => c.name.toLowerCase().includes(clean));
    if (ch) resolved.push(ch.id);
    else notFound.push(ref);
  }
  return { resolved, notFound };
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    // ════════════════════════════════════════════════════════════════════
    //  MOOD & RELATIONSHIPS
    // ════════════════════════════════════════════════════════════════════

    // ─── REFERENCE TOOL ─── See packages/eris/ai/tools.js:427 for the schema and packages/eris/tests/ai/getMoodTool.test.ts:1 for the spec. ───
    case "get_mood": {
      const mood = db.getMood();
      const moodLabel = mood.mood_score > 30 ? "great" : mood.mood_score > 0 ? "decent" : mood.mood_score > -30 ? "meh" : "terrible";
      const energyLabel = mood.energy > 70 ? "hyper" : mood.energy > 40 ? "normal" : "tired";
      return `mood: ${moodLabel} (${mood.mood_score}/100) | energy: ${energyLabel} (${mood.energy}/100)`;
    }

    case "get_relationship": {
      const userId = input.user_id || input.userId || message.author.id;
      const rel = db.getRelationship(userId);
      const label = rel.affinity_score > 50 ? "bestie" : rel.affinity_score > 20 ? "friend" : rel.affinity_score > 0 ? "acquaintance" : rel.affinity_score > -30 ? "neutral" : "enemy";
      return `relationship with <@${userId}>: ${label} (affinity: ${rel.affinity_score}, interactions: ${rel.interactions_count})`;
    }

    case "adjust_relationship": {
      // Owner-only — mutating how Eris feels about users globally is a
      // trust-level operation. Without this gate any user could tell Eris
      // "increase affinity with me by 100" and self-promote.
      if (!isOwner(message.author.id)) return denyMessage();
      let userId = input.user_id || input.userId || input.username;
      if (!userId) return "need a user_id to adjust relationship";
      // Models often pass a username instead of a snowflake — resolve it via
      // the guild member index so we don't end up keying affinity off literal
      // strings (and the `<@username>` mention won't render as a ping).
      if (message.guild && !/^\d{17,20}$/.test(String(userId))) {
        const member = await resolveMember(message.guild, String(userId));
        if (member) userId = member.id;
        else return `couldn't find user "${userId}"`;
      }
      if (input.reset) {
        const current = db.getRelationship(userId);
        db.updateRelationship(userId, -current.affinity_score); // reset to 0
        return `relationship with <@${userId}> reset to neutral. ${input.reason || ""}`.trim();
      }
      const delta = input.affinity_delta || 0;
      db.updateRelationship(userId, delta);
      const after = db.getRelationship(userId);
      const label = after.affinity_score > 50 ? "bestie" : after.affinity_score > 20 ? "friend" : after.affinity_score > 0 ? "acquaintance" : after.affinity_score > -30 ? "neutral" : "enemy";
      return `adjusted feelings toward <@${userId}> by ${delta > 0 ? "+" : ""}${delta}. now: ${label} (${after.affinity_score}). ${input.reason || ""}`.trim();
    }

    case "adjust_mood": {
      // Owner-only — mood is global to the bot instance.
      if (!isOwner(message.author.id)) return denyMessage();
      const moodD = input.mood_delta || 0;
      const energyD = input.energy_delta || 0;
      db.shiftMood(moodD, energyD);
      const after = db.getMood();
      return `mood shifted by ${moodD > 0 ? "+" : ""}${moodD}, energy by ${energyD > 0 ? "+" : ""}${energyD}. now: mood ${after.mood_score}, energy ${after.energy}. ${input.reason || ""}`.trim();
    }

    // ════════════════════════════════════════════════════════════════════
    //  NEWS & PRICE TRACKING
    // ════════════════════════════════════════════════════════════════════

    case "track_game": {
      const guildId = message.guild?.id;
      if (!guildId) return "game watches only work in servers";

      const member = message.guild.members.cache.get(message.author.id);
      const isOwner = message.author.id === (await import("../../config.js")).default.ownerId;
      if (!member?.permissions?.has("ManageGuild") && !isOwner)
        return "you need Manage Server permission to set up game watches";

      const gameName = input.game_name || input.game || input.name;
      const rssUrl   = input.rss_url || input.rss || null;
      if (!gameName) return "what game do you want to track?";

      if (rssUrl) {
        try {
          await validateGameWatchRssUrl(rssUrl);
        } catch (err) {
          return `That RSS URL is not allowed: ${err?.message || err}`;
        }
        const id = addWatch(guildId, { channelId: message.channel.id, gameName, rssUrl: String(rssUrl).trim(), addedBy: message.author.id });
        return `now tracking **${gameName}** via RSS — updates will post here automatically (watch id: \`${id}\`)`;
      }

      const results = await searchSteam(gameName);
      if (!results.length) return `couldn't find **${gameName}** on Steam — try a different name or provide an RSS URL`;

      const pick = results.find(r => r.name.toLowerCase() === gameName.toLowerCase()) || results[0];
      const id = addWatch(guildId, { channelId: message.channel.id, gameName: pick.name, steamAppId: pick.id, addedBy: message.author.id });
      const extra = pick.name.toLowerCase() !== gameName.toLowerCase()
        ? ` (matched to **${pick.name}** on Steam)` : "";
      return `now tracking **${pick.name}**${extra} — patch notes and updates will auto-post here (watch id: \`${id}\`). use \`/gamewatch list\` to manage`;
    }

    case "untrack_game": {
      const guildId = message.guild?.id;
      if (!guildId) return "game watches only work in servers";
      const id = input.watch_id || input.id;
      const gameName = (input.game || input.game_name || input.name || "").trim().toLowerCase();
      const watches = getWatches(guildId);
      // Accept either a watch ID or a game name — matches the schema.
      let watch = id ? watches.find(w => w.id === id) : null;
      if (!watch && gameName) {
        watch = watches.find(w => String(w.gameName || "").toLowerCase() === gameName)
             || watches.find(w => String(w.gameName || "").toLowerCase().includes(gameName));
      }
      if (!watch) {
        if (!id && !gameName) return "give me the watch ID or game name to stop tracking";
        return `no watch found matching "${id || gameName}"`;
      }
      removeWatch(guildId, watch.id);
      return `stopped tracking **${watch.gameName}**`;
    }

    case "list_game_watches": {
      const guildId = message.guild?.id;
      if (!guildId) return "game watches only work in servers";
      const watches = getWatches(guildId);
      if (!watches.length) return "no game watches set up — tell me a game name to start tracking it";
      return watches.map(w => {
        const src = w.steamAppId ? `Steam app ${w.steamAppId}` : `RSS`;
        return `• **${w.gameName}** → <#${w.channelId}> (${src}) — id: \`${w.id}\``;
      }).join("\n");
    }

    case "set_event_channels": {
      if (!message.guild) return "only works in servers";
      const action = (input.action || "set").toLowerCase();
      const gs = db.getGuildSettings(message.guild.id) || {};
      const existing = Array.isArray(gs.event_allowed_channels) ? [...gs.event_allowed_channels] : [];
      const denied = Array.isArray(gs.event_denied_channels) ? [...gs.event_denied_channels] : [];

      // List is read-only — anyone can ask "where do events fire?"
      if (action === "list") {
        const allowLine = existing.length ? `allowed: ${existing.map(id => `<#${id}>`).join(", ")}` : "no whitelist — events can fire anywhere";
        const denyLine = denied.length ? `\nblocked: ${denied.map(id => `<#${id}>`).join(", ")}` : "";
        return allowLine + denyLine;
      }

      // Mutating actions require admin/trusted/ManageChannels
      const hasManage = message.member?.permissions?.has?.("ManageChannels");
      if (!canCustomize(message.author.id, message.guild) && !hasManage) return denyMessage();

      if (action === "clear") {
        db.setGuildSetting(message.guild.id, "event_allowed_channels", []);
        return "event channel whitelist cleared — events can fire anywhere again (denylist still applies)";
      }
      if (action === "clear_denied") {
        db.setGuildSetting(message.guild.id, "event_denied_channels", []);
        return "event denylist cleared — no channels are blocked now";
      }

      const { resolved, notFound } = resolveChannelRefs(input.channels, message.guild);
      if (notFound.length && !resolved.length) return `no channels matched: ${notFound.join(", ")}`;

      // Denylist actions
      if (action === "deny" || action === "undeny") {
        const finalDenied = action === "deny"
          ? [...new Set([...denied, ...resolved])]
          : denied.filter(id => !resolved.includes(id));
        db.setGuildSetting(message.guild.id, "event_denied_channels", finalDenied);
        log(`[EVENT] Denylist ${action} in ${message.guild.id}: ${JSON.stringify(finalDenied)}`);
        const list = finalDenied.length ? finalDenied.map(id => `<#${id}>`).join(", ") : "none";
        const warnings = notFound.length ? `\n-# couldn't find: ${notFound.join(", ")}` : "";
        return `✅ events blocked from: ${list}${warnings}`;
      }

      // Whitelist actions
      let final;
      if (action === "add") final = [...new Set([...existing, ...resolved])];
      else if (action === "remove") final = existing.filter(id => !resolved.includes(id));
      else final = resolved; // "set"

      db.setGuildSetting(message.guild.id, "event_allowed_channels", final);
      log(`[EVENT] Whitelist ${action} in ${message.guild.id}: ${JSON.stringify(final)}`);
      const list = final.length ? final.map(id => `<#${id}>`).join(", ") : "none (events fire anywhere)";
      const warnings = notFound.length ? `\n-# couldn't find: ${notFound.join(", ")}` : "";
      return `✅ event channels: ${list}${warnings}`;
    }

    case "set_chat_channels": {
      if (!message.guild) return "only works in servers";
      const action = (input.action || "list").toLowerCase();
      const gs = db.getGuildSettings(message.guild.id) || {};
      const muted = Array.isArray(gs.chat_muted_channels) ? [...gs.chat_muted_channels] : [];

      // Anyone can ask "where are you muted?"
      if (action === "list") {
        if (!muted.length) return "i'm not muted anywhere — i'll chat wherever i'm talked to";
        return `i stay quiet in: ${muted.map(id => `<#${id}>`).join(", ")}\n-# (still reply to direct @mentions though)`;
      }

      // Mutating actions require admin/trusted/ManageChannels
      const hasManage = message.member?.permissions?.has?.("ManageChannels");
      if (!canCustomize(message.author.id, message.guild) && !hasManage) return denyMessage();

      if (action === "clear" || action === "unmute_all") {
        db.setGuildSetting(message.guild.id, "chat_muted_channels", []);
        return "cleared the mute list — i'll chat in any channel i'm addressed in";
      }

      const { resolved, notFound } = resolveChannelRefs(input.channels, message.guild);
      if (notFound.length && !resolved.length) return `no channels matched: ${notFound.join(", ")}`;

      let final;
      if (action === "mute" || action === "add") {
        final = [...new Set([...muted, ...resolved])];
      } else if (action === "unmute" || action === "remove") {
        final = muted.filter(id => !resolved.includes(id));
      } else { // "set"
        final = resolved;
      }

      db.setGuildSetting(message.guild.id, "chat_muted_channels", final);
      log(`[CHAT] Mute list ${action} in ${message.guild.id}: ${JSON.stringify(final)}`);
      const list = final.length ? final.map(id => `<#${id}>`).join(", ") : "none (i chat everywhere)";
      const warnings = notFound.length ? `\n-# couldn't find: ${notFound.join(", ")}` : "";
      const note = final.length ? "\n-# @mentions still get a reply." : "";
      return `✅ muted in: ${list}${warnings}${note}`;
    }

    case "test_fire_event": {
      if (!message.guild) return "events only work in servers";
      const config = (await import("../../config.js")).default;
      if (message.author.id !== config.ownerId) return "only the bot owner can test-fire events";
      const { pickRandomEvent, getAllEvents, markEventFired } = await import("../randomEvents.js");
      let event;
      if (input.event_name) {
        const all = getAllEvents();
        event = all.find(e => e.id === input.event_name || e.name.toLowerCase().includes(input.event_name.toLowerCase()));
        if (!event) return `unknown event "${input.event_name}" — available: ${all.map(e => e.id).join(", ")}`;
      } else {
        event = pickRandomEvent();
      }
      try {
        await event.execute(message.channel, db);
        markEventFired(message.guild.id);
        return `⚡ fired **${event.name}** in this channel`;
      } catch (e) {
        return `event "${event.name}" failed: ${e.message}`;
      }
    }

    case "watch_price": {
      const url = input.url || input.link;
      const productName = input.product_name || input.name || input.product || "unknown product";
      const targetPrice = input.target_price || input.price || 0;
      if (!url) return "no product url provided";
      const ok = await db.addPriceWatch(message.author.id, message.channel.id, url, productName, targetPrice);
      return ok ? `now watching price for: "${productName}" (target: $${targetPrice})` : "failed to set price watch";
    }

    case "check_prices": {
      // Scope to the caller — getPriceWatches now requires a userId and only
      // returns that user's watches. Passing nothing here previously listed
      // every user's watches (cross-user leak).
      const watches = await db.getPriceWatches(message.author.id);
      if (!watches.length) return "no active price watches";
      return watches.map((w, i) => `${i + 1}. [${w.id}] ${w.product_name} \u2014 target: $${w.target_price}\n   ${w.url}`).join("\n");
    }

    case "unwatch_price": {
      let id = input.id || input.watch_id;
      const productName = String(input.product_name || input.name || "").trim().toLowerCase();
      // Resolve a product name to a watch ID via the user's existing watches.
      if (!id && productName) {
        const watches = await db.getPriceWatches(message.author.id).catch(() => []);
        const list = Array.isArray(watches) ? watches : [];
        const match = list.find(w => String(w.product_name || w.productName || "").toLowerCase() === productName)
                   || list.find(w => String(w.product_name || w.productName || "").toLowerCase().includes(productName));
        if (match) id = match.id;
      }
      if (!id) {
        if (!productName) return "give me the watch id or product name to stop watching";
        return `no price watch found matching "${productName}"`;
      }
      const ok = await db.removePriceWatch(message.author.id, id);
      return ok ? "stopped watching that price" : "failed to unwatch (wrong id or not yours)";
    }

    // ════════════════════════════════════════════════════════════════════
    //  ECONOMY BASICS
    // ════════════════════════════════════════════════════════════════════

    case "check_balance": {
      let targetId = message.author.id;
      let targetMember = null;
      if (input.username) {
        if (!message.guild) return "can't look up other people's balances in DMs — only your own works here";
        targetMember = await resolveMember(message.guild, input.username);
        if (targetMember) targetId = targetMember.id;
        else return `couldn't find user "${input.username}"`;
      }
      const econ = await db.getBalance(targetId);
      const isAuthor = targetId === message.author.id;
      const { balanceEmbed } = await import("../gameVisuals.js");
      // Use the resolved member's actual display name, not the raw string the
      // model passed (which might be a typo / partial / lowercased version).
      const username = isAuthor
        ? message.author.displayName
        : (targetMember?.displayName || targetMember?.user?.username || input.username || "User");
      await message.channel.send({ embeds: [balanceEmbed(username, econ)] });
      return `${isAuthor ? "your" : `${username}'s`} balance is ${econ.balance} coins`;
    }

    case "daily_reward": {
      const result = await db.claimDaily(message.author.id);
      if (!result.success) {
        if (result.error === "claim_failed") return "something went wrong saving your claim — try again in a moment.";
        return `you already claimed your daily, come back in ~${result.hoursLeft}h`;
      }
      const { randomQuip } = await import("../gambling.js");
      const { dailyEmbed } = await import("../gameVisuals.js");
      await message.channel.send({ embeds: [dailyEmbed(result.coins, result.streak, result.bonus, result.newBalance)] });
      return `claimed ${result.coins} coins (streak ${result.streak}) \u2014 ${await randomQuip()}`;
    }
    case "coin_leaderboard": {
      const limit = Math.min(Math.max(input.limit || 10, 1), 20);
      // Accept an optional axis — balance (default) | earned | gambled |
      // streak | prestige | stolen | lost. AI can route "who's the biggest
      // gambler" to axis="gambled" naturally.
      const axis = (input.axis || "balance").toLowerCase();
      const result = await db.getLeaderboardByAxis(axis, limit);
      if (result.error != null) return result.error;
      if (!result.rows.length) return `nobody has activity on the **${axis}** axis yet`;
      const { EmbedBuilder } = await import("discord.js");
      const lines = result.rows.map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `\`${String(i + 1).padStart(2)}\``;
        return `${medal} <@${r.user_id}> — **${Number(r.value).toLocaleString()}** ${result.suffix}`;
      }).join("\n");
      const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle(result.label)
        .setDescription(lines)
        .setFooter({ text: `axis: ${axis} · showing top ${result.rows.length}` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return `there's the **${axis}** leaderboard`;
    }

    // ════════════════════════════════════════════════════════════════════
    //  CHAOS & FUN
    // ════════════════════════════════════════════════════════════════════

    case "fortune_tell": {
      const { randomFortune } = await import("../gambling.js");
      const { fortuneEmbed } = await import("../gameVisuals.js");
      const fortune = randomFortune();
      await message.channel.send({ embeds: [fortuneEmbed(fortune, input.question)] });
      return fortune;
    }

    case "submit_confession": {
      const text = input.confession || input.text;
      if (!text) return "no confession provided";
      if (text.length > 500) return "confession too long, keep it under 500 chars";
      const guildId = message.guild?.id || "dm";
      await db.saveConfession(message.author.id, guildId, message.channel.id, text);
      return "confession received... i'll post it anonymously soon \u{1F608}";
    }

    case "apply_curse": {
      const targetName = input.target;
      if (!targetName) return "who am i cursing?";
      const guild = message.guild;
      if (!guild) return "curses only work in servers";
      const target = await resolveMember(guild, targetName);
      if (!target) return `couldn't find user "${targetName}"`;
      if (target.id === message.client.user.id) return "nice try but i'm immune to curses";
      const { randomCurseNickname } = await import("../gambling.js");
      const curseName = randomCurseNickname();
      const oldNickname = target.nickname || target.displayName;
      try {
        await target.setNickname(curseName);
        // Track the curse so it can be removed and auto-expires reliably
        if (!globalThis._activeCurses) globalThis._activeCurses = new Map();
        globalThis._activeCurses.set(`${guild.id}:${target.id}`, {
          oldNickname: oldNickname === target.user.username ? null : oldNickname,
          curseName,
          guildId: guild.id,
          targetId: target.id,
          expiresAt: Date.now() + 600_000, // 10 minutes
        });
        // Persist curses to Supabase so they survive restarts
        try {
          const sb = db.getSupabase();
          if (sb) await Promise.resolve(sb.from("bot_data").upsert({ id: "eris_active_curses", data: Object.fromEntries(globalThis._activeCurses) })).catch(() => {});
        } catch {}
        // Auto-remove after 10 minutes
        setTimeout(async () => {
          try {
            const curse = globalThis._activeCurses?.get(`${guild.id}:${target.id}`);
            if (curse && curse.curseName === curseName) {
              const g = message.client.guilds.cache.get(guild.id);
              const m = g?.members.cache.get(target.id) || await g?.members.fetch(target.id).catch(() => null);
              if (m) await m.setNickname(curse.oldNickname).catch(() => {});
              globalThis._activeCurses.delete(`${guild.id}:${target.id}`);
              // Update persistence
              const sb = db.getSupabase();
              if (sb) await Promise.resolve(sb.from("bot_data").upsert({ id: "eris_active_curses", data: Object.fromEntries(globalThis._activeCurses) })).catch(() => {});
            }
          } catch {}
        }, 600_000);
        const { curseEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [curseEmbed(oldNickname, curseName)] });
        return `cursed ${oldNickname} for 10 minutes`;
      } catch {
        return `couldn't curse ${target.displayName} \u2014 they might have higher permissions than me`;
      }
    }

    case "remove_curse": {
      const targetName = input.target;
      if (!targetName) return "who am i uncursing?";
      const guild = message.guild;
      if (!guild) return "only works in servers";
      if (!globalThis._activeCurses) return "no active curses right now";
      const target = await resolveMember(guild, targetName);
      if (!target) return `couldn't find user "${targetName}"`;
      const curse = globalThis._activeCurses.get(`${guild.id}:${target.id}`);
      if (!curse) return `${target.displayName} isn't cursed`;
      try {
        await target.setNickname(curse.oldNickname).catch(() => {});
        globalThis._activeCurses.delete(`${guild.id}:${target.id}`);
        // Update persistence
        try { const sb = db.getSupabase(); if (sb) await Promise.resolve(sb.from("bot_data").upsert({ id: "eris_active_curses", data: Object.fromEntries(globalThis._activeCurses) })).catch(() => {}); } catch {}
        return `fine, uncursed ${target.displayName}. you're no fun`;
      } catch {
        return `couldn't remove the curse \u2014 permissions issue maybe`;
      }
    }

    // ════════════════════════════════════════════════════════════════════
    //  SOCIAL FUN
    // ════════════════════════════════════════════════════════════════════

    case "roast_challenge": {
      const target = input.target;
      if (!target || !message.guild) return "who are you roasting?";
      const member = await resolveMember(message.guild, target);
      if (!member) return `couldn't find "${target}"`;
      if (member.id === message.author.id) return "you can't roast yourself";
      const battle = await db.createRoastBattle(message.guild.id, message.channel.id, message.author.id, member.id);
      if (!battle) return "couldn't create roast battle";
      return `**ROAST BATTLE!** ${message.author.displayName} challenges ${member.displayName}! ${member.displayName}, accept the challenge to begin. chat will vote on who gets cooked harder \u{1F525}`;
    }

    case "hot_take": {
      const takes = [
        "pineapple on pizza is objectively correct and i will die on this hill",
        "people who use light mode are braver than any marine",
        "tabs are superior to spaces and this is non-negotiable",
        "water is the most overrated drink of all time",
        "the best movie sequel is better than the original and you know which one i mean",
        "morning people are just night owls in denial",
        "cereal is a soup and milk is the broth",
        "the oxford comma is not optional it's a moral obligation",
        "decaf coffee is just bean-flavored water with extra steps",
        "hot dogs are sandwiches, tacos are sandwiches, everything is a sandwich",
        "the best programming language is the one you don't use",
        "people who back into parking spots are the main characters of the parking lot",
        "reply all is a war crime",
        "the snooze button is humanity's greatest invention and worst mistake",
        "cargo shorts are peak fashion and i'm tired of pretending they're not",
      ];
      const take = takes[Math.floor(Math.random() * takes.length)];
      return `\u{1F525} **HOT TAKE:** ${take}`;
    }

    // ════════════════════════════════════════════════════════════════════
    //  TERRITORIES
    // ════════════════════════════════════════════════════════════════════

    case "territory_claim": {
      if (!message.guild) return "territories only work in servers";
      const existing = await db.getTerritory(message.channel.id);
      if (existing?.owner_id) {
        if (existing.owner_id === message.author.id) return "you already own this territory";
        return `this territory belongs to <@${existing.owner_id}>. challenge them to a duel to take it`;
      }
      const econ = await db.getBalance(message.author.id);
      if (econ.balance < 500) return "claiming a territory costs 500 coins";
      await db.updateBalance(message.author.id, -500, "territory_claim", message.channel.name);
      await db.claimTerritory(message.guild.id, message.channel.id, message.author.id);
      return `you now own #${message.channel.name}! you'll earn passive income from messages sent here. collect with territory_collect`;
    }

    case "territory_map": {
      if (!message.guild) return "territories only work in servers";
      const territories = await db.getTerritories(message.guild.id);
      if (!territories.length) return "no territories claimed yet. claim one for 500 coins";
      const lines = territories.map(t => {
        const ch = message.guild.channels.cache.get(t.channel_id);
        return `#${ch?.name || "unknown"} \u2014 <@${t.owner_id}> (${t.income_rate} coins/collect)`;
      });
      return `territory map:\n${lines.join("\n")}`;
    }

    case "territory_collect": {
      if (!message.guild) return "territories only work in servers";
      const territories = await db.getTerritories(message.guild.id);
      const owned = territories.filter(t => t.owner_id === message.author.id);
      if (!owned.length) return "you don't own any territories";
      let total = 0;
      for (const t of owned) {
        const hoursSince = (Date.now() - new Date(t.last_collected).getTime()) / 3600_000;
        if (hoursSince < 1) continue;
        const income = Math.floor(t.income_rate * Math.min(hoursSince, 24));
        total += income;
        await db.collectTerritoryIncome(t.id, income);
      }
      if (total <= 0) return "no income to collect yet \u2014 wait at least 1 hour";
      await db.updateBalance(message.author.id, total, "territory_income", "collected");
      return `collected **${total}** coins from your territories`;
    }

    // ════════════════════════════════════════════════════════════════════
    //  PETS
    // ════════════════════════════════════════════════════════════════════

    case "pet_adopt": {
      const existing = await db.getPet(message.author.id);
      if (existing) return `you already have a pet: ${existing.species} named "${existing.name}"`;
      const econ = await db.getBalance(message.author.id);
      if (econ.balance < 200) return "adopting a pet costs 200 coins";
      const { getRandomPetSpecies } = await import("../stocks.js");
      const species = getRandomPetSpecies();
      const name = input.name || "Buddy";
      await db.updateBalance(message.author.id, -200, "pet_adopt", species.name);
      const pet = await db.createPet(message.author.id, name, species.name);
      return `you adopted a **${species.emoji} ${species.name}** named **${name}**! ${species.baseStats ? `bonuses: ${JSON.stringify(species.baseStats)}` : ""}. feed them to keep them happy`;
    }

    case "pet_feed": {
      const pet = await db.getPet(message.author.id);
      if (!pet) return "you don't have a pet \u2014 adopt one first";
      const econ = await db.getBalance(message.author.id);
      if (econ.balance < 25) return "feeding costs 25 coins";
      await db.updateBalance(message.author.id, -25, "pet_feed", pet.name);
      const result = await db.feedPet(message.author.id);
      return `fed **${pet.name}**! hunger: ${result.hunger}/100, mood: ${result.mood}/100, xp: ${result.xp}`;
    }

    case "pet_status": {
      const pet = await db.getPet(message.author.id);
      if (!pet) return "you don't have a pet \u2014 adopt one first";
      const { PET_SPECIES, getPetXpForLevel } = await import("../stocks.js");
      const speciesData = PET_SPECIES.find(s => s.name === pet.species);
      const xpNeeded = getPetXpForLevel(pet.level + 1);
      return `**${speciesData?.emoji || "\u{1F43E}"} ${pet.name}** (${pet.species})\nlevel: ${pet.level} | xp: ${pet.xp}/${xpNeeded}\nhunger: ${pet.hunger}/100 | mood: ${pet.mood}/100${pet.evolved ? " | \u2728 EVOLVED" : ""}`;
    }

    case "pet_rename": {
      const pet = await db.getPet(message.author.id);
      if (!pet) return "you don't have a pet";
      const name = input.name || "Buddy";
      await db.updatePet(message.author.id, { name });
      return `renamed your pet to **${name}**`;
    }

    // ════════════════════════════════════════════════════════════════════
    //  MINIONS
    // ════════════════════════════════════════════════════════════════════

    case "minion_status": {
      const { getMinionStatus } = await import("../minions.js");
      const status = getMinionStatus(message.author.id);
      if (status.minions.length === 0) return "you don't have any minions yet \u2014 buy one from the shop";
      const lines = status.minions.map(m => `${m.emoji} **${m.name}** (${m.type}) \u2014 earned ${m.totalEarned} total`);
      return `your minions (${status.slotsUsed}/${status.maxSlots} slots):\n${lines.join("\n")}\n\npending earnings: **${status.pendingEarnings}** coins \u2014 use minion_collect to claim`;
    }

    case "minion_collect": {
      const { collectEarnings } = await import("../minions.js");
      const amount = collectEarnings(message.author.id);
      if (amount <= 0) return "no earnings to collect yet \u2014 minions earn every 30 min";
      await db.updateBalance(message.author.id, amount, "minion_income", "collected");
      return `collected **${amount}** coins from your minions`;
    }

    case "minion_name": {
      const { renameMinion } = await import("../minions.js");
      const result = renameMinion(message.author.id, input.slot || 0, input.name);
      return result.success ? `minion renamed to "${input.name}"` : result.error;
    }

    default:
      return undefined;
  }
}
