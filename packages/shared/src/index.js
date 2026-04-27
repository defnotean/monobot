// ─── @defnotean/shared — public API ──────────────────────────────────────
// Import via deep paths (preferred; keeps imports grep-able):
//   import { categorizeRole } from "@defnotean/shared/roleCategorizer";
//   import { signTwinRequest } from "@defnotean/shared/twinSign";
//   import { LRUCache } from "@defnotean/shared/LRUCache";
//   import { safeFetch } from "@defnotean/shared/safeFetch";
//
// Or via this barrel if the consumer really wants the whole package:
//   import { categorizeRole, signTwinRequest, LRUCache } from "@defnotean/shared";

export * from "./roleCategorizer.js";
export * from "./twinSign.js";
export * from "./LRUCache.js";
export * from "./safeFetch.js";
