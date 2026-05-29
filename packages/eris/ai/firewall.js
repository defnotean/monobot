// ─── Eris firewall — thin wrapper around @defnotean/shared/firewall ───────
// The implementation is consolidated in packages/shared so eris and irene
// cannot drift on detection coverage.

import { createFirewall, spotlight } from "@defnotean/shared/firewall";
import config from "../config.js";
import { log } from "../utils/logger.js";

// shared's createFirewall destructures ownerId/voyageApiKey/log but only gives
// log (and windowStore) a default, so TS infers the options param as just
// `{ log?: () => void, windowStore?: ... }` — ownerId/voyageApiKey aren't known
// properties (TS2353) and log is typed `() => void` while our logger takes a
// message arg. We build a locally-typed options object: ownerId/voyageApiKey are
// pinned to `string` so a real typo there still type-errors, and only `log` is
// cast to `any`. The whole object is then asserted onto the factory's parameter
// type to clear the excess-property check without widening ownerId/voyageApiKey.
// (A JSDoc typedef on shared's createFirewall would let us drop this entirely —
// deferred to a cross-package wave; eris cannot edit shared from this stream.)
/** @type {{ ownerId: string, voyageApiKey: string, log: any }} */
const _fwOptions = {
  ownerId: config.ownerId,
  voyageApiKey: config.voyageApiKey,
  log,
};
const _fw = createFirewall(/** @type {Parameters<typeof createFirewall>[0]} */ (_fwOptions));

export const checkInjection = (text, supabase, userId, opts) => _fw.checkInjection(text, supabase, userId, opts);
export const logBlockedAttempt = (...args) => _fw.logBlockedAttempt(...args);
export const logRedosEvent = (...args) => _fw.logRedosEvent(...args);
export const seedPatternsAtBoot = (...args) => _fw.seedPatternsAtBoot(...args);
export const getRedosLog = () => _fw.getRedosLog();
export const shutdown = () => _fw.shutdown();
export { spotlight };
export const _firewall = _fw; // exposed for tests / introspection
