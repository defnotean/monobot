import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeChannel, getReplies, repliedText } from "../../_helpers/mockDiscord.js";

const settingsStore = new Map<string, any>();

vi.mock("../../../database.js", () => ({
  setGuildSetting: (gid: string, key: string, value: any) => {
    const cur = settingsStore.get(gid) ?? {};
    cur[key] = value;
    settingsStore.set(gid, cur);
  },
}));

vi.mock("../../../ai/weeklyDigest.js", () => ({
  buildDigest: (...a: any[]) => mockBuildDigest(...a),
  postDigest: (...a: any[]) => mockPostDigest(...a),
}));

let mockBuildDigest: any, mockPostDigest: any;

import * as digestCmd from "../../../commands/utility/digest.js";

beforeEach(() => {
  settingsStore.clear();
  mockBuildDigest = vi.fn();
  mockPostDigest = vi.fn();
});

function inter(sub: string, options: any = {}) {
  return makeInteraction({ guild: makeGuild({ id: "g1", name: "S" }), subcommand: sub, options });
}

describe("utility/digest now", () => {
  it("defers then edits with the generated digest embed", async () => {
    const embed = { data: { title: "Digest" } };
    mockBuildDigest.mockResolvedValue(embed);
    const interaction = inter("now", { days: 7 });
    await digestCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(mockBuildDigest).toHaveBeenCalledWith(interaction.guild, { days: 7 });
    const replies = getReplies(interaction);
    const edit = replies.find((r: any) => r.kind === "editReply");
    expect(edit.payload.embeds[0]).toBe(embed);
  });

  it("reports no activity when buildDigest returns nothing", async () => {
    mockBuildDigest.mockResolvedValue(null);
    const interaction = inter("now", { days: 3 });
    await digestCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("no activity in the last 3 days");
  });

  it("defaults the lookback window to 7 days when omitted", async () => {
    mockBuildDigest.mockResolvedValue(null);
    const interaction = inter("now", { days: null });
    await digestCmd.execute(interaction);
    expect(mockBuildDigest).toHaveBeenCalledWith(interaction.guild, { days: 7 });
  });
});

describe("utility/digest channel", () => {
  it("persists the chosen auto-post channel", async () => {
    const ch = makeChannel({ id: "c1" });
    const interaction = inter("channel", { channel: ch });
    await digestCmd.execute(interaction);
    expect(settingsStore.get("g1").digest_channel_id).toBe("c1");
    expect(repliedText(interaction)).toContain("weekly digests will post");
  });
});

describe("utility/digest post", () => {
  it("confirms a successful post", async () => {
    mockPostDigest.mockResolvedValue({ posted: true });
    const interaction = inter("post");
    await digestCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("posted");
  });

  it("surfaces the failure reason when posting fails", async () => {
    mockPostDigest.mockResolvedValue({ posted: false, reason: "no channel set" });
    const interaction = inter("post");
    await digestCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("no channel set");
  });
});

describe("utility/digest disable", () => {
  it("clears the configured channel", async () => {
    settingsStore.set("g1", { digest_channel_id: "old" });
    const interaction = inter("disable");
    await digestCmd.execute(interaction);
    expect(settingsStore.get("g1").digest_channel_id).toBeNull();
    expect(repliedText(interaction)).toContain("disabled");
  });
});
