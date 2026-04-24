import { log } from "../utils/logger.js";

export const name = "entitlementUpdate";

export async function execute(oldEntitlement, newEntitlement) {
  log(`[ENTITLEMENT] Updated: user ${newEntitlement.userId} — SKU ${newEntitlement.skuId}`);
}
