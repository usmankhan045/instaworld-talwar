import assert from "node:assert/strict";
import test from "node:test";

import {combineOrders} from "../app/lib/order-combination.server.ts";
import {
  getRecentShopifyOrderCandidates,
  getShopifyOrders,
  hasReliableCustomerMatch,
  type ShopifyOrder,
  type ShopifyOrderMatchCandidate,
} from "../app/lib/shopify-orders.server.ts";

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

const matchAddress = {
  name: "Zafar Iqbal",
  phone: "+92 300 9662956",
  address1: "H/no 89 D block Wapda City",
  address2: null,
  city: "Faisalabad",
  province: "Punjab",
  provinceCode: "PB",
  zip: null,
  country: "Pakistan",
  countryCode: "PK",
};

const matchOrder = {
  id: "order-current",
  orderNumber: "1228",
  email: "ayatzafar47@gmail.com",
  createdAt: "2026-10-18T00:00:00Z",
  cancelledAt: null,
  displayFinancialStatus: "PENDING",
  totalPrice: {amount: "5200", currencyCode: "PKR"},
  totalOutstanding: {amount: "5200", currencyCode: "PKR"},
  customer: null,
  shippingAddress: matchAddress,
  billingAddress: null,
  lineItems: [],
} satisfies ShopifyOrder;

test("matches the same normalized phone when Shopify stores it on the billing address", () => {
  const candidate = {
    ...matchOrder,
    id: "order-related",
    orderNumber: "1229",
    email: "different@example.com",
    shippingAddress: {...matchAddress, phone: null, address1: "Another address"},
    billingAddress: {...matchAddress, phone: "0300-9662956"},
  } satisfies ShopifyOrderMatchCandidate;

  assert.equal(hasReliableCustomerMatch(matchOrder, candidate), true);
});

test("matches name and phone even when email and address differ", () => {
  const candidate = {
    ...matchOrder,
    id: "order-related-different-details",
    orderNumber: "1230",
    email: null,
    shippingAddress: {
      ...matchAddress,
      phone: "03009662956",
      address1: "A completely different delivery address",
      city: "Lahore",
    },
    billingAddress: null,
  } satisfies ShopifyOrderMatchCandidate;

  assert.equal(hasReliableCustomerMatch(matchOrder, candidate), true);
});

test("does not match a common name when the phone differs", () => {
  const candidate = {
    ...matchOrder,
    id: "order-unrelated",
    orderNumber: "1231",
    email: "different@example.com",
    shippingAddress: {...matchAddress, phone: "03111111111", address1: "Unrelated road", city: "Lahore"},
    billingAddress: null,
  } satisfies ShopifyOrderMatchCandidate;

  assert.equal(hasReliableCustomerMatch(matchOrder, candidate), false);
});

test("does not match the same phone when the customer name differs", () => {
  const candidate = {
    ...matchOrder,
    id: "order-other-person",
    orderNumber: "1232",
    email: "ayatzafar47@gmail.com",
    shippingAddress: {...matchAddress, name: "Another Person"},
    billingAddress: null,
  } satisfies ShopifyOrderMatchCandidate;

  assert.equal(hasReliableCustomerMatch(matchOrder, candidate), false);
});

test("loads recent open matching candidates in one lightweight Shopify query", async () => {
  let operation = "";
  const admin = {graphql: async (query: string) => {
    operation = query;
    return new Response(JSON.stringify({data: {orders: {nodes: [{
      id: "order-related",
      name: "#1229",
      email: "ayatzafar47@gmail.com",
      createdAt: "2026-10-19T00:00:00Z",
      cancelledAt: null,
      shippingAddress: matchAddress,
      billingAddress: null,
    }]}}}));
  }};

  const candidates = await getRecentShopifyOrderCandidates(admin);
  assert.equal(candidates[0].orderNumber, "1229");
  assert.equal(candidates[0].billingAddress, null);
  assert.match(operation, /first:\s*100/);
  assert.match(operation, /status:open/);
  assert.doesNotMatch(operation, /customer\s*\{/);
  assert.doesNotMatch(operation, /lineItems/);
});
