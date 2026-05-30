import { describe, it, expect, vi, beforeEach } from "vitest";

let store: Record<string, any> = {};

vi.mock("../../../database.js", () => ({
  getGuildSettings: vi.fn(() => store),
  setGuildSetting: vi.fn((_g: string, key: string, val: any) => {
    store = { ...store, [key]: val };
  }),
}));

import { makeInteraction, makeRole, makeChannel, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { execute } from "../../../commands/utility/bumpconfig.js";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("bumpconfig command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = {};
  });

  it("rejects use in DMs (no guild)", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "show" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  describe("role group", () => {
    it("add: adds a new role", async () => {
      const role = makeRole({ id: "r1" });
      const interaction: any = makeInteraction({
        subcommandGroup: "role", subcommand: "add", options: { role },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_ping_roles", ["r1"]);
      expect(getLastReplyContent(interaction)).toMatch(/added/);
    });

    it("add: refuses a duplicate role", async () => {
      store = { bump_ping_roles: ["r1"] };
      const role = makeRole({ id: "r1" });
      const interaction: any = makeInteraction({
        subcommandGroup: "role", subcommand: "add", options: { role },
      });
      await execute(interaction);
      expect(m.setGuildSetting).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/already in the list/);
    });

    it("remove: removes an existing role", async () => {
      store = { bump_ping_roles: ["r1", "r2"] };
      const role = makeRole({ id: "r1" });
      const interaction: any = makeInteraction({
        subcommandGroup: "role", subcommand: "remove", options: { role },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_ping_roles", ["r2"]);
      expect(getLastReplyContent(interaction)).toMatch(/removed/);
    });

    it("remove: reports when the role wasn't in the list", async () => {
      store = { bump_ping_roles: ["r2"] };
      const role = makeRole({ id: "r1" });
      const interaction: any = makeInteraction({
        subcommandGroup: "role", subcommand: "remove", options: { role },
      });
      await execute(interaction);
      expect(m.setGuildSetting).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/wasn't in the list/);
    });

    it("clear: empties the role list", async () => {
      store = { bump_ping_roles: ["r1", "r2"] };
      const interaction: any = makeInteraction({ subcommandGroup: "role", subcommand: "clear" });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_ping_roles", []);
    });

    it("rotation: stores the rotation mode", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: "role", subcommand: "rotation", options: { mode: "rotate" },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_rotation_mode", "rotate");
      expect(getLastReplyContent(interaction)).toMatch(/rotation mode: rotate/);
    });
  });

  describe("service group", () => {
    it("enable: adds a service to the default list", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: "service", subcommand: "enable", options: { which: "discadia" },
      });
      await execute(interaction);
      // defaults to ["disboard"], then push discadia
      expect(m.setGuildSetting).toHaveBeenCalledWith(
        interaction.guild.id, "bump_enabled_services", ["disboard", "discadia"],
      );
    });

    it("disable: removes a service", async () => {
      store = { bump_enabled_services: ["disboard", "discadia"] };
      const interaction: any = makeInteraction({
        subcommandGroup: "service", subcommand: "disable", options: { which: "disboard" },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(
        interaction.guild.id, "bump_enabled_services", ["discadia"],
      );
    });
  });

  describe("standalone subcommands", () => {
    it("channel: clears when no channel given", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "channel", options: {},
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_reminder_channel_id", null);
      expect(getLastReplyContent(interaction)).toMatch(/reminder channel cleared/);
    });

    it("channel: rejects a non-text channel", async () => {
      const channel = makeChannel({ id: "c1", textBased: false });
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "channel", options: { channel },
      });
      await execute(interaction);
      expect(m.setGuildSetting).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/pick a text channel/);
    });

    it("channel: stores a valid text channel", async () => {
      const channel = makeChannel({ id: "c1", textBased: true });
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "channel", options: { channel },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_reminder_channel_id", "c1");
    });

    it("quiet: rejects an invalid timezone", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "quiet",
        options: { start_hour: 22, end_hour: 8, timezone: "Not/AReal_Zone" },
      });
      await execute(interaction);
      expect(m.setGuildSetting).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/invalid timezone/);
    });

    it("quiet: stores valid quiet hours", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "quiet",
        options: { start_hour: 22, end_hour: 8, timezone: "America/Los_Angeles" },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(
        interaction.guild.id, "bump_quiet_hours", { start: 22, end: 8, tz: "America/Los_Angeles" },
      );
    });

    it("template: clears template when text is empty", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "template", options: {},
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_template", null);
      expect(getLastReplyContent(interaction)).toMatch(/custom template cleared/);
    });

    it("template: saves and previews with variable substitution", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "template",
        options: { text: "time to {command} on {service} for {guildName}!" },
      });
      await execute(interaction);
      const [, key, val] = m.setGuildSetting.mock.calls[0];
      expect(key).toBe("bump_template");
      expect(val).toContain("{command}"); // stored raw
      // preview substitutes the vars
      expect(getLastReplyContent(interaction)).toMatch(/\/bump on DISBOARD/);
    });

    it("no_show_toggle: stores boolean and echoes state", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "no_show_toggle", options: { enabled: false },
      });
      await execute(interaction);
      expect(m.setGuildSetting).toHaveBeenCalledWith(interaction.guild.id, "bump_no_show_escalate", false);
      expect(getLastReplyContent(interaction)).toMatch(/no-show escalation disabled/);
    });

    it("celebration_template: clears category when text empty", async () => {
      store = { bump_celebration_templates: { milestone: "x", goal_hit: "y" } };
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "celebration_template",
        options: { category: "milestone", text: "  " },
      });
      await execute(interaction);
      const [, key, val] = m.setGuildSetting.mock.calls.at(-1)!;
      expect(key).toBe("bump_celebration_templates");
      expect(val).toEqual({ goal_hit: "y" }); // milestone removed
      expect(getLastReplyContent(interaction)).toMatch(/cleared custom template for `milestone`/);
    });

    it("celebration_template: saves with sample preview substitution", async () => {
      const interaction: any = makeInteraction({
        subcommandGroup: null, subcommand: "celebration_template",
        options: { category: "milestone", text: "streak {streak} hit!" },
      });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/streak 30 hit!/);
    });

    it("show: renders a configuration summary embed reflecting stored settings", async () => {
      store = {
        bump_ping_roles: ["r1"],
        bump_enabled_services: ["disboard", "discadia"],
        bump_rotation_mode: "rotate",
        bump_applause_enabled: false,
      };
      const interaction: any = makeInteraction({ subcommandGroup: null, subcommand: "show" });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/Bump config/);
      const rotation = data.fields.find((f: any) => f.name === "Rotation mode");
      expect(rotation.value).toBe("rotate");
      const applause = data.fields.find((f: any) => f.name === "Post-bump applause");
      expect(applause.value).toBe("off");
    });
  });
});
