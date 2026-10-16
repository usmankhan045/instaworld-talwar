import assert from "node:assert/strict";
import test from "node:test";

import {buildDryRunCallPlan, CALL_JOB_LEASE_MS} from "../app/lib/calling-worker.server.ts";

test("dry-run call plan contains personalized order and address segments", () => {
  const plan = buildDryRunCallPlan(
    {
      id: "job-1",
      shop: "talwar.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderNumber: "1150",
      customerName: "Saifullah Khan",
      phone: "03459283676",
      productSummary: "Handmade x 2",
      normalizedAddress: "Bacha Khan Complex, SWABI, Khyber Pakhtunkhwa, Pakistan",
      attemptCount: 1,
    },
    {id: "attempt-1"},
  );

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.destination, "03459283676");
  assert.equal(plan.shopifyOrderNumber, "1150");
  assert.equal(plan.willPlaceCall, false);
  assert.equal(plan.willBookShipment, false);
  assert.deepEqual(
    plan.segments,
    [
      {kind: "fixed", key: "greeting"},
      {kind: "dynamic", key: "customer", text: "Saifullah Khan"},
      {kind: "dynamic", key: "product", text: "Handmade x 2"},
      {kind: "fixed", key: "order-choice"},
      {kind: "dynamic", key: "address", text: "Bacha Khan Complex, SWABI, Khyber Pakhtunkhwa, Pakistan"},
      {kind: "fixed", key: "address-choice"},
    ],
  );
});

test("call-job lease is long enough for preparation but finite", () => {
  assert.equal(CALL_JOB_LEASE_MS, 5 * 60 * 1000);
  assert.ok(CALL_JOB_LEASE_MS > 0);
});
