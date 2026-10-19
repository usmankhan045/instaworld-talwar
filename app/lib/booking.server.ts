import {randomUUID} from "node:crypto";

import prisma from "../db.server";
import {combineOrders} from "./order-combination.server";
import {
  allocateShipmentWeight,
  buildInstaWorldAddress,
  createShipment,
  FIXED_SHIPMENT_WEIGHT_KG,
  findShipmentByReference,
  isCancelledShipment,
  getPaymentType,
  normalisePhone,
  normaliseCity,
  resolveInstaWorldCity,
  replaceCityInAddress,
  truncate,
  type InstaWorldConfig,
  type InstaWorldRequest,
} from "./instaworld.server";
import {createShopifyFulfillment} from "./shopify-fulfillment.server";
import type {ShopifyOrder} from "./shopify-orders.server";
import {selectDeliveryAddress} from "./delivery-selection.server";
import {resolveInstaWorldConfig} from "./instaworld-accounts.server";
import {
  checkInstaWorldOrderAvailability,
  secondaryOrderAvailabilityError,
} from "./instaworld-order-availability.server";

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

function memoizedShipmentLookup(config: InstaWorldConfig) {
  const lookups = new Map<string, Promise<Awaited<ReturnType<typeof findShipmentByReference>>>>();
  return (reference: string) => {
    let lookup = lookups.get(reference);
    if (!lookup) {
      lookup = findShipmentByReference(reference, config);
      lookups.set(reference, lookup);
    }
    return lookup;
  };
}

async function releaseReservationsForCancelledShipments(
  shop: string,
  orderIds: string[],
  lookupShipment: (reference: string) => ReturnType<typeof findShipmentByReference>,
) {
  const activeReservations = await prisma.orderReservation.findMany({
    where: {
      shop,
      shopifyOrderId: {in: orderIds},
      state: "active",
      leaseExpiresAt: {gt: new Date()},
    },
    select: {attemptId: true},
  });
  if (activeReservations.length === 0) return;

  const attemptIds = [...new Set(activeReservations.map((reservation) => reservation.attemptId))];
  const attempts = await prisma.bookingAttempt.findMany({
    where: {shop, id: {in: attemptIds}},
    select: {
      id: true,
      shipment: {select: {refNo: true, status: true, instaworldStatus: true}},
    },
  });

  const cancelledAttemptIds = new Set<string>();
  const remoteStatuses = await Promise.all(attempts.map(async (attempt) => {
    const localStatus = `${attempt.shipment.status} ${attempt.shipment.instaworldStatus || ""}`;
    if (localStatus.toUpperCase().includes("CANCEL")) {
      return {attemptId: attempt.id, cancelled: true};
    }
    const remote = await lookupShipment(attempt.shipment.refNo);
    return {attemptId: attempt.id, cancelled: Boolean(remote && isCancelledShipment(remote))};
  }));
  for (const result of remoteStatuses) {
    if (result.cancelled) cancelledAttemptIds.add(result.attemptId);
  }

  if (cancelledAttemptIds.size > 0) {
    await prisma.orderReservation.updateMany({
      where: {shop, attemptId: {in: [...cancelledAttemptIds]}, state: "active"},
      data: {state: "released", releasedAt: new Date()},
    });
  }
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

  // This value was already matched against InstaWorld's live city list.
  const city = String(combined.consignee.city ?? "").trim().toUpperCase();

  // Email is optional; omit it when Shopify did not provide one.
  const email = orders[0]?.email?.trim() || undefined;
  const shipmentWeights = allocateShipmentWeight(combined.items.length);

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
      address: truncate(buildInstaWorldAddress([
        replaceCityInAddress(combined.consignee.address1, combined.consignee.city, city),
        replaceCityInAddress(combined.consignee.address2, combined.consignee.city, city),
        city,
        combined.consignee.province,
        combined.consignee.zip,
        combined.consignee.country,
      ]), 200),
      ...(email ? {email} : {}),
    },
    items: combined.items.map((item, index) => ({
      title: item.title ? truncate(item.title, 100) : undefined,
      sku: item.sku ?? undefined,
      // Color from the product's custom.color metafield (set in Shopify admin)
      product_detail: item.color ?? undefined,
      quantity: item.quantity,
      // Declare 0.8 kg once for the complete parcel, not once per line.
      kg: shipmentWeights[index],
    })),
  };
}

