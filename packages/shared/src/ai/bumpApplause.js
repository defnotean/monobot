// ─── Bump Applause ──────────────────────────────────────────────────────────
// After someone bumps, the bot gives them a quick shoutout in their own voice.
// Rotating pool of lines so it never feels scripted; context-aware so top
// bumpers / streak carriers get special flavor; rare "good boy" easter egg.
//
// Design rules:
//   - Applause skips during quiet hours (server config) so we don't make
//     noise when everyone's asleep.
//   - Applause skips when the first-bumper coin bonus already posted — the
//     coin message is itself a form of applause, and doubling up feels like
//     the bot is spamming.
//   - Applause skips if bump_applause_enabled is explicitly set to false.
//   - We REPLY to the bump-bot's confirm message rather than sending a new
//     channel message so the visual thread stays clean.
//
// Voice:
//   - Eris: chaotic, lowercase, mildly sarcastic, pg-13.
//   - Irene: warm, lowercase, gentler, softer internet-speak.
//   - Both share the same picker logic but draw from different pools.
//
// Bot-local deps are injected via factory:
//
//   const applause = createBumpApplause({
//     getGuildSettings,       // (guildId) => settings | undefined
//     isQuietHoursActive,     // (settings, now?) => boolean
//     getSupabase,            // () => supabase client | null
//     getUserStreak,          // optional: (userId, guildId, service) => number
//     getBumpLeaderboard,     // optional: (guildId, opts) => row[]
//     log,                    // optional: (msg) => void
//   });
//   await applause.sendBumpApplause({ ... });

// ─── Tunables ───────────────────────────────────────────────────────────────

export const GOOD_BOY_CHANCE = 0.08;       // ~8% of bumps get the good-boy easter egg
export const TOP_BUMPER_RANK_THRESHOLD = 3; // if user is top-3 this week, flavor applies
export const STREAK_FLAVOR_MIN = 5;         // streak days needed for streak flavor
export const FIRST_OF_DAY_CHANCE = 0.45;    // when first-of-day applies, 45% chance we use that flavor
export const CONTEXTUAL_FLAVOR_CHANCE = 0.5; // top-bumper / streak flavors fire this often when eligible

// ─── Line pools ─────────────────────────────────────────────────────────────

export const ERIS_APPLAUSE = {
  // Broad "thanks for bumping" in her chaotic voice.
  default: [
    "ty {name} 🫡",
    "bumped. logged. canonized 📓",
    "ok the chosen one has bumped",
    "thats what we like to see {name}",
    "bump ceo activity detected",
    "{name} once again carrying",
    "the server thanks u personally {name}",
    "respect {name}",
    "logged in the ledger 📓",
    "ty king/queen {name}",
    "{name} the goat",
    "genuinely {name} saved us",
    "this is why we keep u around {name}",
    "{name} my hero",
    "adding this to the list of reasons ur cool {name}",
    "u bumped. the stars align. ty {name}",
    "ok hero of time {name}",
    "without {name} this server would be in shambles",
    "bumping activity detected. proceeding with approval. {name} certified",
    "yessir {name}",
    "bless {name}",
    "ok so {name} is literally the backbone of this operation",
    "the bump has been bumped. {name} credited",
    "ty for ur service to the nation {name}",
    "i love when {name} does this",
    "pinned in my heart fr {name}",
    "{name} cooking again",
    "W bump from {name} as usual",
    "{name} absolute unit",
    "chefs kiss {name} 🤌",
  ],

  // Rare easter egg — the meme the user specifically asked for.
  // Mixed phrasings so it doesnt always land as the exact same joke.
  goodBoy: [
    "good boy {name} 🐕",
    "atta boy {name}",
    "whos a good bumper?? {name} is. yes u are",
    "*pats {name} on the head* good boy",
    "{name} deserves a treat fr",
    "such a good lil bumper {name}",
    "awww good boy {name} 🐾 go get the ball",
    "good boy good boy good boy {name}",
    "{name} with the good behavior today. good boy",
    "sit. stay. bump. good boy {name}",
  ],

  // When user is a top-3 bumper this week (eligibility gated by caller).
  topBumper: [
    "the goat returns {name}",
    "{name} bump ceo back at it",
    "{name} single handedly keeping this server afloat",
    "our top bumper {name} reports for duty",
    "and {name} said 'not on my watch'",
    "{name} actually deranged about bumping and i respect it",
    "{name} AGAIN. at this point i owe u rent",
  ],

  // When this is the user's first bump of the day (eligibility gated by caller).
  firstOfDay: [
    "first bump of the day from {name}. love that for us",
    "{name} setting the tone today",
    "welcome back {name}, ur useful",
    "morning bump by {name}, we eating today",
    "{name} starting the day right",
  ],

  // When user has a meaningful personal streak (eligibility gated by caller).
  streakCarrier: [
    "the streakmaster {name}",
    "{name} {streak} days strong. the consistency is lowkey insane",
    "not letting the streak die on {name}'s watch i see",
    "{name} and the {streak}-day bump streak, a love story",
    "{streak} days. {name} is built different fr",
  ],
};

