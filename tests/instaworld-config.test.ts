import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {
  findShipmentByReference,
  INSTAWORLD_API_BASE_URL,
  type InstaWorldConfig,
} from "../app/lib/instaworld.server.ts";
import {discoverInstaWorldAccount} from "../app/lib/instaworld-accounts.server.ts";

const accountConfig: InstaWorldConfig = {
  account: "live",
  apiKey: "store-specific-key",
  baseUrl: INSTAWORLD_API_BASE_URL,
  locationId: 9876,
  refPrefix: "",
};

test("courier requests use the explicitly selected store account", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({data: []}), {
      status: 200,
      headers: {"Content-Type": "application/json"},
    });
  };

  try {
    await findShipmentByReference("1001", accountConfig);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, `${INSTAWORLD_API_BASE_URL}/shipments?ref_no=1001`);
  assert.equal(authorization, "Bearer store-specific-key");
});

test("the InstaWorld client has no environment credential fallback", () => {
  const clientSource = readFileSync("app/lib/instaworld.server.ts", "utf8");
  const accountSource = readFileSync("app/lib/instaworld-accounts.server.ts", "utf8");
  const forbiddenVariables = [
    "INSTAWORLD_API_KEY",
    "INSTAWORLD_LOCATION_ID",
    "INSTAWORLD_TEST_API_KEY",
    "INSTAWORLD_TEST_LOCATION_ID",
    "INSTAWORLD_TEST_SHOPS",
  ];

  for (const variable of forbiddenVariables) {
    assert.ok(!clientSource.includes(variable), `${variable} must not be read by the API client`);
    assert.ok(!accountSource.includes(variable), `${variable} must not be read by the account resolver`);
  }
  assert.match(accountSource, /No InstaWorld account is connected for this store/);
});

test("one API key discovers its account, locations, and attached couriers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const data = path.endsWith("/locations")
      ? [{id: 42, name: "Main pickup", address: "Street 1", city: "Lahore", is_default: true, couriers: [{id: 7, name: "Courier A", status: "active"}]}]
      : path.endsWith("/me")
        ? {id: "merchant-9", business_name: "Example Merchant", email: "owner@example.test", api_key: "must-not-be-stored", couriers: [{id: 8, name: "Courier B", enabled: true}]}
          : null;
    return data
      ? new Response(JSON.stringify({data}), {status: 200, headers: {"Content-Type": "application/json"}})
      : new Response(JSON.stringify({error: {code: "not_found"}}), {status: 404, headers: {"Content-Type": "application/json"}});
  };

  try {
    const snapshot = await discoverInstaWorldAccount("one-store-key");
    assert.equal(snapshot.name, "Example Merchant");
    assert.equal(snapshot.externalAccountId, "merchant-9");
    assert.equal(snapshot.locationId, 42);
    assert.deepEqual(snapshot.locations.map(({id, name}) => ({id, name})), [{id: 42, name: "Main pickup"}]);
    assert.deepEqual(snapshot.couriers.map(({name}) => name).sort(), ["Courier A", "Courier B"]);
    assert.equal("api_key" in snapshot.details, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
