// @ts-check
/**
 * Reusable mock-Discord test helper for the eris package.
 *
 * Provides factory functions that build the shapes eris's slash commands and
 * event handlers actually read off of discord.js objects — NOT a full mock of
 * discord.js. The factories were modeled directly against real command/event
 * usage in packages/eris/commands/* and packages/eris/events/*, e.g.:
 *
 *   - interaction.options.getString/getInteger/getBoolean/getUser/getChannel/
 *     getRole/getSubcommand/getSubcommandGroup    (bumpconfig, coinflip, marry…)
 *   - interaction.reply / deferReply / editReply / followUp / fetchReply /
 *     showModal                                    (ping, slots, interactionCreate)
 *   - interaction.replied / interaction.deferred flags  (interactionCreate)
 *   - interaction.user / interaction.member / interaction.guild /
 *     interaction.channel / interaction.client.{commands,guilds,ws,user}
 *   - interaction.isButton/isStringSelectMenu/isModalSubmit/isCommand/
 *     isChatInputCommand + customId/commandName    (interactionCreate)
 *   - message.content/author/member/guild/guildId/channel.{send,sendTyping}/
 *     reply/react/mentions                          (messageCreate, reactions)
 *   - guild.id/name/ownerId/members/roles/channels  (guildCreate, bumpconfig)
 *
 * Every interactive method is a vitest vi.fn() spy so tests can assert what a
 * handler replied / deferred / followed up with. Reply payloads are also
 * captured so tests can read the *last* thing a handler said without digging
 * through mock.calls.
 *
 * All factories accept a single `overrides` object and deep-merge shallowly:
 * pass only the fields the handler under test reads; everything else gets a
 * sensible default. Nested objects you pass (user, member, guild, channel,
 * options) replace the default for that key wholesale, so build them with the
 * sibling factories when you need a partial.
 */

import { vi } from "vitest";

let _idCounter = 0;
/** Monotonic-ish snowflake-shaped id so distinct factory calls don't collide. */
function nextId(prefix = "") {
  _idCounter += 1;
  // 18-digit numeric-string id, like a real Discord snowflake.
  const base = (1000000000000000000n + BigInt(_idCounter)).toString();
  return prefix ? `${prefix}-${base}` : base;
}

/* ───────────────────────── Options accessor ───────────────────────── */

/**
 * Build an `interaction.options`-shaped accessor.
 *
 * @param {Record<string, any>} [values] - keyed by option name; the value is
 *   whatever the matching getter should return. For user/channel/role you can
 *   pass either a fully-built object or a plain `{ id, ... }`.
 * @param {{ subcommand?: string|null, subcommandGroup?: string|null }} [meta]
 */
export function makeOptions(values = {}, meta = {}) {
  const subcommand = meta.subcommand ?? null;
  const subcommandGroup = meta.subcommandGroup ?? null;

  /** @param {string} name */
  const get = (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null);

  return {
    /** raw bag, handy for assertions/debugging */
    _values: values,

    getString: vi.fn((name) => {
      const v = get(name);
      return v == null ? null : String(v);
    }),
    getInteger: vi.fn((name) => {
      const v = get(name);
      return v == null ? null : Number(v);
    }),
    getNumber: vi.fn((name) => {
      const v = get(name);
      return v == null ? null : Number(v);
    }),
    getBoolean: vi.fn((name) => {
      const v = get(name);
      return v == null ? null : Boolean(v);
    }),
    // user/channel/role return the object as-is (real discord.js returns rich
    // objects; commands read .id, .username, .bot, .isTextBased(), etc).
    getUser: vi.fn((name) => get(name)),
    getMember: vi.fn((name) => get(name)),
    getChannel: vi.fn((name) => get(name)),
    getRole: vi.fn((name) => get(name)),
    getMentionable: vi.fn((name) => get(name)),
    getAttachment: vi.fn((name) => get(name)),

    // Subcommand routing. real discord.js throws if there is no subcommand and
    // you call getSubcommand() without `false`; commands typically call it
    // unconditionally only on commands that have subcommands, so we mirror the
    // optional form: getSubcommand(false) -> null, getSubcommand() -> value.
    getSubcommand: vi.fn((required = true) => {
      if (subcommand == null && required) {
        throw new Error("No subcommand was provided (mockDiscord makeOptions)");
      }
      return subcommand;
    }),
    getSubcommandGroup: vi.fn((_required = true) => subcommandGroup),
  };
}

