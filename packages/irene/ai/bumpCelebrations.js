// ─── Bump Celebrations & Streak Awareness ──────────────────────────────────
// Side effects that happen AROUND bumps (not the bump reminder itself):
//
//   - Bump-a-thon goal-hit ping (posted once when a bump pushes progress
//     over the configured goal)
//   - Bump-a-thon expiration ("fell X short") — watcher started from ready.js
//   - Streak milestone celebrations (7, 14, 30, 50, 100 consecutive days)
//   - Streak-lost acknowledgment — prepended to the next reminder when a
//     non-trivial streak was broken
//
// All functions degrade silently if Supabase is unavailable so the core
// reminder keeps working on unmigrated servers.

import { getGuildSettings, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";

const STREAK_MILESTONES = [7, 14, 30, 50, 100, 200, 365];

// ─── Template rendering (shared by all celebration paths) ─────────────────
// Server admins can override any celebration message via bump_celebration_templates
// on guild settings: { milestone?, goal_hit?, fell_short?, streak_lost? }
// Placeholders are {name}, {streak}, {goal}, {progress}, {short}, {service},
// {duration_hours}, {mvp}. Unknown placeholders are left intact so bad
// templates degrade loudly, not silently.

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

function getCustomTemplate(settings, category) {
  const tpls = settings?.bump_celebration_templates;
  if (!tpls || typeof tpls !== "object") return null;
  const val = tpls[category];
  return typeof val === "string" && val.trim() ? val : null;
}

// ─── Bumpathon progress check ──────────────────────────────────────────────

/**
 * Count bumps for a guild since `sinceMs`. Uses irene_bumps / irene_bumps
 * transparently — the analytics module already handles which table.
 */
export async function countBumpsSince(guildId, sinceMs, bumpsTable = "irene_bumps") {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return 0;
    const { count } = await sb.from(bumpsTable)
      .select("id", { count: "exact", head: true })
      .eq("guild_id", guildId)
      .gte("bumped_at", new Date(sinceMs).toISOString());
    return count || 0;
  } catch {
    return 0;
  }
}

/**
 * Called from handleBumpConfirm after recordBump succeeds. If a bumpathon is
 * active and this bump just crossed the goal line, post a one-time
 * celebration in the bump channel.
 *
 * Marks `bumpathon.completed = true` so subsequent bumps don't re-fire the
 * celebration. Leaves the event otherwise intact so /bumpathon status still
 * shows the final number.
 */
export async function maybeCelebrateBumpathon(client, guildId, bumpsTable = "irene_bumps") {
  const settings = getGuildSettings(guildId) || {};
  const event = settings.bumpathon;
  if (!event || event.completed) return;
  if (!event.endsAt || event.endsAt < Date.now()) return; // expired — handled elsewhere

  const progress = await countBumpsSince(guildId, event.startedAt, bumpsTable);
  if (progress < event.goal) return;

  // Mark done FIRST so the celebration only fires once even if multiple
  // bumps land in the same second.
  setGuildSetting(guildId, "bumpathon", { ...event, completed: true, completedAt: Date.now() });

  try {
    const { EmbedBuilder } = await import("discord.js");
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channelId = settings.bump_reminder_channel_id || settings.bump_channel_id;
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const durationHours = Math.max(1, Math.round((Date.now() - event.startedAt) / (60 * 60 * 1000)));

    // Admins can override the message with a custom template.
    const customTpl = getCustomTemplate(settings, "goal_hit");
    if (customTpl) {
      const rendered = renderTemplate(customTpl, {
        progress,
        goal: event.goal,
        duration_hours: durationHours,
        mvp: event.startedBy ? `<@${event.startedBy}>` : "everyone",
      });
      await channel.send({
        content: rendered.slice(0, 1950),
        allowedMentions: { parse: ["users"] },
      });
    } else {
      const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle("🏆 BUMP-A-THON GOAL HIT")
        .setDescription(
          `**${progress} / ${event.goal}** bumps in ${durationHours}h.\n\n` +
          `everyone who bumped, thank you. ${event.startedBy ? `shoutout to <@${event.startedBy}> for calling it` : ""}`
        )
        .setFooter({ text: "this server is fed." });
      await channel.send({ embeds: [embed] });
    }
    log(`[BUMP] Bumpathon goal hit in ${guildId} (${progress}/${event.goal})`);
  } catch (e) {
    log(`[BUMP] Celebration post failed: ${e.message}`);
  }
}

