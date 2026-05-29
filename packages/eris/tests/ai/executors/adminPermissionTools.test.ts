import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  directives: [] as Array<{ text: string; channel: string | null; addedBy: string }>,
}));

vi.mock("../../../database.js", () => ({
  getGuildSettings: vi.fn((guildId: string) => {
    const prefix = `${guildId}:`;
    const out: Record<string, unknown> = {};
    for (const [key, value] of state.settings.entries()) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    }
    return out;
  }),
  setGuildSetting: vi.fn((guildId: string, key: string, value: unknown) => {
    state.settings.set(`${guildId}:${key}`, value);
  }),
  addDirective: vi.fn((_guildId: string, text: string, channel: string | null, addedBy: string) => {
    state.directives.push({ text, channel, addedBy });
    return { success: true, index: state.directives.length - 1 };
  }),
  getDirectives: vi.fn(() => [...state.directives]),
  removeDirective: vi.fn((_guildId: string, indexOrKeyword: string | number) => {
    if (!state.directives.length) return { success: false, reason: "no directives saved" };
    const idx = typeof indexOrKeyword === "number"
      ? indexOrKeyword
      : state.directives.findIndex((d) => d.text.includes(String(indexOrKeyword)));
    if (idx < 0 || idx >= state.directives.length) return { success: false, reason: "directive not found" };
    state.directives.splice(idx, 1);
    return { success: true };
  }),
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../utils/pcAgent.js", () => ({ auditLog: vi.fn(async () => {}) }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/adminExecutor.js";
// @ts-expect-error - importing JS module without types
import * as db from "../../../database.js";
// @ts-expect-error - importing JS module without types
import * as perms from "../../../utils/permissions.js";
// @ts-expect-error - importing JS module without types
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../../ai/tools.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";
const REGULAR_ID = "999999999999999999";
const CUSTOMIZER_ID = "888888888888888888";
const ADMIN_ID = "777777777777777777";

function makeMessage({
  authorId = REGULAR_ID,
  guildOwnerId = CUSTOMIZER_ID,
  manageGuild = false,
}: {
  authorId?: string;
  guildOwnerId?: string;
  manageGuild?: boolean;
} = {}) {
  return {
    author: { id: authorId },
    guild: {
      id: GUILD_ID,
      ownerId: guildOwnerId,
      channels: { cache: new Map() },
    },
    member: {
      permissions: {
        has: vi.fn((perm: string) => manageGuild && perm === "ManageGuild"),
      },
    },
    channel: { id: CHANNEL_ID },
    client: { users: { cache: new Map() } },
  } as any;
}

function expectDenied(result: unknown) {
  expect(String(result)).toMatch(/above your pay grade|not trusted|earn trust|not happening/i);
}

describe("Eris admin-mutating AI tool exposure", () => {
  it("keeps server-admin mutators discoverable but protected by runtime authorization", () => {
    const everyoneNames = new Set(EVERYONE_TOOLS.map((tool: any) => tool.name));

    for (const name of [
      "toggle_twin_chat",
      "toggle_cross_bot_punish",
      "save_directive",
      "remove_directive",
    ]) {
      expect(everyoneNames.has(name)).toBe(true);
    }

    expect(everyoneNames.has("list_directives")).toBe(true);
    expect(OWNER_TOOLS.some((tool: any) => tool.name === "execute_terminal")).toBe(true);
  });
});

describe("Eris admin executor permission checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings.clear();
    state.directives.length = 0;
    for (const id of perms.getTrustedUsers()) perms.removeTrustedUser(id);
  });

  it("denies regular users toggling twin chat without writing guild settings", async () => {
    const result = await execute(
      "toggle_twin_chat",
      { enabled: false },
      makeMessage({ authorId: REGULAR_ID }),
      {},
    );

    expectDenied(result);
    expect(db.setGuildSetting).not.toHaveBeenCalled();
  });

  it("allows server owners to toggle twin chat", async () => {
    const result = await execute(
      "toggle_twin_chat",
      { enabled: false },
      makeMessage({ authorId: CUSTOMIZER_ID, guildOwnerId: CUSTOMIZER_ID }),
      {},
    );

    expect(String(result)).toMatch(/twin chat disabled/i);
    expect(db.setGuildSetting).toHaveBeenCalledWith(GUILD_ID, "twin_chat_enabled", false);
  });

  it("denies regular users toggling cross-bot punishment without writing guild settings", async () => {
    const result = await execute(
      "toggle_cross_bot_punish",
      { enabled: true },
      makeMessage({ authorId: REGULAR_ID }),
      {},
    );

    expectDenied(result);
    expect(db.setGuildSetting).not.toHaveBeenCalled();
  });

  it("allows Manage Server admins to toggle cross-bot punishment", async () => {
    const result = await execute(
      "toggle_cross_bot_punish",
      { enabled: true },
      makeMessage({ authorId: ADMIN_ID, manageGuild: true }),
      {},
    );

    expect(String(result)).toMatch(/enabled/i);
    expect(db.setGuildSetting).toHaveBeenCalledWith(GUILD_ID, "cross_bot_punish", true);
  });

  it("denies regular users saving and removing directives without mutating directives", async () => {
    state.directives.push({ text: "always whisper", channel: null, addedBy: CUSTOMIZER_ID });

    const save = await execute(
      "save_directive",
      { directive: "always shout" },
      makeMessage({ authorId: REGULAR_ID }),
      {},
    );
    const remove = await execute(
      "remove_directive",
      { keyword: "whisper" },
      makeMessage({ authorId: REGULAR_ID }),
      {},
    );

    expectDenied(save);
    expectDenied(remove);
    expect(db.addDirective).not.toHaveBeenCalled();
    expect(db.removeDirective).not.toHaveBeenCalled();
    expect(state.directives).toEqual([{ text: "always whisper", channel: null, addedBy: CUSTOMIZER_ID }]);
  });

  it("allows trusted customizers to save directives and Manage Server admins to remove them", async () => {
    perms.addTrustedUser(CUSTOMIZER_ID);

    const save = await execute(
      "save_directive",
      { directive: "use pirate voice on fridays" },
      makeMessage({ authorId: CUSTOMIZER_ID, guildOwnerId: REGULAR_ID }),
      {},
    );
    const remove = await execute(
      "remove_directive",
      { keyword: "pirate" },
      makeMessage({ authorId: ADMIN_ID, manageGuild: true }),
      {},
    );

    expect(String(save)).toMatch(/saved/i);
    expect(String(remove)).toMatch(/removed directive/i);
    expect(db.addDirective).toHaveBeenCalledWith(
      GUILD_ID,
      "use pirate voice on fridays",
      null,
      CUSTOMIZER_ID,
    );
    expect(db.removeDirective).toHaveBeenCalledWith(GUILD_ID, "pirate");
    expect(state.directives).toHaveLength(0);
  });
});
