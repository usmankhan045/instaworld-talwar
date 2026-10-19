import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateShipmentWeight,
  buildInstaWorldAddress,
  FIXED_SHIPMENT_WEIGHT_KG,
  getInstaWorldCities,
  isCancelledShipment,
  isDeliveredShipment,
  matchInstaWorldCity,
  normaliseCity,
  replaceCityInAddress,
  stringifyForInstaWorld,
  toInstaWorldPdfSafeText,
} from "../app/lib/instaworld.server.ts";
import {PAKISTAN_CITY_ALIASES} from "../app/lib/pakistan-cities.ts";

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

test("prefers the current Shopify spelling when InstaWorld lists it exactly", () => {
  assert.equal(
    matchInstaWorldCity("Liaqatpur", ["LIAQATPUR", "LIAQUATPUR"]),
    "LIAQATPUR",
  );
  assert.equal(matchInstaWorldCity("Islamabd", ["ISLAMABAD"]), "ISLAMABAD");
});

test("matches InstaWorld city spellings despite spaces and small customer typos", () => {
  assert.equal(matchInstaWorldCity("Tando Allahyar", ["TANDO ALLAH YAR"]), "TANDO ALLAH YAR");
  assert.equal(matchInstaWorldCity("  Tando   Allahyar ", ["TANDO ALLAH YAR"]), "TANDO ALLAH YAR");
  assert.equal(matchInstaWorldCity("Tando Allahya", ["TANDO ALLAH YAR"]), "TANDO ALLAH YAR");
  assert.equal(matchInstaWorldCity("Tando Adam", ["TANDO ALLAH YAR"]), null);
});

test("uses a fresh persisted InstaWorld city catalog without calling the API", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("the API should not be called");
  };
  try {
    const cities = await getInstaWorldCities({
      account: "live",
      apiKey: "test",
      baseUrl: "https://example.invalid",
      locationId: 1,
      refPrefix: "",
      cityCatalogKey: "fresh-persisted-catalog-test",
      cityCatalog: [" Tando  Allah Yar "],
      cityCatalogSyncedAt: Date.now(),
    });
    assert.deepEqual(cities, ["TANDO ALLAH YAR"]);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes and saves a stale InstaWorld city catalog", async () => {
  const originalFetch = globalThis.fetch;
  let saved: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({data: [{name: "Tando Allah Yar"}, {name: "Lahore"}]}), {
    status: 200,
    headers: {"Content-Type": "application/json"},
  });
  try {
    const cities = await getInstaWorldCities({
      account: "live",
      apiKey: "test",
      baseUrl: "https://example.invalid",
      locationId: 1,
      refPrefix: "",
      cityCatalogKey: "stale-persisted-catalog-test",
      cityCatalog: ["OLD CITY"],
      cityCatalogSyncedAt: 1,
      saveCityCatalog: async (catalog) => { saved = catalog; },
    });
    assert.deepEqual(cities, ["TANDO ALLAH YAR", "LAHORE"]);
    assert.deepEqual(saved, cities);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to a stale saved city catalog when InstaWorld is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("temporary outage"); };
  try {
    const cities = await getInstaWorldCities({
      account: "live",
      apiKey: "test",
      baseUrl: "https://example.invalid",
      locationId: 1,
      refPrefix: "",
      cityCatalogKey: "stale-fallback-catalog-test",
      cityCatalog: ["TANDO ALLAH YAR"],
      cityCatalogSyncedAt: 1,
    });
    assert.deepEqual(cities, ["TANDO ALLAH YAR"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("converts Urdu city names to InstaWorld's canonical English names", () => {
  assert.equal(normaliseCity("بورے والا"), "BUREWALA");
  assert.equal(normaliseCity("بوریوالا"), "BUREWALA");
  assert.equal(normaliseCity("اسلام آباد"), "ISLAMABAD");
  assert.equal(normaliseCity("فیصل آباد"), "FAISALABAD");
});

test("covers every Urdu city alias in the shared Pakistan city catalog", () => {
  const entries = Object.entries(PAKISTAN_CITY_ALIASES);
  assert.ok(entries.length >= 140);
  for (const [city, aliases] of entries) {
    for (const alias of aliases) assert.equal(normaliseCity(alias), city.toUpperCase(), alias);
  }
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

test("recognizes delivered InstaWorld shipments so they are not combined again", () => {
  assert.equal(isDeliveredShipment({trackingNumber: "123", raw: {status: {code: "DELIVERED"}}}), true);
  assert.equal(isDeliveredShipment({trackingNumber: "124", raw: {public_status: "Delivered"}}), true);
  assert.equal(isDeliveredShipment({trackingNumber: "125", raw: {status: "IN_TRANSIT"}}), false);
});
