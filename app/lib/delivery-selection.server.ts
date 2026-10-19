import {verifyDeliveryAddress} from "./address-validation.server.ts";
import {combineOrders} from "./order-combination.server.ts";
import type {ShopifyOrder} from "./shopify-orders.server.ts";

/** Use a merchant choice exactly; otherwise try usable source addresses until one verifies. */
export async function selectDeliveryAddress(
  orders: ShopifyOrder[],
  declaredWeight?: number,
  addressOrderId?: string,
) {
  const initial = combineOrders(orders, declaredWeight, addressOrderId);
  const candidates = addressOrderId
    ? [initial.addressOrderId]
    : [initial.addressOrderId, ...initial.addressOptions.map((option) => option.orderId)
      .filter((id) => id !== initial.addressOrderId)];
  let firstFailure: Awaited<ReturnType<typeof verifyDeliveryAddress>> | undefined;
  for (const candidateId of candidates) {
    const combined = candidateId === initial.addressOrderId
      ? initial : combineOrders(orders, declaredWeight, candidateId);
    const verification = await verifyDeliveryAddress(combined.consignee);
    if (verification.ok) return {combined, verification};
    firstFailure ??= verification;
  }
  return {combined: initial, verification: firstFailure!};
}
