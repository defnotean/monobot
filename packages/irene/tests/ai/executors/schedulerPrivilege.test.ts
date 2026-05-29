import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

const db = vi.hoisted(() => ({
  addReminder: vi.fn(),
  removeReminder: vi.fn(),
  addScheduledTask: vi.fn(),
  getScheduledTasks: vi.fn(() => []),
  getScheduledTask: vi.fn(),
  removeScheduledTask: vi.fn(() => ({ changes: 1 })),
  flushNow: vi.fn(async () => undefined),
  getSupabase: vi.fn(() => null),
  getTrustedUsers: vi.fn(() => [] as string[]),
}));

const executor = vi.hoisted(() => ({
  executeTool: vi.fn(async () => "executed"),
  findMember: vi.fn(),
}));

vi.mock("../../../database.js", () => db);
vi.mock("../../../ai/executor.js", () => executor);
vi.mock("../../../utils/logger.js", () => ({
  log: vi.fn(),
  sendModLog: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { execute as executeAdvanced } from "../../../ai/executors/advancedExecutor.js";
// @ts-expect-error - importing JS module without types
import { armScheduledTask, scheduledTaskTimers } from "../../../utils/scheduler.js";

function clearScheduledTimers() {
  for (const timer of scheduledTaskTimers.values()) clearTimeout(timer);
  scheduledTaskTimers.clear();
}

function buildMessage({ admin = false, owner = false } = {}) {
  const authorId = "200000000000000002";
  const guild: any = {
    id: "100000000000000001",
    ownerId: owner ? authorId : "999999999999999999",
    name: "Test Guild",
  };
  const member: any = {
    id: authorId,
    guild,
    permissions: {
      has: vi.fn((perm: bigint) =>
        admin && (perm === PermissionFlagsBits.Administrator || perm === PermissionFlagsBits.ManageGuild)
      ),
    },
  };
  const channel: any = {
    id: "300000000000000003",
    send: vi.fn(async () => ({})),
  };
  const client: any = {
    guilds: { cache: new Map([[guild.id, guild]]) },
    users: { fetch: vi.fn(async () => ({ id: authorId, username: "regular" })) },
  };
  guild.channels = {
    cache: new Map([[channel.id, channel]]),
    fetch: vi.fn(async () => channel),
  };
  guild.members = {
    fetch: vi.fn(async () => member),
  };

  return {
    author: { id: authorId, username: "regular" },
    member,
    guild,
    channel,
    client,
  } as any;
}

function buildCtx(guild: any) {
  return {
    guild,
    findChannel: vi.fn(),
    findRole: vi.fn(),
    findRoles: vi.fn(() => []),
    findMember: vi.fn(),
    webRateLimitPerMin: 10,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getTrustedUsers.mockReturnValue([]);
  db.addScheduledTask.mockImplementation((guildId, channelId, authorId, toolName, toolInput, fireAt, note) => ({
    id: 42,
    guildId,
    channelId,
    authorId,
    toolName,
    toolInput,
    fireAt,
    note,
  }));
  executor.executeTool.mockResolvedValue("executed");
  clearScheduledTimers();
});

afterEach(() => {
  clearScheduledTimers();
  vi.useRealTimers();
});

describe("schedule_task privilege boundaries", () => {
  it.each(["trust_user", "trust", "set_log_channel"])(
    "rejects non-admin attempts to schedule admin-only tool %s",
    async (toolName) => {
      const message = buildMessage();

      const result = await executeAdvanced(
        "schedule_task",
        {
          delay_seconds: 3,
          tool_name: toolName,
          tool_input: { username: "target" },
        },
        message,
        buildCtx(message.guild),
      );

      expect(String(result)).toMatch(/admin/i);
      expect(db.addScheduledTask).not.toHaveBeenCalled();
      expect(scheduledTaskTimers.size).toBe(0);
    },
  );

  it("still lets a regular user schedule an everyone-safe tool", async () => {
    const message = buildMessage();

    const result = await executeAdvanced(
      "schedule_task",
      {
        delay_seconds: 3,
        tool_name: "calculate",
        tool_input: { expression: "2 + 2" },
      },
      message,
      buildCtx(message.guild),
    );

    expect(String(result)).toContain("Scheduled task #42");
    expect(db.addScheduledTask).toHaveBeenCalledWith(
      message.guild.id,
      message.channel.id,
      message.author.id,
      "calculate",
      { expression: "2 + 2" },
      expect.any(Number),
      null,
    );
    expect(scheduledTaskTimers.size).toBe(1);
  });

  it("still lets an admin schedule an admin-only tool", async () => {
    const message = buildMessage({ admin: true });

    const result = await executeAdvanced(
      "schedule_task",
      {
        delay_seconds: 3,
        tool_name: "trust_user",
        tool_input: { username: "target" },
      },
      message,
      buildCtx(message.guild),
    );

    expect(String(result)).toContain("Scheduled task #42");
    expect(db.addScheduledTask).toHaveBeenCalledWith(
      message.guild.id,
      message.channel.id,
      message.author.id,
      "trust_user",
      { username: "target" },
      expect.any(Number),
      null,
    );
  });
});

describe("scheduled task fire-time privilege boundaries", () => {
  it.each(["trust_user", "trust", "set_log_channel"])(
    "drops queued admin-only tool %s when the scheduler is not admin at fire time",
    async (toolName) => {
      vi.useFakeTimers();
      const message = buildMessage();
      const task = {
        id: 77,
        guildId: message.guild.id,
        channelId: message.channel.id,
        authorId: message.author.id,
        toolName,
        toolInput: { username: "target" },
        fireAt: Date.now(),
      };

      expect(armScheduledTask(task, message.client)).toBe(0);
      await vi.runOnlyPendingTimersAsync();

      expect(executor.executeTool).not.toHaveBeenCalled();
      expect(db.removeScheduledTask).toHaveBeenCalledWith(task.id);
      expect(db.flushNow).toHaveBeenCalled();
    },
  );

  it("still executes an everyone-safe scheduled tool for a regular user", async () => {
    vi.useFakeTimers();
    const message = buildMessage();
    const task = {
      id: 78,
      guildId: message.guild.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      toolName: "calculate",
      toolInput: { expression: "6 * 7" },
      fireAt: Date.now(),
    };

    expect(armScheduledTask(task, message.client)).toBe(0);
    await vi.runOnlyPendingTimersAsync();

    expect(executor.executeTool).toHaveBeenCalledWith(
      "calculate",
      { expression: "6 * 7" },
      expect.objectContaining({ _scheduled: true }),
    );
    expect(db.removeScheduledTask).toHaveBeenCalledWith(task.id);
    expect(db.flushNow).toHaveBeenCalled();
  });
});