/* ───────────────────────── Reply capture ───────────────────────── */

/**
 * Normalize a reply/edit/followUp argument into a content string + payload.
 * Commands call reply either with a bare string or `{ content, embeds, ... }`.
 * @param {any} arg
 */
function normalizeReply(arg) {
  if (typeof arg === "string") return { content: arg, payload: { content: arg } };
  if (arg && typeof arg === "object") return { content: arg.content ?? null, payload: arg };
  return { content: null, payload: arg };
}

/* ───────────────────────── Guild / Channel / Role / Member ───────────────────────── */

/**
 * @param {Partial<{
 *   id: string, name: string, ownerId: string, memberCount: number,
 *   roles: any[], channels: any[], members: any[], iconURL: any, me: any,
 * }>} [overrides]
 */
export function makeGuild(overrides = {}) {
  const id = overrides.id ?? nextId("guild");
  const roleArr = overrides.roles ?? [];
  const channelArr = overrides.channels ?? [];
  const memberArr = overrides.members ?? [];

  const roleCache = new Map(roleArr.map((r) => [r.id, r]));
  const channelCache = new Map(channelArr.map((c) => [c.id, c]));
  const memberCache = new Map(memberArr.map((m) => [m.id, m]));

  return {
    id,
    name: overrides.name ?? "Test Guild",
    ownerId: overrides.ownerId ?? nextId("owner"),
    memberCount: overrides.memberCount ?? (memberArr.length || 1),
    iconURL: overrides.iconURL === undefined ? vi.fn(() => "https://cdn.discord/icon.png") : overrides.iconURL,
    roles: {
      cache: roleCache,
      fetch: vi.fn(async (rid) => roleCache.get(rid) ?? null),
    },
    channels: {
      cache: channelCache,
      fetch: vi.fn(async (cid) => channelCache.get(cid) ?? null),
    },
    members: {
      cache: memberCache,
      me: overrides.me ?? memberArr[0] ?? null,
      fetch: vi.fn(async (mid) => memberCache.get(mid) ?? null),
    },
    leave: vi.fn(async () => {}),
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => null } })),
  };
}

/**
 * @param {Partial<{ id: string, name: string }>} [overrides]
 */
export function makeRole(overrides = {}) {
  return {
    id: overrides.id ?? nextId("role"),
    name: overrides.name ?? "Test Role",
    ...overrides,
  };
}

/**
 * @param {Partial<{
 *   id: string, name: string, type: number, textBased: boolean,
 *   guild: any, isDM: boolean,
 * }>} [overrides]
 */
export function makeChannel(overrides = {}) {
  const textBased = overrides.textBased ?? true;
  const send = vi.fn(async (arg) => normalizeReply(arg).payload);
  return {
    id: overrides.id ?? nextId("chan"),
    name: overrides.name ?? "general",
    type: overrides.type ?? 0,
    send,
    sendTyping: vi.fn(async () => {}),
    isTextBased: vi.fn(() => textBased),
    isDMBased: vi.fn(() => overrides.isDM ?? false),
    guild: overrides.guild ?? null,
    ...("guild" in overrides ? { guild: overrides.guild } : {}),
  };
}

/**
 * Build a GuildMember-shaped object.
 * @param {Partial<{
 *   id: string, user: any, permissions: any, roles: string[],
 *   displayName: string, nickname: string|null,
 * }>} [overrides]
 */
export function makeMember(overrides = {}) {
  const user = overrides.user ?? makeUser({ id: overrides.id });
  const id = overrides.id ?? user.id;
  // Permission set: tests pass an array of bigint flags (PermissionFlagsBits.X)
  // or a boolean. We model `member.permissions.has(flag)`.
  const permList = overrides.permissions;
  const permissions = {
    has: vi.fn((flag) => {
      if (permList === true) return true;
      if (Array.isArray(permList)) {
        return permList.some((p) => p === flag || String(p) === String(flag));
      }
      return false;
    }),
  };
  const roleIds = overrides.roles ?? [];
  return {
    id,
    user,
    displayName: overrides.displayName ?? user.username,
    nickname: overrides.nickname ?? null,
    permissions,
    roles: {
      cache: new Map(roleIds.map((rid) => [rid, makeRole({ id: rid })])),
    },
  };
}

