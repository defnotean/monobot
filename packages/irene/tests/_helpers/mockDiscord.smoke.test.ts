import { describe, it, expect } from "vitest";

// @ts-expect-error — JS helper, no .d.ts
import {
  makeInteraction,
  makeMessage,
  makeGuild,
  makeMember,
  makeChannel,
  makeRole,
  makeUser,
  makeOptions,
  makePermissions,
  makeClient,
  getReplies,
  lastReply,
  repliedText,
  PermissionFlagsBits,
  Collection,
} from "./mockDiscord.js";

describe("mockDiscord helper", () => {
  it("makePermissions.has() reflects the granted bitmask (real has, not always-true)", () => {
    const perms = makePermissions([PermissionFlagsBits.KickMembers]);
    expect(perms.has(PermissionFlagsBits.KickMembers)).toBe(true);
    expect(perms.has(PermissionFlagsBits.BanMembers)).toBe(false);
    // raw bigint form used by some source (8n = Administrator)
    expect(makePermissions(8n).has(PermissionFlagsBits.Administrator)).toBe(true);
    expect(makePermissions("all").has(PermissionFlagsBits.ManageGuild)).toBe(true);
    expect(makePermissions([]).has(PermissionFlagsBits.ManageGuild)).toBe(false);
  });

  it("makeRole/makeChannel/makeUser produce mention-able, distinct objects", () => {
    const role = makeRole({ name: "Mods", position: 5 });
    expect(role.toString()).toBe(`<@&${role.id}>`);
    expect(role.position).toBe(5);

    const chan = makeChannel({ name: "general" });
    expect(chan.toString()).toBe(`<#${chan.id}>`);
    expect(chan.isTextBased()).toBe(true);

    const user = makeUser({ username: "ian" });
    expect(user.toString()).toBe(`<@${user.id}>`);
    expect(user.bot).toBe(false);
    // ids are unique across factory calls
    expect(makeUser().id).not.toBe(makeUser().id);
  });

  it("makeChannel.send / messages.fetch spies work", async () => {
    const chan = makeChannel({});
    const sent = await chan.send("hi");
    expect(chan.send).toHaveBeenCalledWith("hi");
    expect(sent.content).toBe("hi");
    expect(await chan.messages.fetch("nope")).toBeNull();
  });

  it("makeMember exposes a working roles.highest.position + spied roles.add/remove", async () => {
    const m = makeMember({ permissions: [PermissionFlagsBits.ManageMessages], highestRolePosition: 7 });
    expect(m.roles.highest.position).toBe(7);
    expect(m.permissions.has(PermissionFlagsBits.ManageMessages)).toBe(true);
    expect(m.permissions.has(PermissionFlagsBits.Administrator)).toBe(false);
    const role = makeRole({});
    await m.roles.add(role);
    expect(m.roles.add).toHaveBeenCalledWith(role);
  });

  it("makeGuild seeds caches and spies channels.create / members.fetch", async () => {
    const chan = makeChannel({ name: "rules" });
    const member = makeMember({});
    const guild = makeGuild({ channels: [chan], members: [member], ownerId: "owner-x" });
    expect(guild.channels.cache.get(chan.id)).toBe(chan);
    expect(await guild.members.fetch(member.id)).toBe(member);
    expect(await guild.members.fetch("ghost")).toBeNull();
    const created = await guild.channels.create({ name: "new" });
    expect(guild.channels.create).toHaveBeenCalled();
    expect(guild.channels.cache.get(created.id)).toBe(created);
    // members.me has full perms + a high role by default so bot-perm gates pass
    expect(guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)).toBe(true);
    expect(guild.members.me.roles.highest.position).toBe(100);
  });

  it("makeOptions resolves the getters real commands call", () => {
    const targetUser = makeUser({ username: "victim" });
    const targetChan = makeChannel({ name: "log" });
    const targetRole = makeRole({ name: "muted" });
    const opts = makeOptions(
      { name: "Hello", count: "3", flag: true, ratio: "1.5", user: targetUser, channel: targetChan, role: targetRole },
      { subcommand: "create", subcommandGroup: "grp", focused: "he" },
    );
    expect(opts.getString("name")).toBe("Hello");
    expect(opts.getInteger("count")).toBe(3);
    expect(opts.getNumber("ratio")).toBe(1.5);
    expect(opts.getBoolean("flag")).toBe(true);
    expect(opts.getUser("user")).toBe(targetUser);
    expect(opts.getChannel("channel")).toBe(targetChan);
    expect(opts.getRole("role")).toBe(targetRole);
    expect(opts.getSubcommand()).toBe("create");
    expect(opts.getSubcommandGroup()).toBe("grp");
    expect(opts.getFocused()).toBe("he");
    // missing optional → null; missing required → throws (matches discord.js)
    expect(opts.getString("missing")).toBeNull();
    expect(() => opts.getString("missing", true)).toThrow(/Required option/);
  });

  it("makeInteraction wires spied reply/deferReply/editReply/followUp/showModal and tracks state", async () => {
    const i = makeInteraction({
      commandName: "ping",
      options: { reason: "because" },
      subcommand: "go",
    });
    expect(i.isChatInputCommand()).toBe(true);
    expect(i.options.getString("reason")).toBe("because");
    expect(i.options.getSubcommand()).toBe("go");

    expect(i.replied).toBe(false);
    await i.reply({ content: "hi" });
    expect(i.reply).toHaveBeenCalledTimes(1);
    expect(i.replied).toBe(true);

    await i.deferReply();
    expect(i.deferred).toBe(true);

    await i.editReply({ content: "edited" });
    await i.followUp({ content: "more" });
    const modal = { custom_id: "m1" };
    await i.showModal(modal);
    expect(i.showModal).toHaveBeenCalledWith(modal);

    const fetched = await i.fetchReply();
    expect(typeof fetched.createdTimestamp).toBe("number");

    // reply readers see every recorded payload
    const replies = getReplies(i);
    expect(replies.map((r: any) => r.kind)).toEqual([
      "reply", "deferReply", "editReply", "followUp", "showModal",
    ]);
    expect(lastReply(i)).toBe(modal);
  });

  it("makeInteraction({ isOwner }) makes the member the guild owner (owner gate passes)", () => {
    const i = makeInteraction({ isOwner: true });
    expect(i.member.id).toBe(i.guild.ownerId);
  });

  it("makeInteraction cross-references guild/channel/member consistently", () => {
    const i = makeInteraction({ permissions: [PermissionFlagsBits.ManageGuild] });
    expect(i.guild.channels.cache.get(i.channel.id)).toBe(i.channel);
    expect(i.guild.members.cache.get(i.member.id)).toBe(i.member);
    expect(i.client.guilds.cache.get(i.guild.id)).toBe(i.guild);
    expect(i.member.permissions.has(PermissionFlagsBits.ManageGuild)).toBe(true);
  });

  it("repliedText concatenates content + embed text from EmbedBuilder-style payloads", async () => {
    const i = makeInteraction({});
    await i.reply({
      content: "top-level",
      embeds: [{ data: { title: "T", description: "D", fields: [{ name: "F", value: "V" }] } }],
    });
    const text = repliedText(i);
    expect(text).toContain("top-level");
    expect(text).toContain("T");
    expect(text).toContain("D");
    expect(text).toContain("F");
    expect(text).toContain("V");
  });

  it("makeMessage wires spied reply/react/delete and a real mentions.has", async () => {
    const me = makeUser({ username: "irene" });
    const author = makeUser({ username: "human" });
    const msg = makeMessage({ content: "hey @irene", author, mentionsUsers: [me] });
    expect(msg.content).toBe("hey @irene");
    expect(msg.author).toBe(author);
    expect(msg.mentions.has(me)).toBe(true);
    expect(msg.mentions.has(author)).toBe(false);

    const reply = await msg.reply("yo");
    expect(msg.reply).toHaveBeenCalledWith("yo");
    expect(reply.content).toBe("yo");
    await msg.react("👍");
    expect(msg.react).toHaveBeenCalledWith("👍");
    await msg.delete();
    expect(msg.delete).toHaveBeenCalledTimes(1);
  });

  it("makeMessage with no guild models a DM (guild null, member null)", () => {
    const dm = makeMessage({ content: "dm text" });
    expect(dm.guild).toBeNull();
    expect(dm.member).toBeNull();
  });

  it("makeClient exposes ws.ping and collection caches", () => {
    const c = makeClient();
    expect(typeof c.ws.ping).toBe("number");
    expect(c.guilds.cache instanceof Collection).toBe(true);
    expect(c.user.bot).toBe(true);
  });
});
