// ─── Personal Canon (per-bot binding) ──────────────────────────────────────
// Thin shim around @defnotean/shared/selfCanon that wires the bot-local
// personality store. The actual logic lives in shared; this file only exists
// to bind `_getData` / `_markOpinionsDirty` from `./personality.js`.

import { createSelfCanon, _internal } from "@defnotean/shared/selfCanon";
import { _getData, _markOpinionsDirty } from "./personality.js";

const canon = createSelfCanon({
  getData: _getData,
  markOpinionsDirty: _markOpinionsDirty,
});

export const recordSelfFact = canon.recordSelfFact;
export const listSelfFacts = canon.listSelfFacts;
export const forgetSelfFact = canon.forgetSelfFact;
export const buildSelfCanonContext = canon.buildSelfCanonContext;

// Re-export internals for tests that still want them.
export { _internal };
