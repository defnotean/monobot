import { describe, it, expect, vi } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeMessage, makeUser, makeGuild, repliedText, Collection } from "../../_helpers/mockDiscord.js";

import * as afkCmd from "../../../commands/utility/afk.js";

const {
  execute,
  setAfkStatus,
  clearAfk,
  getAfk,
  checkAfkReturn,
  checkAfkMentions,
  getAfkData,
  initAfkData,
} = afkCmd as any;

describe("utility/afk store helpers", () => {
  it("setAfkStatus then getAfk round-trips reason + timestamp, scoped per guild/user", () => {
    setAfkStatus("g1", "u1", "lunch");
    const status = getAfk("g1", "u1");
    expect(status).toBeTruthy();
    expect(status.reason).toBe("lunch");
    expect(typeof status.timestamp).toBe("number");
    // different guild for same user is a different key -> not AFK there
    expect(getAfk("g2", "u1")).toBeNull();
    clearAfk("g1", "u1");
  });

  it("clearAfk returns true only when a status existed, and removes it", () => {
    setAfkStatus("g1", "u2", "brb");
    expect(clearAfk("g1", "u2")).toBe(true);
    expect(getAfk("g1", "u2")).toBeNull();
    // second clear: nothing to remove
    expect(clearAfk("g1", "u2")).toBe(false);
  });

  it("initAfkData loads from a persisted snapshot and getAfkData round-trips it", () => {
    initAfkData({ afk_users: { "gA-uA": { reason: "sleep", timestamp: 123 } } });
    expect(getAfk("gA", "uA")).toEqual({ reason: "sleep", timestamp: 123 });
    const dumped = getAfkData();
    expect(dumped["gA-uA"]).toEqual({ reason: "sleep", timestamp: 123 });
    clearAfk("gA", "uA");
  });
});

describe("utility/afk execute", () => {
  it("sets AFK status with the provided reason and replies ephemerally", async () => {
    const user = makeUser({ id: "exec-1" });
    const guild = makeGuild({ id: "gex-1" });
    const interaction = makeInteraction({ user, guild, options: { reason: "studying" } });

    await execute(interaction);

    expect(getAfk("gex-1", "exec-1")?.reason).toBe("studying");
    expect(repliedText(interaction)).toContain("AFK Status Set");
    expect(repliedText(interaction)).toContain("studying");
    // ephemeral via flags: 64
    expect(interaction.reply.mock.calls[0][0].flags).toBe(64);
    clearAfk("gex-1", "exec-1");
  });

  it("falls back to the default 'AFK' reason when none is given", async () => {
    const user = makeUser({ id: "exec-2" });
    const guild = makeGuild({ id: "gex-2" });
    const interaction = makeInteraction({ user, guild, options: { reason: null } });

    await execute(interaction);

    expect(getAfk("gex-2", "exec-2")?.reason).toBe("AFK");
    clearAfk("gex-2", "exec-2");
  });
});

describe("utility/afk checkAfkReturn", () => {
  it("clears the author's AFK and welcomes them back", async () => {
    const author = makeUser({ id: "ret-1", bot: false });
    const guild = makeGuild({ id: "gret-1" });
    setAfkStatus("gret-1", "ret-1", "away");
    const message = makeMessage({ author, guild });

    checkAfkReturn(message);

    expect(getAfk("gret-1", "ret-1")).toBeNull();
    expect(message.reply).toHaveBeenCalled();
    expect(message.reply.mock.calls[0][0].content).toContain("welcome back");
  });

  it("ignores bot authors entirely", () => {
    const bot = makeUser({ id: "ret-bot", bot: true });
    const guild = makeGuild({ id: "gret-2" });
    setAfkStatus("gret-2", "ret-bot", "x");
    const message = makeMessage({ author: bot, guild });

    checkAfkReturn(message);

    // bot path returns early -> status untouched, no reply
    expect(getAfk("gret-2", "ret-bot")).toBeTruthy();
    expect(message.reply).not.toHaveBeenCalled();
    clearAfk("gret-2", "ret-bot");
  });

  it("does not reply when the author had no AFK status", () => {
    const author = makeUser({ id: "ret-3", bot: false });
    const guild = makeGuild({ id: "gret-3" });
    const message = makeMessage({ author, guild });

    checkAfkReturn(message);

    expect(message.reply).not.toHaveBeenCalled();
  });
});

describe("utility/afk checkAfkMentions", () => {
  it("does nothing when there are no mentions", () => {
    const message = makeMessage({ guild: makeGuild({}) });
    // helper builds mentions.users as a Collection (size 0)
    message.mentions.size = 0;
    checkAfkMentions(message);
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("replies with an AFK card for a mentioned AFK user", () => {
    const afkUser = makeUser({ id: "mn-1", username: "Sleeper" });
    const guild = makeGuild({ id: "gmn-1" });
    setAfkStatus("gmn-1", "mn-1", "napping");

    const message = makeMessage({ guild, mentionsUsers: [afkUser] });
    message.mentions.size = 1;

    checkAfkMentions(message);

    expect(message.reply).toHaveBeenCalled();
    const payload = message.reply.mock.calls[0][0];
    expect(payload.embeds.length).toBe(1);
    const embed = payload.embeds[0].data ?? payload.embeds[0];
    expect(embed.title).toContain("Sleeper is AFK");
    expect(embed.description).toBe("napping");
    clearAfk("gmn-1", "mn-1");
  });

  it("does not reply when a mentioned user is not AFK", () => {
    const notAfk = makeUser({ id: "mn-2" });
    const guild = makeGuild({ id: "gmn-2" });
    const message = makeMessage({ guild, mentionsUsers: [notAfk] });
    message.mentions.size = 1;

    checkAfkMentions(message);

    expect(message.reply).not.toHaveBeenCalled();
  });
});
