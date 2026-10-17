import assert from "node:assert/strict";
import test from "node:test";

import {combineOrders} from "../app/lib/order-combination.server.ts";
import {getShopifyOrders} from "../app/lib/shopify-orders.server.ts";

test("Hamtaa shipment items put color only in Product Detail", async () => {
  const products = [
    {title: "Half white", product: {handle: "handmade-hamtaa-cloth-canyon", title: "Handmade Hamtaa Cloth", color: null}},
    {title: "Handmade Hamtaa Cloth", product: {handle: "handmade-hamtaa-cloth-pebble", title: "Handmade Hamtaa Cloth", color: {value: "Pebble Grey"}}},
    {title: "Slub Hamtaa Cloth - Soft Ivory", product: {handle: "slub-hamtaa-cloth-soft-ivory", title: "Slub Hamtaa Cloth - Soft Ivory", color: null}},
    {title: "Talwar Heritage Series — Slate Grey", product: {handle: "talwar-heritage-series-slate-grey", title: "Talwar Heritage Series — Slate Grey", color: {value: "Slate Grey"}}},
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
    {title: "Handmade Hamtaa Cloth", color: "Half white"},
    {title: "Handmade Hamtaa Cloth", color: "Pebble Grey"},
    {title: "Slub Hamtaa Cloth", color: "Soft Ivory"},
    {title: "Talwar Heritage Series — Slate Grey", color: "Slate Grey"},
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
    {title: "Handmade Hamtaa Cloth", color: "Half white"},
    {title: "Handmade Hamtaa Cloth", color: "Pebble Grey"},
    {title: "Slub Hamtaa Cloth", color: "Soft Ivory"},
    {title: "Talwar Heritage Series — Slate Grey", color: "Slate Grey"},
  ]);
});
