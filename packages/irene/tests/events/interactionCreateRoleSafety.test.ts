import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../database.js", () => ({
  getColorRoles: vi.fn(() => []),
  getCustomCommand: vi.fn(),
  setCustomCommand: vi.fn(),
  deleteCustomCommand: vi.fn(),
  listCustomCommands: vi.fn(() => []),
}));

vi.mock("../../utils/vcpanel.js", () => ({
  handlePanelInteraction: vi.fn(),
  handlePanelModal: vi.fn(),
  handlePanelSelect: vi.fn(),
}));
vi.mock("../../commands/utility/embed.js", () => ({ handleEmbedModal: vi.fn() }));
vi.mock("../../commands/fun/giveaway.js", () => ({ handleGiveawayButton: vi.fn() }));
vi.mock("../../commands/fun/polladvanced.js", () => ({ handlePollButton: vi.fn() }));
vi.mock("../../commands/setup/setup-wizard.js", () => ({ handleSetupWizard: vi.fn() }));
vi.mock("../../commands/setup/ticket.js", () => ({ handleTicketWizard: vi.fn() }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../events/interactionCreate.js";
import { makeGuild, makeMember, makePermissions, makeRole, makeUser } from "../_helpers/mockDiscord.js";

function buildInteraction() {
  const role = makeRole({
    id: "danger-role",
    name: "Adminish",
    position: 2,
    permissions: makePermissions([PermissionFlagsBits.ManageRoles]),
  });
  const guild = makeGuild({
    roles: [role],
    botPermissions: [PermissionFlagsBits.ManageRoles],
    botHighestRolePosition: 100,
  });
  const member = makeMember({
    user: makeUser({ id: "user-1", username: "user", tag: "user#0001" }),
    guild,
    permissions: [],
    highestRolePosition: 50,
  });
  guild.members.cache.set(member.id, member);

  const interaction: any = {
    customId: `toggle_role:${role.id}`,
    guild,
    member,
    client: { user: guild.members.me.user },
    isButton: vi.fn(() => true),
    isStringSelectMenu: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  return { interaction, member, role };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("interaction role safety", () => {
  it("blocks legacy role-toggle buttons that point at dangerous roles", async () => {
    const { interaction, member } = buildInteraction();

    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/elevated permissions/i),
    }));
    expect(member.roles.add).not.toHaveBeenCalled();
  });
});
