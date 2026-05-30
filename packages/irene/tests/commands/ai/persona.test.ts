// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const personaState = { current: null };

vi.mock("../../../database.js", () => ({
  getServerPersona: vi.fn(() => personaState.current),
  setServerPersona: vi.fn(),
  getTrustedUsers: vi.fn(() => []),
}));

vi.mock("../../../config.js", () => ({
  default: { botPersonality: "You are Irene, a helpful assistant." },
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import { getServerPersona, setServerPersona } from "../../../database.js";
import { execute, data } from "../../../commands/ai/persona.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeGuild,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

// persona.js calls interaction.guild.members.me.setNickname(...).catch(...)
function withSetNickname(guild) {
  guild.members.me.setNickname = vi.fn(async () => {});
  return guild;
}

beforeEach(() => {
  vi.clearAllMocks();
  personaState.current = null;
});

describe("/persona", () => {
  it("declares the persona command", () => {
    expect(data.name).toBe("persona");
  });

  it("blocks non-admin/non-owner before any subcommand work", async () => {
    const interaction = makeInteraction({
      subcommand: "view",
      options: {},
      permissions: [],
    });
    await execute(interaction);
    expect(getServerPersona).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("view: shows default when no persona set", async () => {
    personaState.current = null;
    const interaction = makeInteraction({
      subcommand: "view",
      options: {},
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("Irene");
    expect(text).toMatch(/Default \(no override set\)/i);
  });

  it("view: shows a stored persona with truncated personality", async () => {
    personaState.current = { name: "Gremlin", personality: "z".repeat(500) };
    const interaction = makeInteraction({
      subcommand: "view",
      options: {},
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("Gremlin");
    // truncated to 400 + ellipsis
    expect(text).toContain("…");
  });

  it("reset: clears persona and renames the bot back to Irene", async () => {
    const guild = withSetNickname(makeGuild());
    const interaction = makeInteraction({
      guild,
      subcommand: "reset",
      options: {},
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setServerPersona).toHaveBeenCalledWith(guild.id, null);
    expect(guild.members.me.setNickname).toHaveBeenCalledWith("Irene");
    expect(repliedText(interaction)).toMatch(/Persona Reset/i);
  });

  it("set: rejects names longer than 80 chars", async () => {
    const guild = withSetNickname(makeGuild());
    const interaction = makeInteraction({
      guild,
      subcommand: "set",
      options: { name: "n".repeat(81) },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setServerPersona).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Name Too Long/i);
  });

  it("set: auto-generates personality from the default template when none given", async () => {
    const guild = withSetNickname(makeGuild());
    const interaction = makeInteraction({
      guild,
      subcommand: "set",
      options: { name: "Bender" },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setServerPersona).toHaveBeenCalledTimes(1);
    const [, payload] = setServerPersona.mock.calls[0];
    expect(payload.name).toBe("Bender");
    // The default "Irene" in the template is replaced with the new name.
    expect(payload.personality).toContain("Bender");
    expect(payload.personality).not.toContain("Irene");
    expect(guild.members.me.setNickname).toHaveBeenCalledWith("Bender");
    expect(repliedText(interaction)).toMatch(/auto-generated/i);
  });

  it("set: uses the provided custom personality verbatim (trimmed)", async () => {
    const guild = withSetNickname(makeGuild());
    const interaction = makeInteraction({
      guild,
      subcommand: "set",
      options: { name: "Sage", personality: "  be wise and calm  " },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    const [, payload] = setServerPersona.mock.calls[0];
    expect(payload.personality).toBe("be wise and calm");
    expect(repliedText(interaction)).toMatch(/custom personality/i);
  });
});
