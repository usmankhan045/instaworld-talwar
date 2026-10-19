
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {selectDeliveryAddress} from "../lib/delivery-selection.server";
import type {ShopifyOrder} from "../lib/shopify-orders.server";
import {
  getRecentShopifyOrderCandidates,
  getShopifyOrders,
  getShopifyOrderNumbers,
  hasReliableCustomerMatch,
  searchShopifyOrders,
  formatShopifyError,
} from "../lib/shopify-orders.server";
import {resolveInstaWorldCity, type InstaWorldConfig} from "../lib/instaworld.server";
import {
  checkInstaWorldOrderAvailability,
  secondaryOrderAvailabilityError,
} from "../lib/instaworld-order-availability.server";
import { authenticate } from "../shopify.server";
import {listInstaWorldAccounts, resolveInstaWorldConfig} from "../lib/instaworld-accounts.server";

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...(init?.headers || {}),
    },
  });
}

async function findRelatedOrders(
  admin: Parameters<typeof searchShopifyOrders>[0],
  shop: string,
  selectedOrderIds: string[],
  currentOrder: ShopifyOrder,
  config: Parameters<typeof checkInstaWorldOrderAvailability>[2],
) {
  try {
    const candidates = await getRecentShopifyOrderCandidates(admin);
    const matchingCandidates = candidates
      .filter((candidate) => !selectedOrderIds.includes(candidate.id) && !candidate.cancelledAt)
      .filter((candidate) => hasReliableCustomerMatch(currentOrder, candidate))
      .slice(0, 24);
    const availability = await checkInstaWorldOrderAvailability(shop, matchingCandidates, config);
    const eligibleIds = new Set(availability
      // A transient courier lookup must not hide a Shopify match. Selection
      // and booking still revalidate and fail closed before combining orders.
      .filter((result) => !result.verified || result.available)
      .map((result) => result.orderId));
    return matchingCandidates
      .filter((candidate) => eligibleIds.has(candidate.id))
      .map(({id, orderNumber, createdAt, cancelledAt}) => ({id, orderNumber, createdAt, cancelledAt}));
  } catch (error) {
    // Suggestions are an enhancement; never block the selected order.
    console.warn("[InstaWorld orders API] related customer order lookup failed", error);
    return [];
  }
}

async function checkCityServiceable(rawCity: string, config: InstaWorldConfig): Promise<string | null> {
  if (!rawCity) return null;

  try {
    const serviceCity = await resolveInstaWorldCity(rawCity, config);
    if (!serviceCity) {
      return `InstaWorld does not currently service ${rawCity.trim().toUpperCase()}. This order cannot be booked for delivery to this city.`;
    }
  } catch {
    // Fail open — don't block preview if city check fails
  }
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
  const { admin } = await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";

  if (query.length < 2) {
    return json({ orders: [] });
  }

  const orders = await searchShopifyOrders(admin, query);
  return json({
    orders: orders.map(({id, orderNumber, createdAt, cancelledAt}) => ({id, orderNumber, createdAt, cancelledAt})),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  let stage = "request validation";
  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"] | undefined;
  let orderIds: string[] = [];

  try {
    if (request.method !== "POST") {
      return json(
        { message: "Only POST requests are supported." },
        { status: 405 },
      );
    }

    stage = "Shopify authentication";
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    const {session} = auth;

    stage = "request body parsing";
    const body = await request.json().catch(() => null);

    orderIds = Array.isArray(body?.orderIds)
      ? body.orderIds.filter(
          (id: unknown): id is string => typeof id === "string",
        )
      : [];

    if (
      orderIds.length < 1 ||
      new Set(orderIds).size !== orderIds.length
    ) {
      return json(
        { message: "Select at least one order." },
        { status: 400 },
      );
    }

    stage = "Shopify order and InstaWorld account retrieval";
    const selectedAccountId = typeof body?.accountId === "string" ? body.accountId : undefined;
    const [config, orders] = await Promise.all([
      resolveInstaWorldConfig(session.shop, selectedAccountId),
      getShopifyOrders(admin, orderIds),
    ]);

    const addressOrderId = typeof body?.addressOrderId === "string" ? body.addressOrderId : undefined;
    stage = "parallel order validation and customer matching";
    const [secondaryAvailability, addressSelection, relatedOrders] = await Promise.all([
      checkInstaWorldOrderAvailability(
      session.shop,
      orders.slice(1),
      config,
      ),
      selectDeliveryAddress(orders, undefined, addressOrderId),
      findRelatedOrders(admin, session.shop, orderIds, orders[0], config),
    ]);
    const availabilityError = secondaryOrderAvailabilityError(secondaryAvailability);
    if (availabilityError) {
      return json({...availabilityError, stage}, {status: 409});
    }

    stage = "order combination";
    const {combined, verification: addressVerification} = addressSelection;

    // Check address–city match (fail-open: only block if we get a confident mismatch)
    stage = "address/city validation";
    // Check if InstaWorld services the destination city — non-blocking warning
    stage = "InstaWorld city serviceability check";
    const [cityWarning, accounts] = await Promise.all([
      addressVerification.ok
        ? checkCityServiceable(combined.consignee.city ?? "", config)
        : Promise.resolve(null),
      listInstaWorldAccounts(session.shop),
    ]);

    return json({
      combined,
      relatedOrders,
      cityWarning,
      verifiedAddress: addressVerification.ok ? addressVerification.verifiedAddress : null,
      addressError: addressVerification.ok ? null : addressVerification.message,
      accounts,
    });
  } catch (error) {
    // Preserve Shopify authentication redirects and thrown responses.
    if (error instanceof Response) {
      throw error;
    }

    const orderNumbers: Record<string, string> = admin
      ? await getShopifyOrderNumbers(admin, orderIds).catch(() => ({} as Record<string, string>))
      : {};
    const humanMessage = formatShopifyError(error);
    console.error("[InstaWorld orders API]", {
      stage,
      message: humanMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return json(
      {
        code: "ORDER_PREVIEW_FAILED",
        stage,
        orderNumbers,
        orderNumber: orderIds.length === 1 ? orderNumbers[orderIds[0]] : undefined,
        message: `${stage} failed: ${humanMessage}`,
      },
      { status: 500 },
    );
  }
}