/**
 * Watcher that sweeps every N minutes looking for bumpathons whose time has
 * run out without hitting the goal, posts a "fell X short" note, and clears
 * the state. Call `startBumpathonWatcher(client)` once from ready.js.
 */
export function startBumpathonWatcher(client, { intervalMs = 5 * 60_000, bumpsTable = "irene_bumps" } = {}) {
  const tick = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const settings = getGuildSettings(guild.id) || {};
        const event = settings.bumpathon;
        if (!event || event.completed) continue;
        if (!event.endsAt || event.endsAt > Date.now()) continue;

        // It expired. Determine final progress.
        const progress = await countBumpsSince(guild.id, event.startedAt, bumpsTable);

        // Clear it regardless of outcome.
        setGuildSetting(guild.id, "bumpathon", null);

        // If the goal was hit, maybeCelebrateBumpathon already handled it
        // when the crossing bump was recorded. Only post the "fell short"
        // note when we actually fell short.
        if (progress >= event.goal) continue;

        const channelId = settings.bump_reminder_channel_id || settings.bump_channel_id;
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId)
          ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) continue;

        const short = event.goal - progress;
        const customTpl = getCustomTemplate(settings, "fell_short");
        if (customTpl) {
          await channel.send({
            content: renderTemplate(customTpl, { progress, goal: event.goal, short }).slice(0, 1950),
            allowedMentions: { parse: [] },
          }).catch(() => {});
        } else {
          const { EmbedBuilder } = await import("discord.js");
          const embed = new EmbedBuilder()
            .setColor(0x6B7280)
            .setTitle("bump-a-thon ended")
            .setDescription(`**${progress} / ${event.goal}** bumps. fell ${short} short this time. still not bad.`)
            .setFooter({ text: "try again tomorrow maybe" });
          await channel.send({ embeds: [embed] }).catch(() => {});
        }
        log(`[BUMP] Bumpathon expired in ${guild.id} (${progress}/${event.goal})`);
      } catch (e) {
        log(`[BUMP] Bumpathon watcher error: ${e.message}`);
      }
    }
  };

  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  // Fire once on boot so expired-while-offline events get cleaned up.
  tick().catch(() => {});
  return handle;
}

// ─── Streak milestone celebrations ─────────────────────────────────────────

/**
 * Called from handleBumpConfirm after recordBump succeeds. Computes the new
 * guild streak for this service; if it just crossed a milestone (7/14/30/
 * 50/100/200/365 days), posts a celebration once.
 *
 * Dedupe is keyed on (guild, service, milestone) so a server that hits 7
 * days, drops, and re-hits 7 days later gets the celebration again — that's
 * the intent, a fresh 7-day run deserves a fresh cheer.
 */
export async function maybeCelebrateStreakMilestone(client, { guildId, service = "disboard" }) {
  try {
    const { getGuildStreak } = await import("./bumpAnalytics.js");
    const streak = await getGuildStreak(guildId, service);
    if (!STREAK_MILESTONES.includes(streak)) return;

    // Dedupe — last milestone we celebrated for this guild/service combo.
    const settings = getGuildSettings(guildId) || {};
    const key = `bump_streak_celebrated_${service}`;
    const prev = settings[key];
    // If the same milestone was celebrated within the last 20 hours, skip —
    // multiple bumps on the same streak-day would otherwise retrigger.
    if (prev?.milestone === streak && Date.now() - (prev.at || 0) < 20 * 60 * 60 * 1000) return;

    setGuildSetting(guildId, key, { milestone: streak, at: Date.now() });

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channelId = settings.bump_reminder_channel_id || settings.bump_channel_id;
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const customTpl = getCustomTemplate(settings, "milestone");
    if (customTpl) {
      await channel.send({
        content: renderTemplate(customTpl, { streak, service }).slice(0, 1950),
        allowedMentions: { parse: [] },
      });
    } else {
      const { EmbedBuilder } = await import("discord.js");
      const emoji = streak >= 100 ? "🔥" : streak >= 30 ? "🌟" : "✨";
      const hook = streak >= 365 ? "a full year. insane."
        : streak >= 100 ? "triple digits. this is a real server now."
        : streak >= 50 ? "fifty straight days."
        : streak >= 30 ? "a whole month."
        : streak >= 14 ? "two weeks straight. consistency."
        : "a full week. keep it going.";

      const embed = new EmbedBuilder()
        .setColor(streak >= 100 ? 0xFF6B6B : streak >= 30 ? 0xF1C40F : 0xA78BFA)
        .setTitle(`${emoji} ${streak}-day bump streak`)
        .setDescription(hook);
      await channel.send({ embeds: [embed] });
    }
    log(`[BUMP] Streak milestone ${streak} celebrated in ${guildId}/${service}`);
  } catch (e) {
    log(`[BUMP] Streak milestone check failed: ${e.message}`);
  }
}

