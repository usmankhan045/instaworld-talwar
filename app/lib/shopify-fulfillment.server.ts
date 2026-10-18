/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * InstaWorld → Shopify fulfillment sync helpers.
 *
 * Shopify fulfillment flow:
 *  1. On booking: get the order's fulfillment orders → create a fulfillment
 *     with the InstaWorld tracking number → store the fulfillment GID.
 *  2. On sync: create fulfillment events as InstaWorld reports progress.
 */

// ---------------------------------------------------------------------------
// InstaWorld status → Shopify fulfillment event mapping
// ---------------------------------------------------------------------------

/** Shopify FulfillmentEventStatus values used by fulfillmentEventCreate. */
export type ShopifyFulfillmentEventStatus =
  | "LABEL_PRINTED"
  | "LABEL_PURCHASED"
  | "CONFIRMED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "ATTEMPTED_DELIVERY"
  | "READY_FOR_PICKUP"
  | "CARRIER_PICKED_UP"
  | "DELAYED"
  | "FAILURE";

export function instaworldStatusToShopify(instaworldStatus: string): {
  fulfillmentEventStatus: ShopifyFulfillmentEventStatus | null;
  shouldMarkDelivered: boolean;
  shouldCancel: boolean;    // call fulfillmentCancel (RTO returned / cancelled)
} {
  switch (instaworldStatus.toUpperCase()) {
    case "BOOKED":
    case "BOOKING_IN_PROCESS":
      return {fulfillmentEventStatus: "LABEL_PRINTED", shouldMarkDelivered: false, shouldCancel: false};
    case "PICKED_UP":
      return {fulfillmentEventStatus: "CARRIER_PICKED_UP", shouldMarkDelivered: false, shouldCancel: false};
    case "IN_TRANSIT":
      return {fulfillmentEventStatus: "IN_TRANSIT", shouldMarkDelivered: false, shouldCancel: false};
    case "OUT_FOR_DELIVERY":
      return {fulfillmentEventStatus: "OUT_FOR_DELIVERY", shouldMarkDelivered: false, shouldCancel: false};
    case "DELIVERED":
      return {fulfillmentEventStatus: "DELIVERED", shouldMarkDelivered: true, shouldCancel: false};
    case "DELIVERY_ATTEMPT_FAILED":
    case "ACTION_REQUIRED":
    case "ON_HOLD":
      return {fulfillmentEventStatus: "ATTEMPTED_DELIVERY", shouldMarkDelivered: false, shouldCancel: false};
    case "RTO_INITIATED":
    case "RTO_IN_TRANSIT":
    case "RTO_RECEIVED_AT_HUB":
      // Shopify has no return-to-sender fulfillment event. Keep the courier
      // status locally until the return is final and the fulfillment can be cancelled.
      return {fulfillmentEventStatus: null, shouldMarkDelivered: false, shouldCancel: false};
    case "RTO_RETURNED_TO_SHIPPER":
      return {fulfillmentEventStatus: null, shouldMarkDelivered: false, shouldCancel: true};
    case "CANCELLED":
      return {fulfillmentEventStatus: null, shouldMarkDelivered: false, shouldCancel: true};
    default:
      return {fulfillmentEventStatus: null, shouldMarkDelivered: false, shouldCancel: false};
  }
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function gql(admin: any, query: string, variables?: Record<string, unknown>) {
  const response = await admin.graphql(query, {variables});
  return response.json();
}

/**
 * Get all fulfillment order IDs for a Shopify order.
 * We need these to create a fulfillment.
 */
async function getFulfillmentOrderIds(admin: any, shopifyOrderId: string): Promise<string[]> {
  const data = await gql(
    admin,
    `query GetFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
          }
        }
      }
    }`,
    {orderId: shopifyOrderId},
  );
  const nodes = data?.data?.order?.fulfillmentOrders?.nodes ?? [];
  return nodes
    .filter((fo: any) => fo.status === "OPEN" || fo.status === "IN_PROGRESS")
    .map((fo: any) => fo.id);
}

/**
 * Create a Shopify fulfillment for one or more Shopify order IDs,
 * attaching the InstaWorld tracking number.
 * Returns the Shopify fulfillment GID, or null on failure.
 */
export async function createShopifyFulfillment(
  admin: any,
  shopifyOrderIds: string[],
  trackingNumber: string,
): Promise<string | null> {
  const trackingUrl = `https://one-be.instaworld.pk/tracking/${trackingNumber}`;
  let firstFulfillmentId: string | null = null;
  let createdCount = 0;

  // Shopify only allows fulfillment orders from the same Shopify order in a
  // single fulfillmentCreate mutation. The InstaWorld parcel is combined,
  // but each source Shopify order needs its own fulfillment record.
  for (const orderId of shopifyOrderIds) {
    const fulfillmentOrderIds = await getFulfillmentOrderIds(admin, orderId);
    if (fulfillmentOrderIds.length === 0) {
      console.warn("[shopify-fulfillment] No open fulfillment orders found for", orderId);
      continue;
    }

    const data = await gql(
      admin,
      `mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: fulfillmentOrderIds.map((id) => ({fulfillmentOrderId: id})),
          trackingInfo: {
            number: trackingNumber,
            url: trackingUrl,
            company: "InstaWorld",
          },
          notifyCustomer: false,
        },
      },
    );

    const errors = data?.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length > 0) {
      console.error("[shopify-fulfillment] createFulfillment userErrors for", orderId, errors);
      continue;
    }

    const fulfillmentId = data?.data?.fulfillmentCreate?.fulfillment?.id ?? null;
    if (fulfillmentId) {
      firstFulfillmentId ||= fulfillmentId;
      createdCount += 1;
    }
  }

  if (createdCount !== shopifyOrderIds.length) {
    console.error("[shopify-fulfillment] Created fulfillments for", createdCount, "of", shopifyOrderIds.length, "source orders.");
  }
  return firstFulfillmentId;
}

/**
 * Record shipment progress on a fulfillment. DELIVERED is an event status;
 * Shopify doesn't expose a fulfillmentComplete mutation.
 */
export async function createShopifyFulfillmentEvent(
  admin: any,
  fulfillmentId: string,
  status: ShopifyFulfillmentEventStatus,
): Promise<boolean> {
  const data = await gql(
    admin,
    `mutation FulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
        fulfillmentEvent { id status }
        userErrors { field message }
      }
    }`,
    {fulfillmentEvent: {fulfillmentId, status}},
  );

  const errors = data?.data?.fulfillmentEventCreate?.userErrors ?? [];
  if (errors.length > 0) {
    console.error("[shopify-fulfillment] createEvent userErrors:", errors);
    return false;
  }
  return Boolean(data?.data?.fulfillmentEventCreate?.fulfillmentEvent?.id);
}

/**
 * Cancel a Shopify fulfillment (CANCELLED / RTO returned).
 */
export async function cancelShopifyFulfillment(
  admin: any,
  fulfillmentId: string,
): Promise<boolean> {
  const data = await gql(
    admin,
    `mutation FulfillmentCancel($id: ID!) {
      fulfillmentCancel(id: $id) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {id: fulfillmentId},
  );

  const errors = data?.data?.fulfillmentCancel?.userErrors ?? [];
  if (errors.length > 0) {
    console.error("[shopify-fulfillment] cancel userErrors:", errors);
    return false;
  }
  return true;
}
