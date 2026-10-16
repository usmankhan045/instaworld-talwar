import assert from "node:assert/strict";
import test from "node:test";

import type {ShopifyOrder} from "../app/lib/shopify-orders.server.ts";
import {combineOrders} from "../app/lib/order-combination.server.ts";

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

test("rejects incompatible delivery addresses", () => {
  assert.throws(
    () =>
      combineOrders([
        order({id: "1"}),
        order({
          id: "2",
          shippingAddress: {...order().shippingAddress, address1: "Different street"},
        }),
      ]),
    /incompatible recipient or delivery details/,
  );
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

test("uses TCS for all combined shipments, including legacy courier selections", () => {
  const combined = combineOrders([
    order({id: "1", courier: "POSTEX"}),
    order({id: "2"}),
  ]);
  assert.equal(combined.courier, "TCS");
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
