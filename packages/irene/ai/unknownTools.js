// @ts-check

import {
  UNKNOWN_TOOL_MAX_KEYS,
  UNKNOWN_TOOL_TTL_MS,
  createUnknownToolTracker,
} from "@defnotean/shared/unknownTools";

export { UNKNOWN_TOOL_MAX_KEYS, UNKNOWN_TOOL_TTL_MS, createUnknownToolTracker };

const tracker = createUnknownToolTracker();

export const _unknownToolCounts = tracker._unknownToolCounts;
export const clearUnknownToolCounts = tracker.clearUnknownToolCounts;
export const pruneUnknownToolCounts = tracker.pruneUnknownToolCounts;
export const recordUnknownTool = tracker.recordUnknownTool;
