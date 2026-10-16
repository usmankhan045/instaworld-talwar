import {
  normaliseCity,
  normalisePhone,
  replaceCityInAddress,
} from "./instaworld.server.ts";

export type ShopifyOrderCreatedWebhook = {
  id?: string | number;
  name?: string | null;
  order_number?: string | number | null;
  phone?: string | null;
  cancelled_at?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
  shipping_address?: {
    name?: string | null;
    phone?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    province_code?: string | null;
    zip?: string | number | null;
    country?: string | null;
  } | null;
  line_items?: Array<{
    title?: string | null;
    quantity?: number | string | null;
  }> | null;
};

export type CallJobCreateInput = {
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  customerName: string;
  phone: string;
  productSummary: string;
  normalizedAddress: string;
  orderStatus: string;
  addressStatus: string;
  callStatus: string;
};

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function combineName(
  shippingName: string,
  firstName: string,
  lastName: string,
): string {
  return shippingName || [firstName, lastName].filter(Boolean).join(" ") || "Customer";
}

function formatProducts(lineItems: ShopifyOrderCreatedWebhook["line_items"]): string {
  const products = (lineItems ?? [])
    .map((item) => {
      const title = text(item.title) || "Product";
      const quantity = Number(item.quantity ?? 0);
      return `${title} x ${Number.isFinite(quantity) && quantity > 0 ? quantity : 1}`;
    });

  return products.length > 0 ? products.join(", ") : "Online order";
}

function formatAddress(
  address: NonNullable<ShopifyOrderCreatedWebhook["shipping_address"]>,
): {normalizedAddress: string; hasRequiredAddress: boolean} {
  const rawCity = text(address.city);
  const city = normaliseCity(rawCity);
  const addressLines = [text(address.address1), text(address.address2)]
    .filter(Boolean)
    .join(", ");
  const correctedAddressLines = replaceCityInAddress(addressLines, rawCity, city);
  const normalizedAddress = [
    correctedAddressLines,
    city,
    text(address.province) || text(address.province_code),
    text(address.zip),
    text(address.country),
  ]
    .filter(Boolean)
    .join(", ");

  return {
    normalizedAddress,
    hasRequiredAddress: Boolean(correctedAddressLines && city),
  };
}

/**
 * Convert Shopify's orders/create payload into the durable call-job data.
 * This function is intentionally pure so webhook behavior can be tested
 * without a Shopify connection or a live database.
 */
export function buildCallJobInput(
  payload: ShopifyOrderCreatedWebhook,
): CallJobCreateInput {
  const shippingAddress = payload.shipping_address;
  const customer = payload.customer;
  const shopifyOrderId = text(payload.id);
  const shopifyOrderNumber = (text(payload.name) || text(payload.order_number)).replace(/^#/, "");
  const customerName = combineName(
    text(shippingAddress?.name),
    text(customer?.first_name),
    text(customer?.last_name),
  );
  const phone = normalisePhone(
    text(shippingAddress?.phone) || text(payload.phone) || text(customer?.phone),
  );
  const productSummary = formatProducts(payload.line_items);
  const {normalizedAddress, hasRequiredAddress} = shippingAddress
    ? formatAddress(shippingAddress)
    : {normalizedAddress: "", hasRequiredAddress: false};
  const isCancelled = Boolean(payload.cancelled_at);
  const isEligible = Boolean(shopifyOrderId && shopifyOrderNumber && phone && hasRequiredAddress && !isCancelled);

  return {
    shopifyOrderId,
    shopifyOrderNumber,
    customerName,
    phone,
    productSummary,
    normalizedAddress,
    orderStatus: isCancelled ? "cancelled" : "pending",
    addressStatus: hasRequiredAddress ? "pending" : "invalid",
    callStatus: isEligible ? "queued" : "manual_review",
  };
}
