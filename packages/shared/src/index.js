// ─── @defnotean/shared — public API ──────────────────────────────────────
// Import via deep paths (preferred; keeps imports grep-able):
//   import { categorizeRole } from "@defnotean/shared/roleCategorizer";
//   import { signTwinRequest } from "@defnotean/shared/twinSign";
//   import { LRUCache } from "@defnotean/shared/LRUCache";
//   import { safeFetch } from "@defnotean/shared/safeFetch";
//   import { createFirewall, spotlight } from "@defnotean/shared/firewall";
//
// Or via this barrel if the consumer really wants the whole package:
//   import { categorizeRole, signTwinRequest, LRUCache } from "@defnotean/shared";

export * from "./roleCategorizer.js";
export * from "./twinSign.js";
export * from "./LRUCache.js";
export * from "./safeFetch.js";
export * from "./rateLimit.js";
export * from "./httpRequest.js";
export * from "./logRedact.js";
export * from "./ai/promptBudget.js";
export * from "./ai/innerState.js";
export * from "./ai/gifCadence.js";
export * from "./ai/localVision.js";
export { createFirewall, spotlight, normalizeText, InMemoryWindowStore, RedisWindowStore } from "./ai/firewall.js";
