
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { combineOrders } from "../lib/order-combination.server";
import {
  getShopifyOrders,
  searchShopifyOrders,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  try {
    if (request.method !== "POST") {
      return json(
        { message: "Only POST requests are supported." },
        { status: 405 },
      );
    }

    stage = "Shopify authentication";
    const { admin, session } = await authenticate.admin(request);

    stage = "request body parsing";
    const body = await request.json().catch(() => null);

    const orderIds = Array.isArray(body?.orderIds)
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

    stage = "Prisma shipment lookup";
    const existing = await prisma.shipmentOrder.findMany({
      where: {
        shop: session.shop,
        shopifyOrderId: { in: orderIds },
      },
      select: {
        shopifyOrderId: true,
        shopifyOrderNumber: true,
        shipment: {
          select: {
            trackingNumber: true,
            status: true,
          },
        },
      },
    });

    if (existing.length > 0) {
      return json(
        {
          message: `Order #${existing[0].shopifyOrderNumber} is already associated with a shipment.`,
          existing,
        },
        { status: 409 },
      );
    }

    stage = "order combination";
    const combined = combineOrders(orders);

    // Check address–city match (fail-open: only block if we get a confident mismatch)
    stage = "address/city validation";
    const addressVerification = await verifyDeliveryAddress(combined.consignee);
    if (!addressVerification.ok) {
      return json(
        {
          code: addressVerification.code,
          stage,
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
      cityWarning,
      verifiedAddress: addressVerification.verifiedAddress,
    });
  } catch (error) {
    // Preserve Shopify authentication redirects and thrown responses.
    if (error instanceof Response) {
      throw error;
    }

    const message = errorMessage(error);
    console.error("[InstaWorld orders API]", {
      stage,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return json(
      {
        code: "ORDER_PREVIEW_FAILED",
        stage,
        message: `${stage} failed: ${message}`,
      },
      { status: 500 },
    );
  }
}
