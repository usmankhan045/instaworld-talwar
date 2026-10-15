import {randomUUID} from "node:crypto";

import prisma from "../db.server";
import {combineOrders} from "./order-combination.server";
import {
  createShipment,
  findShipmentByReference,
  getPaymentType,
  normalisePhone,
  normaliseCity,
  truncate,
  requireInstaWorldConfig,
  type InstaWorldRequest,
} from "./instaworld.server";
import {createShopifyFulfillment} from "./shopify-fulfillment.server";
import type {ShopifyOrder} from "./shopify-orders.server";
import {verifyDeliveryAddress} from "./address-validation.server";

const RESERVATION_LEASE_MS = 5 * 60 * 1000;

function fingerprint(orders: ShopifyOrder[], declaredWeight: number) {
  return JSON.stringify({
    orderIds: orders.map((order) => order.id).sort(),
    declaredWeight,
  });
}

/**
 * Pick the best available phone number across the primary order's shipping
 * address and all other combined orders' shipping addresses.
 * Normalises to Pakistani format before returning.
 */
function pickPhone(orders: ShopifyOrder[]): string {
  for (const order of orders) {
    const phone = order.shippingAddress?.phone;
    if (phone) return normalisePhone(phone);
  }
  return "";
}

function splitName(full: string): {first_name: string; last_name?: string} {
  const parts = full.trim().split(/\s+/);
  const first_name = parts[0] || "Customer";
  const last_name = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  return {first_name, last_name};
}

function buildRequest(
  combined: ReturnType<typeof combineOrders>,
  orders: ShopifyOrder[],
  refNo: string,
  locationId: number,
): InstaWorldRequest {
  const consigneeName = combined.consignee.name || "";
  const {first_name, last_name} = splitName(consigneeName);

  // Phone: use consignee phone first, then fall back across all orders
  const phone = normalisePhone(combined.consignee.phone) || pickPhone(orders);

  // City: normalise + alias map
  const city = normaliseCity(combined.consignee.city);

  // Email: use the primary order's email, or "nil" if not provided
  const email = orders[0]?.email || "nil";

  return {
    refNo,
    locationId,
    remarks: "allow to open",
    payment: {
      type: getPaymentType(combined.payment.treatment),
      amount: combined.payment.amountDue,
    },
    consignee: {
      first_name,
      ...(last_name ? {last_name} : {}),
      phone,
      city,
      address: truncate(
        [
          combined.consignee.address1,
          combined.consignee.address2,
          combined.consignee.city,
          combined.consignee.province,
          combined.consignee.zip,
          combined.consignee.country,
        ]
          .filter(Boolean)
          .join(", "),
        200,
      ),
      email,
    },
    items: combined.items.map((item) => ({
      title: item.title ? truncate(item.title, 100) : undefined,
      sku: item.sku ?? undefined,
      // Color from the product's custom.color metafield (set in Shopify admin)
      productDetail: item.color ?? undefined,
      quantity: item.quantity,
      // Fixed 0.8 kg per line item regardless of quantity
      kg: 0.8,
    })),
  };
}

