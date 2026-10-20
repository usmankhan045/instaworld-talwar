import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("the sync worker updates only app data and never Shopify fulfillment", () => {
  const worker = readFileSync("app/routes/api.instaworld-sync.ts", "utf8");

  assert.doesNotMatch(worker, /unauthenticated\.admin/);
  assert.doesNotMatch(worker, /createShopifyFulfillment/);
  assert.doesNotMatch(worker, /createShopifyFulfillmentEvent/);
  assert.doesNotMatch(worker, /cancelShopifyFulfillment/);
  assert.match(worker, /instaworldStatus: newStatus/);
});

test("booking still creates the initial Shopify fulfillment", () => {
  const booking = readFileSync("app/lib/booking.server.ts", "utf8");

  assert.match(booking, /createShopifyFulfillment\(/);
  assert.match(booking, /shopifyFulfillmentId: fulfillmentId/);
});

test("the worker reports recoverable courier problems as warnings", () => {
  const worker = readFileSync("app/routes/api.instaworld-sync.ts", "utf8");
  const client = readFileSync("app/lib/instaworld-shipments.server.ts", "utf8");

  assert.match(worker, /warnings/);
  assert.match(worker, /criticalErrors\.length === 0 \? 200 : 500/);
  assert.match(client, /MAX_PAGE_ATTEMPTS = 3/);
  assert.match(client, /pagination stopped safely/);
  assert.doesNotMatch(client, /throw new Error\(`InstaWorld shipment lookup failed/);
});
