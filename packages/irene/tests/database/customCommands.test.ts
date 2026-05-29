import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as db from "../../database.js";

const fakeSupabase = {
  from: () => ({
    upsert: async () => ({ error: null }),
  }),
};

beforeEach(() => {
  db._internal.__resetForTest();
  db._internal.__setSupabaseForTest(fakeSupabase as any);
});

afterEach(() => {
  db._internal.__resetForTest();
});

describe("custom command store", () => {
  it("normalizes trigger casing and preserves explicit created_at", () => {
    db.setCustomCommand("guild-1", "Hello", {
      response: "hi",
      created_at: "2026-05-29T12:00:00.000Z",
    });

    expect(db.getCustomCommand("guild-1", "HELLO")).toEqual({
      trigger: "hello",
      response: "hi",
      created_at: "2026-05-29T12:00:00.000Z",
    });
    expect(db.getCustomCommands("guild-1")).toHaveProperty("hello");
  });

  it("marks only the touched guild custom_commands entity dirty", () => {
    db.setCustomCommand("guild-1", "hello", { response: "hi" });

    expect([...db._internal.dirty]).toEqual(["custom_commands"]);
    expect([...(db._internal.dirtyEntities.get("custom_commands") ?? [])]).toEqual(["guild-1"]);
  });

  it("lists and deletes commands without dirtying missing deletes", () => {
    db.setCustomCommand("guild-1", "hello", { response: "hi" });
    db.setCustomCommand("guild-1", "bye", { response: "later" });

    expect(db.listCustomCommands("guild-1").map((cmd) => cmd.trigger).sort()).toEqual(["bye", "hello"]);

    db._internal.dirty.clear();
    db._internal.dirtyEntities.clear();

    expect(db.deleteCustomCommand("guild-1", "HELLO")).toBe(true);
    expect(db.getCustomCommand("guild-1", "hello")).toBeNull();
    expect([...db._internal.dirty]).toEqual(["custom_commands"]);
    expect([...(db._internal.dirtyEntities.get("custom_commands") ?? [])]).toEqual(["guild-1"]);

    db._internal.dirty.clear();
    db._internal.dirtyEntities.clear();

    expect(db.deleteCustomCommand("guild-1", "missing")).toBe(false);
    expect([...db._internal.dirty]).toEqual([]);
    expect([...db._internal.dirtyEntities]).toEqual([]);
  });
});
