import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCallAudioManifest,
  FIXED_IVR_RECORDINGS,
  normalizeSpeechPronunciation,
} from "../app/lib/calling-audio.server.ts";

test("builds personalized greeting and address audio segments", () => {
  const manifest = buildCallAudioManifest({
    id: "job-1",
    shopifyOrderNumber: "1150",
    customerName: "Saifullah Khan",
    productSummary: "Hamtaa Handmade x 2",
    normalizedAddress: "Bacha Khan Complex, SWABI, KPK, Pakistan",
  });

  assert.equal(manifest.orderNumber, "1150");
  assert.equal(manifest.dynamicSegments.length, 2);
  assert.match(manifest.dynamicSegments[0].text, /Saifullah Khan/);
  assert.match(manifest.dynamicSegments[0].text, /حماتا ہینڈ میڈ/);
  assert.match(manifest.dynamicSegments[1].text, /Khyber Pakhtunkhwa/);
  assert.equal(manifest.dynamicSegments[0].outputFileKey, "orders/job-1/greeting.wav");
  assert.equal(manifest.dynamicSegments[1].outputFileKey, "orders/job-1/address.wav");
});

test("keeps unknown names and products instead of guessing their pronunciation", () => {
  const value = normalizeSpeechPronunciation("Raeess Ahead, Product XYZ-42");
  assert.equal(value, "Raeess Ahead, Product XYZ-42");
});

test("limits and sanitizes dynamic speech input", () => {
  const manifest = buildCallAudioManifest({
    id: "job-2",
    shopifyOrderNumber: "1151",
    customerName: `  Ali\n${"x".repeat(300)}  `,
    productSummary: "Product\u0000 Name",
    normalizedAddress: "House 1\nMain Road",
  });

  assert.ok(manifest.dynamicSegments[0].text.length < 250);
  assert.doesNotMatch(manifest.dynamicSegments[0].text, /\u0000/);
  assert.doesNotMatch(manifest.dynamicSegments[1].text, /\n/);
});

test("defines every fixed recording required by the IVR flow", () => {
  assert.deepEqual(Object.keys(FIXED_IVR_RECORDINGS).sort(), [
    "addressChoice",
    "addressNeedsReview",
    "invalidInput",
    "noInputRetry",
    "orderCancelled",
    "orderChoice",
    "orderConfirmed",
  ]);
});
