import assert from "node:assert/strict";
import test from "node:test";

import {
  checkInstaWorldOrderAvailability,
  secondaryOrderAvailabilityError,
} from "../app/lib/instaworld-order-availability.server.ts";
import type {InstaWorldConfig} from "../app/lib/instaworld.server.ts";

const config: InstaWorldConfig = {
  account: "live",
  apiKey: "test",
  baseUrl: "https://example.invalid",
  locationId: 1,
  refPrefix: "",
};

test("blocks every non-cancelled InstaWorld shipment status", async () => {
  for (const status of ["BOOKED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]) {
    const [result] = await checkInstaWorldOrderAvailability("shop", [{id: "2", orderNumber: "1220"}], config, {
      linkedReferences: new Map(),
      findShipment: async () => ({trackingNumber: "IW-1", raw: {status}}),
    });
    assert.equal(result.available, false, status);
    assert.equal(result.verified, true, status);
  }
});

test("allows an order when InstaWorld has no shipment or only a cancelled shipment", async () => {
  const noShipment = await checkInstaWorldOrderAvailability("shop", [{id: "2", orderNumber: "1220"}], config, {
    linkedReferences: new Map(),
    findShipment: async () => null,
  });
  assert.equal(noShipment[0].available, true);

  const cancelled = await checkInstaWorldOrderAvailability("shop", [{id: "2", orderNumber: "1220"}], config, {
    linkedReferences: new Map(),
    findShipment: async () => ({trackingNumber: "IW-2", raw: {status: "CANCELLED"}}),
  });
  assert.equal(cancelled[0].available, true);
});

test("checks a previous combined reference and fails closed when InstaWorld is unavailable", async () => {
  const references: string[] = [];
  const [combined] = await checkInstaWorldOrderAvailability("shop", [{id: "2", orderNumber: "1220"}], config, {
    linkedReferences: new Map([["2", ["1221+1220"]]]),
    findShipment: async (reference) => {
      references.push(reference);
      return reference === "1221+1220"
        ? {trackingNumber: "IW-3", raw: {status: "DELIVERED"}}
        : null;
    },
  });
  assert.deepEqual(references, ["1220", "1221+1220"]);
  assert.equal(combined.available, false);

  const unavailable = await checkInstaWorldOrderAvailability("shop", [{id: "3", orderNumber: "1222"}], config, {
    linkedReferences: new Map(),
    findShipment: async () => { throw new Error("timeout"); },
  });
  assert.equal(unavailable[0].verified, false);
  assert.match(secondaryOrderAvailabilityError(unavailable)?.message || "", /could not verify/i);
});
