// ─── Bump → Join Correlation ────────────────────────────────────────────────
// Hooks into guildMemberAdd events. For each join, checks whether a bump
// landed in the last POST_BUMP_WINDOW_MIN minutes. If so, records a row in
// eris_bump_joins (or irene_bump_joins) linking the join to the bump.
//
// Also provides analytics queries for /bumps correlation:
//   - post-bump join ratio (% of joins that landed within the window)
//   - joins-per-bump average (total joins-within-window / total bumps)
//
// Schema:
//   CREATE TABLE eris_bump_joins (
//     id                 bigserial PRIMARY KEY,
//     guild_id           text NOT NULL,
//     user_id            text NOT NULL,
//     joined_at          timestamptz NOT NULL,
//     last_bump_at       timestamptz,
//     minutes_since_bump integer,
//     service            text
//   );
//   CREATE INDEX eris_bump_joins_guild_idx ON eris_bump_joins (guild_id, joined_at DESC);
//
// If the table doesn't exist, every function degrades silently.

import { log } from "../utils/logger.js";

// How recent a bump needs to be for us to attribute the join to it.
// 15 minutes covers the common "someone sees server on DISBOARD → clicks →
// joins" flow without over-attributing random background joins.
export const POST_BUMP_WINDOW_MIN = 15;

function tableFor(botName) {
  return botName === "irene" ? "irene_bump_joins" : "eris_bump_joins";
}

function bumpsTableFor(botName) {
  return botName === "irene" ? "irene_bumps" : "eris_bumps";
}

// ─── On-join hook ───────────────────────────────────────────────────────────

/**
 * Called from guildMemberAdd. Records whether this join is attributable to
 * a recent bump. Non-blocking, never throws, returns { attributed, minutesSinceBump }
 * for testability.
 */
export async function recordJoinForCorrelation({ guildId, userId, joinedAtMs = Date.now(), botName = "eris" } = {}) {
  if (!guildId || !userId) return { attributed: false };
  if (globalThis._bumpCorrDisabled) return { attributed: false };
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return { attributed: false };

    // Look up the most recent bump in this guild.
    const { data: bumpRows } = await sb
      .from(bumpsTableFor(botName))
      .select("bumped_at, service")
      .eq("guild_id", guildId)
      .order("bumped_at", { ascending: false })
      .limit(1);
    const lastBump = bumpRows?.[0];

    let lastBumpAt = null;
    let minutesSinceBump = null;
    let service = null;
    if (lastBump?.bumped_at) {
      lastBumpAt = lastBump.bumped_at;
      service = lastBump.service || null;
      minutesSinceBump = Math.round((joinedAtMs - Date.parse(lastBump.bumped_at)) / 60_000);
      if (minutesSinceBump < 0 || minutesSinceBump > 60 * 24 * 7) {
        // Sanity clamp — clock skew or very old data
        minutesSinceBump = null;
      }
    }

    const attributed = minutesSinceBump != null && minutesSinceBump <= POST_BUMP_WINDOW_MIN;

    const { error } = await sb.from(tableFor(botName)).insert({
      guild_id: guildId,
      user_id: userId,
      joined_at: new Date(joinedAtMs).toISOString(),
      last_bump_at: lastBumpAt,
      minutes_since_bump: minutesSinceBump,
      service,
    });
    if (error) {
      // Suppress "table not found" spam — log once then disable feature
      if (/not find the table|does not exist|PGRST20[56]/i.test(error.message || "")) {
        if (!globalThis._bumpCorrTableMissingLogged) {
          log(`[BumpCorr] DISABLED — table missing in Supabase: ${error.message}`);
          globalThis._bumpCorrTableMissingLogged = true;
          globalThis._bumpCorrDisabled = true;
        }
      } else {
        log(`[BumpCorr] insert failed: ${error.message}`);
      }
      return { attributed };
    }
    return { attributed, minutesSinceBump };
  } catch (e) {
    log(`[BumpCorr] recordJoinForCorrelation: ${e.message}`);
    return { attributed: false };
  }
}

// ─── Analytics queries ──────────────────────────────────────────────────────

/**
 * Returns join-correlation stats for a guild over `periodDays` days.
 * {
 *   totalJoins,
 *   postBumpJoins,   // joins within POST_BUMP_WINDOW_MIN of a bump
 *   postBumpRatio,   // 0..1
 *   avgJoinsPerBump, // postBumpJoins / totalBumps (capped to [0, ~10])
 *   windowMinutes,   // echoed for display
 * }
 */
export async function getJoinCorrelationStats(guildId, { periodDays = 14, botName = "eris" } = {}) {
  const empty = {
    totalJoins: 0,
    postBumpJoins: 0,
    postBumpRatio: 0,
    avgJoinsPerBump: 0,
    windowMinutes: POST_BUMP_WINDOW_MIN,
  };
  if (!guildId) return empty;

  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return empty;
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    // Joins with correlation data
    const { data: joins, error: joinsErr } = await sb
      .from(tableFor(botName))
      .select("minutes_since_bump")
      .eq("guild_id", guildId)
      .gte("joined_at", cutoff);
    if (joinsErr) {
      log(`[BumpCorr] stats joins failed: ${joinsErr.message}`);
      return empty;
    }

    const totalJoins = joins?.length || 0;
    const postBumpJoins = (joins || []).filter(
      r => r.minutes_since_bump != null && r.minutes_since_bump <= POST_BUMP_WINDOW_MIN
    ).length;

    // Total bumps in the same window (for avgJoinsPerBump)
    const { count: bumpCount } = await sb
      .from(bumpsTableFor(botName))
      .select("id", { count: "exact", head: true })
      .eq("guild_id", guildId)
      .gte("bumped_at", cutoff);

    const avgJoinsPerBump = bumpCount ? postBumpJoins / bumpCount : 0;
    const postBumpRatio = totalJoins ? postBumpJoins / totalJoins : 0;

    return {
      totalJoins,
      postBumpJoins,
      postBumpRatio,
      avgJoinsPerBump: Math.round(avgJoinsPerBump * 100) / 100,
      windowMinutes: POST_BUMP_WINDOW_MIN,
    };
  } catch (e) {
    log(`[BumpCorr] getJoinCorrelationStats: ${e.message}`);
    return empty;
  }
}

export const _internal = { tableFor, bumpsTableFor };
