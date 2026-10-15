import assert from "node:assert/strict";
import test from "node:test";

import {validateBulkCsv} from "../app/lib/bulk-booking.server.ts";

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
});

test("rejects conflicting customer details under one shipment reference", () => {
  const result = validateBulkCsv([
    header,
    'WA-1,Ali,Khan,03001234567,,House 1,Lahore,Punjab,54000,Pakistan,3600,Shawl,,Black,1,cod',
    'WA-1,Ali,Khan,03009999999,,House 1,Lahore,Punjab,54000,Pakistan,3600,Shawl,,Blue,1,cod',
  ].join("\n"));

  assert.match(result.errors.join(" "), /does not match/);
});