/**
 * @param {Partial<{ id: string, username: string, bot: boolean, tag: string }>} [overrides]
 */
export function makeUser(overrides = {}) {
  const id = overrides.id ?? nextId("user");
  const username = overrides.username ?? "tester";
  return {
    id,
    username,
    bot: overrides.bot ?? false,
    tag: overrides.tag ?? `${username}#0001`,
    displayAvatarURL: vi.fn(() => "https://cdn.discord/avatar.png"),
    ...overrides,
  };
}

/* ───────────────────────── Client ───────────────────────── */

/**
 * Build an `interaction.client` / `message.client`-shaped object.
 * @param {Partial<{
 *   user: any, commands: Map<string, any>, modalHandlers: Map<string, any>,
 *   guilds: any[], wsPing: number,
 * }>} [overrides]
 */
export function makeClient(overrides = {}) {
  const guildArr = overrides.guilds ?? [];
  return {
    user: overrides.user ?? makeUser({ id: nextId("bot"), username: "eris", bot: true }),
    ws: { ping: overrides.wsPing ?? 42 },
    commands: overrides.commands ?? new Map(),
    modalHandlers: overrides.modalHandlers ?? new Map(),
    guilds: {
      cache: new Map(guildArr.map((g) => [g.id, g])),
      fetch: vi.fn(async (gid) => guildArr.find((g) => g.id === gid) ?? null),
    },
    users: {
      fetch: vi.fn(async (uid) => makeUser({ id: uid })),
    },
  };
}

/* ───────────────────────── Interaction ───────────────────────── */

/**
 * Build a ChatInputCommandInteraction-shaped object for testing slash commands.
 *
 * @param {Partial<{
 *   commandName: string,
 *   options: Record<string, any> | ReturnType<typeof makeOptions>,
 *   subcommand: string|null,
 *   subcommandGroup: string|null,
 *   user: any,
 *   member: any,
 *   guild: any,
 *   channel: any,
 *   client: any,
 *   customId: string,
 *   type: "command"|"button"|"select"|"modal",
 *   replied: boolean,
 *   deferred: boolean,
 *   createdTimestamp: number,
 * }>} [overrides]
 */
export function makeInteraction(overrides = {}) {
  const type = overrides.type ?? "command";

  // options can be a prebuilt accessor (has getString) or a raw values bag.
  let options;
  if (overrides.options && typeof (/** @type any */ (overrides.options)).getString === "function") {
    options = overrides.options;
  } else {
    options = makeOptions(/** @type any */ (overrides.options) ?? {}, {
      subcommand: overrides.subcommand ?? null,
      subcommandGroup: overrides.subcommandGroup ?? null,
    });
  }

  const user = overrides.user ?? makeUser();
  const member =
    overrides.member ?? (overrides.guild ? makeMember({ user }) : null);
  const guild = overrides.guild === undefined ? makeGuild() : overrides.guild;
  const channel = overrides.channel ?? makeChannel({ guild });
  const client = overrides.client ?? makeClient();

  // Captured reply state so tests can read what was said last.
  /** @type {{ content: string|null, payload: any }[]} */
  const replies = [];

  const interaction = {
    id: nextId("interaction"),
    commandName: overrides.commandName ?? "test",
    customId: overrides.customId ?? "",
    options,
    user,
    member,
    guild,
    guildId: guild ? guild.id : null,
    channel,
    channelId: channel ? channel.id : null,
    client,
    locale: "en-US",
    createdTimestamp: overrides.createdTimestamp ?? Date.now(),

    // Mutable lifecycle flags. interactionCreate reads these to decide whether
    // it is safe to reply.
    replied: overrides.replied ?? false,
    deferred: overrides.deferred ?? false,

    // ── interaction-kind guards (interactionCreate routes on these) ──
    isButton: vi.fn(() => type === "button"),
    isStringSelectMenu: vi.fn(() => type === "select"),
    isModalSubmit: vi.fn(() => type === "modal"),
    isCommand: vi.fn(() => type === "command"),
    isChatInputCommand: vi.fn(() => type === "command"),
    isAutocomplete: vi.fn(() => false),

    // ── reply surface (all spied) ──
    reply: vi.fn(async (arg) => {
      const n = normalizeReply(arg);
      replies.push(n);
      interaction.replied = true;
      return { ...n.payload, id: nextId("msg") };
    }),
    deferReply: vi.fn(async (/** @type {any} */ _opts = undefined) => {
      interaction.deferred = true;
      return undefined;
    }),
    editReply: vi.fn(async (arg) => {
      const n = normalizeReply(arg);
      replies.push(n);
      interaction.replied = true;
      return { ...n.payload, id: nextId("msg") };
    }),
    followUp: vi.fn(async (arg) => {
      const n = normalizeReply(arg);
      replies.push(n);
      return { ...n.payload, id: nextId("msg") };
    }),
    deleteReply: vi.fn(async () => {}),
    fetchReply: vi.fn(async () => {
      const last = replies[replies.length - 1];
      return { ...(last ? last.payload : {}), id: nextId("msg"), createdTimestamp: interaction.createdTimestamp + 1 };
    }),
    showModal: vi.fn(async (_modal) => {
      interaction.replied = true;
      return undefined;
    }),

    // Internal capture — read via getReplies()/getLastReply() helpers below.
    _replies: replies,
  };

  return interaction;
}