export async function bookCombinedOrders(
  shop: string,
  orders: ShopifyOrder[],
  declaredWeight: number,
  admin?: unknown,
) {
  const config = requireInstaWorldConfig(shop);
  const combined = combineOrders(orders, declaredWeight);
  const addressVerification = await verifyDeliveryAddress(combined.consignee);
  if (!addressVerification.ok) {
    throw new Error(addressVerification.message);
  }
  const verifiedCombined = {
    ...combined,
    consignee: {
      ...combined.consignee,
      address1: addressVerification.verifiedAddress.formattedAddress,
      address2: null,
      city: addressVerification.verifiedAddress.city,
      province: addressVerification.verifiedAddress.province || combined.consignee.province,
      zip: addressVerification.verifiedAddress.postalCode || combined.consignee.zip,
    },
  };
  const attemptId = randomUUID();
  const idempotencyKey = randomUUID();
  // Use Shopify order number(s) as the human-readable refNo (e.g. "1006" or "1006+1007")
  const orderNumbers = orders.map((o) => o.orderNumber).join("+");
  const prefix = config.refPrefix;
  const baseRefNo = `${prefix}${orderNumbers}`.slice(0, 200);
  const leaseExpiresAt = new Date(Date.now() + RESERVATION_LEASE_MS);

  const {attempt, refNo, requestPayload} = await prisma.$transaction(async (tx) => {
    const existing = await tx.shipmentOrder.findFirst({
      where: {shop, shopifyOrderId: {in: combined.orderIds}},
      select: {shopifyOrderNumber: true},
    });
    if (existing) {
      throw new Error(`Order #${existing.shopifyOrderNumber} is already booked.`);
    }

    // Failed attempts remain in the database for auditability. Reuse the
    // readable reference for the first attempt, then add a retry suffix so a
    // later retry cannot collide with the failed reservation.
    const previousReference = await tx.shipment.findUnique({
      where: {shipment_shop_refNo_key: {shop, refNo: baseRefNo}},
      select: {id: true},
    });
    const refNo = previousReference
      ? `${baseRefNo.slice(0, 188)}-R${randomUUID().slice(0, 8)}`
      : baseRefNo;
    const requestPayload = buildRequest(verifiedCombined, orders, refNo, config.locationId!);
    const shipment = await tx.shipment.create({
      data: {
        shop,
        refNo,
        status: "reserved",
        declaredWeight,
        paymentType: combined.payment.treatment,
        amountDue: combined.payment.amountDue,
        currencyCode: combined.payment.currencyCode,
      },
    });
    const bookingAttempt = await tx.bookingAttempt.create({
      data: {
        id: attemptId,
        shop,
        shipmentId: shipment.id,
        idempotencyKey,
        status: "reserved",
        requestFingerprint: fingerprint(orders, declaredWeight),
        requestPayload: JSON.stringify(requestPayload),
        leaseExpiresAt,
        leaseToken: randomUUID(),
      },
    });

    try {
      for (const order of orders) {
        await tx.orderReservation.create({
          data: {
            shop,
            shopifyOrderId: order.id,
            attemptId: bookingAttempt.id,
            leaseExpiresAt,
          },
        });
      }
    } catch {
      throw new Error("One or more orders are already reserved by another booking operation.");
    }
    return {attempt: bookingAttempt, refNo, requestPayload};
  });

  try {
    const existing = await findShipmentByReference(refNo, shop);
    if (existing) {
      return await finalizeSuccessfulBooking(shop, attempt.id, existing.trackingNumber, orders, admin);
    }

    await prisma.bookingAttempt.update({
      where: {id: attempt.id},
      data: {status: "submitting", startedAt: new Date()},
    });
    await prisma.shipment.update({
      where: {id: attempt.shipmentId},
      data: {status: "submitting"},
    });

    const result = await createShipment(requestPayload, idempotencyKey, shop);
    return await finalizeSuccessfulBooking(shop, attempt.id, result.trackingNumber, orders, admin);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
    const definite = status !== null && status >= 400 && status < 500;
    if (!definite) {
      await prisma.bookingAttempt.update({
        where: {id: attempt.id},
        data: {status: "reconciling", lastErrorMessage: error instanceof Error ? error.message : "Ambiguous InstaWorld result."},
      });
      await prisma.shipment.update({where: {id: attempt.shipmentId}, data: {status: "reconciling"}});
      throw new Error("InstaWorld result is ambiguous; the operation remains reserved for reconciliation.");
    }

    await prisma.$transaction([
      prisma.bookingAttempt.update({
        where: {id: attempt.id},
        data: {status: "definite_failure", completedAt: new Date(), lastErrorMessage: error instanceof Error ? error.message : "Booking failed."},
      }),
      prisma.shipment.update({where: {id: attempt.shipmentId}, data: {status: "failed"}}),
      prisma.orderReservation.updateMany({
        where: {attemptId: attempt.id, state: "active"},
        data: {state: "released", releasedAt: new Date()},
      }),
    ]);
    throw error;
  }
}