export const IRENE_APPLAUSE = {
  default: [
    "ty for the bump {name} 💞",
    "appreciate you {name}",
    "{name} you're the best 🩵",
    "bumped with love 🩵 ty {name}",
    "we love a bumper. thanks {name}",
    "thank u sm {name}",
    "real one behavior {name}",
    "{name} keeps this server alive fr",
    "hero of the day: {name}",
    "where would we be without u {name}",
    "{name} u get a gold star ⭐",
    "thank u thank u {name}",
    "{name} literally a blessing",
    "logged with love 🩵 ty {name}",
    "noted and appreciated {name}",
    "{name} out here being helpful",
    "you're so good {name}",
    "aww ty {name}",
    "{name} carrying the team 🫶",
    "the softest bump from {name} 🩵",
    "gentle applause for {name} 👏",
    "the {name}wagon rolls on",
    "{name} never misses",
    "🌸 ty {name} 🌸",
    "{name} ty ily",
  ],

  goodBoy: [
    "good boy {name} 🐾",
    "thats my good bumper {name} 🩵",
    "*pets {name} gently*",
    "who's a good boy?? {name} is 🐕",
    "good boy {name}, ur getting a treat",
    "such a sweetie {name}. good job",
    "{name}, good boy / good girl / good bumper, all of the above",
    "soft head pat for {name} 🐾",
  ],

  topBumper: [
    "{name} this week's mvp 💫",
    "our top bumper {name} reporting in 🩵",
    "{name} doing the lord's work",
    "the reliable one strikes again: {name}",
    "{name} always comes through",
  ],

  firstOfDay: [
    "first of the day from {name} 🌅",
    "{name} starting us off right today",
    "good morning {name}! ty for the opener 🩵",
    "{name} setting a lovely tone",
  ],

  streakCarrier: [
    "{name} and the {streak}-day streak 🩵",
    "{streak} days in a row thanks to {name}",
    "{name} keeping the streak alive",
    "{name} devoted as always — {streak} days strong",
  ],
};

const POOLS = {
  eris: ERIS_APPLAUSE,
  irene: IRENE_APPLAUSE,
};

// ─── Picker ─────────────────────────────────────────────────────────────────

function pickFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Choose an applause line for a bumper.
 *
 * Category priority (each gated by a random roll so the default pool still
 * wins most of the time):
 *   1. goodBoy — pure RNG (~8%), highest priority if hit
 *   2. streakCarrier — fires if userStreak >= STREAK_FLAVOR_MIN and RNG <= CONTEXTUAL_FLAVOR_CHANCE
 *   3. topBumper — fires if isTopBumper and RNG <= CONTEXTUAL_FLAVOR_CHANCE
 *   4. firstOfDay — fires if isFirstOfDay and RNG <= FIRST_OF_DAY_CHANCE
 *   5. default — everything else
 *
 * The caller supplies `rng` for deterministic tests. Real usage defaults to Math.random.
 *
 * @param {object} opts
 * @param {string} opts.name     Display name of bumper ("@user" or bare name).
 * @param {string} opts.botName  "eris" or "irene" — picks the right pool.
 * @param {boolean} [opts.isTopBumper]  True when this user is top-3 this week.
 * @param {boolean} [opts.isFirstOfDay] True when this is their first bump today.
 * @param {number}  [opts.userStreak]   User's current personal streak in days.
 * @param {() => number} [opts.rng]     Injected randomness (for tests).
 */
export function pickApplauseLine({
  name,
  botName = "eris",
  isTopBumper = false,
  isFirstOfDay = false,
  userStreak = 0,
  rng = Math.random,
} = {}) {
  const pool = POOLS[botName] || POOLS.eris;
  const safeName = name || "bumper";

  // 1. Good boy easter egg — trumps everything when it hits.
  if (rng() < GOOD_BOY_CHANCE) {
    return render(pickFrom(pool.goodBoy), { name: safeName, streak: userStreak });
  }

  // 2. Streak carrier — noticeable personal streak.
  if (userStreak >= STREAK_FLAVOR_MIN && rng() < CONTEXTUAL_FLAVOR_CHANCE) {
    return render(pickFrom(pool.streakCarrier), { name: safeName, streak: userStreak });
  }

  // 3. Top bumper flavor.
  if (isTopBumper && rng() < CONTEXTUAL_FLAVOR_CHANCE) {
    return render(pickFrom(pool.topBumper), { name: safeName, streak: userStreak });
  }

  // 4. First-of-day flavor.
  if (isFirstOfDay && rng() < FIRST_OF_DAY_CHANCE) {
    return render(pickFrom(pool.firstOfDay), { name: safeName, streak: userStreak });
  }

  // 5. Default pool.
  return render(pickFrom(pool.default), { name: safeName, streak: userStreak });
}

