import type {ShopifyOrder} from "./shopify-orders.server";

const DEFAULT_WEIGHT_PER_QUANTITY = 0.8;

function roundWeight(value: number) {
  return Math.round(value * 100) / 100;
}

export type PaymentSummary = {
  treatment: "cod" | "prepaid";
  amountDue: number;
  currencyCode: string;
};

export type CombinedOrder = {
  orderIds: string[];
  orders: ShopifyOrder[];
  items: Array<{
    key: string;
    title: string;
    sku: string | null;
    quantity: number;
    sourceOrderIds: string[];
  }>;
  totalQuantity: number;
  defaultWeight: number;
  payment: PaymentSummary;
  consignee: NonNullable<ShopifyOrder["shippingAddress"]>;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedPhone(value: string | null | undefined) {
  return normalized(value).replace(/[^\d+]/g, "");
}

function getPayment(order: ShopifyOrder): PaymentSummary {
  const paymentStatus = normalized(order.displayFinancialStatus);

  // Fully paid / refunded → prepaid, no COD to collect
  if (["paid", "refunded", "partially_refunded"].includes(paymentStatus)) {
    const currencyCode = order.totalOutstanding?.currencyCode || order.totalPrice.currencyCode;
    return {treatment: "prepaid", amountDue: 0, currencyCode};
  }

  // Outstanding amount available → use it
  if (order.totalOutstanding) {
    const amountDue = Number(order.totalOutstanding.amount);
    const currencyCode = order.totalOutstanding.currencyCode;

    if (!Number.isFinite(amountDue) || amountDue < 0) {
      throw new Error(`Order #${order.orderNumber} has an invalid outstanding amount.`);
    }
    if (!currencyCode) {
      throw new Error(`Order #${order.orderNumber} has no currency for its outstanding amount.`);
    }
    if (amountDue > 0) {
      const codStates = ["pending", "partially_paid", "authorized", "partially_refunded"];
      if (!codStates.includes(paymentStatus)) {
        throw new Error(
          `Order #${order.orderNumber} has an unsupported financial state: ${order.displayFinancialStatus ?? "unknown"}.`,
        );
      }
      return {treatment: "cod", amountDue, currencyCode};
    }
    // amountDue === 0 but not "paid" — fully discounted, treat as prepaid
    return {treatment: "prepaid", amountDue: 0, currencyCode};
  }

  // totalOutstanding is null — fall back to totalPrice for COD states
  const codFallbackStates = ["pending", "authorized", "partially_paid"];
  if (codFallbackStates.includes(paymentStatus)) {
    const amountDue = Number(order.totalPrice.amount);
    const currencyCode = order.totalPrice.currencyCode;
    if (!Number.isFinite(amountDue) || amountDue <= 0 || !currencyCode) {
      throw new Error(`Order #${order.orderNumber} has no reliable amount for COD collection.`);
    }
    return {treatment: "cod", amountDue, currencyCode};
  }

  throw new Error(
    `Order #${order.orderNumber} has an ambiguous payment state: ${order.displayFinancialStatus ?? "unknown"}.`,
  );
}

export function combineOrders(
  orders: ShopifyOrder[],
  declaredWeight = orders.reduce(
    (sum, order) =>
      sum + order.lineItems.reduce((lineSum, item) => lineSum + item.quantity, 0) * DEFAULT_WEIGHT_PER_QUANTITY,
    0,
  ),
): CombinedOrder {
  if (orders.some((order) => order.cancelledAt)) {
    throw new Error("Cancelled orders cannot be combined.");
  }

  const [first] = orders;
  const firstAddress = first.shippingAddress;
  if (!firstAddress) {
    throw new Error(`Order #${first.orderNumber} has no delivery address.`);
  }

  for (const order of orders.slice(1)) {
    const address = order.shippingAddress;
    if (!address) {
      throw new Error(`Order #${order.orderNumber} has no delivery address.`);
    }
    const sameAddress = [
      "name",
      "address1",
      "address2",
      "city",
      "provinceCode",
      "zip",
      "countryCode",
    ].every((field) => normalized(address[field as keyof typeof address]) === normalized(firstAddress[field as keyof typeof firstAddress]));
    if (!sameAddress || normalizedPhone(address.phone) !== normalizedPhone(firstAddress.phone)) {
      throw new Error(`Order #${order.orderNumber} has incompatible recipient or delivery details.`);
    }
  }

  const payments = orders.map(getPayment);
  const treatment = payments[0].treatment;
  if (payments.some((payment) => payment.treatment !== treatment)) {
    throw new Error("COD and prepaid orders cannot be combined.");
  }
  const currencyCode = payments[0].currencyCode;
  if (payments.some((payment) => payment.currencyCode !== currencyCode)) {
    throw new Error("Orders with different currencies cannot be combined.");
  }

  const itemMap = new Map<string, CombinedOrder["items"][number]>();
  for (const order of orders) {
    for (const item of order.lineItems) {
      const key = `${item.sku ?? ""}:${item.title}`;
      const existing = itemMap.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.sourceOrderIds.push(order.id);
      } else {
        itemMap.set(key, {
          key,
          title: item.title,
          sku: item.sku,
          quantity: item.quantity,
          sourceOrderIds: [order.id],
        });
      }
    }
  }

  const items = [...itemMap.values()];
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalQuantity <= 0) {
    throw new Error("Combined shipment must contain at least one item.");
  }
  if (!Number.isFinite(declaredWeight) || declaredWeight <= 0) {
    throw new Error("Declared weight must be a positive number.");
  }

  return {
    orderIds: orders.map((order) => order.id),
    orders,
    items,
    totalQuantity,
    defaultWeight: roundWeight(totalQuantity * DEFAULT_WEIGHT_PER_QUANTITY),
    payment: {
      treatment,
      amountDue: payments.reduce((sum, payment) => sum + payment.amountDue, 0),
      currencyCode,
    },
    consignee: firstAddress,
  };
}
