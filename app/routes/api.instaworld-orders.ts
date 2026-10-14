
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { combineOrders } from "../lib/order-combination.server";
import {
  getShopifyOrders,
  searchShopifyOrders,
} from "../lib/shopify-orders.server";
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
    return json({ combined });
  } catch (error) {
    // Preserve Shopify authentication redirects and thrown responses.
    if (error instanceof Response) {
      throw error;
    }

    console.error("[InstaWorld orders API]", {
      stage,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return json(
      {
        message:
          "Unable to load orders. Check server logs for the failing stage.",
      },
      { status: 500 },
    );
  }
}
