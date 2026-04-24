import { log } from "../utils/logger.js";

export const name = "entitlementCreate";

export async function execute(entitlement) {
  log(`[ENTITLEMENT] New subscription: user ${entitlement.userId} — SKU ${entitlement.skuId}`);
}
