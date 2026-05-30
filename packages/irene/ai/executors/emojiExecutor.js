// @ts-check

import { PermissionFlagsBits } from "discord.js";
import { safeFetch } from "@defnotean/shared/safeFetch";
import { isGuildOwnerMember } from "../../utils/permissions.js";

const HANDLED = new Set(["list_emojis", "add_emoji", "remove_emoji"]);
const EMOJI_MAX_BYTES = 256_000;
const EMOJI_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function hasManageExpressions(member) {
  return Boolean(
    isGuildOwnerMember(member) ||
    member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has?.(PermissionFlagsBits.ManageGuildExpressions)
  );
}

/**
 * @param {string} toolName
 * @param {any} input
 * @param {any} message
 * @param {{ guild?: any, by?: string }} ctx
 * @returns {Promise<string | undefined>}
 */
export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, by } = ctx;

  switch (toolName) {
    case "list_emojis": {
      if (!guild) return "this only works in a server, not DMs";
      const emojis = guild.emojis.cache;
      if (!emojis.size) return "No custom emojis";
      return emojis.map((/** @type {any} */ e) => `${e.animated ? "(animated) " : ""}:${e.name}: — ${e.id}`).join("\n");
    }

    case "add_emoji": {
      if (!hasManageExpressions(message.member)) return "You need Manage Expressions to add emojis.";
      if (!hasManageExpressions(guild.members?.me)) return "I need Manage Expressions to add emojis.";
      const res = await safeFetch(input.url, { binary: true, maxBytes: EMOJI_MAX_BYTES, timeoutMs: 10_000 });
      const type = String(res.headers?.get?.("content-type") || "").split(";")[0].toLowerCase();
      if (!EMOJI_IMAGE_TYPES.has(type)) return "Emoji image must be PNG, JPEG, GIF, or WebP.";
      const emoji = await guild.emojis.create({ attachment: res.bytes, name: input.name, reason: `Added ${by}` });
      return `Added emoji :${emoji.name}:`;
    }

    case "remove_emoji": {
      if (!hasManageExpressions(message.member)) return "You need Manage Expressions to remove emojis.";
      if (!hasManageExpressions(guild.members?.me)) return "I need Manage Expressions to remove emojis.";
      const emoji = guild.emojis.cache.find((/** @type {any} */ e) => e.name.toLowerCase() === input.name.toLowerCase());
      if (!emoji) return `Couldn't find emoji "${input.name}"`;
      await emoji.delete(`Removed ${by}`);
      return `Removed emoji :${input.name}:`;
    }

    default:
      return undefined;
  }
}