// ─── Streak-lost detection ─────────────────────────────────────────────────
// Called from _fireReminder BEFORE the reminder goes out. Returns a short
// string to prepend if a non-trivial streak was just broken, or null. We
// record the guild's "last known streak" on every bump so we can detect the
// drop at reminder time.

/**
 * Record the current streak after a bump. Cheap write; used as the baseline
 * for streak-lost detection on the next reminder fire.
 */
export async function recordStreakBaseline({ guildId, service = "disboard" }) {
  try {
    const { getGuildStreak } = await import("./bumpAnalytics.js");
    const streak = await getGuildStreak(guildId, service);
    const settings = getGuildSettings(guildId) || {};
    const key = `bump_streak_baseline_${service}`;
    setGuildSetting(guildId, key, { streak, at: Date.now() });
    return streak;
  } catch {
    return 0;
  }
}

/**
 * Was the streak broken between the last recorded baseline and right now?
 * Returns the prior streak length if yes (and the current streak is < 2),
 * null otherwise. Only flags "meaningful" drops — losing a 3-day streak
 * isn't worth a notification.
 */
export async function detectStreakLost({ guildId, service = "disboard" }) {
  try {
    const settings = getGuildSettings(guildId) || {};
    const key = `bump_streak_baseline_${service}`;
    const baseline = settings[key];
    if (!baseline || !baseline.streak || baseline.streak < 5) return null;

    const { getGuildStreak } = await import("./bumpAnalytics.js");
    const current = await getGuildStreak(guildId, service);
    if (current >= baseline.streak) return null; // streak still healthy
    if (current >= 2) return null; // small dip, not a full break

    // We're calling this once at reminder time — clear the baseline so we
    // don't spam the message on every subsequent reminder.
    setGuildSetting(guildId, key, null);
    return baseline.streak;
  } catch {
    return null;
  }
}

// ─── Rank helpers ──────────────────────────────────────────────────────────

/**
 * Best (lowest) rank in the given time window. Null if no ranks have been
 * captured — most bump services don't surface rank in their confirm message.
 */
/**
 * @param {string} guildId
 * @param {{ periodDays?: number, service?: string|null, bumpsTable?: string }} [opts]
 */
export async function getBestRankInPeriod(guildId, { periodDays = 7, service = null, bumpsTable = "irene_bumps" } = {}) {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return null;
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
    let q = sb.from(bumpsTable).select("rank").eq("guild_id", guildId).not("rank", "is", null).gte("bumped_at", cutoff);
    if (service) q = q.eq("service", service);
    const { data, error } = await q.order("rank", { ascending: true }).limit(1);
    if (error || !data?.length) return null;
    return data[0].rank;
  } catch {
    return null;
  }
}

/**
 * Build the streak-lost line prepended to the next reminder. Respects a
 * custom "streak_lost" template if the guild set one; otherwise returns the
 * default phrasing. Callable from bumpReminder without importing this whole
 * module's scheduler state.
 */
export function buildStreakLostLine(settings, lostLength) {
  if (!lostLength) return "";
  const customTpl = getCustomTemplate(settings, "streak_lost");
  if (customTpl) {
    return renderTemplate(customTpl, { streak: lostLength });
  }
  return `💔 lost our ${lostLength}-day streak. we'll bounce back.`;
}

