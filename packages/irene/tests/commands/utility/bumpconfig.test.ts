import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, makeChannel, makeRole, repliedText } from "../../_helpers/mockDiscord.js";

const settingsStore = new Map<string, any>();

vi.mock("../../../database.js", () => ({
  getGuildSettings: (gid: string) => settingsStore.get(gid) ?? {},
  setGuildSetting: (gid: string, key: string, value: any) => {
    const cur = settingsStore.get(gid) ?? {};
    cur[key] = value;
    settingsStore.set(gid, cur);
  },
}));

import * as bumpconfigCmd from "../../../commands/utility/bumpconfig.js";

beforeEach(() => settingsStore.clear());

function inter(opts: { group?: string; sub: string; options?: any }) {
  return makeInteraction({
    guild: makeGuild({ id: "g1", name: "S" }),
    user: makeUser({ id: "u1" }),
    subcommand: opts.sub,
    subcommandGroup: opts.group,
    options: opts.options ?? {},
  });
}

describe("utility/bumpconfig guild guard", () => {
  it("requires a guild context", async () => {
    const interaction = makeInteraction({ subcommand: "show" });
    interaction.guild = null;
    await bumpconfigCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("only works in servers");
  });
});

describe("utility/bumpconfig role group", () => {
  it("add appends a new role id and persists it", async () => {
    const interaction = inter({ group: "role", sub: "add", options: { role: makeRole({ id: "r1" }) } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_ping_roles).toEqual(["r1"]);
    expect(repliedText(interaction)).toContain("added");
  });

  it("add refuses a duplicate role without re-persisting", async () => {
    settingsStore.set("g1", { bump_ping_roles: ["r1"] });
    const interaction = inter({ group: "role", sub: "add", options: { role: makeRole({ id: "r1" }) } });
    await bumpconfigCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("already in the list");
    expect(settingsStore.get("g1").bump_ping_roles).toEqual(["r1"]);
  });

  it("remove deletes a present role", async () => {
    settingsStore.set("g1", { bump_ping_roles: ["r1", "r2"] });
    const interaction = inter({ group: "role", sub: "remove", options: { role: makeRole({ id: "r1" }) } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_ping_roles).toEqual(["r2"]);
    expect(repliedText(interaction)).toContain("removed");
  });

  it("remove warns when the role was not in the list", async () => {
    settingsStore.set("g1", { bump_ping_roles: ["r2"] });
    const interaction = inter({ group: "role", sub: "remove", options: { role: makeRole({ id: "r1" }) } });
    await bumpconfigCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("wasn't in the list");
  });

  it("rotation stores the chosen mode", async () => {
    const interaction = inter({ group: "role", sub: "rotation", options: { mode: "rotate" } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_rotation_mode).toBe("rotate");
  });
});

describe("utility/bumpconfig service group", () => {
  it("enable adds the service to the enabled list", async () => {
    const interaction = inter({ group: "service", sub: "enable", options: { which: "discadia" } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_enabled_services).toContain("discadia");
  });

  it("disable removes the service", async () => {
    settingsStore.set("g1", { bump_enabled_services: ["disboard", "discadia"] });
    const interaction = inter({ group: "service", sub: "disable", options: { which: "discadia" } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_enabled_services).toEqual(["disboard"]);
  });
});

describe("utility/bumpconfig standalone subcommands", () => {
  it("quiet rejects an invalid timezone without saving", async () => {
    const interaction = inter({ sub: "quiet", options: { start_hour: 22, end_hour: 6, timezone: "Not/AZone" } });
    await bumpconfigCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("invalid timezone");
    expect(settingsStore.get("g1")?.bump_quiet_hours).toBeUndefined();
  });

  it("quiet saves valid hours + timezone", async () => {
    const interaction = inter({ sub: "quiet", options: { start_hour: 22, end_hour: 6, timezone: "America/Los_Angeles" } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_quiet_hours).toEqual({ start: 22, end: 6, tz: "America/Los_Angeles" });
  });

  it("channel clears the override when no channel is given", async () => {
    settingsStore.set("g1", { bump_reminder_channel_id: "old" });
    const interaction = inter({ sub: "channel", options: { channel: null } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_reminder_channel_id).toBeNull();
    expect(repliedText(interaction)).toContain("cleared");
  });

  it("channel rejects a non-text channel", async () => {
    const voiceCh = makeChannel({ id: "v1", type: 2, textBased: false });
    const interaction = inter({ sub: "channel", options: { channel: voiceCh } });
    await bumpconfigCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("text channel");
  });

  it("channel saves a valid text channel id", async () => {
    const textCh = makeChannel({ id: "t1", type: 0, textBased: true });
    const interaction = inter({ sub: "channel", options: { channel: textCh } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_reminder_channel_id).toBe("t1");
  });

  it("applause toggle persists the boolean", async () => {
    const interaction = inter({ sub: "applause", options: { enabled: false } });
    await bumpconfigCmd.execute(interaction);
    expect(settingsStore.get("g1").bump_applause_enabled).toBe(false);
    expect(repliedText(interaction)).toContain("applause off");
  });

  it("show renders the config embed with current values", async () => {
    settingsStore.set("g1", { bump_ping_roles: ["r1"], bump_rotation_mode: "rotate", bump_mvp_enabled: false });
    const interaction = inter({ sub: "show" });
    await bumpconfigCmd.execute(interaction);
    const payload = interaction.reply.mock.calls[0][0];
    const embed = payload.embeds[0].data ?? payload.embeds[0];
    expect(embed.title).toContain("Bump config");
    const f = (n: string) => embed.fields.find((x: any) => x.name === n)?.value;
    expect(f("Rotation mode")).toBe("rotate");
    expect(f("Weekly MVP DM")).toBe("off");
  });
});
