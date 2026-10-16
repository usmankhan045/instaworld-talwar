import assert from "node:assert/strict";
import test from "node:test";

import {buildCallJobInput} from "../app/lib/calling.server.ts";

test("builds an eligible queued call job with normalized city in the spoken address", () => {
  const result = buildCallJobInput({
    id: 18971861516371,
    name: "#1150",
    phone: null,
    customer: {first_name: "Saifullah", last_name: "Khan", phone: null},
    shipping_address: {
      name: "Saifullah Khan",
      phone: "+923459283676",
      address1: "Bacha Khan medical complex new ER laboratory shah mansoor swabi kpk",
      address2: null,
      city: "Swabi KPK",
      province: "Khyber Pakhtunkhwa",
      province_code: "KP",
      zip: null,
      country: "Pakistan",
    },
    line_items: [{title: "Handmade", quantity: 2}],
  });

  assert.equal(result.shopifyOrderId, "18971861516371");
  assert.equal(result.shopifyOrderNumber, "1150");
  assert.equal(result.customerName, "Saifullah Khan");
  assert.equal(result.phone, "03459283676");
  assert.equal(result.productSummary, "Handmade x 2");
  assert.equal(result.callStatus, "queued");
  assert.equal(result.addressStatus, "pending");
  assert.match(result.normalizedAddress, /SWABI/);
  assert.doesNotMatch(result.normalizedAddress, /SWABI KPK/i);
});

test("marks an order for manual review when it cannot be called safely", () => {
  const result = buildCallJobInput({
    id: "gid://shopify/Order/1",
    name: "#1",
    shipping_address: {
      name: "Customer",
      phone: null,
      address1: "House 1",
      city: "Lahore",
      province: "Punjab",
      country: "Pakistan",
    },
    line_items: [{title: "Product", quantity: 1}],
  });

  assert.equal(result.callStatus, "manual_review");
  assert.equal(result.addressStatus, "pending");
});

test("does not queue a cancelled Shopify order", () => {
  const result = buildCallJobInput({
    id: 2,
    name: "#2",
    cancelled_at: "2026-10-16T10:00:00Z",
    phone: "03001234567",
    shipping_address: {
      name: "Ali Khan",
      phone: "03001234567",
      address1: "House 1 Main Road",
      city: "Lahore",
      province: "Punjab",
      country: "Pakistan",
    },
    line_items: [{title: "Shawl", quantity: 1}],
  });

  assert.equal(result.orderStatus, "cancelled");
  assert.equal(result.callStatus, "manual_review");
});
