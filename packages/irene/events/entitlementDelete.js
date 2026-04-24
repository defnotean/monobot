import { log } from "../utils/logger.js";

export const name = "entitlementDelete";

export async function execute(entitlement) {
  log(`[ENTITLEMENT] Cancelled/expired: user ${entitlement.userId} — SKU ${entitlement.skuId}`);
}
