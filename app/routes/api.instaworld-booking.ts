import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";

import prisma from "../db.server";
import {bookCombinedOrders, recoverBookingAttempt} from "../lib/booking.server";
import {getShopifyOrders} from "../lib/shopify-orders.server";
import {authenticate} from "../shopify.server";

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

export async function loader({request}: LoaderFunctionArgs) {
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
  const {session} = await authenticate.admin(request);
  const orderId = new URL(request.url).searchParams.get("orderId")?.trim();
  if (!orderId) {
    return json({message: "orderId is required."}, {status: 400});
  }

  const shipment = await prisma.shipmentOrder.findFirst({
    where: {shop: session.shop, shopifyOrderId: orderId},
    select: {
      shopifyOrderNumber: true,
      shipment: {
        select: {
          refNo: true,
          trackingNumber: true,
          status: true,
          amountDue: true,
          declaredWeight: true,
          bookedAt: true,
        },
      },
    },
  });

  return json({shipment});
}

export async function action({request}: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({message: "Only POST requests are supported."}, {status: 405});
  }

  const {admin, session} = await authenticate.admin(request);
  const body = await request.json().catch(() => null);
  if (typeof body?.recoverAttemptId === "string") {
    try {
      const result = await recoverBookingAttempt(session.shop, body.recoverAttemptId);
      return json({success: true, ...result});
    } catch (error) {
      return json(
        {success: false, message: error instanceof Error ? error.message : "Recovery failed."},
        {status: 409},
      );
    }
  }

  const orderIds = Array.isArray(body?.orderIds)
    ? body.orderIds.filter((id: unknown): id is string => typeof id === "string")
    : [];
  const declaredWeight = Number(body?.declaredWeight);

  if (orderIds.length < 2 || new Set(orderIds).size !== orderIds.length) {
    return json({message: "Select at least two different orders."}, {status: 400});
  }
  if (!Number.isFinite(declaredWeight) || declaredWeight <= 0) {
    return json({message: "Declared weight must be a positive number."}, {status: 400});
  }

  const orders = await getShopifyOrders(admin, orderIds);
  try {
    const result = await bookCombinedOrders(session.shop, orders, declaredWeight);
    return json({success: true, ...result});
  } catch (error) {
    return json(
      {success: false, message: error instanceof Error ? error.message : "Booking failed."},
      {status: 409},
    );
  }
}