export async function recoverBookingAttempt(shop: string, attemptId: string) {
  const recoveryToken = randomUUID();
  const now = new Date();
  const claim = await prisma.bookingAttempt.updateMany({
    where: {
      id: attemptId,
      shop,
      status: {in: ["reserved", "submitting", "reconciling"]},
      leaseExpiresAt: {lte: now},
    },
    data: {
      status: "reconciling",
      leaseToken: recoveryToken,
      leaseExpiresAt: new Date(Date.now() + RESERVATION_LEASE_MS),
      recoveryCount: {increment: 1},
    },
  });
  if (claim.count !== 1) {
    throw new Error("Booking attempt is not recoverable or is already being recovered.");
  }

  const attempt = await prisma.bookingAttempt.findUniqueOrThrow({
    where: {id: attemptId},
    include: {shipment: true},
  });
  if (!attempt.requestPayload) {
    throw new Error("Booking attempt has no canonical request payload for recovery.");
  }

  const reservations = await prisma.orderReservation.findMany({
    where: {attemptId},
    select: {shopifyOrderId: true},
  });
  const sourceOrders = reservations.map((reservation) => ({
    id: reservation.shopifyOrderId,
    orderNumber: reservation.shopifyOrderId,
  }));
  const existing = await findShipmentByReference(attempt.shipment.refNo, shop);
  if (existing) {
    return finalizeSuccessfulBooking(shop, attemptId, existing.trackingNumber, sourceOrders);
  }

  const result = await createShipment(
    JSON.parse(attempt.requestPayload) as InstaWorldRequest,
    attempt.idempotencyKey,
    shop,
  );
  return finalizeSuccessfulBooking(shop, attemptId, result.trackingNumber, sourceOrders);
}

async function finalizeSuccessfulBooking(
  shop: string,
  attemptId: string,
  trackingNumber: string,
  sourceOrders: Array<Pick<ShopifyOrder, "id" | "orderNumber">>,
  admin?: unknown,
) {
  const attempt = await prisma.bookingAttempt.findUniqueOrThrow({
    where: {id: attemptId},
    select: {shipmentId: true},
  });
  const reservations = await prisma.orderReservation.findMany({
    where: {attemptId},
    select: {shopifyOrderId: true},
  });
  const orders = await prisma.$transaction(async (tx) => {
    const shipment = await tx.shipment.update({
      where: {id: attempt.shipmentId},
      data: {status: "booked", trackingNumber, bookedAt: new Date()},
    });
    await tx.bookingAttempt.update({
      where: {id: attemptId},
      data: {status: "succeeded", completedAt: new Date()},
    });
    await tx.shipmentOrder.createMany({
      data: reservations.map((reservation) => ({
        shop,
        shipmentId: shipment.id,
        shopifyOrderId: reservation.shopifyOrderId,
        shopifyOrderNumber:
          sourceOrders.find((order) => order.id === reservation.shopifyOrderId)?.orderNumber ||
          reservation.shopifyOrderId,
      })),
    });
    await tx.orderReservation.updateMany({
      where: {attemptId, state: "active"},
      data: {state: "consumed"},
    });
    return shipment;
  });

  // Create Shopify fulfillment with InstaWorld tracking number
  if (admin && trackingNumber) {
    try {
      const shopifyOrderIds = reservations.map((r) => r.shopifyOrderId);
      const fulfillmentId = await createShopifyFulfillment(
        admin,
        shopifyOrderIds,
        trackingNumber,
      );
      if (fulfillmentId) {
        await prisma.shipment.update({
          where: {id: orders.id},
          data: {
            shopifyFulfillmentId: fulfillmentId,
            instaworldStatus: "BOOKED",
          },
        });
      }
    } catch (fulfillmentError) {
      // Non-fatal — booking already succeeded; sync job will create the fulfillment
      console.error("[booking] Failed to create Shopify fulfillment:", fulfillmentError);
    }
  }

  return {trackingNumber: orders.trackingNumber};
}
