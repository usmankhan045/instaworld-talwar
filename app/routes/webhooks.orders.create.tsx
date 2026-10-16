import type {ActionFunctionArgs} from "react-router";

import db from "../db.server";
import {authenticate} from "../shopify.server";
import {buildCallJobInput, type ShopifyOrderCreatedWebhook} from "../lib/calling.server";

export const action = async ({request}: ActionFunctionArgs) => {
  const {payload, shop, topic} = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unsupported webhook topic", {status: 404});
  }

  const callJob = buildCallJobInput(payload as ShopifyOrderCreatedWebhook);

  if (!callJob.shopifyOrderId || !callJob.shopifyOrderNumber) {
    return new Response("Shopify order identity is missing", {status: 400});
  }

  await db.callJob.upsert({
    where: {
      callJob_shop_shopifyOrderId_key: {
        shop,
        shopifyOrderId: callJob.shopifyOrderId,
      },
    },
    create: {
      shop,
      ...callJob,
    },
    update: {
      customerName: callJob.customerName,
      phone: callJob.phone,
      productSummary: callJob.productSummary,
      normalizedAddress: callJob.normalizedAddress,
    },
  });

  return new Response(null, {status: 200});
};
