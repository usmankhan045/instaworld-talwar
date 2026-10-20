import assert from "node:assert/strict";
import test from "node:test";

import {
  instaWorldStatusCode,
  isOverdueInstaWorldShipment,
  isTerminalInstaWorldStatus,
} from "../app/lib/instaworld-shipments.server.ts";

const now = new Date("2026-10-20T12:00:00.000Z");

test("reads the authoritative nested InstaWorld status code", () => {
  assert.equal(instaWorldStatusCode({status: {code: "OUT_FOR_DELIVERY"}, public_status: "Booked"}), "OUT_FOR_DELIVERY");
});

test("flags active shipments only after three full days", () => {
  assert.equal(isOverdueInstaWorldShipment({status: {code: "IN_TRANSIT"}, created_at: "2026-10-17T11:59:59.000Z"}, now), true);
  assert.equal(isOverdueInstaWorldShipment({status: {code: "IN_TRANSIT"}, created_at: "2026-10-17T12:00:01.000Z"}, now), false);
});

test("does not flag delivered, cancelled, or completed returns", () => {
  for (const status of ["DELIVERED", "CANCELLED", "RTO_RETURNED_TO_SHIPPER"]) {
    assert.equal(isTerminalInstaWorldStatus(status), true);
    assert.equal(isOverdueInstaWorldShipment({status: {code: status}, created_at: "2026-10-01T00:00:00.000Z"}, now), false);
  }
});

test("uses the app booking time only when InstaWorld omits its timestamp", () => {
  assert.equal(isOverdueInstaWorldShipment(
    {status: {code: "BOOKED"}},
    now,
    new Date("2026-10-10T00:00:00.000Z"),
  ), true);
});