export async function bookCombinedOrders(
  shop: string,
  orders: ShopifyOrder[],
  _declaredWeight: number,
  admin?: unknown,
  accountId?: string,
  addressOrderId?: string,
) {
  // The courier weighs the parcel at the office. Always book one fixed
  // shipment weight regardless of line count or product quantity.
  const declaredWeight = FIXED_SHIPMENT_WEIGHT_KG;
  const existingLinksPromise = prisma.shipmentOrder.findMany({
    where: {shop, shopifyOrderId: {in: orders.map((order) => order.id)}},
    select: {
      shopifyOrderId: true,
      shopifyOrderNumber: true,
      shipment: {select: {id: true, refNo: true, status: true, instaworldStatus: true}},
    },
  });
  const [config, addressSelection, existingLinks] = await Promise.all([
    resolveInstaWorldConfig(shop, accountId),
    selectDeliveryAddress(orders, declaredWeight, addressOrderId),
    existingLinksPromise,
  ]);
  const {combined, verification: addressVerification} = addressSelection;
  if (!addressVerification.ok) {
    throw new Error(addressVerification.message);
  }
  const lookupShipment = memoizedShipmentLookup(config);
  const [secondaryAvailability, resolvedServiceCity] = await Promise.all([
    checkInstaWorldOrderAvailability(shop, orders.slice(1), config, {
      findShipment: (reference) => lookupShipment(reference),
    }),
    resolveInstaWorldCity(combined.consignee.city, config).catch(() => normaliseCity(combined.consignee.city)),
  ]);
  const availabilityError = secondaryOrderAvailabilityError(secondaryAvailability);
  if (availabilityError) throw new Error(availabilityError.message);
  const serviceCity = resolvedServiceCity;
  if (!serviceCity) {
    throw new Error(`InstaWorld does not currently service ${combined.consignee.city?.trim().toUpperCase() || "this city"}.`);
  }
  const verifiedCombined = {
    ...combined,
    consignee: {
      ...combined.consignee,
      // Shopify is the current source of truth after a merchant edits an order.
      // Map data validates it but must not restore an older spelling.
      address1: combined.consignee.address1,
      address2: combined.consignee.address2,
      city: serviceCity,
      province: combined.consignee.province || addressVerification.verifiedAddress.province,
      zip: combined.consignee.zip || addressVerification.verifiedAddress.postalCode,
    },
  };
  const cancelledLinkedOrderIds = new Set<string>();
  const linkedShipments = await Promise.all(existingLinks.map(async (link) => ({
    link,
    remote: await lookupShipment(link.shipment.refNo),
  })));
  const cancelledShipmentIds: string[] = [];
  for (const {link, remote} of linkedShipments) {
    if (remote && !isCancelledShipment(remote)) {
      throw new Error(`Order #${link.shopifyOrderNumber} is already booked in InstaWorld.`);
    }
    const localStatus = `${link.shipment.status} ${link.shipment.instaworldStatus || ""}`.toUpperCase();
    if (!remote || isCancelledShipment(remote) || localStatus.includes("CANCEL")) {
      cancelledLinkedOrderIds.add(link.shopifyOrderId);
      cancelledShipmentIds.push(link.shipment.id);
    }
  }
  if (cancelledShipmentIds.length > 0) {
    await prisma.shipment.updateMany({
      where: {id: {in: cancelledShipmentIds}},
      data: {status: "cancelled", instaworldStatus: "CANCELLED"},
    });
  }
  if (cancelledLinkedOrderIds.size > 0) {
    await prisma.orderReservation.updateMany({
      where: {
        shop,
        shopifyOrderId: {in: [...cancelledLinkedOrderIds]},
        state: "active",
      },
      data: {state: "released", releasedAt: new Date()},
    });
  }
  // A canceled InstaWorld shipment can leave its local reservation active
  // until the normal lease expires. Release that reservation before checking
  // for concurrent attempts so the order can be booked again immediately.
  await releaseReservationsForCancelledShipments(shop, combined.orderIds, lookupShipment);
  const attemptId = randomUUID();
  const idempotencyKey = randomUUID();
  // Use Shopify order number(s) as the human-readable refNo (e.g. "1006" or "1006+1007")
  const orderNumbers = orders.map((o) => o.orderNumber).join("+");
  const baseRefNo = orderNumbers.slice(0, 200);
  const leaseExpiresAt = new Date(Date.now() + RESERVATION_LEASE_MS);

  const {attempt, refNo, requestPayload} = await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.orderReservation.updateMany({
      where: {
        shop,
        shopifyOrderId: {in: combined.orderIds},
        state: "active",
        leaseExpiresAt: {lte: now},
      },
      data: {state: "released", releasedAt: now},
    });
    const activeReservations = await tx.orderReservation.findMany({
      where: {
        shop,
        shopifyOrderId: {in: combined.orderIds},
        state: "active",
        leaseExpiresAt: {gt: now},
      },
      select: {shopifyOrderId: true},
    });
    if (activeReservations.length > 0) {
      const activeIds = new Set(activeReservations.map((reservation) => reservation.shopifyOrderId));
      const activeNumbers = orders
        .filter((order) => activeIds.has(order.id))
        .map((order) => `#${order.orderNumber}`)
        .join(", ");
      throw new Error(`${activeNumbers || "This order"} is already being booked. Wait for the current attempt to finish, then try again.`);
    }

    const previousShipment = await tx.shipment.findUnique({
      where: {shipment_shop_refNo_key: {shop, refNo: baseRefNo}},
      include: {attempts: {orderBy: {createdAt: "desc"}, take: 1}},
    });
    const refNo = baseRefNo;
    const requestPayload = buildRequest(verifiedCombined, orders, refNo, config.locationId!);
    const shipment = previousShipment
      ? await tx.shipment.update({
          where: {id: previousShipment.id},
          data: {
            status: "reserved",
            trackingNumber: null,
            bookedAt: null,
            instaworldStatus: null,
            shopifyFulfillmentId: null,
            lastSyncedAt: null,
            declaredWeight,
            paymentType: combined.payment.treatment,
            amountDue: combined.payment.amountDue,
            currencyCode: combined.payment.currencyCode,
            instaworldAccountId: config.id,
          },
        })
      : await tx.shipment.create({
          data: {
            shop,
            refNo,
            status: "reserved",
            declaredWeight,
            paymentType: combined.payment.treatment,
            amountDue: combined.payment.amountDue,
            currencyCode: combined.payment.currencyCode,
            instaworldAccountId: config.id,
          },
        });
    const previousAttempt = previousShipment?.attempts[0];
    const bookingAttempt = previousAttempt
      ? await tx.bookingAttempt.update({
          where: {id: previousAttempt.id},
          data: {
            idempotencyKey,
            status: "reserved",
            requestFingerprint: fingerprint(orders, declaredWeight),
            requestPayload: JSON.stringify(requestPayload),
            leaseExpiresAt,
            leaseToken: randomUUID(),
            lastErrorCode: null,
            lastErrorMessage: null,
            lastHttpStatus: null,
            startedAt: null,
            completedAt: null,
          },
        })
      : await tx.bookingAttempt.create({
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
        // An order can be booked again after a canceled shipment. Reuse its
        // existing released/consumed reservation row because the database
        // intentionally has one reservation row per shop + order.
        await tx.orderReservation.upsert({
          where: {orderReservation_shop_shopifyOrderId_key: {shop, shopifyOrderId: order.id}},
          update: {
            attemptId: bookingAttempt.id,
            state: "active",
            leaseExpiresAt,
            releasedAt: null,
          },
          create: {
            shop,
            shopifyOrderId: order.id,
            attemptId: bookingAttempt.id,
            leaseExpiresAt,
          },
        });
      }
    } catch {
      const orderNumbers = orders.map((order) => `#${order.orderNumber}`).join(", ");
      throw new Error(`${orderNumbers} could not be reserved because another booking started at the same time. Try again.`);
    }
    return {attempt: bookingAttempt, refNo, requestPayload};
  });

  try {
    const existing = await lookupShipment(refNo);
    if (existing && !isCancelledShipment(existing)) {
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

    const result = await createShipment(requestPayload, idempotencyKey, config);
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
  const config = await resolveInstaWorldConfig(shop, attempt.shipment.instaworldAccountId ?? undefined);
  const existing = await findShipmentByReference(attempt.shipment.refNo, config);
  if (existing && !isCancelledShipment(existing)) {
    return finalizeSuccessfulBooking(shop, attemptId, existing.trackingNumber, sourceOrders);
  }

  const result = await createShipment(
    JSON.parse(attempt.requestPayload) as InstaWorldRequest,
    attempt.idempotencyKey,
    config,
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
    for (const reservation of reservations) {
      const shopifyOrderNumber =
        sourceOrders.find((order) => order.id === reservation.shopifyOrderId)?.orderNumber ||
        reservation.shopifyOrderId;
      await tx.shipmentOrder.upsert({
        where: {shipmentOrder_shop_shopifyOrderId_key: {shop, shopifyOrderId: reservation.shopifyOrderId}},
        update: {shipmentId: shipment.id, shopifyOrderNumber},
        create: {shop, shipmentId: shipment.id, shopifyOrderId: reservation.shopifyOrderId, shopifyOrderNumber},
      });
    }
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
