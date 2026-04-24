// ─── guildMemberAdd ─────────────────────────────────────────────────────────
// Minimal handler — all we need for Eris is the bump-correlation tracker.
// If more join behavior is added later, keep those side effects in their own
// modules and call them from here so this file stays thin.

import { recordJoinForCorrelation } from "../ai/bumpCorrelation.js";
import { log } from "../utils/logger.js";

export default async function guildMemberAdd(member) {
  if (!member?.guild?.id || !member.id || member.user?.bot) return;
  try {
    await recordJoinForCorrelation({
      guildId: member.guild.id,
      userId: member.id,
      joinedAtMs: member.joinedTimestamp ?? Date.now(),
      botName: "eris",
    });
  } catch (e) {
    log(`[Join] correlation record failed: ${e.message}`);
  }
}
