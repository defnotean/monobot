// ─── Cross-Bot State Awareness (per-bot binding) ───────────────────────────
// Thin shim around @defnotean/shared/twinState that wires Irene's config
// (TWIN_API_SECRET + ERIS_API_URL) and logger into the shared module.

import { createTwinState } from "@defnotean/shared/twinState";
import config from "../config.js";
import { log } from "./logger.js";

const twinState = createTwinState({
  getSecret: () => config.twinApiSecret,
  getUrl: () => config.twinApiUrl,
  log,
});

export const getTwinStateCached = twinState.getTwinStateCached;
export const buildTwinStateContext = twinState.buildTwinStateContext;
export const _clearCache = twinState._clearCache;
