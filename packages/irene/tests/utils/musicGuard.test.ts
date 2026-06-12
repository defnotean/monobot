// ─── musicGuard — shared DJ + same-VC playback authorization ─────────────────
//
// The guard is the single source of truth for "may this member control
// playback?" used by /skip /stop /pause /resume /volume /loop /shuffle and
// the AI music tool executor. Semantics mirror the control-panel button
// handler in events/interactionCreate.js:
//   same-VC  — Administrator permission or server owner bypasses
//   DJ role  — server owner / Manage Guild bypass; no-op when no role is set

import { describe, it, expect, vi, afterEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error — JS module, no types
import { checkDjAndSameVc, requireDjAndSameVc } from "../../utils/musicGuard.js";
// @ts-expect-error — JS module, no types
import { setDjRole, removeDjRole } from "../../commands/music/dj.js";

const BOT_ID = "bot-1";
const GUILD_ID = "g-1";

function makeGuild({ botVcId = "vc-bot" as string | null } = {}) {
  return {
    id: GUILD_ID,
    ownerId: "owner-1",
    client: { user: { id: BOT_ID } },
    members: {
      cache: new Map([[BOT_ID, { voice: { channel: botVcId ? { id: botVcId } : null } }]]),
    },
    roles: { cache: new Map([["dj-role", { name: "DJ" }]]) },
  };
}

function makeMember({
  id = "u-1",
  vcId = "vc-bot" as string | null,
  perms = [] as bigint[],
  roleIds = [] as string[],
} = {}) {
  return {
    id,
    voice: { channel: vcId ? { id: vcId } : null },
    permissions: { has: (p: bigint) => perms.includes(p) },
    roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
  };
}

afterEach(() => {
  removeDjRole(GUILD_ID);
});

describe("checkDjAndSameVc — same-VC rule", () => {
  it("allows a member sharing the bot's voice channel (no DJ role set)", () => {
    expect(checkDjAndSameVc(makeMember(), makeGuild())).toBeNull();
  });

  it("denies a member in a different voice channel", () => {
    const denial = checkDjAndSameVc(makeMember({ vcId: "vc-other" }), makeGuild());
    expect(denial?.reason).toBe("vc");
    expect(denial?.text).toMatch(/same voice channel/i);
  });

  it("denies a member not connected to voice at all", () => {
    const denial = checkDjAndSameVc(makeMember({ vcId: null }), makeGuild());
    expect(denial?.reason).toBe("vc");
  });

  it("denies when the bot is not in a voice channel (non-admin)", () => {
    const denial = checkDjAndSameVc(makeMember(), makeGuild({ botVcId: null }));
    expect(denial?.reason).toBe("vc");
  });

  it("Administrator bypasses the same-VC requirement", () => {
    const member = makeMember({ vcId: null, perms: [PermissionFlagsBits.Administrator] });
    expect(checkDjAndSameVc(member, makeGuild())).toBeNull();
  });

  it("the server owner bypasses the same-VC requirement", () => {
    const member = makeMember({ id: "owner-1", vcId: null });
    expect(checkDjAndSameVc(member, makeGuild())).toBeNull();
  });
});

describe("checkDjAndSameVc — DJ role rule", () => {
  it("denies a member without the configured DJ role", () => {
    setDjRole(GUILD_ID, "dj-role");
    const denial = checkDjAndSameVc(makeMember(), makeGuild());
    expect(denial?.reason).toBe("dj");
    expect(denial?.text).toContain("**DJ**");
  });

  it("allows a member holding the DJ role", () => {
    setDjRole(GUILD_ID, "dj-role");
    expect(checkDjAndSameVc(makeMember({ roleIds: ["dj-role"] }), makeGuild())).toBeNull();
  });

  it("Manage Guild bypasses the DJ role but NOT the same-VC rule", () => {
    setDjRole(GUILD_ID, "dj-role");
    const inVc = makeMember({ perms: [PermissionFlagsBits.ManageGuild] });
    expect(checkDjAndSameVc(inVc, makeGuild())).toBeNull();

    const outsideVc = makeMember({ vcId: "vc-other", perms: [PermissionFlagsBits.ManageGuild] });
    expect(checkDjAndSameVc(outsideVc, makeGuild())?.reason).toBe("vc");
  });

  it("the server owner bypasses the DJ role", () => {
    setDjRole(GUILD_ID, "dj-role");
    expect(checkDjAndSameVc(makeMember({ id: "owner-1" }), makeGuild())).toBeNull();
  });
});

describe("requireDjAndSameVc — slash command wrapper", () => {
  it("returns true without replying when allowed", async () => {
    const interaction = { member: makeMember(), guild: makeGuild(), reply: vi.fn(async () => {}) };
    expect(await requireDjAndSameVc(interaction)).toBe(true);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("replies ephemerally and returns false when denied", async () => {
    const interaction = {
      member: makeMember({ vcId: "vc-other" }),
      guild: makeGuild(),
      reply: vi.fn(async () => {}),
    };
    expect(await requireDjAndSameVc(interaction)).toBe(false);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = (interaction.reply as any).mock.calls[0][0];
    expect(payload.flags).toBe(64);
    expect(payload.embeds).toHaveLength(1);
  });
});
