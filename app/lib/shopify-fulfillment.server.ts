/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * InstaWorld → Shopify fulfillment sync helpers.
 *
 * Shopify fulfillment flow:
 *  1. On booking: get the order's fulfillment orders → create a fulfillment
 *     with the InstaWorld tracking number → store the fulfillment GID.
 *  2. On sync: update the fulfillment's shipmentStatus as InstaWorld reports
 *     progress, and call fulfillmentComplete when DELIVERED.
 */

// ---------------------------------------------------------------------------
// InstaWorld status → Shopify shipmentStatus mapping
// ---------------------------------------------------------------------------

/** Shopify FulfillmentDisplayStatus / shipmentStatus values */
export type ShopifyShipmentStatus =
  | "LABEL_PRINTED"
  | "LABEL_PURCHASED"
  | "CONFIRMED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "ATTEMPTED_DELIVERY"
  | "READY_FOR_PICKUP"
  | "PICKED_UP"
  | "FAILURE"
  | "RETURN_TO_SENDER";

export function instaworldStatusToShopify(instaworldStatus: string): {
  shipmentStatus: ShopifyShipmentStatus | null;
  shouldComplete: boolean;  // call fulfillmentComplete (DELIVERED)
  shouldCancel: boolean;    // call fulfillmentCancel (RTO returned / cancelled)
} {
  switch (instaworldStatus.toUpperCase()) {
    case "BOOKED":
    case "BOOKING_IN_PROCESS":
      return {shipmentStatus: "LABEL_PRINTED", shouldComplete: false, shouldCancel: false};
    case "PICKED_UP":
      return {shipmentStatus: "PICKED_UP", shouldComplete: false, shouldCancel: false};
    case "IN_TRANSIT":
      return {shipmentStatus: "IN_TRANSIT", shouldComplete: false, shouldCancel: false};
    case "OUT_FOR_DELIVERY":
      return {shipmentStatus: "OUT_FOR_DELIVERY", shouldComplete: false, shouldCancel: false};
    case "DELIVERED":
      return {shipmentStatus: "DELIVERED", shouldComplete: true, shouldCancel: false};
    case "DELIVERY_ATTEMPT_FAILED":
    case "ACTION_REQUIRED":
    case "ON_HOLD":
      return {shipmentStatus: "ATTEMPTED_DELIVERY", shouldComplete: false, shouldCancel: false};
    case "RTO_INITIATED":
    case "RTO_IN_TRANSIT":
    case "RTO_RECEIVED_AT_HUB":
      return {shipmentStatus: "RETURN_TO_SENDER", shouldComplete: false, shouldCancel: false};
    case "RTO_RETURNED_TO_SHIPPER":
      return {shipmentStatus: "RETURN_TO_SENDER", shouldComplete: false, shouldCancel: true};
    case "CANCELLED":
      return {shipmentStatus: null, shouldComplete: false, shouldCancel: true};
    default:
      return {shipmentStatus: null, shouldComplete: false, shouldCancel: false};
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
  // Collect all open fulfillment orders across all Shopify orders
  const fulfillmentOrderIds: string[] = [];
  for (const orderId of shopifyOrderIds) {
    const ids = await getFulfillmentOrderIds(admin, orderId);
    fulfillmentOrderIds.push(...ids);
  }

  if (fulfillmentOrderIds.length === 0) {
    console.warn("[shopify-fulfillment] No open fulfillment orders found for", shopifyOrderIds);
    return null;
  }

  const trackingUrl = `https://one-be.instaworld.pk/tracking/${trackingNumber}`;

  const data = await gql(
    admin,
    `mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
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
    console.error("[shopify-fulfillment] createFulfillment userErrors:", errors);
    return null;
  }

  return data?.data?.fulfillmentCreate?.fulfillment?.id ?? null;
}

/**
 * Update the tracking shipment status on an existing Shopify fulfillment.
 * Used for PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY etc.
 */
export async function updateShopifyFulfillmentTracking(
  admin: any,
  fulfillmentId: string,
  trackingNumber: string,
): Promise<boolean> {
  const data = await gql(
    admin,
    `mutation FulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
      fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      fulfillmentId,
      trackingInfoInput: {
        number: trackingNumber,
        url: `https://one-be.instaworld.pk/tracking/${trackingNumber}`,
        company: "InstaWorld",
      },
      notifyCustomer: false,
    },
  );

  const errors = data?.data?.fulfillmentTrackingInfoUpdate?.userErrors ?? [];
  if (errors.length > 0) {
    console.error("[shopify-fulfillment] updateTracking userErrors:", errors);
    return false;
  }
  return true;
}

/**
 * Mark a fulfillment as successfully completed (order DELIVERED).
 */
export async function completeShopifyFulfillment(
  admin: any,
  fulfillmentId: string,
): Promise<boolean> {
  const data = await gql(
    admin,
    `mutation FulfillmentComplete($id: ID!) {
      fulfillmentComplete(id: $id) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {id: fulfillmentId},
  );

  const errors = data?.data?.fulfillmentComplete?.userErrors ?? [];
  if (errors.length > 0) {
    console.error("[shopify-fulfillment] complete userErrors:", errors);
    return false;
  }
  return true;
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
