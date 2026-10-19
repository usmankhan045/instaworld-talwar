import assert from "node:assert/strict";
import test from "node:test";

import {combineOrders} from "../app/lib/order-combination.server.ts";
import {getShopifyOrders} from "../app/lib/shopify-orders.server.ts";

test("shipment items use store product details without handle-specific mappings", async () => {
  const products = [
    {title: "Classic Shirt", product: {color: null}, variant: {title: "Half white / Medium"}},
    {title: "Leather Sandal", product: {color: {value: "Pebble Grey"}}, variant: {title: "Default Title"}},
    {title: "Organic Jaggery", product: {color: null}, variant: {title: "Default Title"}},
  ];
  const node = {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-10-17T00:00:00Z",
    totalPriceSet: {shopMoney: {amount: "3900", currencyCode: "PKR"}},
    lineItems: {edges: products.map((product, index) => ({node: {
      id: `gid://shopify/LineItem/${index + 1}`,
      ...product,
      quantity: 1,
      originalUnitPriceSet: {shopMoney: {amount: "3900", currencyCode: "PKR"}},
      discountedTotalSet: {shopMoney: {amount: "3900", currencyCode: "PKR"}},
    }}))},
  };
  const admin = {graphql: async () => ({json: async () => ({data: {nodes: [node]}})})};

  const [order] = await getShopifyOrders(admin, ["gid://shopify/Order/1"]);
  assert.deepEqual(order.lineItems.map(({title, color}) => ({title, color})), [
    {title: "Classic Shirt", color: "Half white / Medium"},
    {title: "Leather Sandal", color: "Pebble Grey"},
    {title: "Organic Jaggery", color: null},
  ]);

  const combined = combineOrders([{
    ...order,
    displayFinancialStatus: "PENDING",
    totalOutstanding: {amount: "3900", currencyCode: "PKR"},
    shippingAddress: {
      name: "Test Customer", phone: "+923001234567", address1: "Street 1",
      address2: null, city: "Lahore", province: "Punjab", provinceCode: "PB",
      zip: "54000", country: "Pakistan", countryCode: "PK",
    },
  }]);
  assert.deepEqual(combined.items.map(({title, color}) => ({title, color})), [
    {title: "Classic Shirt", color: "Half white / Medium"},
    {title: "Leather Sandal", color: "Pebble Grey"},
    {title: "Organic Jaggery", color: null},
  ]);
});
