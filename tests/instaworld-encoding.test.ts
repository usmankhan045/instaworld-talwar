import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateShipmentWeight,
  buildInstaWorldAddress,
  FIXED_SHIPMENT_WEIGHT_KG,
  isCancelledShipment,
  normaliseCity,
  replaceCityInAddress,
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

test("removes Pakistani province names and abbreviations from city input", () => {
  assert.equal(normaliseCity("Swabi KPK"), "SWABI");
  assert.equal(normaliseCity("Swabi, Khyber Pakhtunkhwa"), "SWABI");
  assert.equal(normaliseCity("Lahore Punjab"), "LAHORE");
  assert.equal(normaliseCity("Karachi Sindh"), "KARACHI");
  assert.equal(normaliseCity("Gilgit GB"), "GILGIT");
  assert.equal(normaliseCity("Muzaffarabad AJK"), "MUZAFFARABAD");
  assert.equal(normaliseCity("City Lahore"), "LAHORE");
  assert.equal(normaliseCity("Lahore City"), "LAHORE");
  assert.equal(normaliseCity("District Swabi KPK"), "SWABI");
});

test("corrects the city spelling inside the complete address", () => {
  const rawCity = "Islamabd";
  const city = normaliseCity(rawCity);
  assert.equal(
    buildInstaWorldAddress([
      replaceCityInAddress("House 13, Sector G-8, Islamabd", rawCity, city),
      city,
      "Pakistan",
    ]),
    "House 13, Sector G-8, ISLAMABAD, Pakistan",
  );
});

test("recognizes canceled InstaWorld shipments so they can be booked again", () => {
  assert.equal(isCancelledShipment({trackingNumber: "123", raw: {status: "cancelled"}}), true);
  assert.equal(isCancelledShipment({trackingNumber: "124", raw: {public_status: "CANCELED BY MERCHANT"}}), true);
  assert.equal(isCancelledShipment({trackingNumber: "126", raw: {status: {code: "CANCELLED"}}}), true);
  assert.equal(isCancelledShipment({trackingNumber: "127", raw: {is_cancelled: true}}), true);
  assert.equal(isCancelledShipment({trackingNumber: "125", raw: {status: "BOOKED"}}), false);
});
