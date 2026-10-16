import type {ActionFunctionArgs} from "react-router";

import {authenticate} from "../shopify.server";

export const action = async ({request}: ActionFunctionArgs) => {
  const {topic} = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unsupported webhook topic", {status: 404});
  }

  // An already-deployed subscription can continue sending deliveries until
  // the Shopify app configuration is deployed. Acknowledge them without
  // creating call jobs while the IVR is developed independently.
  return new Response(null, {status: 200});
};
