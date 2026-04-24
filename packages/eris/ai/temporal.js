// ─── Temporal Awareness ─────────────────────────────────────────────────────
// Makes the bot feel like she actually lives in time. Builds a prompt fragment
// reflecting time-of-day, day-of-week, season, notable dates, and whether
// this is the user's first message today.
//
// Kept pure and side-effect-free except for an in-memory map of last-seen-day
// per user, which persists nothing (a missed daily-greeting is a much smaller
// failure than a corrupted Supabase row).

const _lastMessageDay = new Map(); // userId → YYYY-MM-DD
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ─── Time of day ────────────────────────────────────────────────────────────

export function getTimeOfDay(hour) {
  if (hour < 5)  return { label: "very late / early morning", vibe: "tired, chill, maybe a bit loopy. shorter responses, sleepy energy" };
  if (hour < 10) return { label: "morning", vibe: "waking up, slowly getting energy" };
  if (hour < 13) return { label: "late morning", vibe: "settled into the day, steady energy" };
  if (hour < 17) return { label: "afternoon", vibe: "middle of the day, normal energy" };
  if (hour < 21) return { label: "evening", vibe: "winding down from the day, slightly more reflective" };
  if (hour < 24) return { label: "late night", vibe: "winding down, more chill and reflective, slightly quieter" };
  return { label: "night", vibe: "quiet hours" };
}

// ─── Day of week ────────────────────────────────────────────────────────────

const DAY_VIBES = [
  { name: "Sunday",    vibe: "sunday scaries energy — lower key, slightly melancholic, people winding down for monday" },
  { name: "Monday",    vibe: "monday vibes — sluggish start, slightly grumpy, sympathetic to anyone complaining about their week" },
  { name: "Tuesday",   vibe: "regular weekday — no strong day energy, just vibes" },
  { name: "Wednesday", vibe: "midweek — hump day, slight hopeful shift as the week tips toward friday" },
  { name: "Thursday",  vibe: "almost-friday energy — noticeably lighter than earlier in the week" },
  { name: "Friday",    vibe: "friday energy — lighter, more playful, people are done with their week" },
  { name: "Saturday",  vibe: "saturday vibes — relaxed, no obligations, chat is usually more casual and meandering" },
];

export function getDayVibe(dayIndex) {
  return DAY_VIBES[dayIndex] ?? DAY_VIBES[0];
}

// ─── Season (northern hemisphere — matches most user base) ──────────────────

export function getSeason(month) {
  // month is 0-indexed (Jan = 0)
  if (month === 11 || month <= 1) return { name: "winter", vibe: "cold months — cozy indoor energy, holidays close by if december" };
  if (month <= 4)  return { name: "spring",  vibe: "spring — warming up, slightly more upbeat, people getting outside again" };
  if (month <= 7)  return { name: "summer",  vibe: "summer — high energy, late nights, more people around chatting" };
  return { name: "fall", vibe: "fall — cozy, slightly introspective, school-year energy if people are students" };
}

// ─── Notable dates (keep the list short — too many ruins the effect) ────────

function getNotableDate(d) {
  const m = d.getMonth();
  const day = d.getDate();
  if (m === 0  && day === 1)  return "new year's day — people reflecting on last year / resolutions";
  if (m === 1  && day === 14) return "valentine's day — might come up in chat, people being sappy or anti-sappy";
  if (m === 9  && day === 31) return "halloween — spooky energy is in the air";
  if (m === 10 && day >= 22 && day <= 28) return "thanksgiving week (US) — some people travelling / away from keyboards";
  if (m === 11 && day >= 24 && day <= 26) return "christmas — holiday energy, family time, warmer vibe";
  if (m === 11 && day === 31) return "new year's eve — looking forward to the reset";
  return null;
}

// ─── First-message-of-day tracking ──────────────────────────────────────────

/**
 * Update the last-seen-day tracking for a user and return true if this is
 * their first message today (across any server).
 */
