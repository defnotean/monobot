// ─── Eris firewall — thin wrapper around @defnotean/shared/firewall ───────
// The implementation is consolidated in packages/shared so eris and irene
// cannot drift on detection coverage.

import { createFirewall, spotlight } from "@defnotean/shared/firewall";
import config from "../config.js";
import { log } from "../utils/logger.js";

// shared's createFirewall now carries a JSDoc `FirewallOptions` typedef
// (ownerId?: string, voyageApiKey?: string, log?: (msg: string) => void, …), so
// the options object type-checks directly — no `any` cast or Parameters<>
// assertion needed. The typedef still catches a real ownerId/voyageApiKey typo
// (unknown property → TS2353) and a wrong-typed value, and `log` matches our
// single-arg logger, so this no longer masks bugs.
const _fw = createFirewall({
  ownerId: config.ownerId,
  voyageApiKey: config.voyageApiKey,
  log,
});

export const checkInjection = (text, supabase, userId, opts) => _fw.checkInjection(text, supabase, userId, opts);
export const logBlockedAttempt = (...args) => _fw.logBlockedAttempt(...args);
export const logRedosEvent = (...args) => _fw.logRedosEvent(...args);
export const seedPatternsAtBoot = (...args) => _fw.seedPatternsAtBoot(...args);
export const getRedosLog = () => _fw.getRedosLog();
export const shutdown = () => _fw.shutdown();
export { spotlight };
export const _firewall = _fw; // exposed for tests / introspection
