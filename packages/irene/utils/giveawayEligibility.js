// ─── Giveaway entry eligibility ─────────────────────────────────────────────
// Pure check: given a giveaway's anti-alt requirements and the entrant's
// account/tenure timestamps, can they enter? Used by /giveaway's button
// handler to reject sub-threshold entries with a clear reason.
//
// Inputs are timestamps (ms since epoch) so the function has no Discord
// dependency and is trivially unit-testable.
//
// Returns:
//   { ok: true }                                                            — eligible
//   { ok: false, reason: "account_too_young", required, actual }            — Discord account younger than min
//   { ok: false, reason: "tenure_too_short", required, actual }             — joined this guild less ago than min
//   { ok: false, reason: "no_member_data" }                                 — guildJoinedAtMs missing (uncached member)

const MS_PER_DAY = 86_400_000;

export function checkEligibility({
  accountCreatedAtMs,
  guildJoinedAtMs,
  minAccountAgeDays = 0,
  minTenureDays = 0,
  now = Date.now(),
}) {
  if (minAccountAgeDays > 0) {
    if (!Number.isFinite(accountCreatedAtMs)) {
      return { ok: false, reason: "no_account_data" };
    }
    const ageMs = now - accountCreatedAtMs;
    const requiredMs = minAccountAgeDays * MS_PER_DAY;
    if (ageMs < requiredMs) {
      return {
        ok: false,
        reason: "account_too_young",
        required: minAccountAgeDays,
        actualDays: Math.floor(ageMs / MS_PER_DAY),
      };
    }
  }

  if (minTenureDays > 0) {
    if (!Number.isFinite(guildJoinedAtMs)) {
      return { ok: false, reason: "no_member_data" };
    }
    const tenureMs = now - guildJoinedAtMs;
    const requiredMs = minTenureDays * MS_PER_DAY;
    if (tenureMs < requiredMs) {
      return {
        ok: false,
        reason: "tenure_too_short",
        required: minTenureDays,
        actualDays: Math.floor(tenureMs / MS_PER_DAY),
      };
    }
  }

  return { ok: true };
}

/**
 * Format an eligibility-failure result into a user-facing message.
 * Returns null if eligible.
 */
export function formatRejection(result) {
  if (!result || result.ok) return null;
  switch (result.reason) {
    case "account_too_young":
      return `your Discord account is too new for this giveaway. requires ${result.required}d account age, you're at ${result.actualDays}d.`;
    case "tenure_too_short":
      return `you haven't been in this server long enough. requires ${result.required}d tenure, you're at ${result.actualDays}d.`;
    case "no_account_data":
      return "couldn't read your account creation date — try again.";
    case "no_member_data":
      return "couldn't read your join date for this server — try again.";
    default:
      return "you're not eligible for this giveaway.";
  }
}

/**
 * Build a "requirements" string for the giveaway embed. Returns null if no
 * requirements are set (so the caller can skip the field entirely).
 */
export function describeRequirements({ minAccountAgeDays = 0, minTenureDays = 0 } = {}) {
  const parts = [];
  if (minAccountAgeDays > 0) parts.push(`account ≥ ${minAccountAgeDays}d old`);
  if (minTenureDays > 0) parts.push(`in server ≥ ${minTenureDays}d`);
  return parts.length ? parts.join(" · ") : null;
}