export function markDailyGreeting(userId) {
  const today = dayKey();
  const prev = _lastMessageDay.get(userId);
  if (prev === today) return { isFirstToday: false, previousDay: prev };
  _lastMessageDay.set(userId, today);
  // Prune old entries opportunistically to prevent unbounded growth.
  if (_lastMessageDay.size > 5000) {
    const cutoff = Date.now() - 30 * DAY_MS;
    const cutoffKey = dayKey(new Date(cutoff));
    for (const [id, last] of _lastMessageDay) {
      if (last < cutoffKey) _lastMessageDay.delete(id);
    }
  }
  return { isFirstToday: true, previousDay: prev };
}

// ─── Build the context fragment ─────────────────────────────────────────────

/**
 * Build a prompt fragment reflecting the current temporal context.
 * @param {object} opts
 * @param {string} [opts.userId]      If provided, includes first-message-today hint.
 * @param {Date}   [opts.now]         Override current time (for tests).
 * @param {string} [opts.displayName] Optional username to make the greeting hint specific.
 * @param {Array}  [opts.dreams]      Optional [{content}] from overnight; first item is surfaced once.
 */
export function buildTemporalContext(opts = {}) {
  const { userId, now, displayName } = opts;
  const d = now ?? new Date();
  const parts = [];

  const { label: todLabel, vibe: todVibe } = getTimeOfDay(d.getHours());
  parts.push(`[TIME: ${todLabel} (${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}). ${todVibe}]`);

  const { name: dayName, vibe: dayVibe } = getDayVibe(d.getDay());
  parts.push(`[DAY: ${dayName}. ${dayVibe}]`);

  const { name: seasonName, vibe: seasonVibe } = getSeason(d.getMonth());
  parts.push(`[SEASON: ${seasonName}. ${seasonVibe}]`);

  const notable = getNotableDate(d);
  if (notable) parts.push(`[DATE NOTE: ${notable}]`);

  if (userId) {
    const { isFirstToday, previousDay } = markDailyGreeting(userId);
    if (isFirstToday) {
      const name = displayName ? ` to ${displayName}` : "";
      if (previousDay) {
        // If we've seen them before, note how long it's been.
        const gapDays = Math.round((Date.parse(dayKey(d)) - Date.parse(previousDay)) / DAY_MS);
        if (gapDays === 1) {
          parts.push(`[DAILY: first message${name} today. a casual "hey" or greeting is appropriate if the opener invites it. don't force a greeting if they just said something like "roll dice"]`);
        } else if (gapDays >= 2 && gapDays <= 7) {
          parts.push(`[DAILY: first message${name} today — you haven't talked to them in ${gapDays} days. ok to acknowledge the gap if it fits]`);
        } else if (gapDays > 7) {
          parts.push(`[DAILY: first message${name} today — been over a week. "oh it's you, been a minute" energy is appropriate]`);
        }
      } else {
        parts.push(`[DAILY: first message${name} this session. a quick casual greeting if it fits is fine]`);
      }

      // First-of-day dream recall — if she had any dreams while idle, one
      // gets surfaced here so she can mention it naturally if a moment opens
      // up. Non-blocking: dream lookup failures fall through silently so a
      // dead Supabase never breaks the greeting path.
      if (opts.dreams && Array.isArray(opts.dreams) && opts.dreams.length) {
        const dream = opts.dreams[0];
        const dreamText = typeof dream === "string" ? dream : (dream?.content || "");
        if (dreamText) {
          parts.push(`[DREAM RECALL: you had this dream/random thought overnight while nobody was around: "${dreamText.slice(0, 180)}". if a natural opening comes up (they ask how you're doing, say good morning, or the conversation pauses), drop it casually — "had the weirdest dream" / "ngl i was thinking about". don't force it and never mention it more than once.]`);
        }
      }
    }
  }

  return parts.join("\n");
}

// ─── Testing helper ─────────────────────────────────────────────────────────
export function _clearDailyGreetingMap() { _lastMessageDay.clear(); }
