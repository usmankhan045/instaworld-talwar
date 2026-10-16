import assert from "node:assert/strict";
import test from "node:test";

import {buildDryRunCallPlan, claimNextCallJob, releaseExpiredCallJobLeases, CALL_JOB_LEASE_MS} from "../app/lib/calling-worker.server.ts";

test("Shopify call worker remains dormant while standalone IVR is developed", async () => {
  assert.equal(await claimNextCallJob(), null);
  assert.equal(await releaseExpiredCallJobLeases(), 0);
});

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
  assert.equal(plan.audioManifest.fixedRecordings.length, 7);
  assert.deepEqual(
    plan.audioManifest.fixedRecordings.map((recording) => recording.fileKey),
    [
      "order-choice.wav",
      "address-choice.wav",
      "order-confirmed.wav",
      "order-cancelled.wav",
      "no-input-retry.wav",
      "invalid-input.wav",
      "address-needs-review.wav",
    ],
  );
  assert.equal(plan.audioManifest.dynamicSegments.length, 2);
  assert.match(plan.audioManifest.dynamicSegments[0].text, /Saifullah Khan/);
  assert.match(plan.audioManifest.dynamicSegments[0].text, /ہینڈ میڈ x 2/);
  assert.match(plan.audioManifest.dynamicSegments[1].text, /SWABI/);
  assert.match(plan.audioManifest.dynamicSegments[1].text, /Khyber Pakhtunkhwa/);
});

test("call-job lease is long enough for preparation but finite", () => {
  assert.equal(CALL_JOB_LEASE_MS, 5 * 60 * 1000);
  assert.ok(CALL_JOB_LEASE_MS > 0);
});
