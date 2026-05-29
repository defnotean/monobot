// @ts-check

/**
 * @typedef {{ trigger?: string, created_at?: string, [key: string]: any }} CustomCommand
 * @typedef {{ custom_commands?: Record<string, Record<string, CustomCommand>> }} DatabaseShape
 * @typedef {{
 *   getData: () => DatabaseShape,
 *   markEntity: (slice: "custom_commands", key: string) => void,
 *   save: (bucket: "custom_commands") => void,
 * }} CustomCommandStoreDeps
 */

/**
 * @param {CustomCommandStoreDeps} deps
 */
export function createCustomCommandsStore({ getData, markEntity, save }) {
  /**
   * @param {string} guildId
   * @returns {Record<string, CustomCommand>}
   */
  function getCustomCommands(guildId) {
    const data = getData();
    if (!data.custom_commands) data.custom_commands = {};
    return data.custom_commands[guildId] || {};
  }

  /**
   * @param {string} guildId
   * @param {string} trigger
   * @returns {CustomCommand | null}
   */
  function getCustomCommand(guildId, trigger) {
    return getCustomCommands(guildId)[trigger.toLowerCase()] || null;
  }

  /**
   * @param {string} guildId
   * @param {string} trigger
   * @param {CustomCommand} command
   */
  function setCustomCommand(guildId, trigger, command) {
    const data = getData();
    if (!data.custom_commands) data.custom_commands = {};
    if (!data.custom_commands[guildId]) data.custom_commands[guildId] = {};
    data.custom_commands[guildId][trigger.toLowerCase()] = {
      ...command,
      trigger: trigger.toLowerCase(),
      created_at: command.created_at ?? new Date().toISOString(),
    };
    markEntity("custom_commands", guildId);
    save("custom_commands");
  }

  /**
   * @param {string} guildId
   * @param {string} trigger
   * @returns {boolean}
   */
  function deleteCustomCommand(guildId, trigger) {
    const data = getData();
    if (!data.custom_commands?.[guildId]) return false;
    const key = trigger.toLowerCase();
    if (data.custom_commands[guildId][key]) {
      delete data.custom_commands[guildId][key];
      markEntity("custom_commands", guildId);
      save("custom_commands");
      return true;
    }
    return false;
  }

  /**
   * @param {string} guildId
   * @returns {CustomCommand[]}
   */
  function listCustomCommands(guildId) {
    return Object.values(getCustomCommands(guildId));
  }

  return {
    getCustomCommands,
    getCustomCommand,
    setCustomCommand,
    deleteCustomCommand,
    listCustomCommands,
  };
}
