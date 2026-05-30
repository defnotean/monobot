import { describe, it, expect, vi, beforeEach } from "vitest";

const settingsStore: Record<string, any> = {};

vi.mock("../../../database.js", () => ({
  getGuildSettings: vi.fn(() => settingsStore.current),
  setGuildSetting: vi.fn((_g: string, key: string, val: any) => {
    settingsStore.current = { ...(settingsStore.current || {}), [key]: val };
  }),
  // dynamic import("../../../database.js") in status reads getSupabase
  getSupabase: vi.fn(() => null),
}));

import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { execute } from "../../../commands/utility/bumpathon.js";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("bumpathon command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.current = {};
  });

  it("rejects use in DMs (no guild)", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  it("start: persists the event config and posts a goal embed", async () => {
    const interaction: any = makeInteraction({
      subcommand: "start",
      options: { goal: 25, hours: 12 },
    });
    await execute(interaction);

    expect(m.setGuildSetting).toHaveBeenCalledTimes(1);
    const [, key, val] = m.setGuildSetting.mock.calls[0];
    expect(key).toBe("bumpathon");
    expect(val.goal).toBe(25);
    expect(val.startedBy).toBe(interaction.user.id);
    expect(val.endsAt).toBe(val.startedAt + 12 * 60 * 60 * 1000);

    const data = getLastReply(interaction)?.payload.embeds[0].data;
    expect(data.title).toMatch(/BUMP-A-THON STARTED/);
    expect(data.description).toMatch(/goal: \*\*25\*\*/);
  });

  it("status: reports no active bump-a-thon when none configured", async () => {
    settingsStore.current = {};
    const interaction: any = makeInteraction({ subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/no active bump-a-thon/i);
  });

  it("status: treats an expired event as inactive", async () => {
    settingsStore.current = { bumpathon: { goal: 10, startedAt: 1, endsAt: Date.now() - 1000 } };
    const interaction: any = makeInteraction({ subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/no active bump-a-thon/i);
  });

  it("status: renders a progress bar for an active event (supabase null -> 0 progress)", async () => {
    settingsStore.current = {
      bumpathon: { goal: 10, startedAt: Date.now() - 1000, endsAt: Date.now() + 60_000 },
    };
    const interaction: any = makeInteraction({ subcommand: "status" });
    await execute(interaction);
    const data = getLastReply(interaction)?.payload.embeds[0].data;
    expect(data.title).toBe("Bump-a-thon status");
    expect(data.description).toMatch(/\*\*0 \/ 10\*\* bumps/);
    expect(data.description).toMatch(/0%/);
  });

  it("cancel: clears the stored event", async () => {
    settingsStore.current = { bumpathon: { goal: 10, startedAt: 1, endsAt: Date.now() + 1000 } };
    const interaction: any = makeInteraction({ subcommand: "cancel" });
    await execute(interaction);
    expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bumpathon", null);
    expect(getLastReplyContent(interaction)).toMatch(/cancelled/i);
  });
});
