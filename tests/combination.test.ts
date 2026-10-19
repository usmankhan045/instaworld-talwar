import assert from "node:assert/strict";
import test from "node:test";

import type {ShopifyOrder} from "../app/lib/shopify-orders.server.ts";
import {combineOrders} from "../app/lib/order-combination.server.ts";
import {selectDeliveryAddress} from "../app/lib/delivery-selection.server.ts";

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Order/${Math.random()}`,
    orderNumber: "1001",
    email: "test@example.com",
    createdAt: "2026-10-14T00:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PENDING",
    paymentStatus: "PENDING",
    totalPrice: {amount: "100", currencyCode: "PKR"},
    totalOutstanding: {amount: "100", currencyCode: "PKR"},
    customer: null,
    shippingAddress: {
      name: "Ali Khan",
      phone: "+923001234567",
      address1: "Street 1",
      address2: null,
      city: "Lahore",
      province: "Punjab",
      provinceCode: "PB",
      zip: "54000",
      country: "Pakistan",
      countryCode: "PK",
    },
    lineItems: [
      {
        id: "line-1",
        title: "Shirt",
        sku: "SHIRT",
        quantity: 1,
        color: null,
        unitPrice: {amount: "100", currencyCode: "PKR"},
        totalPrice: {amount: "100", currencyCode: "PKR"},
      },
    ],
    ...overrides,
  } as ShopifyOrder;
}

test("combines three compatible orders and calculates quantity, weight, and COD", () => {
  const orders = [
    order({id: "1", orderNumber: "1001"}),
    order({
      id: "2",
      orderNumber: "1002",
      totalOutstanding: {amount: "200", currencyCode: "PKR"},
      lineItems: [{...order().lineItems[0], id: "line-2", quantity: 2}],
    }),
    order({
      id: "3",
      orderNumber: "1003",
      totalOutstanding: {amount: "300", currencyCode: "PKR"},
      lineItems: [{...order().lineItems[0], id: "line-3", quantity: 3}],
    }),
  ];

  const combined = combineOrders(orders);

  assert.equal(combined.totalQuantity, 6);
  assert.equal(combined.defaultWeight, 4.8);
  assert.equal(combined.payment.amountDue, 600);
  assert.equal(combined.items[0].quantity, 6);
});

test("combines the same customer's orders with different addresses and permits a source choice", () => {
  const orders = [order({id: "1"}), order({
    id: "2",
    shippingAddress: {...order().shippingAddress, address1: "Different street"},
  })];
  const combined = combineOrders(orders, undefined, "2");
  assert.equal(combined.consignee.address1, "Different street");
  assert.equal(combined.addressOrderId, "2");
  assert.equal(combined.addressesDiffer, true);
  assert.equal(combined.addressOptions.length, 2);
});

test("chooses a complete address from a later order when the first is incomplete", () => {
  const combined = combineOrders([
    order({id: "1", shippingAddress: {...order().shippingAddress, address1: null}}),
    order({id: "2"}),
  ]);
  assert.equal(combined.addressOrderId, "2");
  assert.equal(combined.consignee.address1, "Street 1");
});

test("uses a valid phone from another selected order", () => {
  const combined = combineOrders([
    order({id: "1", shippingAddress: {...order().shippingAddress, phone: "123"}}),
    order({id: "2", shippingAddress: {...order().shippingAddress, phone: "03001234567"}}),
  ], undefined, "1");
  assert.equal(combined.consignee.phone, "03001234567");
});

test("rejects orders that cannot be identified as the same customer", () => {
  assert.throws(() => combineOrders([
    order({id: "1"}),
    order({id: "2", email: "other@example.com", shippingAddress: {
      ...order().shippingAddress, name: "Other Customer", phone: "+923009999999",
      address1: "Another street",
    }}),
  ]), /could not be confirmed as the same customer/);
});

test("rejects an address choice outside the selected orders", () => {
  assert.throws(() => combineOrders([order({id: "1"})], undefined, "2"),
    /must come from one of the selected orders/);
});

test("automatic selection tries another order when the first address fails validation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", {status: 200});
  try {
    const orders = [
      order({id: "1", shippingAddress: {...order().shippingAddress, address1: "St"}}),
      order({id: "2"}),
    ];
    const automatic = await selectDeliveryAddress(orders);
    assert.equal(automatic.verification.ok, true);
    assert.equal(automatic.combined.addressOrderId, "2");
    const manual = await selectDeliveryAddress(orders, undefined, "1");
    assert.equal(manual.verification.ok, false);
    assert.equal(manual.combined.addressOrderId, "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects mixed COD and prepaid treatment", () => {
  assert.throws(
    () =>
      combineOrders([
        order({id: "1"}),
        order({
          id: "2",
          paymentStatus: "PAID",
          displayFinancialStatus: "PAID",
          totalOutstanding: {amount: "0", currencyCode: "PKR"},
        }),
      ]),
    /COD and prepaid orders cannot be combined/,
  );
});

test("accepts a merchant-adjusted positive weight", () => {
  const combined = combineOrders([order({id: "1"}), order({id: "2"})], 3.25);
  assert.equal(combined.defaultWeight, 1.6);
});

test("keeps same-title products with different colors as separate items", () => {
  const combined = combineOrders([
    order({
      id: "1",
      lineItems: [{...order().lineItems[0], color: "Olive Green"}],
    }),
    order({
      id: "2",
      lineItems: [{...order().lineItems[0], color: "Charcoal Grey"}],
    }),
  ]);

  assert.equal(combined.items.length, 2);
  assert.deepEqual(
    combined.items.map((item) => item.color),
    ["Olive Green", "Charcoal Grey"],
  );
});
