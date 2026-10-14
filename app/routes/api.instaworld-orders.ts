import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";

import prisma from "../db.server";
import {combineOrders} from "../lib/order-combination.server";
import {getShopifyOrders, searchShopifyOrders} from "../lib/shopify-orders.server";
import {authenticate} from "../shopify.server";

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export async function loader({request}: LoaderFunctionArgs) {
  const {admin} = await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";

  if (query.length < 2) {
    return json({orders: []});
  }

  const orders = await searchShopifyOrders(admin, query);
  return json({orders});
}

export async function action({request}: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({message: "Only POST requests are supported."}, {status: 405});
  }

  const {admin, session} = await authenticate.admin(request);
  const body = await request.json().catch(() => null);
  const orderIds = Array.isArray(body?.orderIds)
    ? body.orderIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  if (orderIds.length < 1 || new Set(orderIds).size !== orderIds.length) {
    return json({message: "Select at least one order."}, {status: 400});
  }

  const orders = await getShopifyOrders(admin, orderIds);
  const existing = await prisma.shipmentOrder.findMany({
    where: {
      shop: session.shop,
      shopifyOrderId: {in: orderIds},
    },
    select: {shopifyOrderId: true, shopifyOrderNumber: true, shipment: {select: {trackingNumber: true, status: true}}},
  });

  if (existing.length > 0) {
    return json(
      {
        message: `Order #${existing[0].shopifyOrderNumber} is already associated with a shipment.`,
        existing,
      },
      {status: 409},
    );
  }

  if (orderIds.length === 1) {
    return json({orders});
  }

  try {
    const combined = combineOrders(orders);
    return json({combined});
  } catch (error) {
    return json(
      {message: error instanceof Error ? error.message : "Orders cannot be combined."},
      {status: 422},
    );
  }
}