/* ───────────────────────── Message ───────────────────────── */

/**
 * Build a Message-shaped object for testing messageCreate / reaction handlers.
 *
 * @param {Partial<{
 *   content: string,
 *   author: any,
 *   member: any,
 *   guild: any,
 *   guildId: string|null,
 *   channel: any,
 *   client: any,
 *   mentions: any,
 *   reference: any,
 * }>} [overrides]
 */
export function makeMessage(overrides = {}) {
  const author = overrides.author ?? makeUser();
  const guild = overrides.guild === undefined ? makeGuild() : overrides.guild;
  const channel = overrides.channel ?? makeChannel({ guild });
  const client = overrides.client ?? makeClient();

  /** @type {{ content: string|null, payload: any }[]} */
  const replies = [];

  const mentions = overrides.mentions ?? {
    users: new Map(),
    roles: new Map(),
    has: vi.fn(() => false),
  };

  const message = {
    id: nextId("msg"),
    content: overrides.content ?? "hello eris",
    author,
    member: overrides.member ?? (guild ? makeMember({ user: author }) : null),
    guild,
    guildId: "guildId" in overrides ? overrides.guildId : guild ? guild.id : null,
    channel,
    client,
    mentions,
    reference: overrides.reference ?? null,
    createdTimestamp: Date.now(),

    reply: vi.fn(async (arg) => {
      const n = normalizeReply(arg);
      replies.push(n);
      return { ...n.payload, id: nextId("msg") };
    }),
    react: vi.fn(async (_emoji) => ({})),
    delete: vi.fn(async () => ({})),
    edit: vi.fn(async (arg) => normalizeReply(arg).payload),

    _replies: replies,
  };

  return message;
}

/* ───────────────────────── Reply readers ───────────────────────── */

/**
 * Return the array of normalized replies an interaction/message captured.
 * @param {{ _replies: { content: string|null, payload: any }[] }} obj
 */
export function getReplies(obj) {
  return obj._replies.slice();
}

/**
 * Return the last reply's normalized form, or null if nothing was said.
 * @param {{ _replies: { content: string|null, payload: any }[] }} obj
 * @returns {{ content: string|null, payload: any }|null}
 */
export function getLastReply(obj) {
  const r = obj._replies;
  return r.length ? r[r.length - 1] : null;
}

/**
 * Convenience: the `content` string of the last reply (or null).
 * @param {{ _replies: { content: string|null, payload: any }[] }} obj
 */
export function getLastReplyContent(obj) {
  const last = getLastReply(obj);
  return last ? last.content : null;
}
