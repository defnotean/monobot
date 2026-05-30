// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn(), sendModLog: vi.fn(async () => {}) }));
vi.mock("../../../database.js", () => ({
  getRules: vi.fn(() => []),
  addRule: vi.fn(() => ({ success: true, rule: { number: 1, severity: "medium", text: "be nice" } })),
  removeRule: vi.fn(() => ({ success: true, removed: { text: "old", severity: "low" } })),
  clearRules: vi.fn(() => ({ count: 0 })),
  setAutoModEnabled: vi.fn(),
  isAutoModEnabled: vi.fn(() => false),
  getExemptions: vi.fn(() => []),
  addExemption: vi.fn(() => ({ success: true })),
  removeExemption: vi.fn(() => ({ success: true })),
}));
vi.mock("../../../ai/providers/index.js", () => ({ quickReply: vi.fn(async () => "[]") }));

import * as rules from "../../../commands/moderation/rules.js";
import {
  getRules, addRule, removeRule, clearRules, setAutoModEnabled, addExemption,
} from "../../../database.js";
import { quickReply } from "../../../ai/providers/index.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember, makeChannel,
  makePermissions, repliedText, lastReply, PermissionFlagsBits, Collection,
} from "../../_helpers/mockDiscord.js";

function setup({ perms = [PermissionFlagsBits.ManageGuild], subcommand = "status", options = {}, guildId } = {}) {
  const guild = makeGuild({});
  const invoker = makeUser({ tag: "admin#0001" });
  const member = makeMember({ user: invoker, guild, permissions: perms });
  const interaction = makeInteraction({ guild, user: invoker, member, subcommand, options });
  // rules.js reads interaction.memberPermissions and interaction.guildId.
  interaction.memberPermissions = makePermissions(perms);
  if (guildId !== undefined) interaction.guildId = guildId;
  return { interaction, guild };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRules.mockReturnValue([]);
});

describe("rules command", () => {
  it("declares rules metadata", () => {
    expect(rules.data.name).toBe("rules");
  });

  it("refuses an invoker without ManageGuild", async () => {
    const { interaction } = setup({ perms: [], subcommand: "status" });
    await rules.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Server/i);
    expect(setAutoModEnabled).not.toHaveBeenCalled();
  });

  it("refuses outside a guild (no guildId)", async () => {
    const { interaction } = setup({ subcommand: "status", guildId: null });
    await rules.execute(interaction);
    expect(repliedText(interaction)).toMatch(/only works in servers/i);
  });

  it("add: stores a rule via addRule and confirms", async () => {
    addRule.mockReturnValueOnce({ success: true, rule: { number: 4, severity: "high", text: "no doxxing" } });
    const { interaction } = setup({ subcommand: "add", options: { text: "no doxxing", severity: "high" } });
    await rules.execute(interaction);
    expect(addRule).toHaveBeenCalledWith(interaction.guildId, "no doxxing", "high", interaction.user.id);
    expect(repliedText(interaction)).toMatch(/rule #4 added/i);
  });

  it("add: surfaces the failure reason when addRule rejects", async () => {
    addRule.mockReturnValueOnce({ success: false, reason: "duplicate" });
    const { interaction } = setup({ subcommand: "add", options: { text: "dup" } });
    await rules.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/couldn't add: duplicate/i);
  });

  it("remove: surfaces the failure reason when removeRule rejects", async () => {
    removeRule.mockReturnValueOnce({ success: false, reason: "no such rule" });
    const { interaction } = setup({ subcommand: "remove", options: { number: 99 } });
    await rules.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/no such rule/i);
  });

  it("enable: refuses to enable auto-mod when there are no rules", async () => {
    getRules.mockReturnValue([]);
    const { interaction } = setup({ subcommand: "enable" });
    await rules.execute(interaction);
    expect(setAutoModEnabled).not.toHaveBeenCalled();
    expect(lastReply(interaction).content).toMatch(/no rules stored/i);
  });

  it("enable: turns auto-mod on when rules exist", async () => {
    getRules.mockReturnValue([{ number: 1, severity: "low", text: "be nice" }]);
    const { interaction } = setup({ subcommand: "enable" });
    await rules.execute(interaction);
    expect(setAutoModEnabled).toHaveBeenCalledWith(interaction.guildId, true);
    expect(repliedText(interaction)).toMatch(/auto-mod ENABLED/i);
  });

  it("disable: turns auto-mod off", async () => {
    const { interaction } = setup({ subcommand: "disable" });
    await rules.execute(interaction);
    expect(setAutoModEnabled).toHaveBeenCalledWith(interaction.guildId, false);
    expect(repliedText(interaction)).toMatch(/auto-mod DISABLED/i);
  });

  it("exempt: rejects a rule number that does not exist", async () => {
    getRules.mockReturnValue([{ number: 1, severity: "low", text: "x" }]);
    const target = makeUser({ tag: "vip#0001" });
    const { interaction } = setup({ subcommand: "exempt", options: { user: target, rule: 99 } });
    await rules.execute(interaction);
    expect(addExemption).not.toHaveBeenCalled();
    expect(lastReply(interaction).content).toMatch(/no rule numbered 99/i);
  });

  it("exempt: adds a global exemption when no rule number is given", async () => {
    const target = makeUser({ tag: "vip#0001" });
    const { interaction } = setup({ subcommand: "exempt", options: { user: target } });
    await rules.execute(interaction);
    expect(addExemption).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/exemption added/i);
    expect(repliedText(interaction)).toMatch(/ALL rules/i);
  });

  it("learn: reports usable-text failure when the channel is empty", async () => {
    const channel = makeChannel({ name: "rules" });
    channel.messages.fetch = vi.fn(async () => new Collection()); // no messages -> corpus too short
    const { interaction } = setup({ subcommand: "learn", options: { channel } });
    await rules.execute(interaction);
    expect(quickReply).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/no usable text content/i);
  });

  it("status: shows rule and exemption counts", async () => {
    getRules.mockReturnValue([{ number: 1, severity: "low", text: "x" }]);
    const { interaction } = setup({ subcommand: "status" });
    await rules.execute(interaction);
    expect(repliedText(interaction)).toMatch(/auto-mod status/i);
    expect(repliedText(interaction)).toMatch(/rules.*1/i);
  });
});
