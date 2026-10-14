
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
  shippingAddress: {
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
  } | null;
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

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

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

function parseOrder(node: any): ShopifyOrder {
  if (!node?.id || !node.name) {
    throw new Error("Shopify returned an incomplete order.");
  }

  const shopMoney = (value: any): Money => ({
    amount: String(value?.shopMoney?.amount ?? ""),
    currencyCode: String(value?.shopMoney?.currencyCode ?? ""),
  });

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
    shippingAddress: node.shippingAddress
      ? {
          name: node.shippingAddress.name ?? null,
          phone: node.shippingAddress.phone ?? null,
          address1: node.shippingAddress.address1 ?? null,
          address2: node.shippingAddress.address2 ?? null,
          city: node.shippingAddress.city ?? null,
          province: node.shippingAddress.province ?? null,
          provinceCode: node.shippingAddress.provinceCode ?? null,
          zip: node.shippingAddress.zip ?? null,
          country: node.shippingAddress.country ?? null,
          countryCode: node.shippingAddress.countryCodeV2 ?? null,
        }
      : null,
    lineItems: (node.lineItems?.edges ?? []).map(
      ({ node: item }: any) => ({
        id: String(item.id),
        title: String(item.title || "Product"),
        sku: item.sku ?? null,
        quantity: Number(item.quantity),
        color: item.product?.color?.value ? String(item.product.color.value) : null,
        unitPrice: shopMoney(item.originalUnitPriceSet),
        totalPrice: shopMoney(item.discountedTotalSet),
      }),
    ),
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

  return nodes.map(parseOrder);
}

export async function searchShopifyOrders(
  admin: ShopifyAdminGraphql,
  search: string,
): Promise<
  Array<
    Pick<
      ShopifyOrder,
      "id" | "orderNumber" | "createdAt" | "cancelledAt"
    >
  >
> {
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
            createdAt
            cancelledAt
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

  return data.orders.nodes.map((order) => ({
    id: String(order.id),
    orderNumber: String(order.name).replace(/^#/, ""),
    createdAt: String(order.createdAt),
    cancelledAt: order.cancelledAt ?? null,
  }));
}
