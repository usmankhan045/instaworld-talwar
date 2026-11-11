import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyAddressCity,
  verifyDeliveryAddress,
  type DeliveryAddressInput,
} from "../app/lib/address-validation.server.ts";

const address: DeliveryAddressInput = {
  address1: "House 12, Main Boulevard Gulberg",
  address2: "Near Main Market",
  city: "لاہور",
  province: "Punjab",
  zip: "54660",
  country: "Pakistan",
  countryCode: "PK",
};

test("preserves the Shopify address without external geocoding", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("address pass-through must not call a map provider");
  };

  try {
    const result = await verifyDeliveryAddress(address);
    assert.equal(result.ok, true);
    assert.equal(result.verifiedAddress.source, "shopify");
    assert.equal(result.verifiedAddress.city, "لاہور");
    assert.equal(result.verifiedAddress.postalCode, "54660");
    assert.match(result.verifiedAddress.formattedAddress, /House 12/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual address verification never blocks the legacy city check", async () => {
  assert.equal(await verifyAddressCity("Village address", "بورے والا"), null);
  assert.equal(await verifyAddressCity(null, null), null);
});
