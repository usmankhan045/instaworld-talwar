import assert from "node:assert/strict";
import test from "node:test";

import {formatBulkBookingError, mapWithConcurrency, validateBulkCsv} from "../app/lib/bulk-booking.server.ts";

const header = "reference,first_name,last_name,phone,email,address,city,province,postal_code,country,amount,product_title,sku,color,quantity,payment_type";

test("groups repeated CSV rows into one shipment and preserves product colors", () => {
  const result = validateBulkCsv([
    header,
    'WA-1,Ali,Khan,03001234567,ali@example.com,"House 1, Main Road",Lahore,Punjab,54000,Pakistan,3600,Shawl,SKU-1,Black,1,cod',
    'WA-1,Ali,Khan,03001234567,ali@example.com,"House 1, Main Road",Lahore,Punjab,54000,Pakistan,3600,Shawl,SKU-2,Blue,1,cod',
  ].join("\n"));

  assert.equal(result.errors.length, 0);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].items.map((item) => item.color), ["Black", "Blue"]);
  assert.equal(result.groups[0].email, "ali@example.com");
});

test("rejects conflicting customer details under one shipment reference", () => {
  const result = validateBulkCsv([
    header,
    'WA-1,Ali,Khan,03001234567,,House 1,Lahore,Punjab,54000,Pakistan,3600,Shawl,,Black,1,cod',
    'WA-1,Ali,Khan,03009999999,,House 1,Lahore,Punjab,54000,Pakistan,3600,Shawl,,Blue,1,cod',
  ].join("\n"));

  assert.match(result.errors.join(" "), /does not match/);
});

test("allows a missing email without adding a placeholder", () => {
  const result = validateBulkCsv([
    header,
    'WA-2,Ali,Khan,03001234567,,House 1,Lahore,Punjab,54000,Pakistan,3600,Shawl,,Black,1,cod',
  ].join("\n"));

  assert.equal(result.errors.length, 0);
  assert.equal(result.groups[0].email, null);
});

test("formats every failed booking with a reference and human-readable message", () => {
  assert.equal(
    formatBulkBookingError("WA-9", "booking the shipment with InstaWorld", new Error("The destination city is not serviceable by InstaWorld.")),
    "WA-9: This city is not serviceable by InstaWorld. Check the city name.",
  );
  assert.match(formatBulkBookingError("WA-10", "booking the shipment with InstaWorld", new Error("fetch failed")), /WA-10: Could not connect/);
});

test("keeps the bounded worker pool busy without waiting for the slowest group", async () => {
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseSlowest!: () => void;
  const slowest = new Promise<void>((resolve) => { releaseSlowest = resolve; });

  const running = mapWithConcurrency([0, 1, 2, 3, 4, 5], 5, async (value) => {
    started.push(value);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (value === 0) await slowest;
    else await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(started.includes(5), "the sixth job should start while the first job is still running");
  assert.equal(maximumActive, 5);
  releaseSlowest();
  assert.deepEqual(await running, [0, 2, 4, 6, 8, 10]);
});

test("never exceeds the configured concurrency ceiling", async () => {
  let active = 0;
  let maximumActive = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value;
  });
  assert.equal(maximumActive, 3);
});
