
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { combineOrders } from "../lib/order-combination.server";
import {
  getShopifyOrders,
  getShopifyOrderNumbers,
  searchShopifyOrders,
  formatShopifyError,
} from "../lib/shopify-orders.server";
import { normaliseCity, requireInstaWorldConfig } from "../lib/instaworld.server";
import { verifyDeliveryAddress } from "../lib/address-validation.server";
import { authenticate } from "../shopify.server";

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

// ---------------------------------------------------------------------------
// City serviceability check (cached for 1 hour, fail-open)
// ---------------------------------------------------------------------------
const cityCache = new Map<string, {cities: string[]; expiresAt: number}>();

async function checkCityServiceable(rawCity: string, shop: string): Promise<string | null> {
  if (!rawCity) return null;
  const city = normaliseCity(rawCity);
  if (!city) return null;

  try {
    const now = Date.now();
    const config = requireInstaWorldConfig(shop);
    const cached = cityCache.get(config.account);
    if (!cached || now > cached.expiresAt) {
      const res = await fetch(`${config.baseUrl}/cities`, {
        headers: {Authorization: `Bearer ${config.apiKey}`, Accept: "application/json"},
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const payload = await res.json();
      const list: string[] = Array.isArray(payload?.data)
        ? payload.data.map((c: {name?: string}) => String(c.name ?? "").toUpperCase()).filter(Boolean)
        : [];
      if (list.length > 0) {
        cityCache.set(config.account, {cities: list, expiresAt: now + 60 * 60 * 1000});
      } else {
        return null;
      }
    }
    const serviceable = cityCache.get(config.account)?.cities.includes(city);
    if (serviceable === false) {
      return `InstaWorld does not currently service ${city}. This order cannot be booked for delivery to this city.`;
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
  return json({ orders });
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

    stage = "Shopify order retrieval";
    const orders = await getShopifyOrders(admin, orderIds);

    stage = "order combination";
    const combined = combineOrders(orders);

    // Suggest other recent orders from the same customer that can safely be
    // added to this shipment. The merchant still explicitly adds them in the
    // extension before booking; incompatible addresses/payment states are
    // filtered here so they never appear as compatible suggestions.
    let relatedOrders: Array<{id: string; orderNumber: string; createdAt: string; cancelledAt: string | null}> = [];
    const customerEmail = combined.orders[0]?.email?.trim();
    if (customerEmail) {
      try {
        const candidates = await searchShopifyOrders(admin, `email:${customerEmail}`);
        const candidateIds = candidates
          .filter((candidate) => !orderIds.includes(candidate.id) && !candidate.cancelledAt)
          .map((candidate) => candidate.id)
          .slice(0, 24);
        if (candidateIds.length > 0) {
          const candidateOrders = await getShopifyOrders(admin, candidateIds);
          relatedOrders = candidateOrders
            .filter((candidate) => {
              try {
                combineOrders([...orders, candidate]);
                return true;
              } catch {
                return false;
              }
            })
            .map(({id, orderNumber, createdAt, cancelledAt}) => ({id, orderNumber, createdAt, cancelledAt}));
        }
      } catch (relatedOrderError) {
        // Suggestions are an enhancement; a Shopify search failure must not
        // prevent the current order from being previewed or booked.
        console.warn("[InstaWorld orders API] related customer order lookup failed", relatedOrderError);
      }
    }

    // Check address–city match (fail-open: only block if we get a confident mismatch)
    stage = "address/city validation";
    const addressVerification = await verifyDeliveryAddress(combined.consignee);
    if (!addressVerification.ok) {
      return json(
        {
          code: addressVerification.code,
          stage,
          orderNumber: combined.orders.length === 1 ? combined.orders[0].orderNumber : undefined,
          orderNumbers: combined.orders.map((order) => order.orderNumber),
          message: addressVerification.message,
          detectedCity: addressVerification.detectedCity,
          suggestedAddress: addressVerification.suggestedAddress,
        },
        {status: 422},
      );
    }

    // Check if InstaWorld services the destination city — non-blocking warning
    stage = "InstaWorld city serviceability check";
    const cityWarning = await checkCityServiceable(combined.consignee.city ?? "", session.shop);

    return json({
      combined,
      relatedOrders,
      cityWarning,
      verifiedAddress: addressVerification.verifiedAddress,
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
