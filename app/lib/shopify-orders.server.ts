
/* eslint-disable @typescript-eslint/no-explicit-any */

type ShopifyAdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{
    json: () => Promise<unknown>;
  }>;
};

export type Money = {
  amount: string;
  currencyCode: string;
};

export type ShopifyOrderAddress = {
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  zip: string | null;
  country: string | null;
  countryCode: string | null;
};

export type ShopifyOrder = {
  id: string;
  orderNumber: string;
  email: string | null;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  totalPrice: Money;
  totalOutstanding: Money | null;
  customer: null;
  shippingAddress: ShopifyOrderAddress | null;
  billingAddress?: ShopifyOrderAddress | null;
  lineItems: Array<{
    id: string;
    title: string;
    sku: string | null;
    quantity: number;
    color: string | null;
    unitPrice: Money;
    totalPrice: Money;
  }>;
};

export type ShopifyOrderMatchCandidate = Pick<
  ShopifyOrder,
  "id" | "orderNumber" | "email" | "createdAt" | "cancelledAt" | "shippingAddress" | "billingAddress"
>;

function normalizedMatchValue(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedMatchPhone(value: string | null | undefined): string {
  const digits = normalizedMatchValue(value).replace(/\D/g, "");
  if (digits.startsWith("92") && digits.length === 12) return `0${digits.slice(2)}`;
  return digits.startsWith("3") && digits.length === 10 ? `0${digits}` : digits;
}

export function hasReliableCustomerMatch(current: ShopifyOrder, candidate: ShopifyOrderMatchCandidate): boolean {
  const currentAddresses = [current.shippingAddress, current.billingAddress].filter(Boolean);
  const candidateAddresses = [candidate.shippingAddress, candidate.billingAddress].filter(Boolean);
  const currentNames = new Set(currentAddresses
    .map((address) => normalizedMatchValue(address?.name))
    .filter(Boolean));
  const sameName = candidateAddresses.some((address) => currentNames.has(normalizedMatchValue(address?.name)));
  const currentPhones = new Set(currentAddresses
    .map((address) => normalizedMatchPhone(address?.phone))
    .filter((phone) => /^03\d{9}$/.test(phone)));
  const samePhone = candidateAddresses.some((address) => currentPhones.has(normalizedMatchPhone(address?.phone)));

  // Email and address may legitimately differ between two orders from the
  // same person. Name + Pakistani mobile number is the matching authority.
  return sameName && samePhone;
}

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export function formatShopifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/access denied for product field/i.test(message)) {
    return "Shopify permission missing: this app cannot read product details for this order. Grant the read_products permission and reinstall the app.";
  }
  if (/access denied/i.test(message)) {
    return `Shopify permission missing: ${message}`;
  }
  if (/unique constraint failed.*shop.*refno/i.test(message)) {
    return "This order already has a previous booking attempt. Retrying with the same Shopify order reference.";
  }
  return message;
}

