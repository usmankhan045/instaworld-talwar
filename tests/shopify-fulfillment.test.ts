import assert from "node:assert/strict";
import test from "node:test";

import {
  createShopifyFulfillment,
  createShopifyFulfillmentEvent,
  instaworldStatusToShopify,
} from "../app/lib/shopify-fulfillment.server.ts";

test("loads fulfillment orders once and creates combined-order fulfillments concurrently", async () => {
  const calls: Array<{query: string; variables?: Record<string, unknown>}> = [];
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  const admin = {
    graphql: async (query: string, options: {variables?: Record<string, unknown>}) => {
      calls.push({query, variables: options.variables});
      if (query.includes("GetFulfillmentOrders")) {
        return new Response(JSON.stringify({data: {nodes: [
          {id: "order-1", fulfillmentOrders: {nodes: [{id: "fo-1", status: "OPEN"}]}},
          {id: "order-2", fulfillmentOrders: {nodes: [{id: "fo-2", status: "IN_PROGRESS"}]}},
        ]}}));
      }
      activeMutations += 1;
      maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeMutations -= 1;
      const number = calls.filter((call) => call.query.includes("fulfillmentCreate")).length;
      return new Response(JSON.stringify({data: {fulfillmentCreate: {
        fulfillment: {id: `fulfillment-${number}`, status: "SUCCESS"},
        userErrors: [],
      }}}));
    },
  };

  const result = await createShopifyFulfillment(admin, ["order-1", "order-2"], "IW-123");

  assert.equal(result, "fulfillment-2");
  assert.equal(calls.filter((call) => call.query.includes("GetFulfillmentOrders")).length, 1);
  assert.deepEqual(calls[0].variables, {orderIds: ["order-1", "order-2"]});
  assert.equal(calls.filter((call) => call.query.includes("fulfillmentCreate")).length, 2);
  assert.equal(maximumActiveMutations, 2);
});

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