// ─── Weekly MVP DM ──────────────────────────────────────────────────────────
// Runs on an hourly tick. When it's Sunday in the configured UTC hour
// window, and we haven't sent this week's MVP DMs yet, iterate every guild
// with bumps in the last 7 days, pick the #1 bumper, and DM them a short
// thank-you. Respects user opt-outs (bumpUserPrefs.weekly_mvp_optout).

const MVP_RUN_HOUR_UTC = 15;       // Sunday 15:00 UTC (~8am PT / 11am ET)
const MVP_SEND_WINDOW_HOURS = 2;   // Fire if we're inside [hour, hour+2) and haven't yet this week
const MVP_LOOKBACK_DAYS = 7;

function _isoWeekKey(d = new Date()) {
  // Compact "year-Wweek" key — dedupe per ISO week.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The hourly tick. Exported so tests can drive it without real timers.
 */
export async function runWeeklyMvpTick(client, { bumpsTable = "irene_bumps", botName = "irene", nowDate = new Date() } = {}) {
  // Gating: only fire on Sunday in the MVP run window.
  const day = nowDate.getUTCDay();
  const hour = nowDate.getUTCHours();
  if (day !== 0) return { fired: false, reason: "not-sunday" };
  if (hour < MVP_RUN_HOUR_UTC || hour >= MVP_RUN_HOUR_UTC + MVP_SEND_WINDOW_HOURS) {
    return { fired: false, reason: "outside-window" };
  }

  const weekKey = _isoWeekKey(nowDate);
  let dmsSent = 0;
  let dmsSkipped = 0;

  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = getGuildSettings(guild.id) || {};
      if (settings.bump_mvp_week_sent === weekKey) continue; // already ran this week
      // Also respect an admin disable flag.
      if (settings.bump_mvp_enabled === false) {
        setGuildSetting(guild.id, "bump_mvp_week_sent", weekKey);
        continue;
      }

      // Find the top bumper of the last 7 days.
      const { getBumpLeaderboard, getBumpCount } = await import("./bumpAnalytics.js");
      const top = await getBumpLeaderboard(guild.id, { periodDays: MVP_LOOKBACK_DAYS, limit: 1 });
      if (!top?.length) {
        // No bumps this week — just mark as run so we don't retry all day.
        setGuildSetting(guild.id, "bump_mvp_week_sent", weekKey);
        continue;
      }
      const { user_id: userId, count } = top[0];

      // Opt-out check.
      const { getUserPrefs } = await import("./bumpUserPrefs.js");
      const prefs = await getUserPrefs(userId, botName);
      if (prefs.weekly_mvp_optout) { dmsSkipped++; continue; }

      // Member must still be in the guild to DM them usefully.
      const member = guild.members.cache.get(userId)
        ?? await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      // Compose + send DM.
      const voice = botName === "irene"
        ? `hey ${member.displayName}. you bumped **${count}** times this week for **${guild.name}** — that's legit carrying us. thanks for real 🩵\n\n(you can opt out of these with /bumps mvp off)`
        : `yo ${member.displayName}. you bumped **${count}** times this week for **${guild.name}**. ur literally built different. ty for carrying 🫡\n\n(turn these off with /bumps mvp off if they get annoying)`;
      const dm = await member.createDM().catch(() => null);
      if (dm) {
        await dm.send(voice).catch(() => {});
        dmsSent++;
      }
      setGuildSetting(guild.id, "bump_mvp_week_sent", weekKey);
    } catch (e) {
      log(`[BumpMVP] guild ${guild.id} failed: ${e.message}`);
    }
  }

  if (dmsSent || dmsSkipped) log(`[BumpMVP] sent ${dmsSent}, skipped (opt-out) ${dmsSkipped}`);
  return { fired: true, dmsSent, dmsSkipped, weekKey };
}

export function startWeeklyMvpScheduler(client, opts = {}) {
  // Tick hourly, with unref so the timer doesn't keep Node alive on shutdown.
  const tick = () => runWeeklyMvpTick(client, opts).catch(e => log(`[BumpMVP] tick error: ${e.message}`));
  const handle = setInterval(tick, 60 * 60 * 1000);
  handle.unref?.();
  // Fire once on boot in case we booted during the window.
  tick();
  return handle;
}

export const _internal = { STREAK_MILESTONES, renderTemplate, _isoWeekKey };
