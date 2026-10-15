import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateShipmentWeight,
  buildInstaWorldAddress,
  FIXED_SHIPMENT_WEIGHT_KG,
  normaliseCity,
  stringifyForInstaWorld,
  toInstaWorldPdfSafeText,
} from "../app/lib/instaworld.server.ts";

test("escapes Urdu as ASCII JSON while preserving the original value", () => {
  const original = { consignee: { address: "وفاقی دارالحکومت اسلام آباد" } };
  const wirePayload = stringifyForInstaWorld(original);

  assert.equal(/[^\x00-\x7F]/.test(wirePayload), false);
  assert.match(wirePayload, /\\u0648/);
  assert.deepEqual(JSON.parse(wirePayload), original);
});

test("leaves ordinary InstaWorld JSON unchanged", () => {
  const payload = { city: "ISLAMABAD", remarks: "allow to open", amount: 7200 };
  assert.equal(stringifyForInstaWorld(payload), JSON.stringify(payload));
});

test("allocates one fixed weight across the complete shipment", () => {
  const weights = allocateShipmentWeight(10);
  assert.deepEqual(weights, [FIXED_SHIPMENT_WEIGHT_KG, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(weights.reduce((total, weight) => total + weight, 0), FIXED_SHIPMENT_WEIGHT_KG);
});

test("removes Urdu instead of inventing Roman-Urdu invoice text", () => {
  const safeText = toInstaWorldPdfSafeText("پشاور، خیبر پختونخوا");
  assert.equal(safeText, "");
  assert.equal(/[^\x00-\x7F]/.test(safeText), false);
});

test("books one clean English address without duplicate components", () => {
  assert.equal(
    buildInstaWorldAddress(["House 13, Peshawar", "Peshawar", "خیبر پختونخوا", "25000", "Pakistan"]),
    "House 13, Peshawar, 25000, Pakistan",
  );
});

test("corrects small Pakistani city spelling mistakes", () => {
  assert.equal(normaliseCity("salkot"), "SIALKOT");
  assert.equal(normaliseCity("Islamabd"), "ISLAMABAD");
});
