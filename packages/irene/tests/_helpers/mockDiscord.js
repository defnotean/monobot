// ─── Mock-Discord test helper (irene) ────────────────────────────────────────
//
// Factory functions that build the slimmest objects that look enough like
// discord.js Interactions / Messages / Guilds / Members / Channels / Roles for
// irene's command + event handlers to run against, with vi.fn() spies on every
// reply path so a test can assert *what the handler actually replied/did*.
//
// Design notes / how this mirrors the real source surface:
//   • Permission checks. utils/permissions.js calls
//     `member.permissions.has(PermissionFlagsBits.X)` and source code also calls
//     `.has(8n)` (raw Administrator bit). makePermissions() returns an object
//     with a real `.has()` that OR-checks a granted bitmask, so owner/admin
//     gates (requireAdminOrOwner, requirePermission, canModerate) exercise real
//     branches instead of always-true stubs.
//   • Role hierarchy. canModerate() reads `member.roles.highest.position`, so
//     makeMember() builds a `roles.highest` with a configurable position and a
//     Collection-backed `roles.cache` + spied add/remove.
//   • Options. The accessor supports the getters real commands call —
//     getString/getInteger/getNumber/getBoolean/getUser/getChannel/getRole/
//     getMentionable/getMember/getSubcommand/getSubcommandGroup/getFocused —
//     resolving against the `options`/`subcommand`/`subcommandGroup` you pass.
//   • Replies. reply/deferReply/editReply/followUp/showModal/fetchReply/
//     deferUpdate/update/deleteReply are vi.fn() spies. The interaction also
//     tracks `replied`/`deferred` like the real object and records every reply
//     payload so getReplies()/lastReply() can read them back.
//
// Everything is plain JS (matches the JS source) and lives under tests/, which
// the build tsconfig excludes — so adding it can't affect the package build.

import { vi } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";

let _idSeq = 0;
/**
 * Unique snowflake-shaped id generator for fixtures. Uses BigInt so the base is
 * not subject to Number.MAX_SAFE_INTEGER rounding (which would otherwise make
 * adjacent ids collide), guaranteeing every factory call gets a distinct id.
 */