const ORDER_FIELDS = `
  id
  name
  email
  createdAt
  cancelledAt
  displayFinancialStatus
  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  totalOutstandingSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  shippingAddress {
    name
    phone
    address1
    address2
    city
    province
    provinceCode
    zip
    country
    countryCodeV2
  }
  billingAddress {
    name
    phone
    address1
    address2
    city
    province
    provinceCode
    zip
    country
    countryCodeV2
  }
  lineItems(first: 250) {
    edges {
      node {
        id
        title
        sku
        quantity
        product {
          color: metafield(namespace: "custom", key: "color") {
            value
          }
        }
        variant {
          title
        }
        originalUnitPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountedTotalSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

function assertGraphqlSuccess<T>(result: GraphqlResponse<T>): T {
  if (result.errors?.length) {
    throw new Error(
      result.errors.map((error) => error.message).join("; "),
    );
  }

  if (!result.data) {
    throw new Error("Shopify returned no data.");
  }

  return result.data;
}

function productDetail(item: any): string | null {
  const metafield = String(item.product?.color?.value ?? "").trim();
  if (metafield) return metafield;
  const variantTitle = String(item.variant?.title ?? "").trim();
  return variantTitle && variantTitle.toLowerCase() !== "default title" ? variantTitle : null;
}

function parseOrder(node: any): ShopifyOrder {
  if (!node?.id || !node.name) {
    throw new Error("Shopify returned an incomplete order.");
  }

  const shopMoney = (value: any): Money => ({
    amount: String(value?.shopMoney?.amount ?? ""),
    currencyCode: String(value?.shopMoney?.currencyCode ?? ""),
  });

  const address = (value: any): ShopifyOrderAddress | null => value
    ? {
        name: value.name ?? null,
        phone: value.phone ?? null,
        address1: value.address1 ?? null,
        address2: value.address2 ?? null,
        city: value.city ?? null,
        province: value.province ?? null,
        provinceCode: value.provinceCode ?? null,
        zip: value.zip ?? null,
        country: value.country ?? null,
        countryCode: value.countryCodeV2 ?? null,
      }
    : null;

  return {
    id: String(node.id),
    orderNumber: String(node.name).replace(/^#/, ""),
    email: node.email ? String(node.email) : null,
    createdAt: String(node.createdAt),
    cancelledAt: node.cancelledAt ?? null,
    displayFinancialStatus: node.displayFinancialStatus ?? null,
    totalPrice: shopMoney(node.totalPriceSet),
    totalOutstanding: node.totalOutstandingSet
      ? shopMoney(node.totalOutstandingSet)
      : null,
    customer: null,
    shippingAddress: address(node.shippingAddress),
    billingAddress: address(node.billingAddress),
    lineItems: (node.lineItems?.edges ?? []).map(({ node: item }: any) => {
      return {
        id: String(item.id),
        title: String(item.title || "Product"),
        sku: item.sku ?? null,
        quantity: Number(item.quantity),
        color: productDetail(item),
        unitPrice: shopMoney(item.originalUnitPriceSet),
        totalPrice: shopMoney(item.discountedTotalSet),
      };
    }),
  };
}

export async function getShopifyOrders(
  admin: ShopifyAdminGraphql,
  orderIds: string[],
): Promise<ShopifyOrder[]> {
  const result = await admin.graphql(
    `#graphql
      query OrdersById($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            ${ORDER_FIELDS}
          }
        }
      }
    `,
    { variables: { ids: orderIds } },
  );

  const data = assertGraphqlSuccess(
    (await result.json()) as GraphqlResponse<{ nodes: any[] }>,
  );

  const nodes = data.nodes.filter(Boolean);

  if (nodes.length !== orderIds.length) {
    throw new Error(
      "One or more selected Shopify orders could not be found.",
    );
  }

  const ordersById = new Map(nodes.map((node) => [String(node.id), parseOrder(node)]));
  return orderIds.map((id) => ordersById.get(id)!);
}

/**
 * Fetch only human-readable order numbers for error responses. This fallback
 * intentionally does not request product data, so permission errors can still
 * be reported against the correct order number.
 */
export async function getShopifyOrderNumbers(
  admin: ShopifyAdminGraphql,
  orderIds: string[],
): Promise<Record<string, string>> {
  const result = await admin.graphql(
    `#graphql
      query OrderNumbersById($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
          }
        }
      }
    `,
    { variables: { ids: orderIds } },
  );
  const payload = (await result.json()) as GraphqlResponse<{nodes: Array<{id?: string; name?: string} | null>}>;
  const numbers: Record<string, string> = {};
  for (const node of payload.data?.nodes ?? []) {
    if (node?.id && node.name) numbers[node.id] = String(node.name).replace(/^#/, "");
  }
  return numbers;
}

export async function searchShopifyOrders(
  admin: ShopifyAdminGraphql,
  search: string,
): Promise<ShopifyOrderMatchCandidate[]> {
  const result = await admin.graphql(
    `#graphql
      query SearchOrders($query: String!) {
        orders(
          first: 25,
          query: $query,
          sortKey: CREATED_AT,
          reverse: true
        ) {
          nodes {
            id
            name
            email
            createdAt
            cancelledAt
            shippingAddress {
              name
              phone
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }
            billingAddress {
              name
              phone
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }
          }
        }
      }
    `,
    { variables: { query: search.trim() } },
  );

  const data = assertGraphqlSuccess(
    (await result.json()) as GraphqlResponse<{
      orders: { nodes: any[] };
    }>,
  );

  return data.orders.nodes.map((order) => parseMatchCandidate(order));
}

function parseMatchCandidate(order: any): ShopifyOrderMatchCandidate {
  const address = (value: any): ShopifyOrderAddress | null => value
    ? {
        name: value.name ?? null,
        phone: value.phone ?? null,
        address1: value.address1 ?? null,
        address2: value.address2 ?? null,
        city: value.city ?? null,
        province: value.province ?? null,
        provinceCode: value.provinceCode ?? null,
        zip: value.zip ?? null,
        country: value.country ?? null,
        countryCode: value.countryCodeV2 ?? null,
      }
    : null;
  return {
    id: String(order.id),
    orderNumber: String(order.name).replace(/^#/, ""),
    email: order.email ? String(order.email) : null,
    createdAt: String(order.createdAt),
    cancelledAt: order.cancelledAt ?? null,
    shippingAddress: address(order.shippingAddress),
    billingAddress: address(order.billingAddress),
  };
}

/** Fetch a bounded recent candidate set once, then match customer identity locally. */
export async function getRecentShopifyOrderCandidates(
  admin: ShopifyAdminGraphql,
): Promise<ShopifyOrderMatchCandidate[]> {
  const result = await admin.graphql(
    `#graphql
      query RecentOpenOrders {
        orders(first: 100, query: "status:open", sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            email
            createdAt
            cancelledAt
            shippingAddress {
              name phone address1 address2 city province provinceCode zip country countryCodeV2
            }
            billingAddress {
              name phone address1 address2 city province provinceCode zip country countryCodeV2
            }
          }
        }
      }
    `,
  );
  const data = assertGraphqlSuccess(
    (await result.json()) as GraphqlResponse<{orders: {nodes: any[]}}>,
  );
  return data.orders.nodes.map((order) => parseMatchCandidate(order));
}
