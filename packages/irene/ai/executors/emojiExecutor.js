// @ts-check

const HANDLED = new Set(["list_emojis"]);

/**
 * @param {string} toolName
 * @param {unknown} _input
 * @param {unknown} _message
 * @param {{ guild?: { emojis: { cache: { size: number, map: (fn: (emoji: any) => string) => string[] } } } }} ctx
 * @returns {Promise<string | undefined>}
 */
export async function execute(toolName, _input, _message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  switch (toolName) {
    case "list_emojis": {
      if (!guild) return "this only works in a server, not DMs";
      const emojis = guild.emojis.cache;
      if (!emojis.size) return "No custom emojis";
      return emojis.map((e) => `${e.animated ? "(animated) " : ""}:${e.name}: — ${e.id}`).join("\n");
    }
    default:
      return undefined;
  }
}
