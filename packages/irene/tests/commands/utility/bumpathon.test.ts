import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, repliedText } from "../../_helpers/mockDiscord.js";

const settingsStore = new Map<string, any>();

vi.mock("../../../database.js", () => ({
  getGuildSettings: (gid: string) => settingsStore.get(gid) ?? {},
  setGuildSetting: (gid: string, key: string, value: any) => {
    const cur = settingsStore.get(gid) ?? {};
    cur[key] = value;
    settingsStore.set(gid, cur);
  },
  getSupabase: () => null,
}));

import * as bumpathonCmd from "../../../commands/utility/bumpathon.js";

beforeEach(() => settingsStore.clear());

function inter(sub: string, options: any = {}, guild: any = makeGuild({ id: "g1", name: "S" })) {
  return makeInteraction({ guild, user: makeUser({ id: "u1" }), subcommand: sub, options });
}

describe("utility/bumpathon", () => {
  it("requires a guild context", async () => {
    const interaction = makeInteraction({ subcommand: "status" });
    interaction.guild = null;
    await bumpathonCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("only works in servers");
  });

  it("start persists the event config and announces goal + ending time", async () => {
    const interaction = inter("start", { goal: 50, hours: 24 });
    const before = Date.now();
    await bumpathonCmd.execute(interaction);
    const after = Date.now();

    const saved = settingsStore.get("g1").bumpathon;
    expect(saved.goal).toBe(50);
    expect(saved.startedBy).toBe("u1");
    expect(saved.endsAt).toBeGreaterThanOrEqual(before + 24 * 3600000);
    expect(saved.endsAt).toBeLessThanOrEqual(after + 24 * 3600000);
    expect(repliedText(interaction)).toContain("BUMP-A-THON STARTED");
  });

  it("status reports no active event when none is set", async () => {
    const interaction = inter("status");
    await bumpathonCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("no active bump-a-thon");
  });

  it("status reports no active event when the saved one has expired", async () => {
    settingsStore.set("g1", { bumpathon: { goal: 10, startedAt: 0, endsAt: Date.now() - 1000, startedBy: "x" } });
    const interaction = inter("status");
    await bumpathonCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("no active bump-a-thon");
  });

  it("cancel clears the event and confirms", async () => {
    settingsStore.set("g1", { bumpathon: { goal: 10, startedAt: 0, endsAt: Date.now() + 1000, startedBy: "x" } });
    const interaction = inter("cancel");
    await bumpathonCmd.execute(interaction);
    expect(settingsStore.get("g1").bumpathon).toBeNull();
    expect(repliedText(interaction)).toContain("cancelled");
  });
});
