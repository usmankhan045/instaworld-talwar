import assert from "node:assert/strict";
import test from "node:test";

import {
  createShopifyFulfillmentEvent,
  instaworldStatusToShopify,
} from "../app/lib/shopify-fulfillment.server.ts";

test("maps InstaWorld shipment progress to valid Shopify fulfillment events", () => {
  assert.equal(instaworldStatusToShopify("PICKED_UP").fulfillmentEventStatus, "CARRIER_PICKED_UP");
  assert.equal(instaworldStatusToShopify("IN_TRANSIT").fulfillmentEventStatus, "IN_TRANSIT");
  assert.equal(instaworldStatusToShopify("OUT_FOR_DELIVERY").fulfillmentEventStatus, "OUT_FOR_DELIVERY");
  assert.equal(instaworldStatusToShopify("DELIVERED").fulfillmentEventStatus, "DELIVERED");
});

test("creates a DELIVERED fulfillment event with the configured Admin API shape", async () => {
  let operation = "";
  let variables: Record<string, unknown> | undefined;
  const admin = {
    graphql: async (query: string, options: {variables?: Record<string, unknown>}) => {
      operation = query;
      variables = options.variables;
      return new Response(JSON.stringify({
        data: {
          fulfillmentEventCreate: {
            fulfillmentEvent: {id: "gid://shopify/FulfillmentEvent/1", status: "DELIVERED"},
            userErrors: [],
          },
        },
      }));
    },
  };

  const result = await createShopifyFulfillmentEvent(
    admin,
    "gid://shopify/Fulfillment/123",
    "DELIVERED",
  );

  assert.equal(result, true);
  assert.match(operation, /fulfillmentEventCreate/);
  assert.doesNotMatch(operation, /fulfillmentComplete/);
  assert.deepEqual(variables, {
    fulfillmentEvent: {
      fulfillmentId: "gid://shopify/Fulfillment/123",
      status: "DELIVERED",
    },
  });
});

test("reports fulfillment event user errors as failure", async () => {
  const admin = {
    graphql: async () => new Response(JSON.stringify({
      data: {
        fulfillmentEventCreate: {
          fulfillmentEvent: null,
          userErrors: [{field: ["fulfillmentId"], message: "Fulfillment does not exist"}],
        },
      },
    })),
  };

  assert.equal(
    await createShopifyFulfillmentEvent(admin, "gid://shopify/Fulfillment/missing", "DELIVERED"),
    false,
  );
});
