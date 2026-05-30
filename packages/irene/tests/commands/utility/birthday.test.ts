import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeUser, makeGuild, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";

// In-memory backing store for the mocked database module.
const store = {
  birthdays: new Map<string, any>(), // key `${userId}-${guildId}`
  config: new Map<string, any>(),
};

vi.mock("../../../database.js", () => ({
  setBirthday: (...a: any[]) => mockSetBirthday(...a),
  removeBirthday: (...a: any[]) => mockRemoveBirthday(...a),
  getBirthday: (...a: any[]) => mockGetBirthday(...a),
  getGuildBirthdays: (...a: any[]) => mockGetGuildBirthdays(...a),
  getBirthdayConfig: (...a: any[]) => mockGetBirthdayConfig(...a),
  setBirthdayChannel: (...a: any[]) => mockSetBirthdayChannel(...a),
  setBirthdayRole: (...a: any[]) => mockSetBirthdayRole(...a),
  setBirthdayMessage: (...a: any[]) => mockSetBirthdayMessage(...a),
}));

let mockSetBirthday: any, mockRemoveBirthday: any, mockGetBirthday: any,
  mockGetGuildBirthdays: any, mockGetBirthdayConfig: any,
  mockSetBirthdayChannel: any, mockSetBirthdayRole: any, mockSetBirthdayMessage: any;

import * as birthdayCmd from "../../../commands/utility/birthday.js";

beforeEach(() => {
  mockSetBirthday = vi.fn();
  mockRemoveBirthday = vi.fn();
  mockGetBirthday = vi.fn();
  mockGetGuildBirthdays = vi.fn(() => []);
  mockGetBirthdayConfig = vi.fn(() => ({}));
  mockSetBirthdayChannel = vi.fn();
  mockSetBirthdayRole = vi.fn();
  mockSetBirthdayMessage = vi.fn();
});

function bday(opts: { sub: string; options?: any; perms?: bigint[]; user?: any }) {
  const user = opts.user ?? makeUser({ id: "u1", username: "Birthday" });
  const guild = makeGuild({ id: "g1", name: "Server" });
  return makeInteraction({
    user,
    guild,
    subcommand: opts.sub,
    options: opts.options ?? {},
    permissions: opts.perms ?? [],
  });
}

describe("utility/birthday set", () => {
  it("rejects an out-of-range day for the chosen month without writing", async () => {
    const interaction = bday({ sub: "set", options: { month: 2, day: 30, year: null } });
    await birthdayCmd.execute(interaction);
    expect(mockSetBirthday).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toContain("February only has");
    expect(interaction.reply.mock.calls[0][0].ephemeral).toBe(true);
  });

  it("persists a valid birthday and confirms with the formatted date", async () => {
    const interaction = bday({ sub: "set", options: { month: 6, day: 15, year: 2000 } });
    await birthdayCmd.execute(interaction);
    expect(mockSetBirthday).toHaveBeenCalledWith("u1", "g1", 6, 15, 2000);
    expect(repliedText(interaction)).toContain("June 15, 2000");
  });

  it("omits the year when not provided", async () => {
    const interaction = bday({ sub: "set", options: { month: 3, day: 9, year: null } });
    await birthdayCmd.execute(interaction);
    expect(mockSetBirthday).toHaveBeenCalledWith("u1", "g1", 3, 9, null);
    // no-year branch formats "**March 9**" (no year suffix like ", 2000")
    expect(repliedText(interaction)).toContain("**March 9**");
    expect(repliedText(interaction)).not.toMatch(/March 9,\s*\d{4}/);
  });
});

describe("utility/birthday view", () => {
  it("reports when the target has no birthday set", async () => {
    mockGetBirthday.mockReturnValue(null);
    const interaction = bday({ sub: "view", options: { user: null } });
    await birthdayCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("haven't");
  });

  it("shows the days-until label for an existing birthday", async () => {
    // a birthday far enough that it is in the future this year
    const future = new Date(Date.now() + 5 * 86400000);
    mockGetBirthday.mockReturnValue({ month: future.getMonth() + 1, day: future.getDate() });
    const interaction = bday({ sub: "view", options: { user: null } });
    await birthdayCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("birthday is");
  });
});

describe("utility/birthday remove", () => {
  it("confirms removal when a birthday existed", async () => {
    mockRemoveBirthday.mockReturnValue(true);
    const interaction = bday({ sub: "remove" });
    await birthdayCmd.execute(interaction);
    expect(mockRemoveBirthday).toHaveBeenCalledWith("u1", "g1");
    expect(repliedText(interaction)).toContain("has been removed");
  });

  it("notes there was nothing to remove otherwise", async () => {
    mockRemoveBirthday.mockReturnValue(false);
    const interaction = bday({ sub: "remove" });
    await birthdayCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("don't have a birthday");
  });
});

describe("utility/birthday setup (permission gate)", () => {
  it("refuses members lacking ManageGuild and never writes config", async () => {
    const interaction = bday({
      sub: "setup",
      perms: [],
      options: { channel: { id: "c1", toString: () => "<#c1>" }, role: null, message: null },
    });
    await birthdayCmd.execute(interaction);
    expect(mockSetBirthdayChannel).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toContain("Manage Server");
  });

  it("saves channel (and optional role/message) for a member with ManageGuild", async () => {
    const interaction = bday({
      sub: "setup",
      perms: [PermissionFlagsBits.ManageGuild],
      options: {
        channel: { id: "chan-9", toString: () => "<#chan-9>" },
        role: { id: "role-9", toString: () => "<@&role-9>" },
        message: "Happy bday {user}",
      },
    });
    await birthdayCmd.execute(interaction);
    expect(mockSetBirthdayChannel).toHaveBeenCalledWith("g1", "chan-9");
    expect(mockSetBirthdayRole).toHaveBeenCalledWith("g1", "role-9");
    expect(mockSetBirthdayMessage).toHaveBeenCalledWith("g1", "Happy bday {user}");
  });
});

describe("utility/birthday config", () => {
  it("renders the current configuration with channel + registered count", async () => {
    mockGetBirthdayConfig.mockReturnValue({ channel_id: "c5", role_id: "r5", message: "hi" });
    mockGetGuildBirthdays.mockReturnValue([{}, {}, {}]);
    const interaction = bday({ sub: "config" });
    await birthdayCmd.execute(interaction);
    const payload = interaction.reply.mock.calls[0][0];
    const embed = payload.embeds[0].data ?? payload.embeds[0];
    expect(embed.title).toContain("Birthday Config");
    const f = (n: string) => embed.fields.find((x: any) => x.name === n)?.value;
    expect(f("Registered Birthdays")).toBe("3");
    expect(f("Announcement Channel")).toContain("c5");
  });
});
