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
    color: string | null;
    quantity: number;
    sourceOrderIds: string[];
  }>;
  totalQuantity: number;
  defaultWeight: number;
  payment: PaymentSummary;
  consignee: NonNullable<ShopifyOrder["shippingAddress"]>;
  addressOrderId: string;
  addressOptions: Array<{orderId: string; orderNumber: string; address: NonNullable<ShopifyOrder["shippingAddress"]>}>;
  addressesDiffer: boolean;
  recipientDetailsDiffer: boolean;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedPhone(value: string | null | undefined) {
  const digits = normalized(value).replace(/\D/g, "");
  if (digits.startsWith("92") && digits.length === 12) return `0${digits.slice(2)}`;
  return digits.startsWith("3") && digits.length === 10 ? `0${digits}` : digits;
}

function sameCustomer(first: ShopifyOrder, order: ShopifyOrder) {
  if (first.email && order.email && normalized(first.email) === normalized(order.email)) return true;
  const firstPhone = normalizedPhone(first.shippingAddress?.phone);
  const otherPhone = normalizedPhone(order.shippingAddress?.phone);
  if (/^03\d{9}$/.test(firstPhone) && firstPhone === otherPhone) return true;
  return Boolean(first.shippingAddress?.name && order.shippingAddress?.name &&
    normalized(first.shippingAddress.name) === normalized(order.shippingAddress.name) &&
    first.shippingAddress.address1 && order.shippingAddress.address1 &&
    normalized(first.shippingAddress.address1) === normalized(order.shippingAddress.address1));
}

function usableAddress(address: ShopifyOrder["shippingAddress"]) {
  return Boolean(address?.address1?.trim() && address?.city?.trim());
}

function addressScore(address: NonNullable<ShopifyOrder["shippingAddress"]>) {
  return [address.name, address.phone, address.address1, address.address2, address.city,
    address.province, address.zip, address.countryCode].filter((field) => field?.trim()).length;
}

function addressKey(address: NonNullable<ShopifyOrder["shippingAddress"]>) {
  return [address.address1, address.address2, address.city, address.provinceCode,
    address.zip, address.countryCode].map(normalized).join("|");
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
  addressOrderId?: string,
): CombinedOrder {
  if (orders.length === 0) throw new Error("Select at least one order.");
  if (orders.some((order) => order.cancelledAt)) {
    throw new Error("Cancelled orders cannot be combined.");
  }

  const [first] = orders;
  for (const order of orders.slice(1)) {
    if (!sameCustomer(first, order)) {
      throw new Error(`Order #${order.orderNumber} could not be confirmed as the same customer.`);
    }
  }

  const addressOptions = orders.filter((order) => usableAddress(order.shippingAddress))
    .map((order) => ({orderId: order.id, orderNumber: order.orderNumber,
      address: order.shippingAddress!}));
  if (addressOptions.length === 0) {
    throw new Error("None of the selected orders has a street address and city. Update a shipping address in Shopify before booking.");
  }
  if (addressOrderId && !orders.some((order) => order.id === addressOrderId)) {
    throw new Error("The selected delivery address must come from one of the selected orders.");
  }
  const selectedAddress = addressOrderId
    ? addressOptions.find((option) => option.orderId === addressOrderId)
    : [...addressOptions].sort((left, right) => addressScore(right.address) - addressScore(left.address))[0];
  if (!selectedAddress) {
    throw new Error("The selected order has no usable street address and city. Choose another order's delivery address.");
  }
  const validPhone = (phone: string | null | undefined) => /^03\d{9}$/.test(normalizedPhone(phone));
  const fallbackPhone = orders.map((order) => order.shippingAddress?.phone).find(validPhone);
  const fallbackName = orders.map((order) => order.shippingAddress?.name).find((name) => name?.trim());
  const consignee = {
    ...selectedAddress.address,
    name: selectedAddress.address.name?.trim() || fallbackName || null,
    phone: validPhone(selectedAddress.address.phone) ? selectedAddress.address.phone!.trim() : fallbackPhone || null,
  };

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
      // Keep products with the same title/SKU separate when their Shopify
      // product colors differ, so each InstaWorld line item retains the
      // correct Product Detail value.
      const color = item.color?.trim() || null;
      const key = `${item.sku ?? ""}:${item.title}:${color ?? ""}`;
      const existing = itemMap.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.sourceOrderIds.push(order.id);
      } else {
        itemMap.set(key, {
          key,
          title: item.title,
          sku: item.sku,
          color,
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
    consignee,
    addressOrderId: selectedAddress.orderId,
    addressOptions,
    addressesDiffer: new Set(addressOptions.map((option) => addressKey(option.address))).size > 1,
    recipientDetailsDiffer: new Set(addressOptions.map((option) =>
      `${normalized(option.address.name)}|${normalizedPhone(option.address.phone)}`)).size > 1,
  };
}
