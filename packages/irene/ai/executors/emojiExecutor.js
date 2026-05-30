// @ts-check

const HANDLED = new Set(["list_emojis", "add_emoji", "remove_emoji"]);

/**
 * @param {string} toolName
 * @param {any} input
 * @param {any} _message
 * @param {{ guild?: any, by?: string }} ctx
 * @returns {Promise<string | undefined>}
 */
export async function execute(toolName, input, _message, ctx) {
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
      const emoji = await guild.emojis.create({ attachment: input.url, name: input.name, reason: `Added ${by}` });
      return `Added emoji :${emoji.name}:`;
    }

    case "remove_emoji": {
      const emoji = guild.emojis.cache.find((/** @type {any} */ e) => e.name.toLowerCase() === input.name.toLowerCase());
      if (!emoji) return `Couldn't find emoji "${input.name}"`;
      await emoji.delete(`Removed ${by}`);
      return `Removed emoji :${input.name}:`;
    }

    default:
      return undefined;
  }
}
