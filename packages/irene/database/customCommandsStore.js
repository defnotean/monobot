/**
 * @file packages/irene/database/customCommandsStore.js
 * @module irene/database/customCommandsStore
 *
 * Wires the pure custom-commands store (./customCommands.js) to the shared
 * cache + save pipeline in ./core.js. The factory closes over `getData`,
 * `markEntity`, and `save` so it reads/writes the same singleton cache as
 * every other domain module.
 */

import { data, save, _markEntity } from "./core.js";
import { createCustomCommandsStore } from "./customCommands.js";

const _customCommandsStore = createCustomCommandsStore({
  getData: () => data,
  markEntity: _markEntity,
  save,
});

export const getCustomCommands = _customCommandsStore.getCustomCommands;

export const getCustomCommand = _customCommandsStore.getCustomCommand;

export const setCustomCommand = _customCommandsStore.setCustomCommand;

export const deleteCustomCommand = _customCommandsStore.deleteCustomCommand;
export const listCustomCommands = _customCommandsStore.listCustomCommands;
