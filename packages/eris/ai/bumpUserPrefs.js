// ─── Bump User Preferences (per-bot binding) ───────────────────────────────
// Thin shim around @defnotean/shared/bumpUserPrefs that wires Eris's
// Supabase client and logger into the shared module.

import { createBumpUserPrefs, _internal } from "@defnotean/shared/bumpUserPrefs";
import { getSupabase } from "../database.js";
import { log } from "../utils/logger.js";

const prefs = createBumpUserPrefs({ getSupabase, log });

export const getUserPrefs = prefs.getUserPrefs;
export const setUserPref = prefs.setUserPref;
export const getPersonalPingOptIns = prefs.getPersonalPingOptIns;
export const _clearCache = prefs._clearCache;
export { _internal };
