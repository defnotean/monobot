import { describe, it, expect, beforeEach, vi } from "vitest";
import { Collection } from "discord.js";

// userUpdate fans a "User Updated" embed out to every mutual guild. We mock
// sendModLog + log (sinks) but keep the real logEmbed/LC so the EmbedBuilder
// .data shape is realistic for assertions.

const sendModLog = vi.fn(async () => {});
const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: (...a: any[]) => log(...a),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/userUpdate.js";

function makeUser(overrides: any = {}) {
  const avatar = overrides.avatar ?? "https://cdn/avatar.png";
  const u: any = {
    id: "user-1",
    tag: "alice#0001",
    bot: false,
    username: "alice",
    globalName: "Alice",
    displayAvatarURL: () => avatar,
    ...overrides,
  };
  delete u.avatar;
  return u;
}

// guild whose members.cache.has(uid) reports membership.
function makeGuild(id: string, memberId: string | null) {
  return { id, members: { cache: { has: (uid: string) => uid === memberId } } };
}

// Attach a shared client with a real Collection of guilds to newUser.
function withGuilds(newUser: any, guilds: any[]) {
  const cache = new Collection<string, any>();
  for (const g of guilds) cache.set(g.id, g);
  newUser.client = { guilds: { cache } };
  return newUser;
}

beforeEach(() => {
  sendModLog.mockClear();
  log.mockClear();
});

describe("userUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("userUpdate");
  });

  it("ignores bot users entirely", async () => {
    const oldU = makeUser({ username: "alice" });
    const newU = withGuilds(makeUser({ username: "alicia", bot: true }), [
      makeGuild("g1", "user-1"),
    ]);
    await execute(oldU, newU);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("does NOT log when no tracked field changed", async () => {
    const oldU = makeUser();
    const newU = withGuilds(makeUser(), [makeGuild("g1", "user-1")]);
    await execute(oldU, newU);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a username change to mutual guilds only", async () => {
    const oldU = makeUser({ username: "alice" });
    const newU = withGuilds(makeUser({ username: "alicia" }), [
      makeGuild("g1", "user-1"), // mutual
      makeGuild("g2", "user-1"), // mutual
      makeGuild("g3", "someone-else"), // NOT mutual -> skipped
    ]);
    await execute(oldU, newU);

    expect(sendModLog).toHaveBeenCalledTimes(2);
    const loggedGuildIds = sendModLog.mock.calls.map((c: any) => c[0].id).sort();
    expect(loggedGuildIds).toEqual(["g1", "g2"]);
    const embed = sendModLog.mock.calls[0][1];
    // userUpdate uses the legacy logEmbed(title, color) which sets the TITLE.
    expect(embed.data.title).toBe("User Updated");
    const text = JSON.stringify(embed.data);
    expect(text).toContain("alice");
    expect(text).toContain("alicia");
    expect(text).toContain("<@user-1>");
  });

  it("logs a display-name (globalName) change, rendering (none) for null", async () => {
    const oldU = makeUser({ globalName: null });
    const newU = withGuilds(makeUser({ globalName: "Alice Z" }), [
      makeGuild("g1", "user-1"),
    ]);
    await execute(oldU, newU);
    const text = JSON.stringify(sendModLog.mock.calls[0][1].data);
    expect(text).toContain("(none)");
    expect(text).toContain("Alice Z");
  });

  it("logs an avatar change with thumbnail + image and Before/After labels", async () => {
    const oldU = makeUser({ avatar: "https://cdn/old.png" });
    const newU = withGuilds(makeUser({ avatar: "https://cdn/new.png" }), [
      makeGuild("g1", "user-1"),
    ]);
    await execute(oldU, newU);
    const embed = sendModLog.mock.calls[0][1];
    // Avatar-only change => the two-image labels are present.
    const text = JSON.stringify(embed.data);
    expect(text).toContain("thumbnail");
    expect(text).toContain("main image");
    expect(embed.data.image).toBeTruthy();
  });

  it("does not log to any guild when the user shares none", async () => {
    const oldU = makeUser({ username: "alice" });
    const newU = withGuilds(makeUser({ username: "bob" }), [
      makeGuild("g1", "different-user"),
    ]);
    await execute(oldU, newU);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("records a [USER] line in the log when a change is detected", async () => {
    const oldU = makeUser({ username: "alice" });
    const newU = withGuilds(makeUser({ username: "carol" }), [
      makeGuild("g1", "user-1"),
    ]);
    await execute(oldU, newU);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[USER]"));
  });
});
