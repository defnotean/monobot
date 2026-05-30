import { describe, it, expect } from "vitest";
import {
  makeInteraction,
  makeOptions,
  makeMessage,
  makeGuild,
  makeMember,
  makeChannel,
  makeRole,
  makeUser,
  makeClient,
  getReplies,
  getLastReply,
  getLastReplyContent,
} from "./mockDiscord.js";

describe("mockDiscord helper", () => {
  describe("makeOptions", () => {
    it("returns typed option values via the real getter names", () => {
      const role = makeRole({ id: "role-1" });
      const user = makeUser({ id: "user-1" });
      const chan = makeChannel({ id: "chan-1" });
      const opts = makeOptions(
        { amount: 50, call: "heads", enabled: true, who: user, channel: chan, role },
        { subcommand: "add", subcommandGroup: "role" }
      );

      expect(opts.getInteger("amount")).toBe(50);
      expect(opts.getString("call")).toBe("heads");
      expect(opts.getBoolean("enabled")).toBe(true);
      expect(opts.getUser("who")).toBe(user);
      expect(opts.getChannel("channel")).toBe(chan);
      expect(opts.getRole("role")).toBe(role);
      expect(opts.getSubcommand()).toBe("add");
      expect(opts.getSubcommandGroup()).toBe("role");

      // spies recorded the calls
      expect(opts.getInteger).toHaveBeenCalledWith("amount");
      expect(opts.getString).toHaveBeenCalledWith("call");
    });

    it("returns null for unknown options and coerces types", () => {
      const opts = makeOptions({ n: "7", flag: 1 });
      expect(opts.getString("missing")).toBeNull();
      expect(opts.getInteger("missing")).toBeNull();
      expect(opts.getUser("missing")).toBeNull();
      // coercion: stored as a string "7" but getInteger -> number 7
      expect(opts.getInteger("n")).toBe(7);
      expect(typeof opts.getInteger("n")).toBe("number");
      // truthy non-bool -> boolean true
      expect(opts.getBoolean("flag")).toBe(true);
    });

    it("getSubcommand() throws when required and absent, but getSubcommand(false) returns null", () => {
      const opts = makeOptions({}, {});
      expect(() => opts.getSubcommand()).toThrow();
      expect(opts.getSubcommand(false)).toBeNull();
      expect(opts.getSubcommandGroup(false)).toBeNull();
    });
  });

  describe("makeInteraction", () => {
    it("captures reply content and flips the replied flag", async () => {
      const interaction = makeInteraction({ commandName: "ping" });
      expect(interaction.replied).toBe(false);

      await interaction.reply("pong");

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      expect(interaction.replied).toBe(true);
      expect(getLastReplyContent(interaction)).toBe("pong");
    });

    it("captures object-form replies (embeds/flags) and exposes the payload", async () => {
      const interaction = makeInteraction();
      await interaction.reply({ content: "hi", embeds: [{ title: "T" }], flags: 64 });
      const last = getLastReply(interaction);
      expect(last?.content).toBe("hi");
      expect(last?.payload.embeds[0].title).toBe("T");
      expect(last?.payload.flags).toBe(64);
    });

    it("deferReply flips the deferred flag and editReply records output", async () => {
      const interaction = makeInteraction();
      await interaction.deferReply();
      expect(interaction.deferred).toBe(true);
      await interaction.editReply("done");
      expect(interaction.editReply).toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toBe("done");
    });

    it("followUp and showModal are spies; fetchReply returns the last payload", async () => {
      const interaction = makeInteraction();
      await interaction.reply("first");
      const fetched = await interaction.fetchReply();
      expect(fetched.content).toBe("first");
      // fetchReply produces a timestamp strictly after the interaction's, like
      // ping.js relies on for roundtrip math.
      expect(fetched.createdTimestamp).toBeGreaterThan(interaction.createdTimestamp);

      await interaction.followUp({ content: "more" });
      expect(interaction.followUp).toHaveBeenCalledTimes(1);

      await interaction.showModal({ customId: "m" });
      expect(interaction.showModal).toHaveBeenCalledTimes(1);
    });

    it("models interaction-kind guards used by interactionCreate routing", () => {
      const cmd = makeInteraction({ type: "command", commandName: "balance" });
      expect(cmd.isCommand()).toBe(true);
      expect(cmd.isChatInputCommand()).toBe(true);
      expect(cmd.isButton()).toBe(false);

      const btn = makeInteraction({ type: "button", customId: "bj_hit:123" });
      expect(btn.isButton()).toBe(true);
      expect(btn.isCommand()).toBe(false);
      expect(btn.customId).toBe("bj_hit:123");

      const modal = makeInteraction({ type: "modal", customId: "report_modal:42" });
      expect(modal.isModalSubmit()).toBe(true);
      const [action] = modal.customId.split(":");
      expect(action).toBe("report_modal");
    });

    it("wires options through interaction.options as commands read them", () => {
      const interaction = makeInteraction({
        commandName: "coinflip",
        options: { amount: 100, call: "tails" },
      });
      expect(interaction.options.getInteger("amount")).toBe(100);
      expect(interaction.options.getString("call")).toBe("tails");
    });

    it("supports subcommand routing wired from makeInteraction overrides", () => {
      const interaction = makeInteraction({
        commandName: "bumpconfig",
        subcommand: "add",
        subcommandGroup: "role",
        options: { role: makeRole({ id: "r1" }) },
      });
      expect(interaction.options.getSubcommandGroup(false)).toBe("role");
      expect(interaction.options.getSubcommand()).toBe("add");
      expect(interaction.options.getRole("role").id).toBe("r1");
    });

    it("defaults guild/channel/client and derives guildId/channelId", () => {
      const interaction = makeInteraction();
      expect(interaction.guild).not.toBeNull();
      expect(interaction.guildId).toBe(interaction.guild.id);
      expect(interaction.channelId).toBe(interaction.channel.id);
      expect(interaction.client.ws.ping).toBeTypeOf("number");
    });

    it("allows a null guild for DM-context commands", () => {
      const interaction = makeInteraction({ guild: null });
      expect(interaction.guild).toBeNull();
      expect(interaction.guildId).toBeNull();
      expect(interaction.member).toBeNull();
    });
  });

  describe("makeMessage", () => {
    it("captures replies and exposes author/channel spies", async () => {
      const message = makeMessage({ content: "yo", author: makeUser({ id: "u9", username: "ian" }) });
      expect(message.content).toBe("yo");
      expect(message.author.username).toBe("ian");

      await message.reply("hey back");
      expect(message.reply).toHaveBeenCalledWith("hey back");
      expect(getLastReplyContent(message)).toBe("hey back");

      await message.channel.send("broadcast");
      expect(message.channel.send).toHaveBeenCalledWith("broadcast");
      await message.channel.sendTyping();
      expect(message.channel.sendTyping).toHaveBeenCalledTimes(1);

      await message.react("🔥");
      expect(message.react).toHaveBeenCalledWith("🔥");
    });

    it("derives guildId from guild and supports an explicit null (DM)", () => {
      const inGuild = makeMessage();
      expect(inGuild.guildId).toBe(inGuild.guild.id);

      const dm = makeMessage({ guild: null, guildId: null });
      expect(dm.guild).toBeNull();
      expect(dm.guildId).toBeNull();
    });
  });

  describe("makeGuild / makeMember / makeChannel / makeRole / makeUser / makeClient", () => {
    it("builds a guild with role/channel/member caches and leave/iconURL", async () => {
      const role = makeRole({ id: "rA", name: "Admins" });
      const chan = makeChannel({ id: "cA", name: "logs" });
      const guild = makeGuild({ name: "HQ", roles: [role], channels: [chan], ownerId: "owner-x" });

      expect(guild.name).toBe("HQ");
      expect(guild.ownerId).toBe("owner-x");
      expect(guild.roles.cache.get("rA")).toBe(role);
      expect(guild.channels.cache.get("cA")).toBe(chan);
      expect(await guild.roles.fetch("rA")).toBe(role);
      expect(typeof guild.iconURL()).toBe("string");

      await guild.leave();
      expect(guild.leave).toHaveBeenCalledTimes(1);
    });

    it("member.permissions.has reflects the granted flag list", () => {
      const FLAG = Symbol("ManageGuild");
      const withPerm = makeMember({ permissions: [FLAG] });
      const noPerm = makeMember({ permissions: [] });
      const godMode = makeMember({ permissions: true });

      expect(withPerm.permissions.has(FLAG)).toBe(true);
      expect(withPerm.permissions.has(Symbol("Other"))).toBe(false);
      expect(noPerm.permissions.has(FLAG)).toBe(false);
      expect(godMode.permissions.has(FLAG)).toBe(true);
    });

    it("channel.isTextBased + send are usable and configurable", async () => {
      const text = makeChannel();
      expect(text.isTextBased()).toBe(true);
      const voice = makeChannel({ textBased: false });
      expect(voice.isTextBased()).toBe(false);
      const sent = await text.send({ content: "x" });
      expect(sent.content).toBe("x");
    });

    it("client exposes commands/modalHandlers maps and a guild cache", async () => {
      const cmd = { data: { name: "ping" }, execute: () => {} };
      const guild = makeGuild({ id: "g1" });
      const client = makeClient({
        commands: new Map([["ping", cmd]]),
        guilds: [guild],
        wsPing: 12,
      });
      expect(client.commands.get("ping")).toBe(cmd);
      expect(client.ws.ping).toBe(12);
      expect(client.guilds.cache.get("g1")).toBe(guild);
      expect(await client.users.fetch("u1")).toMatchObject({ id: "u1" });
      expect(client.user.bot).toBe(true);
    });

    it("makeUser distinguishes bots from humans", () => {
      expect(makeUser().bot).toBe(false);
      expect(makeUser({ bot: true, username: "eris" }).username).toBe("eris");
    });
  });

  describe("reply readers", () => {
    it("getReplies returns all captured replies in order", async () => {
      const interaction = makeInteraction();
      await interaction.reply("a");
      await interaction.editReply("b");
      await interaction.followUp("c");
      const all = getReplies(interaction);
      expect(all.map((r) => r.content)).toEqual(["a", "b", "c"]);
    });

    it("getLastReply returns null before anything is said", () => {
      const interaction = makeInteraction();
      expect(getLastReply(interaction)).toBeNull();
      expect(getLastReplyContent(interaction)).toBeNull();
    });
  });
});