export function nextId(prefix = "") {
  _idSeq += 1;
  return `${prefix}${100000000000000000n + BigInt(_idSeq)}`;
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/**
 * Build a PermissionsBitField-like object whose `.has(flag)` reflects a real
 * granted bitmask. Accepts an array/iterable of PermissionFlagsBits values, a
 * single bigint, or the sentinel string "all" to grant everything.
 *
 * @param {Array<bigint>|bigint|"all"|null} granted
 */
export function makePermissions(granted = []) {
  let mask = 0n;
  if (granted === "all") {
    mask = -1n; // every bit set
  } else if (typeof granted === "bigint") {
    mask = granted;
  } else if (granted && typeof granted[Symbol.iterator] === "function") {
    for (const g of granted) mask |= BigInt(g);
  }
  return {
    bitfield: mask,
    /** @param {bigint|bigint[]} flag */
    has(flag) {
      const flags = Array.isArray(flag) ? flag : [flag];
      return flags.every((f) => (mask & BigInt(f)) === BigInt(f));
    },
    add(...flags) {
      for (const f of flags) mask |= BigInt(f);
      this.bitfield = mask;
      return this;
    },
    remove(...flags) {
      for (const f of flags) mask &= ~BigInt(f);
      this.bitfield = mask;
      return this;
    },
  };
}

// ─── Role / Member / Channel / Guild ─────────────────────────────────────────

/**
 * @param {object} [o]
 * @param {string} [o.id]
 * @param {string} [o.name]
 * @param {number} [o.position]
 */
export function makeRole({ id = nextId("role-"), name = "role", position = 1, ...rest } = {}) {
  return {
    id,
    name,
    position,
    hexColor: "#000000",
    color: 0,
    mentionable: true,
    toString: () => `<@&${id}>`,
    ...rest,
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.id]
 * @param {string} [o.name]
 * @param {number} [o.type]  ChannelType value (default 0 = GuildText)
 * @param {boolean} [o.textBased]
 */
export function makeChannel({
  id = nextId("chan-"),
  name = "general",
  type = 0,
  textBased = true,
  guild = null,
  ...rest
} = {}) {
  const messages = new Collection();
  const channel = {
    id,
    name,
    type,
    guild,
    isTextBased: vi.fn(() => textBased),
    isVoiceBased: vi.fn(() => type === 2 || type === 13),
    send: vi.fn(async (payload) => makeMessage({ content: typeof payload === "string" ? payload : payload?.content, channel: undefined })),
    sendTyping: vi.fn(async () => {}),
    bulkDelete: vi.fn(async () => new Collection()),
    delete: vi.fn(async () => {}),
    permissionOverwrites: { edit: vi.fn(async () => {}), delete: vi.fn(async () => {}), cache: new Collection() },
    messages: {
      fetch: vi.fn(async (mid) => messages.get(mid) ?? null),
      cache: messages,
    },
    toString: () => `<#${id}>`,
    ...rest,
  };
  return channel;
}

/**
 * @param {object} [o]
 * @param {string} [o.id]
 * @param {string} [o.tag]
 * @param {string} [o.username]
 * @param {boolean} [o.bot]
 */
export function makeUser({
  id = nextId("user-"),
  tag = "tester#0001",
  username = "tester",
  bot = false,
  ...rest
} = {}) {
  return {
    id,
    tag,
    username,
    bot,
    discriminator: tag.includes("#") ? tag.split("#")[1] : "0001",
    globalName: username,
    createdTimestamp: Date.now() - 365 * 86_400_000,
    displayAvatarURL: vi.fn(() => "https://cdn.example/avatar.png"),
    avatarURL: vi.fn(() => "https://cdn.example/avatar.png"),
    send: vi.fn(async () => makeMessage({})),
    createDM: vi.fn(async () => makeChannel({ name: "dm" })),
    fetch: vi.fn(async function () { return this; }),
    toString: () => `<@${id}>`,
    valueOf: () => id,
    ...rest,
  };
}

/**
 * @param {object} [o]
 * @param {object} [o.user]
 * @param {object} [o.guild]
 * @param {Array<bigint>|bigint|"all"} [o.permissions]
 * @param {number} [o.highestRolePosition]
 * @param {Array<object>} [o.roles] extra roles to put in roles.cache
 */
export function makeMember({
  user = makeUser(),
  guild = null,
  permissions = [],
  highestRolePosition = 1,
  nickname = null,
  roles = [],
  ...rest
} = {}) {
  const roleCache = new Collection();
  const highest = makeRole({ name: "highest", position: highestRolePosition });
  roleCache.set(highest.id, highest);
  for (const r of roles) roleCache.set(r.id, r);
  return {
    id: user.id,
    user,
    guild,
    nickname,
    displayName: nickname ?? user.username,
    bannable: true,
    kickable: true,
    moderatable: true,
    permissions: makePermissions(permissions),
    roles: {
      cache: roleCache,
      highest,
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    voice: { channel: null, setChannel: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) },
    kick: vi.fn(async () => {}),
    ban: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
    send: vi.fn(async () => makeMessage({})),
    toString: () => `<@${user.id}>`,
    ...rest,
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.id]
 * @param {string} [o.name]
 * @param {string} [o.ownerId]
 * @param {object} [o.me] bot's own GuildMember (members.me)
 * @param {Array<object>} [o.channels] channels to seed channels.cache
 * @param {Array<object>} [o.roles] roles to seed roles.cache
 * @param {Array<object>} [o.members] members to seed members.cache
 * @param {Array<bigint>|"all"} [o.botPermissions] perms for members.me
 * @param {number} [o.botHighestRolePosition]
 */
export function makeGuild({
  id = nextId("guild-"),
  name = "Test Guild",
  ownerId = nextId("owner-"),
  channels = [],
  roles = [],
  members = [],
  me = null,
  botPermissions = "all",
  botHighestRolePosition = 100,
  ...rest
} = {}) {
  const channelCache = new Collection();
  for (const c of channels) channelCache.set(c.id, c);
  const roleCache = new Collection();
  const everyone = makeRole({ id, name: "@everyone", position: 0 });
  roleCache.set(everyone.id, everyone);
  for (const r of roles) roleCache.set(r.id, r);
  const memberCache = new Collection();
  for (const m of members) memberCache.set(m.id, m);

  const guild = {
    id,
    name,
    ownerId,
    memberCount: members.length || 1,
    channels: {
      cache: channelCache,
      create: vi.fn(async (opts) => {
        const ch = makeChannel({ name: opts?.name ?? "new-channel", type: opts?.type ?? 0, guild: undefined });
        channelCache.set(ch.id, ch);
        return ch;
      }),
      fetch: vi.fn(async (cid) => channelCache.get(cid) ?? null),
    },
    roles: {
      cache: roleCache,
      everyone,
      create: vi.fn(async (opts) => {
        const r = makeRole({ name: opts?.name ?? "new-role" });
        roleCache.set(r.id, r);
        return r;
      }),
    },
    members: {
      cache: memberCache,
      me: me ?? makeMember({
        user: makeUser({ id: nextId("bot-"), tag: "irene-bot#0000", bot: true }),
        permissions: botPermissions,
        highestRolePosition: botHighestRolePosition,
      }),
      fetch: vi.fn(async (uid) => {
        const key = typeof uid === "object" ? uid?.id : uid;
        return memberCache.get(key) ?? null;
      }),
      ban: vi.fn(async () => {}),
      kick: vi.fn(async () => {}),
    },
    bans: { create: vi.fn(async () => {}), remove: vi.fn(async () => {}), fetch: vi.fn(async () => null) },
    fetchAuditLogs: vi.fn(async () => ({ entries: { values: () => [].values(), first: () => null } })),
    ...rest,
  };
  guild.members.me.guild = guild;
  return guild;
}

// ─── Options accessor ────────────────────────────────────────────────────────

/**
 * Build an `interaction.options` object that resolves the getters real
 * commands use. Pass plain values keyed by option name; getUser/getChannel/
 * getRole/getMember/getMentionable return the value as-is (so pass a member/
 * user/channel mock), getString/getInteger/getNumber/getBoolean coerce/return.
 *
 * Missing options return null (required:true args throw, matching discord.js).
 *
 * @param {Record<string, any>} values
 * @param {object} [extra]
 * @param {string} [extra.subcommand]
 * @param {string} [extra.subcommandGroup]
 * @param {string} [extra.focused]
 */
export function makeOptions(values = {}, { subcommand, subcommandGroup, focused } = {}) {
  const get = (name, required) => {
    if (!(name in values) || values[name] === undefined || values[name] === null) {
      if (required) throw new Error(`Required option "${name}" not found`);
      return null;
    }
    return values[name];
  };
  return {
    _values: values,
    getString: (name, required) => { const v = get(name, required); return v == null ? null : String(v); },
    getInteger: (name, required) => { const v = get(name, required); return v == null ? null : Math.trunc(Number(v)); },
    getNumber: (name, required) => { const v = get(name, required); return v == null ? null : Number(v); },
    getBoolean: (name, required) => { const v = get(name, required); return v == null ? null : Boolean(v); },
    getUser: (name, required) => get(name, required),
    getMember: (name, required) => get(name, required),
    getChannel: (name, required) => get(name, required),
    getRole: (name, required) => get(name, required),
    getMentionable: (name, required) => get(name, required),
    getAttachment: (name, required) => get(name, required),
    getSubcommand: (required = true) => {
      if (subcommand == null && required) throw new Error("No subcommand specified");
      return subcommand ?? null;
    },
    getSubcommandGroup: (required = false) => {
      if (subcommandGroup == null && required) throw new Error("No subcommand group specified");
      return subcommandGroup ?? null;
    },
    getFocused: (full = false) =>
      full ? { name: focused ?? "", value: focused ?? "" } : (focused ?? ""),
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

export function makeClient({ user = makeUser({ tag: "irene-bot#0000", bot: true }), ...rest } = {}) {
  return {
    user,
    ws: { ping: 42 },
    uptime: 1000,
    commands: new Collection(),
    guilds: { cache: new Collection() },
    users: { cache: new Collection(), fetch: vi.fn(async () => null) },
    channels: { cache: new Collection(), fetch: vi.fn(async () => null) },
    ...rest,
  };
}

// ─── Interaction ─────────────────────────────────────────────────────────────

/**
 * Build a ChatInputCommand-like interaction with spied reply methods.
 *
 * @param {object} [o]
 * @param {Record<string, any>} [o.options] option values (see makeOptions)
 * @param {string} [o.subcommand]
 * @param {string} [o.subcommandGroup]
 * @param {string} [o.focused]
 * @param {object} [o.user]
 * @param {object} [o.member] defaults to a member wrapping `user`
 * @param {object} [o.guild]
 * @param {object} [o.channel]
 * @param {object} [o.client]
 * @param {string} [o.commandName]
 * @param {string} [o.customId] for component/modal interactions
 * @param {Array<bigint>|"all"} [o.permissions] convenience: member perms
 * @param {boolean} [o.isOwner] convenience: make member the guild owner
 */
export function makeInteraction({
  options = {},
  subcommand,
  subcommandGroup,
  focused,
  user,
  member,
  guild,
  channel,
  client,
  commandName = "test-command",
  customId,
  permissions = [],
  isOwner = false,
  ...rest
} = {}) {
  user = user ?? makeUser();
  guild = guild ?? makeGuild(isOwner ? { ownerId: user.id } : {});
  member = member ?? makeMember({ user, guild, permissions });
  channel = channel ?? makeChannel({ guild });
  client = client ?? makeClient();
  // Keep cross-references consistent so handlers reading interaction.guild.* see
  // the same channel/member they were given.
  if (!guild.channels.cache.has(channel.id)) guild.channels.cache.set(channel.id, channel);
  if (!guild.members.cache.has(member.id)) guild.members.cache.set(member.id, member);
  client.guilds.cache.set(guild.id, guild);
  // discord.js Guild objects expose `.client`; several handlers (e.g. the music
  // DJ/same-VC guard in utils/musicGuard.js) read `guild.client.user.id` to
  // locate the bot member. Wire it so the mock matches the real surface.
  if (!guild.client) guild.client = client;

  /** Recorded reply/editReply/followUp payloads, in call order. */
  const _replies = [];
  const record = (kind, payload) => { _replies.push({ kind, payload }); return payload; };

  const interaction = {
    id: nextId("int-"),
    commandName,
    customId,
    user,
    member,
    guild,
    guildId: guild?.id ?? null,
    channel,
    channelId: channel?.id ?? null,
    client,
    locale: "en-US",
    createdTimestamp: Date.now(),
    replied: false,
    deferred: false,
    options: makeOptions(options, { subcommand, subcommandGroup, focused }),

    reply: vi.fn(async function (payload) { this.replied = true; return record("reply", payload); }),
    deferReply: vi.fn(async function (payload) { this.deferred = true; return record("deferReply", payload); }),
    editReply: vi.fn(async function (payload) { this.replied = true; return record("editReply", payload); }),
    followUp: vi.fn(async function (payload) { return record("followUp", payload); }),
    deleteReply: vi.fn(async function () { return record("deleteReply", null); }),
    update: vi.fn(async function (payload) { this.replied = true; return record("update", payload); }),
    deferUpdate: vi.fn(async function () { this.deferred = true; return record("deferUpdate", null); }),
    showModal: vi.fn(async function (modal) { return record("showModal", modal); }),
    fetchReply: vi.fn(async () => makeMessage({ channel, guild, createdTimestamp: Date.now() })),

    isChatInputCommand: vi.fn(() => true),
    isCommand: vi.fn(() => true),
    isButton: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    isRepliable: vi.fn(() => true),
    inGuild: vi.fn(() => Boolean(guild)),

    // ── Reader helpers (not part of discord.js — for tests) ──
    _replies,
    getReplies: () => _replies.slice(),
    lastReply: () => (_replies.length ? _replies[_replies.length - 1].payload : null),
    ...rest,
  };
  return interaction;
}

// ─── Message ─────────────────────────────────────────────────────────────────

/**
 * Build a Message-like object with spied reply/react/delete/edit.
 *
 * @param {object} [o]
 * @param {string} [o.content]
 * @param {object} [o.author]
 * @param {object} [o.member]
 * @param {object} [o.guild]
 * @param {object} [o.channel]
 * @param {object} [o.client]
 * @param {Array<object>} [o.mentionsUsers] users considered "mentioned"
 */
export function makeMessage({
  content = "",
  author,
  member,
  guild,
  channel,
  client,
  mentionsUsers = [],
  ...rest
} = {}) {
  author = author ?? makeUser();
  client = client ?? makeClient();
  // guild may legitimately be null (DM). channel defaults to a text channel.
  channel = channel ?? makeChannel({ guild: guild ?? null });
  if (guild && member === undefined) member = makeMember({ user: author, guild });

  const mentionIds = new Set(mentionsUsers.map((u) => (typeof u === "object" ? u.id : u)));

  const message = {
    id: nextId("msg-"),
    content,
    author,
    member: member ?? null,
    guild: guild ?? null,
    channel,
    client,
    createdTimestamp: Date.now(),
    attachments: new Collection(),
    embeds: [],
    mentions: {
      users: new Collection(mentionsUsers.map((u) => [typeof u === "object" ? u.id : u, u])),
      has: vi.fn((target) => {
        const tid = typeof target === "object" ? target?.id : target;
        return mentionIds.has(tid);
      }),
    },
    reply: vi.fn(async (payload) => makeMessage({ content: typeof payload === "string" ? payload : payload?.content, channel, guild, client })),
    react: vi.fn(async () => ({})),
    delete: vi.fn(async () => {}),
    edit: vi.fn(async (payload) => ({ ...message, content: typeof payload === "string" ? payload : payload?.content })),
    pin: vi.fn(async () => {}),
    ...rest,
  };
  return message;
}

// ─── Reply readers ───────────────────────────────────────────────────────────

/** All recorded reply payloads for an interaction built by makeInteraction. */
export function getReplies(interaction) {
  return interaction._replies ? interaction._replies.slice() : [];
}

/** The most recent reply payload (reply/editReply/followUp/update). */
export function lastReply(interaction) {
  const r = getReplies(interaction);
  return r.length ? r[r.length - 1].payload : null;
}

/**
 * Concatenated text we can search for assertions: the content string plus every
 * embed title/description/field across all recorded replies. Handles
 * EmbedBuilder instances (embed.data) and plain embed objects.
 */
export function repliedText(interaction) {
  const parts = [];
  for (const { payload } of getReplies(interaction)) {
    if (!payload) continue;
    if (typeof payload === "string") { parts.push(payload); continue; }
    if (payload.content) parts.push(String(payload.content));
    for (const e of payload.embeds ?? []) {
      const data = e?.data ?? e;
      if (!data) continue;
      if (data.title) parts.push(data.title);
      if (data.description) parts.push(data.description);
      if (data.author?.name) parts.push(data.author.name);
      if (data.footer?.text) parts.push(data.footer.text);
      for (const f of data.fields ?? []) {
        if (f?.name) parts.push(f.name);
        if (f?.value) parts.push(f.value);
      }
    }
  }
  return parts.join("\n");
}

// Re-export for convenience so tests can build perm arrays without importing
// discord.js separately.
export { PermissionFlagsBits, Collection };
