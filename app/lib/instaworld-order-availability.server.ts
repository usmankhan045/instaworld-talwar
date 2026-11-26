import prisma from "../db.server.ts";
import {
  findShipmentByReference,
  isCancelledShipment,
  type InstaWorldConfig,
  type InstaWorldShipment,
} from "./instaworld.server.ts";
import type {ShopifyOrder} from "./shopify-orders.server.ts";

export type InstaWorldOrderAvailability = {
  orderId: string;
  orderNumber: string;
  available: boolean;
  verified: boolean;
  existingReference?: string;
  trackingNumber?: string;
};

type AvailabilityOptions = {
  findShipment?: (reference: string, config: InstaWorldConfig) => Promise<InstaWorldShipment | null>;
  linkedReferences?: Map<string, string[]>;
};

/**
 * Check InstaWorld directly before an order is added to a combined shipment.
 * A cancelled shipment is reusable; every other remote shipment state blocks it.
 */
export async function checkInstaWorldOrderAvailability(
  shop: string,
  orders: Array<Pick<ShopifyOrder, "id" | "orderNumber">>,
  config: InstaWorldConfig,
  options: AvailabilityOptions = {},
): Promise<InstaWorldOrderAvailability[]> {
  const linkedReferences = options.linkedReferences ?? new Map<string, string[]>();
  if (!options.linkedReferences && orders.length > 0) {
    const links = await prisma.shipmentOrder.findMany({
      where: {shop, shopifyOrderId: {in: orders.map((order) => order.id)}},
      select: {shopifyOrderId: true, shipment: {select: {refNo: true}}},
    });
    for (const link of links) {
      const references = linkedReferences.get(link.shopifyOrderId) ?? [];
      references.push(link.shipment.refNo);
      linkedReferences.set(link.shopifyOrderId, references);
    }
  }

  const lookup = options.findShipment ?? findShipmentByReference;
  return Promise.all(orders.map(async (order) => {
    const references = [...new Set([order.orderNumber, ...(linkedReferences.get(order.id) ?? [])])];
    const results = await Promise.allSettled(references.map((reference) => lookup(reference, config)));
    const activeIndex = results.findIndex((result) => result.status === "fulfilled" &&
      result.value && !isCancelledShipment(result.value));
    if (activeIndex >= 0) {
      const shipment = results[activeIndex] as PromiseFulfilledResult<InstaWorldShipment>;
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        available: false,
        verified: true,
        existingReference: references[activeIndex],
        trackingNumber: shipment.value.trackingNumber,
      };
    }
    // Fail closed: every reference must be verified before suggesting an order.
    if (results.some((result) => result.status === "rejected")) {
      return {orderId: order.id, orderNumber: order.orderNumber, available: false, verified: false};
    }
    return {orderId: order.id, orderNumber: order.orderNumber, available: true, verified: true};
  }));
}

export function secondaryOrderAvailabilityError(results: InstaWorldOrderAvailability[]) {
  const existing = results.filter((result) => result.verified && !result.available);
  if (existing.length > 0) {
    return {
      code: "ORDER_ALREADY_IN_INSTAWORLD",
      blockedOrderIds: existing.map((result) => result.orderId),
      orderNumbers: existing.map((result) => result.orderNumber),
      message: `${existing.length === 1 ? "This order already has" : "These orders already have"} an InstaWorld shipment (in progress or delivered) and cannot be added as a second order.`,
    };
  }
  const unverified = results.filter((result) => !result.verified);
  if (unverified.length > 0) {
    return {
      code: "INSTAWORLD_STATUS_UNAVAILABLE",
      blockedOrderIds: unverified.map((result) => result.orderId),
      orderNumbers: unverified.map((result) => result.orderNumber),
      message: `InstaWorld could not verify ${unverified.length === 1 ? "this order" : "these orders"}. It was not added as a second order. Try again shortly.`,
    };
  }
  return null;
}