function render(tpl, vars) {
  return tpl
    .replace(/\{name\}/g, vars.name)
    .replace(/\{streak\}/g, String(vars.streak ?? 0));
}

const _noop = () => {};

/**
 * Build a sendBumpApplause function bound to a bot's deps.
 *
 * @param {object} deps
 * @param {(guildId: string) => any} deps.getGuildSettings
 *   Returns the per-guild settings record (used to gate on bump_applause_enabled).
 * @param {(settings: any) => boolean} deps.isQuietHoursActive
 *   Used to suppress applause during configured quiet hours.
 * @param {() => any} [deps.getSupabase]
 *   Optional. If present, used for first-of-day detection. Skipped on null.
 * @param {(userId: string, guildId: string, service: string) => Promise<number>} [deps.getUserStreak]
 *   Optional. If present, enriches the applause line with the user's streak.
 * @param {(guildId: string, opts: object) => Promise<any[]>} [deps.getBumpLeaderboard]
 *   Optional. If present, lets us flag top-3 bumpers for the topBumper flavor.
 * @param {(msg: string) => void} [deps.log]  Optional logger.
 */
export function createBumpApplause(deps = {}) {
  const {
    getGuildSettings,
    isQuietHoursActive,
    getSupabase,
    getUserStreak,
    getBumpLeaderboard,
    log,
  } = deps;
  if (typeof getGuildSettings !== "function") {
    throw new Error("createBumpApplause: getGuildSettings function is required");
  }
  if (typeof isQuietHoursActive !== "function") {
    throw new Error("createBumpApplause: isQuietHoursActive function is required");
  }
  const _log = typeof log === "function" ? log : _noop;

  /**
   * Send an applause reply to a bump confirmation. Self-contained — gathers
   * all the context it needs, respects server config, fails silently on any
   * error so the scheduler path isn't impacted.
   *
   * The caller (handleBumpConfirm) should invoke this AFTER recordBump has
   * run and AFTER payFirstBumperBonus has been attempted, passing whether the
   * bonus actually paid so we can skip the applause in that case.
   */
  async function sendBumpApplause({
    bumpMessage,       // Discord message from the bump bot (we reply to this)
    guildId,
    bumperId,
    bumperName,        // pre-resolved display name (caller has a Guild instance, easier there)
    service,           // "disboard" | "discadia" | ...
    bumpsTable,        // "eris_bumps" | "irene_bumps"
    botName = "eris",
    firstBumperBonusPaid = false, // if the coin bonus already posted, skip
  }) {
    try {
      const settings = getGuildSettings(guildId) || {};
      if (settings.bump_applause_enabled === false) return;
      if (firstBumperBonusPaid) return;
      if (isQuietHoursActive(settings)) return;
      if (!bumpMessage?.reply) return;

      // Enrich context best-effort.
      let userStreak = 0;
      let isTopBumper = false;
      try {
        const [streak, lb] = await Promise.all([
          typeof getUserStreak === "function"
            ? getUserStreak(bumperId, guildId, service)
            : Promise.resolve(0),
          typeof getBumpLeaderboard === "function"
            ? getBumpLeaderboard(guildId, { limit: TOP_BUMPER_RANK_THRESHOLD, periodDays: 7, service })
            : Promise.resolve([]),
        ]);
        userStreak = streak || 0;
        isTopBumper = Array.isArray(lb) && lb.some(r => r.user_id === bumperId);
      } catch {}

      // First-of-day detection — at most one row for this user today in this
      // guild means this is their first bump of the day.
      let isFirstOfDay = false;
      try {
        const sb = typeof getSupabase === "function" ? getSupabase() : null;
        if (sb && bumpsTable) {
          const startOfToday = new Date();
          startOfToday.setUTCHours(0, 0, 0, 0);
          const { count } = await sb.from(bumpsTable)
            .select("id", { count: "exact", head: true })
            .eq("guild_id", guildId)
            .eq("user_id", bumperId)
            .gte("bumped_at", startOfToday.toISOString());
          // We call this AFTER recordBump, so a count of exactly 1 means
          // this bump was the first.
          isFirstOfDay = count === 1;
        }
      } catch {}

      const name = bumperName ? `@${bumperName}` : `<@${bumperId}>`;
      const line = pickApplauseLine({
        name,
        botName,
        isTopBumper,
        isFirstOfDay,
        userStreak,
      });

      await bumpMessage.reply({
        content: line,
        allowedMentions: { parse: [], users: [bumperId] },
      });
    } catch (e) {
      _log(`[BUMP] Applause send failed: ${e.message}`);
    }
  }

  return { sendBumpApplause };
}

// ─── Testing helpers ───────────────────────────────────────────────────────
export const _internal = { render, POOLS, pickFrom };
