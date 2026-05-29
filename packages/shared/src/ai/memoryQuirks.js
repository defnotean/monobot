// ─── Memory Quirks ──────────────────────────────────────────────────────────
// Perfect recall is the #1 tell that a bot is a bot. This module injects rare
// hints telling the model to hedge, misremember, or self-correct. Fully
// stateless — pure randomness per call.
//
// The injection rate is deliberately low (~3%). Too frequent and she looks
// demented; too rare and she stays uncannily precise.

const QUIRK_HINTS = [
  {
    id: "blank_on_specific",
    text: "[MEMORY QUIRK: you're blanking slightly on a specific detail. if you reference a past fact about this user, hedge like \"wait was that you or [someone] who said...\" then proceed anyway. do this at most once. never fake-remember something you don't have in context]",
  },
  {
    id: "misattribution",
    text: "[MEMORY QUIRK: you might be mixing up two users in your head. if you bring up someone else's preference, add \"or maybe that was someone else, i forget\". keeps you honest]",
  },
  {
    id: "self_correct",
    text: "[MEMORY QUIRK: willingness to self-correct is elevated right now. if you say something and immediately realize it's wrong or phrased badly, follow up with a short \"wait no\" or \"* [correction]\" — real people do this]",
  },
  {
    id: "fuzzy_timing",
    text: "[MEMORY QUIRK: your sense of when things happened is fuzzy today. if you reference \"last week\" or \"a few days ago\", hedge with \"i think\" or \"don't quote me on the timing\"]",
  },
  {
    id: "name_fuzz",
    text: "[MEMORY QUIRK: you almost forgot their name for a second. if it fits, acknowledge it playfully (\"hey... [name], right?\"), but only do this if you'd actually be recalling their username — don't force it]",
  },
  {
    id: "topic_drift",
    text: "[MEMORY QUIRK: you lost the thread of the conversation momentarily. if the user's latest message is ambiguous, ask what they were referring to rather than guessing]",
  },
];

/**
 * Maybe return a memory-quirk hint. Returns empty string most of the time.
 * Override the chance with `opts.chance` (useful for tests / higher realism).
 * @param {{ chance?: number, excludeIds?: string[] }} [opts]
 */
export function getMemoryQuirkHint(opts = {}) {
  const chance = opts.chance ?? 0.03;
  if (Math.random() > chance) return "";
  // Exclude quirks by id if caller asks (e.g. name_fuzz when no username is set).
  const excludeIds = opts.excludeIds;
  const pool = excludeIds?.length
    ? QUIRK_HINTS.filter(q => !excludeIds.includes(q.id))
    : QUIRK_HINTS;
  if (!pool.length) return "";
  return pool[Math.floor(Math.random() * pool.length)].text;
}

export const _QUIRKS_FOR_TEST = QUIRK_HINTS;
