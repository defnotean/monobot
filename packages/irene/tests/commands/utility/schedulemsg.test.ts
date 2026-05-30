import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeChannel, makeClient, repliedText } from "../../_helpers/mockDiscord.js";

import * as sched from "../../../commands/utility/schedulemsg.js";

function memberPerms(granted: string[]) {
  return { has: (name: string) => granted.includes(name) };
}

// A text channel whose permissionsFor() reports the bot's send capability.
function targetChannel(botCanSend = true) {
  const ch = makeChannel({ id: "target-chan", name: "announcements" });
  ch.permissionsFor = vi.fn(() => ({ has: (n: string) => (n === "SendMessages" ? botCanSend : false) }));
  return ch;
}

function sendInteraction(opts: Record<string, any>, perms = ["ManageMessages"]) {
  const guild = makeGuild();
  const client = makeClient();
  const interaction = makeInteraction({ guild, client, subcommand: "send", options: opts });
  interaction.memberPermissions = memberPerms(perms);
  return interaction;
}

describe("utility/schedulemsg", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Each test below uses a UNIQUE guild id, so the module-level
    // scheduledMessages map cannot leak between tests.
  });

  it("declares the schedulemsg command", () => {
    expect(sched.data.name).toBe("schedulemsg");
  });

  it("denies members lacking ManageMessages", async () => {
    const interaction = sendInteraction({ channel: targetChannel(), time: "30m", message: "hi" }, []);
    await sched.execute(interaction);
    expect(repliedText(interaction).toLowerCase()).toContain("permission");
  });

  it("rejects an unparseable time string", async () => {
    const interaction = sendInteraction({ channel: targetChannel(), time: "whenever", message: "hello world" });
    await sched.execute(interaction);
    expect(repliedText(interaction)).toContain("Invalid Time");
  });

  it("rejects when the bot cannot send in the target channel", async () => {
    const interaction = sendInteraction({ channel: targetChannel(false), time: "1h", message: "hi" });
    await sched.execute(interaction);
    expect(repliedText(interaction)).toContain("Permission Denied");
  });

  it("schedules a relative-time message and confirms with an id", async () => {
    const guild = makeGuild({ id: "guild-sched-A" });
    const client = makeClient();
    const interaction = makeInteraction({ guild, client, subcommand: "send", options: { channel: targetChannel(), time: "2h", message: "stand-up reminder", repeat: "daily" } });
    interaction.memberPermissions = memberPerms(["ManageMessages"]);

    await sched.execute(interaction);

    const text = repliedText(interaction);
    expect(text).toContain("message scheduled");
    expect(text).toContain("ID:");
    // persisted into store for this guild
    const stored = sched.getScheduleData()["guild-sched-A"];
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe("stand-up reminder");
    expect(stored[0].repeat).toBe("daily");
    expect(stored[0].nextRunAt).toBeGreaterThan(Date.now());
  });

  it("lists 'no scheduled messages' for an empty guild", async () => {
    const guild = makeGuild({ id: "guild-empty" });
    const interaction = makeInteraction({ guild, subcommand: "list" });
    interaction.memberPermissions = memberPerms(["ManageMessages"]);
    await sched.execute(interaction);
    expect(repliedText(interaction)).toContain("No Scheduled Messages");
  });

  it("cancels an existing scheduled message and 404s on an unknown id", async () => {
    const guild = makeGuild({ id: "guild-cancel" });
    const client = makeClient();
    const base = { guild, client };

    // schedule one
    const add = makeInteraction({ ...base, subcommand: "send", options: { channel: targetChannel(), time: "3h", message: "to be cancelled" } });
    add.memberPermissions = memberPerms(["ManageMessages"]);
    await sched.execute(add);
    const id = sched.getScheduleData()["guild-cancel"][0].id;

    // cancel an id that doesn't exist
    const missing = makeInteraction({ ...base, subcommand: "cancel", options: { id: 9999 } });
    missing.memberPermissions = memberPerms(["ManageMessages"]);
    await sched.execute(missing);
    expect(repliedText(missing)).toContain("Not Found");

    // cancel the real one
    const cancel = makeInteraction({ ...base, subcommand: "cancel", options: { id } });
    cancel.memberPermissions = memberPerms(["ManageMessages"]);
    await sched.execute(cancel);
    expect(repliedText(cancel)).toContain("Cancelled");
    expect(sched.getScheduleData()["guild-cancel"]).toHaveLength(0);
  });
});
