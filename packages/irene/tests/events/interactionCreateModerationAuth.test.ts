import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../database.js", () => ({
  getColorRoles: vi.fn(() => []),
  getGuildSettings: vi.fn(() => ({})),
  logAudit: vi.fn(),
  addTempBan: vi.fn(),
  deleteWarning: vi.fn(() => ({ changes: 1 })),
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
vi.mock("../../utils/twinPunish.js", () => ({ firePunishSignal: vi.fn(async () => undefined) }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../events/interactionCreate.js";
// @ts-expect-error - importing JS module without types
import { createPendingAction, getPendingAction } from "../../ai/executors/moderationExecutor.js";

function permissions(...granted: bigint[]) {
  return { has: (permission: bigint) => granted.includes(permission) };
}

function buildInteraction(customId: string, granted: bigint[] = []) {
  const botId = "999999999999999999";
  const guild: any = {
    id: "888888888888888888",
    ownerId: "777777777777777777",
    bans: { fetch: vi.fn() },
    members: { fetch: vi.fn(), unban: vi.fn() },
    roles: { cache: new Map() },
  };
  const interaction: any = {
    customId,
    guild,
    member: { id: "666666666666666666", permissions: permissions(...granted) },
    user: { id: "666666666666666666", tag: "moderator#0001" },
    client: { user: { id: botId } },
    message: {
      author: { id: botId },
      components: [{}],
      embeds: [],
      edit: vi.fn(async () => {}),
    },
    isButton: vi.fn(() => true),
    isStringSelectMenu: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  };
  return interaction;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moderation confirmation authorization", () => {
  it("does not let an unauthorized member cancel another moderator's pending action", async () => {
    const token = createPendingAction({
      action: "ban_user",
      input: { username: "victim" },
      requiredPerm: PermissionFlagsBits.BanMembers,
      targetId: "123456789012345678",
    });
    const interaction = buildInteraction(`modcancel:${token}`);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/permission/i),
    }));
    expect(interaction.update).not.toHaveBeenCalled();
    expect(getPendingAction(token)).not.toBeNull();
  });

  it("still lets an authorized moderator cancel a pending action", async () => {
    const token = createPendingAction({
      action: "ban_user",
      input: { username: "victim" },
      requiredPerm: PermissionFlagsBits.BanMembers,
      targetId: "123456789012345678",
    });
    const interaction = buildInteraction(`modcancel:${token}`, [PermissionFlagsBits.BanMembers]);

    await execute(interaction);

    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/cancelled/i),
    }));
    expect(getPendingAction(token)).toBeNull();
  });
});

describe("mod-log undo authorization", () => {
  it("does not let ManageGuild unban a member through the bot", async () => {
    const interaction = buildInteraction("modundo:ban:123456789012345678", [PermissionFlagsBits.ManageGuild]);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/permission/i),
    }));
    expect(interaction.guild.bans.fetch).not.toHaveBeenCalled();
    expect(interaction.guild.members.unban).not.toHaveBeenCalled();
  });

  it("lets a BanMembers moderator unban a member", async () => {
    const interaction = buildInteraction("modundo:ban:123456789012345678", [PermissionFlagsBits.BanMembers]);
    interaction.guild.bans.fetch.mockResolvedValue({ user: { tag: "victim#0001" } });

    await execute(interaction);

    expect(interaction.guild.members.unban).toHaveBeenCalledWith(
      "123456789012345678",
      expect.stringMatching(/reversed via mod-log/i),
    );
  });

  it("does not let ManageGuild clear a timeout through the bot", async () => {
    const interaction = buildInteraction("modundo:timeout:123456789012345678", [PermissionFlagsBits.ManageGuild]);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/permission/i),
    }));
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
  });

  it("lets a ModerateMembers moderator clear a timeout", async () => {
    const interaction = buildInteraction("modundo:timeout:123456789012345678", [PermissionFlagsBits.ModerateMembers]);
    const target = {
      user: { tag: "victim#0001" },
      isCommunicationDisabled: vi.fn(() => true),
      timeout: vi.fn(async () => {}),
    };
    interaction.guild.members.fetch.mockResolvedValue(target);

    await execute(interaction);

    expect(target.timeout).toHaveBeenCalledWith(null, expect.stringMatching(/reversed via mod-log/i));
  });
});
