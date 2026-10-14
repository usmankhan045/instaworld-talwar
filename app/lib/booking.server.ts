import {randomUUID} from "node:crypto";

import prisma from "../db.server";
import {combineOrders} from "./order-combination.server";
import {
  createShipment,
  findShipmentByReference,
  getPaymentType,
  buildStableReference,
  isContractConfirmed,
  type InstaWorldRequest,
} from "./instaworld.server";
import type {ShopifyOrder} from "./shopify-orders.server";

const RESERVATION_LEASE_MS = 5 * 60 * 1000;

function fingerprint(orders: ShopifyOrder[], declaredWeight: number) {
  return JSON.stringify({
    orderIds: orders.map((order) => order.id).sort(),
    declaredWeight,
  });
}

function addressText(order: ShopifyOrder) {
  const address = order.shippingAddress;
  if (!address) throw new Error(`Order #${order.orderNumber} has no shipping address.`);
  return [address.address1, address.address2, address.city, address.province, address.zip, address.country]
    .filter(Boolean)
    .join(", ");
}

function buildRequest(
  combined: ReturnType<typeof combineOrders>,
  orders: ShopifyOrder[],
  refNo: string,
): InstaWorldRequest {
  return {
    refNo,
    dispatchLocationId: Number(process.env.INSTAWORLD_LOCATION_ID || 16917),
    payment: {
      type: getPaymentType(combined.payment.treatment),
      amount: combined.payment.amountDue,
    },
    consignee: {
      name: combined.consignee.name || orders[0].customer?.name || "",
      phone: combined.consignee.phone || "",
      city: combined.consignee.city || "",
      address: addressText(orders[0]),
    },
    items: combined.items.map((item) => ({
      name: item.title,
      sku: item.sku,
      quantity: item.quantity,
      weight: item.quantity * 0.8,
    })),
  };
}

export async function bookCombinedOrders(
  shop: string,
  orders: ShopifyOrder[],
  declaredWeight: number,
) {
  if (!isContractConfirmed() || process.env.INSTAWORLD_ENABLE_LIVE !== "true") {
    throw new Error("Live InstaWorld booking is disabled until the API contract is confirmed.");
  }

  const combined = combineOrders(orders, declaredWeight);
  const attemptId = randomUUID();
  const idempotencyKey = randomUUID();
  const refNo = buildStableReference(attemptId);
  const leaseExpiresAt = new Date(Date.now() + RESERVATION_LEASE_MS);
  const requestPayload = buildRequest(combined, orders, refNo);

  const attempt = await prisma.$transaction(async (tx) => {
    const existing = await tx.shipmentOrder.findFirst({
      where: {shop, shopifyOrderId: {in: combined.orderIds}},
      select: {shopifyOrderNumber: true},
    });
    if (existing) {
      throw new Error(`Order #${existing.shopifyOrderNumber} is already booked.`);
    }

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
    return bookingAttempt;
  });

  try {
    const existing = await findShipmentByReference(refNo);
    if (existing) {
      return await finalizeSuccessfulBooking(shop, attempt.id, existing.trackingNumber, orders);
    }

    await prisma.bookingAttempt.update({
      where: {id: attempt.id},
      data: {status: "submitting", startedAt: new Date()},
    });
    await prisma.shipment.update({
      where: {id: attempt.shipmentId},
      data: {status: "submitting"},
    });

    const result = await createShipment(requestPayload, idempotencyKey);
    return await finalizeSuccessfulBooking(shop, attempt.id, result.trackingNumber, orders);
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
  if (!isContractConfirmed() || process.env.INSTAWORLD_ENABLE_LIVE !== "true") {
    throw new Error("Live InstaWorld recovery is disabled until the API contract is confirmed.");
  }
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
  const existing = await findShipmentByReference(attempt.shipment.refNo);
  if (existing) {
    return finalizeSuccessfulBooking(shop, attemptId, existing.trackingNumber, sourceOrders);
  }

  const result = await createShipment(
    JSON.parse(attempt.requestPayload) as InstaWorldRequest,
    attempt.idempotencyKey,
  );
  return finalizeSuccessfulBooking(shop, attemptId, result.trackingNumber, sourceOrders);
}

async function finalizeSuccessfulBooking(
  shop: string,
  attemptId: string,
  trackingNumber: string,
  sourceOrders: Array<Pick<ShopifyOrder, "id" | "orderNumber">>,
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
  return {trackingNumber: orders.trackingNumber};
}
